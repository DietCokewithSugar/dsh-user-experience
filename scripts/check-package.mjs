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

const prepare = readFileSync(join(root, 'scripts', 'prepare.mjs'), 'utf8')
if (/\b(?:pnpm|npm|yarn)\s+(?:add|install|update|upgrade)\b/u.test(prepare)) {
  failures.push('prepare.mjs must not install or update dependencies in the consumer profile')
}

const hostBundle = join(root, 'lib', 'index.js')
if (existsSync(hostBundle)) {
  const source = readFileSync(hostBundle, 'utf8')
  for (const name of ['@deepseek-ai/dsh-tools']) {
    if (!source.includes(`from "${name}"`) && !source.includes(`from '${name}'`)) {
      failures.push(`host bundle must keep ${name} external`)
    }
  }
}

const clientBundle = join(root, 'lib', 'client.js')
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
  console.log('Package singleton contract passed: Harness, Cordis, and React stay host-owned peers.')
}
