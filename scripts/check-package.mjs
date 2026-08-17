import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const singletonPeers = [
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

const failures = []
for (const name of singletonPeers) {
  if (pkg.dependencies?.[name] !== undefined) {
    failures.push(`${name} must not be a direct dependency (it would create a plugin-local runtime copy)`)
  }
  if (pkg.peerDependencies?.[name] === undefined) {
    failures.push(`${name} must be supplied by the Harness profile as a peer dependency`)
  }
  if (pkg.devDependencies?.[name] === undefined) {
    failures.push(`${name} peer must be mirrored in devDependencies for local build/test`)
  }
}

for (const name of Object.keys(pkg.dependencies ?? {})) {
  if (name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/dsh-')) {
    failures.push(`${name} leaked into runtime dependencies`)
  }
}

const blockedLifecycle = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
]
for (const name of blockedLifecycle) {
  if (pkg.scripts?.[name]) {
    failures.push(`${name} must not run at consumer install time (pnpm ≥ 10 blocks it by default)`)
  }
}

const hostBundle = join(root, 'lib', 'index.js')
const clientBundle = join(root, 'lib', 'client.js')
if (!existsSync(hostBundle)) {
  failures.push('lib/index.js must be committed so GitHub installs can load without a build script')
}
if (!existsSync(clientBundle)) {
  failures.push('lib/client.js must be committed so GitHub installs can load without a build script')
}

if (existsSync(hostBundle)) {
  const source = readFileSync(hostBundle, 'utf8')
  for (const name of ['@deepseek-ai/dsh-tools']) {
    if (!source.includes(`from "${name}"`) && !source.includes(`from '${name}'`)) {
      failures.push(`host bundle must keep ${name} external`)
    }
  }
}

if (existsSync(clientBundle)) {
  const source = readFileSync(clientBundle, 'utf8')
  if (!/require\(["']react["']\)/u.test(source)) {
    failures.push('client bundle must keep React external')
  }
}

if (failures.length > 0) {
  console.error('Package singleton contract failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('Package singleton contract passed: Harness, Cordis, and React stay host-owned peers; GitHub installs use committed lib/ with no lifecycle scripts.')
}
