/**
 * 运行模式与场景自动选择（v0.1.1 spec §4.1 / §4.2）。
 *
 * 三档模式：
 * - `auto`         全自动跑完直接出报告，不打断，不索要确认；
 * - `review`       出报告后一次性批量确认（可勾选多条一并提交）；
 * - `interactive`  逐条确认（v0.1 现状，保留给需要精细调优规则的用户）。
 *
 * **为什么要自动选择**：v0.1 把每一步都做成人工关卡，形态退化成命令行工具。
 * 但"该不该打断人"取决于**是谁发起的走查**：用户用自然语言点名走查时人就在
 * 等结果，给他批量确认；R7 在用户写代码写到一半时自动触发，这时弹确认清单
 * 等于打断他——agent 自己发起的走查，就该由 agent 自己消化，安静出报告。
 */

import type { LocalRules } from './local-rules'
import type { UxMode } from './types'

export type { UxMode }

/** 走查的触发来源：决定"该不该打断人"。 */
export type UxTrigger =
  /** 用户用自然语言主动发起走查。 */
  | 'user'
  /** R7 改动触发：agent 自己发起的走查。 */
  | 'auto-scan'

/** 插件配置里的模式项：`detect` 表示交给场景自动选择。 */
export type ConfiguredMode = UxMode | 'detect'

export interface ResolveModeInput {
  /** 本地规则或测试显式指定（`auto` / `review` / `interactive`）。 */
  explicit?: string | undefined
  /** `.ux/rules.local.yml` 的偏好。 */
  localRules?: LocalRules | undefined
  /** 插件配置（profile 层可覆盖）。 */
  configured?: ConfiguredMode | undefined
  /** 本次走查的触发来源。 */
  trigger: UxTrigger
  /** 环境变量视图（便于测试注入）；缺省读 `process.env`。 */
  env?: Record<string, string | undefined>
}

export interface ResolvedMode {
  mode: UxMode
  /** 命中的判定依据，写进提示词与报告，便于排查"为什么是这个模式"。 */
  reason: string
}

/** 解析 `--mode=auto` / `--mode auto` 形式的显式指定，返回剩余输入。 */
export function extractModeFlag(rawInput: string): { mode?: string; rest: string } {
  const joined = rawInput.replace(/--mode[=\s]+([a-z-]+)/iu, (_match, value: string) => `--mode=${value}`)
  const match = /--mode=([a-z-]+)/iu.exec(joined)
  if (match === null) return { rest: rawInput.trim() }
  const rest = joined.replace(match[0], '').replace(/\s+/gu, ' ').trim()
  return { mode: match[1]?.toLowerCase(), rest }
}

function asMode(value: string | undefined): UxMode | undefined {
  return value === 'auto' || value === 'review' || value === 'interactive' ? value : undefined
}

/** 是否是 CI / headless 场景（无人在交互界面前等结果）。 */
function isUnattended(env: Record<string, string | undefined>): boolean {
  const flags = [env.CI, env.DSH_HEADLESS, env.CONTINUOUS_INTEGRATION]
  return flags.some((flag) => flag !== undefined && flag !== '' && flag !== '0' && flag !== 'false')
}

/**
 * 按判定顺序解析本次走查的运行模式，先命中先生效：
 * 1. 命令行显式指定 `--mode`；
 * 2. `.ux/rules.local.yml` 的 `mode`；
 * 3. 插件配置（非 `detect` 时）；
 * 4. 自动探测：CI / headless → auto；R7 自动触发 → auto；用户发起 → review。
 * @param input - 各优先级的输入信号。
 * @returns 生效模式与命中的依据。
 */
export function resolveMode(input: ResolveModeInput): ResolvedMode {
  const explicit = asMode(input.explicit?.toLowerCase())
  if (explicit !== undefined) {
    return { mode: explicit, reason: '命令行显式指定 --mode' }
  }
  const local = asMode(input.localRules?.mode)
  if (local !== undefined) {
    return { mode: local, reason: '.ux/rules.local.yml 的 mode' }
  }
  const configured = input.configured
  if (configured !== undefined && configured !== 'detect') {
    const fromConfig = asMode(configured)
    if (fromConfig !== undefined) return { mode: fromConfig, reason: '插件配置 mode' }
  }
  const env = input.env ?? process.env
  if (isUnattended(env)) {
    return { mode: 'auto', reason: 'CI / headless 环境，无人等待确认' }
  }
  if (input.trigger === 'auto-scan') {
    // agent 自己发起的走查由 agent 自己消化：这时弹确认清单等于打断用户。
    return { mode: 'auto', reason: 'R7 改动自动触发，由 agent 自行消化' }
  }
  return { mode: 'review', reason: '用户主动发起，出报告后批量确认' }
}

/** 模式对应的、写进走查提示词的行为约束。 */
export function modeInstruction(mode: UxMode): string {
  switch (mode) {
    case 'auto':
      return [
        '本次运行模式：auto（全自动）。跑完直接出报告，全程不要向用户索要确认、不要逐条追问。',
        '只有当报告中出现一级 / 二级问题时，才在报告之后补一句简短提示；其余情况安静收尾。',
      ].join('\n')
    case 'interactive':
      return [
        '本次运行模式：interactive（逐条确认）。出报告后逐条与用户确认是否成立，',
        '用户的口头判定用 ux_judge 记录，不要让用户敲命令或报 ID。',
      ].join('\n')
    default:
      return [
        '本次运行模式：review（批量确认）。出报告后一次性请用户批量确认，不要逐条打断。',
        '报告卡片自带勾选与批量按钮；用户也可以直接说「第 2 条不成立」「三级以下全部忽略」，',
        '这时调用 ux_judge 记录判定——用户不需要知道任何 ID。',
      ].join('\n')
  }
}
