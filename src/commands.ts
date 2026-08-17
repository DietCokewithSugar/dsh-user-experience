/**
 * `/ux` 仅保留为报告卡片按钮的隐藏判定通道。
 *
 * 用户侧不再使用 `/ux init` / `/ux scan` / `/ux help`：走查和画像都走自然语言。
 * 卡片按钮经客户端 remote 执行 `/ux judge …`；该子命令不出现在任何面向用户
 * 的提示、错误信息与文档中。
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { applyVerdicts, currentReport } from './judge-tool'
import { isChinese, resolveOutputLanguage, type ConfiguredLanguage, type OutputLanguage } from './i18n'
import type { ExplicitVerdict } from './types'

function naturalLanguageHint(language: OutputLanguage): string {
  return isChinese(language)
    ? '直接用自然语言说即可，例如「看看下单流程好不好用」。不需要敲斜杠命令。'
    : 'Just say what you want in plain language, for example "check the checkout flow". No slash command is needed.'
}

/** 解析并执行隐藏判定通道；其余输入一律引导用户说话。 */
function runSubcommand(
  invocation: CommandInvocation,
  configuredLanguage: ConfiguredLanguage,
): CommandResult {
  const raw = invocation.rawInput.trim()
  const [sub, ...rest] = raw.length === 0 ? [''] : raw.split(/\s+/u)
  const cwd = invocation.agent.session.header.cwd
  const requestLanguage = /\p{Script=Han}/u.test(raw) ? 'zh-CN' : undefined
  const language = resolveOutputLanguage(cwd ?? process.cwd(), configuredLanguage, requestLanguage)

  if (sub !== 'judge') {
    return { kind: 'success', text: naturalLanguageHint(language) }
  }

  const reportRef = rest[0]
  const targets = (rest[1] ?? '').split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  const verdictWord = rest[2]
  if (reportRef === undefined || targets.length === 0
    || (verdictWord !== 'confirmed' && verdictWord !== 'rejected')) {
    return { kind: 'error', text: '判定参数不完整：点卡片上的按钮，或直接说「第 2 条不成立」。' }
  }
  const report = currentReport(
    invocation.agent.session,
    reportRef === 'latest' ? undefined : reportRef,
  )
  if (report === undefined) {
    return { kind: 'error', text: '找不到对应的走查报告，可能会话已被清理。' }
  }
  const verdict: ExplicitVerdict = verdictWord === 'rejected' ? 'rejected' : 'confirmed_explicit'
  let outcome
  try {
    outcome = applyVerdicts(invocation.agent.session, report, targets, verdict, cwd)
  } catch (error: unknown) {
    return {
      kind: 'error',
      text: `判定记录失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (outcome.applied.length === 0) {
    return { kind: 'error', text: '没有匹配到要判定的问题。' }
  }
  const label = verdict === 'rejected' ? '不是问题' : '问题成立'
  const promptHint = verdict === 'confirmed_explicit'
    ? '；可在报告卡片中复制现象导向的任务 Prompt 交给 AI'
    : ''
  return {
    kind: 'success',
    text: outcome.applied.length === 1
      ? `已记录「${outcome.applied[0]?.headline ?? ''}」为「${label}」${promptHint}`
      : `已记录 ${outcome.applied.length} 条为「${label}」${promptHint}`,
  }
}

/**
 * 注册隐藏的 `/ux` 判定通道。
 *
 * 命令栏若仍能看到它，也不该再教 init / scan——所以整个 `input` 字段直接省略。
 * 注意不要退回 `input: { hint: '' }`：`CommandDefinition.input` 是可选的，
 * 省略表示"没有输入提示"，而空串表示"提示是空的"，后者违反注册表契约——
 * `dsh-commands` 的 normalizeDefinition() 会抛
 * `command "ux" input hint must not be empty`，插件 apply 的第一行就失败，
 * 整个插件行起不来。
 */
export function createUxCommand(language: ConfiguredLanguage = 'auto'): CommandDefinition {
  return {
    name: 'ux',
    description: '内部判定通道（报告卡片使用）',
    recordInput: true,
    handler: (invocation) => runSubcommand(invocation, language),
  }
}
