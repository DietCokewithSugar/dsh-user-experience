/**
 * 确认闭环的去 ID 化入口（v0.1.1 spec §4.3）。
 *
 * v0.1 要求用户敲 `/ux judge <报告ID> <findingID> <状态>`——**让用户搬运系统
 * 内部主键**。本模块把这件事翻过来：会话里始终存在"当前报告"上下文，用户
 * 只需要点按钮或直接说话。
 *
 * 三种入口共用这里的解析：
 * - 卡片按钮 → `/ux judge`（脚本接口，不出现在任何面向用户的提示里）
 * - 自然语言 → `ux_judge` 工具（「第 2 条不成立」「这几条都对」）
 * - 批量操作 → 同上（「三级以下全部忽略」「全部确认」）
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { recordVerdict } from './history'
import { isChinese, type OutputLanguage } from './i18n'
import type { ProductType } from './product'
import type { ExplicitVerdict, FindingStatus, UxFinding } from './types'

/** 会话中的"当前报告"。 */
export interface CurrentReport {
  reportId: string
  title: string
  language: OutputLanguage
  productType: ProductType
  findings: readonly UxFinding[]
  /** 折叠 `ux/finding-status` 之后的现状。 */
  statuses: Map<string, FindingStatus>
}

/**
 * 取会话日志里最近一份报告，并折叠出每条 finding 的当前状态。
 * @param session - 当前会话。
 * @param reportId - 指定报告；缺省取最近一份。
 * @returns 当前报告；会话里还没有报告时 undefined。
 */
export function currentReport(session: Session, reportId?: string): CurrentReport | undefined {
  let latest: {
    reportId: string
    title: string
    language: OutputLanguage
    productType: ProductType
    findings: readonly UxFinding[]
  } | undefined
  for (const event of session.events) {
    if (event.type !== 'ux/report') continue
    if (reportId !== undefined && event.data.reportId !== reportId) continue
    latest = {
      reportId: event.data.reportId,
      title: event.data.title,
      language: event.data.language ?? 'zh-CN',
      productType: event.data.productType ?? 'other',
      findings: event.data.findings,
    }
  }
  if (latest === undefined) return undefined
  const statuses = new Map<string, FindingStatus>(
    latest.findings.map((finding) => [finding.id, finding.status]))
  for (const event of session.events) {
    if (event.type !== 'ux/finding-status') continue
    if (event.data.reportId !== latest.reportId) continue
    statuses.set(event.data.findingId, event.data.status)
  }
  return { ...latest, statuses }
}

const LEVEL_BY_WORD: Record<string, string> = {
  一级: 'P0', 二级: 'P1', 三级: 'P2', 四级: 'P3',
  one: 'P0', two: 'P1', three: 'P2', four: 'P3',
}

const ALL_WORDS = new Set(['全部', '所有', '都', 'all', '*'])

/** 「三级以下」「三级及以下」这类批量表达。 */
const BELOW = /^([一二三四])级(?:问题)?(?:及)?以下$/u
const BELOW_EN_PREFIX = /^below\s+(?:level\s+)?(one|two|three|four)$/iu
const BELOW_EN_SUFFIX = /^(?:level\s+)?(one|two|three|four)\s+(?:and|or)\s+below$/iu

/** 「第 2 条」「2」「UX-0002」这类单条表达。 */
const ORDINAL = /^第?\s*(\d+)\s*条?$/u
const ORDINAL_EN = /^(?:(?:item|finding|issue)\s+|#)(\d+)(?:st|nd|rd|th)?$/iu

/**
 * 把一个自然语言选择器解析成 finding id 列表。
 *
 * 支持：序号（`2` / `第 2 条` / `item 2`）、finding id（`UX-0002`）、
 * 批量词（`全部` / `三级以下` / `below level three` / `all`），以及
 * headline / surface 的关键词匹配。
 * @param report - 当前报告。
 * @param selector - 一个选择器文本。
 * @returns 命中的 finding id；无法解析时为空数组。
 */
export function resolveSelector(report: CurrentReport, selector: string): string[] {
  const value = selector.trim()
  if (value.length === 0) return []
  if (ALL_WORDS.has(value.toLowerCase())) return report.findings.map((finding) => finding.id)

  const below = BELOW.exec(value) ?? BELOW_EN_PREFIX.exec(value) ?? BELOW_EN_SUFFIX.exec(value)
  if (below !== null) {
    const floor = LEVEL_BY_WORD[below[1] ?? ''] ?? 'P2'
    return report.findings
      .filter((finding) => finding.technical.severity.level >= floor)
      .map((finding) => finding.id)
  }

  const levelWord = /^([一二三四])级(?:问题)?$/u.exec(value)
    ?? /^(?:level\s+)?(one|two|three|four)$/iu.exec(value)
  if (levelWord !== null) {
    const level = LEVEL_BY_WORD[(levelWord[1] ?? '').toLowerCase()]
    return report.findings
      .filter((finding) => finding.technical.severity.level === level)
      .map((finding) => finding.id)
  }

  const ordinal = ORDINAL.exec(value) ?? ORDINAL_EN.exec(value)
  if (ordinal !== null) {
    const index = Number.parseInt(ordinal[1] ?? '', 10) - 1
    const finding = report.findings[index]
    return finding === undefined ? [] : [finding.id]
  }

  const byId = report.findings.find((finding) =>
    finding.id.toLowerCase() === value.toLowerCase()
    || finding.id.toLowerCase().endsWith(`-${value.toLowerCase().padStart(4, '0')}`))
  if (byId !== undefined) return [byId.id]

  // 关键词：命中 headline 或 surface 的子串（「删除那条我确认」）。
  const keyword = value.toLowerCase()
  return report.findings
    .filter((finding) => finding.human.headline.toLowerCase().includes(keyword)
      || finding.surface.toLowerCase().includes(keyword))
    .map((finding) => finding.id)
}

/** 一次判定的结果说明。 */
export interface JudgeOutcome {
  applied: Array<{ id: string; headline: string; surface: string }>
  /** 无法解析的选择器原文。 */
  unresolved: string[]
}

/**
 * 应用一组判定：写入会话事件，并把显式判定记进长期账本。
 * @param session - 当前会话。
 * @param report - 当前报告。
 * @param targets - 选择器列表。
 * @param verdict - 判定终态。
 * @param root - 项目根目录（记账本用）。
 * @returns 实际生效的条目与无法解析的选择器。
 */
export function applyVerdicts(
  session: Session,
  report: CurrentReport,
  targets: readonly string[],
  verdict: ExplicitVerdict,
  root: string | undefined,
): JudgeOutcome {
  const ids = new Set<string>()
  const unresolved: string[] = []
  for (const target of targets) {
    const resolved = resolveSelector(report, target)
    if (resolved.length === 0) {
      unresolved.push(target)
      continue
    }
    for (const id of resolved) ids.add(id)
  }
  const applied: JudgeOutcome['applied'] = []
  for (const id of ids) {
    const finding = report.findings.find((item) => item.id === id)
    if (finding === undefined) continue
    session.append('ux/finding-status', { reportId: report.reportId, findingId: id, status: verdict })
    if (root !== undefined) recordVerdict(root, finding.fingerprint, verdict)
    applied.push({ id, headline: finding.human.headline, surface: finding.surface })
  }
  return { applied, unresolved }
}

export interface JudgeResult {
  report_id: string
  verdict: ExplicitVerdict
  applied: Array<{ id: string; headline: string; surface: string }>
  unresolved: string[]
  summary: string
}

/** 注册 `ux_judge` 工具（自然语言与批量判定的落点）。 */
export function uxJudgeTool(): ToolDefinition {
  return defineTool({
    name: 'ux_judge',
    description: [
      '记录用户对 UX 报告中问题的判定（成立 / 不成立）。',
      '用户说「第 2 条不成立」「三级以下全部忽略」，或 “item 2 is not an issue” / “ignore below level three” 时调用本工具。',
      'targets 直接写用户的说法即可：序号（2 / item 2）、批量词（全部 / all / 三级以下 / below level three）或问题关键词。',
      '本工具自己定位当前报告——不要向用户索要任何报告 ID 或问题编号。',
    ].join(' '),
    parameters: {
      targets: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '要判定的目标：序号（"2"）、批量词（"全部"/"三级以下"/"一级"）或问题关键词（"删除"）',
      },
      verdict: {
        type: 'string',
        required: true,
        enum: ['confirmed', 'rejected'],
        description: 'confirmed = 问题成立；rejected = 不是问题',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report_id: { type: 'string' },
          verdict: { type: 'string' },
          applied: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                headline: { type: 'string' },
                surface: { type: 'string' },
              },
            },
          },
          unresolved: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as JudgeResult).summary }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('ux_judge：需要 agent 上下文（应在 agent loop 中调用）')
      }
      const report = currentReport(agent.session)
      if (report === undefined) {
        throw new Error('ux_judge：本次会话还没有 UX 走查报告，无法记录判定。先完成一次走查。')
      }
      const verdict: ExplicitVerdict = args.verdict === 'rejected' ? 'rejected' : 'confirmed_explicit'
      const outcome = applyVerdicts(
        agent.session, report, args.targets, verdict, agent.session.header.cwd,
      )
      const zh = isChinese(report.language)
      const label = verdict === 'rejected'
        ? (zh ? '不是问题' : 'not an issue')
        : (zh ? '问题成立' : 'confirmed')
      const lines: string[] = []
      if (outcome.applied.length === 0) {
        lines.push(zh
          ? `没有匹配到要判定的问题：${outcome.unresolved.join('、') || '（未给出目标）'}`
          : `No findings matched: ${outcome.unresolved.join(', ') || '(no target provided)'}`)
        lines.push(zh
          ? `当前报告「${report.title}」共 ${report.findings.length} 条，可以说序号、严重度或问题里的关键词。`
          : `Report "${report.title}" has ${report.findings.length} findings; refer to an ordinal, severity, or headline keyword.`)
      } else {
        lines.push(zh
          ? `已记录 ${outcome.applied.length} 条为「${label}」：`
          : `Marked ${outcome.applied.length} finding(s) as ${label}:`)
        for (const item of outcome.applied) lines.push(`- ${item.surface}｜${item.headline}`)
        if (verdict === 'confirmed_explicit') {
          lines.push(zh
            ? '报告卡片现已提供「复制给 AI 的任务 Prompt」：它只描述观察到的现象，并提醒 AI 先补齐完整项目上下文。'
            : 'The report card now provides a task Prompt for AI. It describes the observed behavior and asks the AI to inspect the complete project context.')
        }
        if (outcome.unresolved.length > 0) {
          lines.push(zh
            ? `没匹配上的说法：${outcome.unresolved.join('、')}`
            : `Unmatched selectors: ${outcome.unresolved.join(', ')}`)
        }
      }
      const pending = report.findings.filter((finding) => {
        const status = report.statuses.get(finding.id)
        return status === 'pending' && !outcome.applied.some((item) => item.id === finding.id)
      })
      if (pending.length > 0) {
        const urgent = pending.filter((finding) => finding.technical.severity.level === 'P0').length
        lines.push(zh
          ? `还有 ${pending.length} 条待判定（其中 ${urgent} 条一级问题）。`
          : `${pending.length} findings remain (${urgent} level-one).`)
      }
      return {
        report_id: report.reportId,
        verdict,
        applied: outcome.applied,
        unresolved: outcome.unresolved,
        summary: lines.join('\n'),
      } satisfies JudgeResult
    },
  })
}
