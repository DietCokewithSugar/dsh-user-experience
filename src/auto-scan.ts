/**
 * R7 改动触发的自动走查（v0.1.1 spec §5，本版从 P1 提升为 P0）。
 *
 * **这是"流水线"与"命令行工具"的分界线。** v0.1 少了这一环，插件就只剩一串
 * 手动命令，形态自然退化。有了它，agent 改完代码自己就把体验走查跑掉了。
 *
 * 实现挂在两个文档化的扩展点上（红线：不改 agent-loop）：
 * 1. `tools/result` —— 观察文件编辑类工具的最终结果，收集变更文件；
 * 2. `agent/turn-stopping` —— 回合收尾时 `agent.steer()` 送入走查提示，
 *    这正是框架里 `/loop` 的原生形态（监听器 steer，机器重读 inbox 再跑一步）。
 *
 * 三条关键约束：
 * - **扫描单元是被改动文件所属的完整组件 / 页面，不是 diff 的那几行**：体验
 *   问题大量是缺失型的（没有空态、没有错误分支、没有二次确认），这些在 diff
 *   里是不存在的行，扫 diff 必然漏掉。diff 只用来确定范围。
 * - **前端改动优先，纯后端改动默认排除**：用户不可感知的改动报出来只是噪音。
 * - **以 auto 模式运行，只在一级 / 二级问题时提示一句**：agent 自己发起的走查
 *   就该由 agent 自己消化，否则等于在用户写代码写到一半时打断他。
 */

import { relative, isAbsolute, sep } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { loadLocalRules } from './local-rules'
import { loadPersonas } from './persona'
import { detectStack } from './project'
import type { UxConfig } from './config'

/** 值得走查的前端源码扩展名（纯后端改动不进入）。 */
const FRONTEND_EXTENSIONS = [
  '.tsx', '.jsx', '.vue', '.ts', '.js', '.css', '.scss', '.sass', '.less', '.pcss',
]

/** 一定不是"用户可感知界面"的路径特征。 */
const NON_UI_PATH = /(?:^|\/)(?:node_modules|dist|build|out|coverage|__tests__|__mocks__|scripts|server|api|migrations)\//u

/** 测试 / 配置 / 类型声明文件：改了也不产生界面变化。 */
const NON_UI_FILE = /\.(?:test|spec|d)\.[cm]?tsx?$|\.config\.[cm]?[jt]s$/u

/** 每个 agent 的待走查改动集合。 */
interface PendingChanges {
  files: Set<string>
  /** 正在跑 R7 走查：期间的文件改动与新触发一律忽略（防自激）。 */
  running: boolean
  /** 上次触发时的回合号（防抖）。 */
  lastTurn: number
  /** 上次触发的文件集合签名（同一批改动不重复触发）。 */
  lastSignature: string
}

const pending = new Map<string, PendingChanges>()

function ensure(agentId: string): PendingChanges {
  const existing = pending.get(agentId)
  if (existing !== undefined) return existing
  const created: PendingChanges = { files: new Set(), running: false, lastTurn: -1, lastSignature: '' }
  pending.set(agentId, created)
  return created
}

/**
 * 判断一个改动文件是否值得走查（前端、非测试、非构建产物）。
 * @param file - 相对项目根的路径。
 * @returns 是否纳入自动走查范围。
 */
export function isReviewableChange(file: string): boolean {
  if (file.length === 0 || file.startsWith('..')) return false
  if (NON_UI_PATH.test(`/${file}`)) return false
  if (NON_UI_FILE.test(file)) return false
  return FRONTEND_EXTENSIONS.some((extension) => file.endsWith(extension))
}

/**
 * 把工具参数里的 `file_path` 归一成相对项目根的路径。
 * @param filePath - 工具收到的路径（可能是绝对路径）。
 * @param cwd - 会话工作目录。
 * @returns 相对路径；越出项目根时 undefined。
 */
export function relativizeChange(filePath: string, cwd: string): string | undefined {
  const relativePath = isAbsolute(filePath) ? relative(cwd, filePath) : filePath
  const normalized = relativePath.split(sep).join('/')
  if (normalized.length === 0 || normalized.startsWith('../')) return undefined
  return normalized
}

/**
 * 由改动文件推出走查范围：**取其所属目录**，因为扫描单元是完整组件 / 页面。
 * @param files - 改动文件（相对项目根）。
 * @returns 去重后的目录清单（文件位于项目根时退回该文件本身）。
 */
export function scanUnitsOf(files: Iterable<string>): string[] {
  const units = new Set<string>()
  for (const file of files) {
    const slash = file.lastIndexOf('/')
    units.add(slash === -1 ? file : file.slice(0, slash))
  }
  return [...units].sort()
}

/** R7 送给模型的走查提示。 */
export function buildAutoScanPrompt(units: readonly string[], files: readonly string[]): string {
  return [
    '[dsh-user-experience R7] 刚才的改动涉及前端界面，按下面的方式**安静地**跑一次 UX 走查：',
    '',
    `1. 根据项目 README、路由和本次流程判断 product_type，并跟随用户/项目语言；调用 ux_scan 时传入这两个字段，paths 用改动所属的完整目录：${units.map((unit) => `"${unit}"`).join('、')}。`,
    '   **扫描单元是完整组件 / 页面，不是改动的那几行**——没有空态、没有错误分支、没有二次确认',
    '   这类缺失型问题在 diff 里根本不存在，只看改动行必然漏掉。',
    `   （本次改动的文件：${files.join('、')}）`,
    '2. 按 .ux/personas.yml 的画像和产品类型重点判定；CSS/布局候选没有截图时只能作为候选，不得输出需要 rendered/interactive 的规则。',
    '3. 调用一次 ux_report 定稿，带相同的 product_type/language，mode 设为 "auto"。',
    '4. 【重要】这次走查是你自己发起的，不是用户要求的：',
    '   - 全程不要向用户提问、不要索要确认；',
    '   - 报告出来后，只有存在一级 / 二级问题时才用一句话提示用户；',
    '   - 没有一级 / 二级问题就安静收尾，不要复述报告，继续等用户的下一个指令。',
    '5. 如果这次改动明显与界面体验无关（纯类型、纯工具函数），直接跳过走查，不要硬跑。',
  ].join('\n')
}

/** 是否启用自动走查（本地偏好优先于插件配置）。 */
function autoScanEnabled(cwd: string, config: UxConfig): boolean {
  const local = loadLocalRules(cwd).autoScan?.enabled
  return local ?? config.autoScan
}

function debounceTurns(cwd: string, config: UxConfig): number {
  return loadLocalRules(cwd).autoScan?.debounceTurns ?? config.autoScanDebounceTurns
}

/**
 * 接线 R7：注册两个监听器。
 * @param ctx - 插件上下文（监听器随上下文卸载而解绑）。
 * @param config - 插件配置。
 */
export function registerAutoScan(ctx: Context, config: UxConfig): void {
  const editTools = new Set(config.autoScanEditTools)

  ctx.on('tools/result', (exec, result) => {
    if (!editTools.has(exec.name)) return
    if (result.isError) return
    const agent = exec.agent
    const cwd = agent?.session.header.cwd
    if (agent === undefined || cwd === undefined) return
    const args = exec.arguments
    if (typeof args !== 'object' || args === null) return
    const filePath = (args as Record<string, unknown>).file_path
    if (typeof filePath !== 'string' || filePath.length === 0) return
    const state = ensure(agent.id)
    // 走查回合内自己产生的改动不算数（防自激；走查本身也不写文件）。
    if (state.running) return
    const relativePath = relativizeChange(filePath, cwd)
    if (relativePath === undefined || !isReviewableChange(relativePath)) return
    if (state.files.size >= config.autoScanMaxFiles) return
    state.files.add(relativePath)
  })

  ctx.on('agent/turn-stopping', (payload) => {
    const agent: Agent = payload.agent
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const state = pending.get(agent.id)
    if (state === undefined) return
    // 新回合开始即说明上一轮 R7 走查已经收尾，解除屏蔽。
    if (state.running && payload.turn !== state.lastTurn) state.running = false
    if (state.running || state.files.size === 0) return

    const files = [...state.files].sort()
    state.files.clear()

    if (!autoScanEnabled(cwd, config)) return
    // 无 persona 不出结论：这时静默跳过，绝不在用户干别的事时弹初始化引导。
    if (loadPersonas(cwd) === undefined) return
    if (!detectStack(cwd).supported) return

    const signature = files.join('|')
    if (signature === state.lastSignature) return
    if (state.lastTurn >= 0 && payload.turn - state.lastTurn < debounceTurns(cwd, config)) return

    // steer 之后走查在**同一回合内**继续跑（这正是 /loop 的形态）：
    // 屏蔽标志一直挂到下一个回合，避免走查过程中的任何动作再次触发走查。
    state.running = true
    state.lastTurn = payload.turn
    state.lastSignature = signature
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: buildAutoScanPrompt(scanUnitsOf(files), files) }],
      source: { kind: 'plugin', plugin: 'dsh-user-experience' },
    }))
  })

  ctx.on('agent/disposed', (payload) => {
    pending.delete(payload.agent.id)
  })
}
