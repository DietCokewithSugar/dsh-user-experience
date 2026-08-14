/**
 * prepare 构建脚本（git 安装时由 pnpm 在用户机器上执行——README 安全提示
 * 即针对此脚本）。
 *
 * 职责：从源码构建发布产物（lib/index.js、lib/client.js、类型声明）。
 *
 * 兼容两种安装形态：
 * - git 安装（github:owner/repo#sha）：pnpm 会安装 devDependencies 后执行
 *   本脚本，tsdown/tsc 可用 → 完整重建。
 * - npm registry 安装：发布包已携带 lib/ 预构建产物，且 registry 依赖不会
 *   安装 devDependencies；此时跳过重建，直接使用随包发布的产物。
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const devTooling = existsSync('node_modules/tsdown') && existsSync('node_modules/typescript')

if (devTooling) {
  console.log('[dsh-user-experience] prepare: rebuilding from source (tsdown + tsc)')
  execSync('tsdown && tsc -p tsconfig.json', { stdio: 'inherit' })
} else {
  console.log('[dsh-user-experience] prepare: dev tooling absent (registry install); using prebuilt lib/ artifacts')
}
