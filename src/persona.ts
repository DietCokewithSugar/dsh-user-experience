/**
 * Persona 文件读写与校验。
 *
 * 存储位置：`.ux/personas.yml`（仓库内一等公民文件）。
 * 推断草稿可先落盘（status=draft）供自动走查使用；用户确认后升为 confirmed。
 * 本模块负责结构校验与缓存（按 cwd + mtime）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildPersonaSectionText } from './protocol'
import type { LoadedPersonas, Persona, PersonaCapability, PersonaFile, PersonaStatus } from './types'

/** Persona 文件相对项目根的路径。 */
export const PERSONAS_FILE = '.ux/personas.yml'

const PERSONA_ID = /^[a-z][a-z0-9_-]*$/u

interface CacheEntry {
  mtimeMs: number
  loaded: LoadedPersonas
}

/** cwd → 最近一次读取结果（mtime 一致才命中）。 */
const cache = new Map<string, CacheEntry>()

export function personasPath(root: string): string {
  return join(root, PERSONAS_FILE)
}

function asStatus(value: unknown): PersonaStatus {
  return value === 'draft' ? 'draft' : 'confirmed'
}

/** 校验单条 persona，失败时抛出带上下文的 TypeError。 */
export function validatePersona(value: unknown, where: string): Persona {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${where}：persona 必须是对象`)
  }
  const p = value as Record<string, unknown>
  const needString = (key: string): string => {
    const v = p[key]
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new TypeError(`${where}：${key} 必须是非空字符串`)
    }
    return v
  }
  const id = needString('id')
  if (!PERSONA_ID.test(id)) {
    throw new TypeError(`${where}：id "${id}" 必须匹配 ${PERSONA_ID.toString()}`)
  }
  const goals = p.goals
  if (!Array.isArray(goals) || goals.length === 0 || goals.some((g) => typeof g !== 'string' || g.length === 0)) {
    throw new TypeError(`${where}：goals 必须是非空字符串数组`)
  }
  const paths = p.key_paths
  if (!Array.isArray(paths) || paths.some((g) => typeof g !== 'string' || g.length === 0)) {
    throw new TypeError(`${where}：key_paths 必须是字符串数组（可为空）`)
  }
  const capability = p.capability
  if (typeof capability !== 'object' || capability === null) {
    throw new TypeError(`${where}：capability 必须是对象`)
  }
  const cap = capability as Record<string, unknown>
  if (cap.tech_literacy !== 'low' && cap.tech_literacy !== 'medium' && cap.tech_literacy !== 'high') {
    throw new TypeError(`${where}：capability.tech_literacy 必须是 low | medium | high`)
  }
  if (cap.device !== 'mobile' && cap.device !== 'desktop' && cap.device !== 'both') {
    throw new TypeError(`${where}：capability.device 必须是 mobile | desktop | both`)
  }
  if (cap.network !== 'stable' && cap.network !== 'unstable') {
    throw new TypeError(`${where}：capability.network 必须是 stable | unstable`)
  }
  if (!Array.isArray(cap.accessibility_needs) || cap.accessibility_needs.some((n) => typeof n !== 'string')) {
    throw new TypeError(`${where}：capability.accessibility_needs 必须是字符串数组`)
  }
  const share = p.share
  if (typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 1) {
    throw new TypeError(`${where}：share 必须是 (0, 1] 之间的有限数字`)
  }
  const extra = Object.keys(p).filter((key) => ![
    'id', 'name', 'scenario', 'goals', 'capability', 'key_paths', 'share',
  ].includes(key))
  if (extra.length > 0) {
    throw new TypeError(`${where}：未知字段 ${extra.join(', ')}`)
  }
  return {
    id,
    name: needString('name'),
    scenario: needString('scenario'),
    goals: goals as string[],
    key_paths: paths as string[],
    capability: {
      tech_literacy: cap.tech_literacy as PersonaCapability['tech_literacy'],
      device: cap.device as PersonaCapability['device'],
      network: cap.network as PersonaCapability['network'],
      accessibility_needs: cap.accessibility_needs as string[],
    },
    share,
  }
}

/** 校验 personas 列表；id 必须唯一。 */
export function validatePersonas(values: readonly unknown[], where: string): Persona[] {
  const seen = new Set<string>()
  return values.map((value, index) => {
    const persona = validatePersona(value, `${where}[${index}]`)
    if (seen.has(persona.id)) {
      throw new TypeError(`${where}：persona id "${persona.id}" 重复`)
    }
    seen.add(persona.id)
    return persona
  })
}

/** 校验 `.ux/personas.yml` 文件内容并转成强类型结构。 */
function parsePersonaFile(raw: unknown, where: string): LoadedPersonas {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(`${where}：顶层必须是对象`)
  }
  const doc = raw as Record<string, unknown>
  const extra = Object.keys(doc).filter((key) => key !== 'personas' && key !== 'status')
  if (extra.length > 0) {
    throw new TypeError(`${where}：未知字段 ${extra.join(', ')}`)
  }
  const personas = doc.personas
  if (!Array.isArray(personas) || personas.length === 0) {
    throw new TypeError(`${where}：personas 必须是非空数组`)
  }
  return {
    status: asStatus(doc.status),
    personas: validatePersonas(personas, `${where}.personas`),
  }
}

/**
 * 读取项目根目录下的 persona 文件（含 status）。
 * @returns 画像与确认状态；文件不存在时返回 undefined。
 */
export function loadPersonaFile(root: string): LoadedPersonas | undefined {
  const file = personasPath(root)
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    cache.delete(root)
    return undefined
  }
  const hit = cache.get(root)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.loaded
  const parsed = parse(readFileSync(file, 'utf8')) as unknown
  const loaded = parsePersonaFile(parsed, file)
  cache.set(root, { mtimeMs, loaded })
  return loaded
}

/**
 * 读取项目根目录下的 persona 列表。
 * @returns persona 列表；文件不存在时返回 undefined。
 */
export function loadPersonas(root: string): readonly Persona[] | undefined {
  return loadPersonaFile(root)?.personas
}

/** 已存在 persona 文件时，persona id 是否合法。 */
export function personaExists(root: string, id: string): boolean {
  return loadPersonas(root)?.some((persona) => persona.id === id) ?? false
}

/**
 * 写入 `.ux/personas.yml`（`ux_personas_write` 工具的唯一写入口）。
 * 写入前完整校验；返回落盘的 persona 列表。
 */
export function writePersonas(
  root: string,
  personas: readonly Persona[],
  status: PersonaStatus = 'confirmed',
): readonly Persona[] {
  const validated = validatePersonas(personas, `${PERSONAS_FILE} 写入`)
  const file = personasPath(root)
  mkdirSync(dirname(file), { recursive: true })
  const doc: PersonaFile = { status, personas: [...validated] }
  writeFileSync(file, stringify(doc, { lineWidth: 100 }) + '\n', 'utf8')
  const mtimeMs = statSync(file).mtimeMs
  cache.set(root, { mtimeMs, loaded: { status, personas: validated } })
  return validated
}

/**
 * R2 入口：为一次系统提示词装配渲染 persona 片段。
 * 每次装配按当前 agent 的 cwd 读取文件（带 mtime 缓存）。
 */
export function renderPersonaSection(agent: Agent | undefined): string {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined) return ''
  return buildPersonaSectionText(loadPersonaFile(cwd), collectInitBrief(cwd))
}

/** 收集生成画像草稿的素材简报：README 片段 + package.json + 顶层目录。 */
export function collectInitBrief(root: string): string {
  const parts: string[] = []
  const readme = ['README.md', 'readme.md', 'README.zh.md'].map((name) => join(root, name)).find((file) => existsSync(file))
  if (readme !== undefined) {
    const text = readFileSync(readme, 'utf8').slice(0, 3000)
    parts.push(`README 片段（${readme}）：\n${text}`)
  }
  const pkgFile = join(root, 'package.json')
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>
      parts.push(`package.json 摘要：name=${String(pkg.name ?? '')} description=${String(pkg.description ?? '')}`)
    } catch {
      // package.json 不可解析时静默跳过，不影响画像草稿。
    }
  }
  try {
    const top = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .slice(0, 12)
    if (top.length > 0) parts.push(`顶层目录：${top.join(', ')}`)
  } catch {
    // 列目录失败不影响简报的其余部分。
  }
  return parts.join('\n\n')
}
