/**
 * Persona 文件读写与校验（spec §5.1 / §R1 / §R2）。
 *
 * 存储位置：`.ux/personas.yml`（仓库内一等公民文件）。
 * 约束：AI 推断的画像只能作为草稿，`ux_personas_write` 工具仅在用户确认后
 * 被调用；本模块负责结构校验与缓存（按 cwd + mtime 缓存，装配系统提示词时
 * 每个请求都会经过 `renderPersonaSection`，小文件校验开销可忽略）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HUMAN_COPY_RULE } from './human-copy'
import type { Persona, PersonaCapability, PersonaFile } from './types'

/** Persona 文件相对项目根的路径。 */
export const PERSONAS_FILE = '.ux/personas.yml'

const PERSONA_ID = /^[a-z][a-z0-9_-]*$/u
const CAPABILITY_KEYS: readonly (keyof PersonaCapability)[] = [
  'tech_literacy', 'device', 'network', 'accessibility_needs',
]

interface CacheEntry {
  mtimeMs: number
  personas: readonly Persona[]
}

/** cwd → 最近一次读取结果（mtime 一致才命中）。 */
const cache = new Map<string, CacheEntry>()

export function personasPath(root: string): string {
  return join(root, PERSONAS_FILE)
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
function parsePersonaFile(raw: unknown, where: string): Persona[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new TypeError(`${where}：顶层必须是对象`)
  }
  const personas = (raw as Record<string, unknown>).personas
  if (!Array.isArray(personas) || personas.length === 0) {
    throw new TypeError(`${where}：personas 必须是非空数组`)
  }
  return validatePersonas(personas, `${where}.personas`)
}

/**
 * 读取项目根目录下的 persona 文件。
 * @returns persona 列表；文件不存在时返回 undefined。
 */
export function loadPersonas(root: string): readonly Persona[] | undefined {
  const file = personasPath(root)
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    cache.delete(root)
    return undefined
  }
  const hit = cache.get(root)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.personas
  const parsed = parse(readFileSync(file, 'utf8')) as unknown
  const personas = parsePersonaFile(parsed, file)
  cache.set(root, { mtimeMs, personas })
  return personas
}

/** 已存在 persona 文件时，persona id 是否合法。 */
export function personaExists(root: string, id: string): boolean {
  return loadPersonas(root)?.some((persona) => persona.id === id) ?? false
}

/**
 * 写入 `.ux/personas.yml`（`ux_personas_write` 工具的唯一写入口）。
 * 写入前完整校验；返回落盘的 persona 列表。
 */
export function writePersonas(root: string, personas: readonly Persona[]): readonly Persona[] {
  const validated = validatePersonas(personas, `${PERSONAS_FILE} 写入`)
  const file = personasPath(root)
  mkdirSync(dirname(file), { recursive: true })
  const doc: PersonaFile = { personas: [...validated] }
  writeFileSync(file, stringify(doc, { lineWidth: 100 }) + '\n', 'utf8')
  const mtimeMs = statSync(file).mtimeMs
  cache.set(root, { mtimeMs, personas: validated })
  return validated
}

// ── R2：Persona 上下文注入（systemPrompt.section）────────────────────────────

/** 尚无 persona 文件时的注入文本：无 persona 不出结论，先引导初始化。 */
export const UX_NO_PERSONA_TEXT = [
  '[dsh-user-experience] UX 走查插件已启用，但本项目还没有目标用户画像（.ux/personas.yml）。',
  '没有 persona 就不出任何 UX 结论：用户提出走查需求时，先请用户执行 /ux init（或直接说"帮我初始化 UX 画像"），',
  '由你读取 README / package.json / 路由结构生成 1-3 个画像草稿，交用户确认或修改后，再调用 ux_personas_write 落盘。',
  '禁止在画像未确认的情况下给出体验问题判断。',
].join('\n')

/** 将 persona 列表渲染为系统提示词片段。 */
function renderPersonas(personas: readonly Persona[]): string {
  const lines = personas.map((persona) => [
    `- [${persona.id}] ${persona.name}（share ${persona.share}）`,
    `  场景：${persona.scenario}`,
    `  目标：${persona.goals.join('；')}`,
    `  能力：技术素养 ${persona.capability.tech_literacy} / 设备 ${persona.capability.device} / 网络 ${persona.capability.network}`
      + (persona.capability.accessibility_needs.length > 0
        ? ` / 无障碍 ${persona.capability.accessibility_needs.join(', ')}`
        : ''),
    `  关键路径：${persona.key_paths.join(' → ')}`,
  ].join('\n'))
  return lines.join('\n')
}

/** 已初始化 persona 时的注入文本：画像 + 走查协议。 */
export function renderPersonaGuidance(personas: readonly Persona[]): string {
  return [
    '[dsh-user-experience] 本项目目标用户画像（.ux/personas.yml，走查的判定依据）：',
    renderPersonas(personas),
    '',
    'UX 走查协议：',
    '1. 每条 finding 必须携带非空 persona_refs，且其中每个 id 都存在于画像文件；R-09（深色模式）与用户画像无关，persona_refs 列全部画像。',
    '2. 硬约束：没有 locator（file，尽量带 symbol）的问题不输出。',
    '3. 判定顺序：确定产品/业务类型 → 模型读码提出候选 → 用 ux_scan 的源码/CSS 证据求证 → 可用时补充浏览器证据 → 确认后进 ux_report；R-09 由 AST 直接出结论。',
    '4. 多 persona 时逐个画像独立走查，最后合并进一份 ux_report：同一位置同一规则合并为一条，persona_refs 取并集。',
    '5. 严重度由矩阵推导：impact 你给（是否阻断关键任务），reach 由命中画像 share 之和推导（>= 0.5 为 wide），一级 / 二级问题必须优先处理。',
    '6. R-02（术语不一致）条件触发：仅当本轮没有一级 / 二级问题时才执行；术语判定持久化到 .ux/glossary.yml，后续只做增量判断。',
    '7. "发现的问题总数"不是目标，宁缺毋滥：拿不准的候选宁可丢弃，不要凑数。',
    '   证据等级必须如实标记：static=源码/CSS；rendered=真实页面截图/DOM/尺寸；interactive=按 persona 实际完成任务并记录步骤。',
    '   R-10/R-12/R-13 至少需要 rendered，R-14 至少需要 interactive。浏览器不可用时退回 static，不得伪造高等级证据。',
    '   输出语言优先跟随当前用户使用的语言，再跟随项目主 README；调用 ux_scan/ux_report 时显式传 language。',
    '',
    '报告是给两个读者看的（结构上已经分开，不要混着写）：',
    `8. 面向开发者的内容：surface（可理解的页面名，如"管理员页面"；拟不出就用路由路径，不用文件路径）+ headline + description。${''}`,
    `   ${HUMAN_COPY_RULE.split('\n').join('\n   ')}`,
    '9. 给 AI 看的：locator / rule / verified_by / severity，照实填进 technical，不要塞进 description。',
    '',
    '确认闭环：',
    '10. 用户说「第 2 条不成立」「这几条都对」「三级以下全部忽略」「删除那条我确认」时，调用 ux_judge 记录判定。',
    '    绝不要让用户报告 ID 或问题编号，也不要让用户敲命令——他说什么，你直接转成 ux_judge 的 targets。',
  ].join('\n')
}

/**
 * R2 入口：为一次系统提示词装配渲染 persona 片段。
 * 每次装配按当前 agent 的 cwd 读取文件（带 mtime 缓存）。
 */
export function renderPersonaSection(agent: Agent | undefined): string {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined) return ''
  const personas = loadPersonas(cwd)
  if (personas === undefined) return UX_NO_PERSONA_TEXT
  return renderPersonaGuidance(personas)
}

// ── 初始化草稿素材（/ux init 的 followup 用）─────────────────────────────────

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
  return parts.join('\n\n')
}
