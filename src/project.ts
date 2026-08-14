/**
 * 项目探测与扫描范围收敛（spec §6 R3 / R6）。
 *
 * - `detectStack`：技术栈范围 v0.1 仅 React + TypeScript。检出非支持技术栈
 *   时明确告知不支持，不给低质量猜测（spec §边界场景 9）。
 * - `gatherFiles`：按用户给定的范围（文件/目录列表）收集 .ts/.tsx 源文件。
 *   大仓库不做全量扫描：范围建议由模型在 R6 流程中给出（架构说明文件优先，
 *   否则主动询问），本函数只负责执行收集。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

/** 技术栈探测结果。 */
export interface StackInfo {
  supported: boolean
  /** 人类可读的技术栈描述。 */
  stack: string
  /** 不支持时给出的原因。 */
  reason?: string
}

/** 默认跳过的目录名（扫描收集阶段）。 */
export const DEFAULT_EXCLUDES = [
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git',
  '.next', '.nuxt', '.turbo', 'vendor', '__snapshots__',
]

/**
 * 探测项目技术栈。
 *
 * React：package.json 依赖含 react；TypeScript：存在 tsconfig.json 或
 * .ts/.tsx 源文件。非支持栈（Vue / Svelte / 小程序等）给出明确原因。
 */
export function detectStack(root: string): StackInfo {
  const pkgFile = join(root, 'package.json')
  let pkg: Record<string, unknown> | undefined
  if (existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>
    } catch {
      // 不可解析视为无 package.json。
    }
  }
  const deps = (): string[] => {
    if (pkg === undefined) return []
    const names = ['dependencies', 'devDependencies', 'peerDependencies']
    return names.flatMap((key) => Object.keys((pkg?.[key] as Record<string, unknown>) ?? {}))
  }
  const dependencyNames = deps()
  const hasReact = dependencyNames.includes('react')
  const hasVue = dependencyNames.includes('vue') || dependencyNames.includes('@vue/runtime-core')
  const hasSvelte = dependencyNames.includes('svelte')
  const hasTs = existsSync(join(root, 'tsconfig.json'))
  const sourceRoots = ['src', 'app', 'pages'].filter((name) => existsSync(join(root, name)))
  const hasTsFiles = sourceRoots.some((name) => containsExtension(join(root, name), ['.ts', '.tsx'], 40))
  const hasVueFiles = sourceRoots.some((name) => containsExtension(join(root, name), ['.vue'], 40))
  const hasSvelteFiles = sourceRoots.some((name) => containsExtension(join(root, name), ['.svelte'], 40))
  if (hasVue || hasVueFiles) {
    return { supported: false, stack: 'Vue', reason: 'v0.1 仅支持 React + TypeScript；Vue 项目暂不支持（扩展留待规则质量验证之后）' }
  }
  if (hasSvelte || hasSvelteFiles) {
    return { supported: false, stack: 'Svelte', reason: 'v0.1 仅支持 React + TypeScript；Svelte 项目暂不支持' }
  }
  if (!hasReact) {
    return { supported: false, stack: '未知（未检测到 React）', reason: 'package.json 中未声明 react 依赖；v0.1 仅支持 React + TypeScript' }
  }
  if (!hasTs && !hasTsFiles) {
    return { supported: false, stack: 'React (JavaScript)', reason: '未检测到 TypeScript（tsconfig.json 或 .ts/.tsx 源文件）；v0.1 仅支持 React + TypeScript' }
  }
  return { supported: true, stack: 'React + TypeScript' }
}

/** 在目录中浅层探测是否存在某扩展名文件（受最大探测数约束）。 */
function containsExtension(dir: string, extensions: readonly string[], maxProbe: number): boolean {
  let probed = 0
  const queue = [dir]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) break
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      probed += 1
      if (probed > maxProbe) return false
      const path = join(current, entry)
      if (extensions.some((ext) => entry.endsWith(ext))) return true
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.isDirectory() && !DEFAULT_EXCLUDES.includes(entry)) queue.push(path)
    }
  }
  return false
}

/** 收集到的单个文件。 */
export interface ScopeFile {
  /** 相对项目根的路径（用 / 分隔）。 */
  path: string
  size: number
}

export interface ScopeGather {
  files: ScopeFile[]
  truncated: boolean
  skipped: number
}

/** 收集范围：相对项目根的文件或目录列表；缺省为 ['src']。 */
export function gatherFiles(
  root: string,
  paths: readonly string[],
  excludes: readonly string[],
  maxFiles: number,
): ScopeGather {
  const excludesSet = new Set([...DEFAULT_EXCLUDES, ...excludes])
  const targets = paths.length > 0 ? paths : ['src']
  const files = new Map<string, ScopeFile>()
  let truncated = false
  let skipped = 0

  const consider = (absolute: string): void => {
    if (files.size >= maxFiles) {
      truncated = true
      skipped += 1
      return
    }
    const rel = normalizePath(relative(root, absolute))
    if (!isSourceFile(rel)) {
      skipped += 1
      return
    }
    let size = 0
    try {
      size = statSync(absolute).size
    } catch {
      skipped += 1
      return
    }
    files.set(rel, { path: rel, size })
  }

  const walk = (absolute: string): void => {
    if (truncated && files.size >= maxFiles) return
    let stat
    try {
      stat = statSync(absolute)
    } catch {
      return
    }
    if (stat.isFile()) {
      consider(absolute)
      return
    }
    if (!stat.isDirectory()) return
    let entries
    try {
      entries = readdirSync(absolute)
    } catch {
      return
    }
    for (const entry of entries) {
      if (excludesSet.has(entry)) continue
      walk(join(absolute, entry))
    }
  }

  for (const target of targets) {
    const resolved = resolve(root, target)
    if (!resolved.startsWith(resolve(root) + sep) && resolved !== resolve(root)) {
      // 越出项目根的范围目标：跳过（不读项目外文件）。
      skipped += 1
      continue
    }
    walk(resolved)
  }

  return {
    files: [...files.values()].sort((left, right) => left.path < right.path ? -1 : 1),
    truncated,
    skipped,
  }
}

function isSourceFile(rel: string): boolean {
  return rel.endsWith('.ts') || rel.endsWith('.tsx')
}

function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

/** 项目根内最可能承载前端源码的目录建议（R6 范围建议的兜底素材）。 */
export function suggestSourceRoots(root: string): string[] {
  return ['src', 'app', 'pages', 'components', 'views']
    .filter((name) => existsSync(join(root, name)))
    .map((name) => `${basename(root)}/${name}`)
}

/** 读取文件文本（带 size 上限保护）。 */
export function readSourceFile(root: string, file: ScopeFile, maxBytes: number): string {
  const text = readFileSync(join(root, file.path), 'utf8')
  return text.length > maxBytes ? text.slice(0, maxBytes) : text
}
