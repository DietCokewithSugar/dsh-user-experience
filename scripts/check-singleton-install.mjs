import { execFileSync } from 'node:child_process'
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temp = mkdtempSync(join(tmpdir(), 'dsh-ux-singleton-'))

const singletonPackages = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
  'react',
]

try {
  // 直接从已经通过 build/check-package 的发布文件组装 tarball。这里刻意不调用
  // npm/pnpm pack，避免 pack 生命周期接触宿主依赖。
  const stagingRoot = join(temp, 'staging')
  const stagingPackage = join(stagingRoot, 'package')
  mkdirSync(stagingPackage, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE']) {
    cpSync(join(root, file), join(stagingPackage, file))
  }
  cpSync(join(root, 'lib'), join(stagingPackage, 'lib'), { recursive: true })
  const tarball = join(temp, `${pkg.name}-${pkg.version}.tgz`)
  execFileSync('tar', ['-czf', tarball, '-C', stagingRoot, 'package'])

  const dependencies = Object.fromEntries(singletonPackages.map((name) => {
    const version = pkg.devDependencies[name]
    if (typeof version !== 'string') throw new Error(`missing local validation version for ${name}`)
    return [name, version]
  }))
  dependencies['react-dom'] = pkg.devDependencies['react-dom']
  dependencies[pkg.name] = `file:${tarball}`

  writeFileSync(join(temp, 'package.json'), JSON.stringify({
    name: 'dsh-ux-singleton-fixture',
    private: true,
    packageManager: pkg.packageManager,
    dependencies,
  }, null, 2))

  execFileSync(
    'pnpm',
    // GitHub Actions 的 pnpm store 可能已有包内容但没有新临时 importer 所需的
    // registry metadata；prefer-offline 会优先复用缓存，并只在元数据缺失时联网。
    ['install', '--prefer-offline', '--ignore-scripts', '--strict-peer-dependencies'],
    { cwd: temp, encoding: 'utf8', stdio: 'pipe' },
  )

  const profileRequire = createRequire(join(temp, 'package.json'))
  const pluginManifest = profileRequire.resolve(`${pkg.name}/package.json`)
  const pluginRequire = createRequire(pluginManifest)

  const mismatches = []
  for (const name of singletonPackages) {
    const fromProfile = realpathSync(profileRequire.resolve(`${name}/package.json`))
    const fromPlugin = realpathSync(pluginRequire.resolve(`${name}/package.json`))
    if (fromProfile !== fromPlugin) {
      mismatches.push(`${name}\n  profile: ${fromProfile}\n  plugin:  ${fromPlugin}`)
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`plugin resolved duplicate singleton packages:\n${mismatches.join('\n')}`)
  }

  console.log('Singleton install passed: plugin and profile resolve identical Harness/Cordis/React package instances.')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
