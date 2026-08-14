/**
 * `ux_report` 工具（spec §6 R3/R5 + 多 persona 合并）：
 *
 * 模型完成判定后的**唯一定稿入口**。职责：
 * - 校验 persona_refs（必须存在且非空；无 persona 不出结论）；
 * - 执行硬约束：没有 locator 的 finding 不输出（丢弃并给出原因）；
 * - 严重度矩阵：impact 由模型给出，reach 由命中 persona 的 share 之和推导，
 *   level 由矩阵推导（spec §5.3）；
 * - 多 persona 合并：同一 locator 同一规则合并为一条，persona_refs 取并集；
 * - 以 `ux/report` 会话事件持久化（卡片与确认闭环的数据源）；
 * - R-02 术语判定增量合并进 `.ux/glossary.yml`；
 * - 输出 Markdown 报告：共性问题在前，各 persona 个性问题随后，均按 P0→P3。
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { loadGlossary, mergeGlossary, type GlossaryTerm } from './glossary'
import { loadPersonas } from './persona'
import { categoryOfRule, isRuleId } from './rules'
import {
  levelOf, reachOf,
  type Impact, type UxFinding, type VerifiedBy,
} from './types'
import type { UxConfig } from './config'

/** 模型提交的 finding 草稿。 */
export interface FindingDraft {
  rule: string
  category?: string
  persona_refs: string[]
  impact: Impact
  verified_by?: VerifiedBy
  file: string
  symbol?: string
  line?: number
  rationale: string
  suggestion: string
}

export interface ReportResult {
  report_id: string
  title: string
  findings: UxFinding[]
  dropped: Array<{ reason: string; rule?: string; file?: string }>
  glossary_terms: number
  markdown: string
}

/** 实例 token：跨进程重启的报告 id 也不会重复。 */
const instanceToken = randomUUID().slice(0, 8)

let reportSeq = 0

function mintReportId(): string {
  reportSeq += 1
  return `ux-rpt-${instanceToken}-${reportSeq}`
}

/** 是否属于"共性问题"（>= 2 个 persona 命中）。 */
function isCommon(finding: UxFinding): boolean {
  return finding.persona_refs.length > 1
}

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

function bySeverity(left: UxFinding, right: UxFinding): number {
  return (SEVERITY_ORDER[left.severity.level] ?? 9) - (SEVERITY_ORDER[right.severity.level] ?? 9)
}

/** 渲染一份 Markdown 报告（spec §R5）。 */
function renderReport(result: ReportResult, personas: ReadonlyMap<string, string>): string {
  const lines: string[] = [
    `# UX 走查报告：${result.title}`,
    '',
    '> 证据等级：**static**（v0.1 仅静态源码证据；本版不覆盖视觉类问题——对比度、热区尺寸、文字截断、焦点顺序）。',
    `> 报告 ID：\`${result.report_id}\`｜严重度：impact（是否阻断关键任务）× reach（命中画像 share 之和）推导。`,
    '',
  ]
  const findings = [...result.findings].sort(bySeverity)
  const common = findings.filter(isCommon)
  if (common.length > 0) {
    lines.push('## 共性问题（≥ 2 个 persona 独立命中，可信度更高）', '')
    for (const finding of common) lines.push(renderFinding(finding, personas))
  }
  const seen = new Set(common.map((finding) => finding.id))
  const perPersona = new Map<string, UxFinding[]>()
  for (const finding of findings) {
    if (seen.has(finding.id)) continue
    for (const ref of finding.persona_refs) {
      const list = perPersona.get(ref) ?? []
      list.push(finding)
      perPersona.set(ref, list)
    }
  }
  for (const [personaId, list] of perPersona) {
    lines.push(`## 个性问题 — ${personas.get(personaId) ?? personaId}`, '')
    for (const finding of list) lines.push(renderFinding(finding, personas))
  }
  if (findings.length === 0) {
    lines.push('## 结果', '', '本轮未发现问题。宁缺毋滥：不要为了覆盖面凑数。', '')
  }
  const counts = new Map<string, number>()
  for (const finding of findings) {
    counts.set(finding.severity.level, (counts.get(finding.severity.level) ?? 0) + 1)
  }
  const countText = ['P0', 'P1', 'P2', 'P3']
    .filter((level) => counts.has(level))
    .map((level) => `${level} × ${counts.get(level) ?? 0}`)
    .join('，') || '无'
  lines.push(
    '## 汇总',
    '',
    `- 本轮输出 ${findings.length} 条（${countText}）`,
    `- 已确认 **0 / ${findings.length}**：请在报告卡片上逐条点击「成立 / 不成立」；仅 confirmed 计入最终清单`,
  )
  if (result.dropped.length > 0) {
    lines.push(`- 丢弃 ${result.dropped.length} 条：`)
    for (const dropped of result.dropped) {
      lines.push(`  - ${dropped.reason}${dropped.file === undefined ? '' : `（${dropped.file}）`}`)
    }
  }
  if (result.glossary_terms > 0) {
    lines.push(`- 术语表更新 ${result.glossary_terms} 条（.ux/glossary.yml）`)
  }
  return lines.join('\n')
}

function renderFinding(finding: UxFinding, personas: ReadonlyMap<string, string>): string {
  const locator = `\`${finding.evidence.locator.file}\``
    + (finding.evidence.locator.symbol === undefined ? '' : `（${finding.evidence.locator.symbol}）`)
  const refs = finding.persona_refs.map((ref) => personas.get(ref) ?? ref).join('、')
  return [
    `- **[${finding.id}] [${finding.severity.level}] [${finding.category}]** ${locator}`,
    `  - 命中画像：${refs}｜规则：${finding.rule}｜证据：${finding.evidence.level} / ${finding.evidence.verified_by}`,
    `  - 依据：${finding.evidence.rationale}`,
    `  - 建议：${finding.suggestion}`,
  ].join('\n')
}

/** 注册 `ux_report` 工具。 */
export function uxReportTool(config: UxConfig): ToolDefinition {
  return defineTool({
    name: 'ux_report',
    description: [
      'UX 走查定稿：把你判定后的 findings 汇总成正式报告。',
      '必须携带 persona_refs（每一条都非空且存在于 .ux/personas.yml）——无 persona 不出结论。',
      '硬约束：没有 locator（file）的 finding 会被丢弃并在报告中列出原因。',
      '严重度由矩阵推导：impact 由你给出，reach 由命中画像 share 之和推导（>=0.5 为 wide）。',
      '同一位置同一规则自动合并为一条（persona_refs 取并集），多 persona 走查只需调用一次。',
      '可选 glossary_updates 持久化 R-02 术语判定（仅当本轮无 P0/P1 时才应执行 R-02）。',
      '返回的 markdown 直接呈现给用户。',
    ].join(' '),
    parameters: {
      title: { type: 'string', required: true, description: '报告标题（如"订单流程 UX 走查"）' },
      persona_ids: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '本次走查覆盖的 persona id 列表（与画像文件一致）',
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rule: { type: 'string', required: true, description: 'R-01 … R-09' },
            category: { type: 'string', description: 'microcopy | state-coverage | theme-adaptation；缺省按规则推导' },
            persona_refs: { type: 'array', items: { type: 'string' }, required: true, description: '命中该问题的 persona id 列表（非空）' },
            impact: { type: 'string', required: true, enum: ['high', 'low'], description: '是否阻断该 persona 完成关键任务' },
            verified_by: { type: 'string', enum: ['model', 'model+ast', 'ast'], description: '验证来源；缺省 model' },
            file: { type: 'string', required: true, description: '相对项目根的文件路径（locator 硬约束）' },
            symbol: { type: 'string', description: '组件 / 符号级定位' },
            line: { type: 'number', description: '行号（可选）' },
            rationale: { type: 'string', required: true, description: '判定依据：规则 ID 或启发式条目原文' },
            suggestion: { type: 'string', required: true, description: '优化方向描述（不给具体代码）' },
          },
        },
        required: true,
        description: '模型判定后的 finding 草稿列表',
      },
      glossary_updates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            canonical: { type: 'string', required: true, description: '规范词' },
            variants: { type: 'array', items: { type: 'string' }, required: true, description: '同义变体' },
            note: { type: 'string', description: '判定备注' },
          },
        },
        description: 'R-02 术语判定（增量合并进 .ux/glossary.yml）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report_id: { type: 'string' },
          title: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                persona_refs: { type: 'array', items: { type: 'string' } },
                category: { type: 'string' },
                rule: { type: 'string' },
                severity: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    impact: { type: 'string' },
                    reach: { type: 'string' },
                    level: { type: 'string' },
                  },
                },
                evidence: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    level: { type: 'string' },
                    verified_by: { type: 'string' },
                    locator: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        file: { type: 'string' },
                        symbol: { type: 'string' },
                        line: { type: 'number' },
                      },
                    },
                    rationale: { type: 'string' },
                  },
                },
                suggestion: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
          dropped: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                reason: { type: 'string' },
                rule: { type: 'string' },
                file: { type: 'string' },
              },
            },
          },
          glossary_terms: { type: 'number' },
          markdown: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const result = value as ReportResult
        return [{ type: 'text', text: result.markdown }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('ux_report：需要 agent 上下文（应在 agent loop 中调用）')
      }
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        throw new Error('ux_report：当前会话没有工作目录（cwd），无法定位项目')
      }
      const personas = loadPersonas(cwd)
      if (personas === undefined) {
        throw new Error('ux_report：项目未初始化 persona（.ux/personas.yml 不存在）。请先 /ux init 并确认画像后再走查——无 persona 不出结论。')
      }
      const personaNames = new Map(personas.map((persona) => [persona.id, persona.name]))
      const shareById = new Map(personas.map((persona) => [persona.id, persona.share]))

      // 报告级 persona 校验：persona_ids 必须非空且全部存在于画像文件。
      const unknownReportPersonas = args.persona_ids.filter((id) => !shareById.has(id))
      if (unknownReportPersonas.length > 0) {
        throw new Error(`ux_report：persona_ids 含未知画像 ${unknownReportPersonas.join(', ')}；合法画像：${personas.map((persona) => persona.id).join(', ')}`)
      }
      if (args.persona_ids.length === 0) {
        throw new Error('ux_report：persona_ids 不能为空（无 persona 不出结论）')
      }

      const dropped: ReportResult['dropped'] = []
      const merged = new Map<string, UxFinding>()

      const dedupeKey = (rule: string, file: string, symbol: string | undefined): string =>
        `${rule}|${file}|${symbol ?? ''}`

      for (const draft of args.findings) {
        if (!isRuleId(draft.rule)) {
          dropped.push({ reason: `未知规则 ${draft.rule}`, rule: draft.rule, file: draft.file })
          continue
        }
        if (typeof draft.file !== 'string' || draft.file.trim().length === 0) {
          dropped.push({ reason: '无 locator（file 缺失）——硬约束：没有 locator 的问题不输出', rule: draft.rule })
          continue
        }
        const refs = draft.persona_refs.filter((id) => shareById.has(id))
        if (refs.length === 0) {
          dropped.push({ reason: 'persona_refs 为空或全部无效——无 persona 不出结论', rule: draft.rule, file: draft.file })
          continue
        }
        const category = draft.category === 'microcopy' || draft.category === 'state-coverage' || draft.category === 'theme-adaptation'
          ? draft.category
          : categoryOfRule(draft.rule)
        const impact: Impact = draft.impact === 'high' ? 'high' : 'low'
        const shares = refs.map((id) => shareById.get(id) ?? 0)
        const reach = reachOf(shares)
        const key = dedupeKey(draft.rule, draft.file, draft.symbol)
        const existing = merged.get(key)
        if (existing !== undefined) {
          // 合并：persona_refs 取并集；impact 取更严重的一侧（high 优先）。
          existing.persona_refs = [...new Set([...existing.persona_refs, ...refs])]
          if (impact === 'high' && existing.severity.impact === 'low') {
            existing.severity.impact = 'high'
          }
          continue
        }
        const finding: UxFinding = {
          id: '', // 定稿阶段统一编号
          persona_refs: refs,
          category,
          rule: draft.rule,
          severity: {
            impact,
            reach,
            level: levelOf(impact, reach),
          },
          evidence: {
            level: 'static',
            verified_by: draft.verified_by === 'model+ast' || draft.verified_by === 'ast'
              ? draft.verified_by
              : 'model',
            locator: {
              file: draft.file.trim(),
              ...(draft.symbol === undefined ? {} : { symbol: draft.symbol }),
              ...(typeof draft.line === 'number' && Number.isSafeInteger(draft.line) ? { line: draft.line } : {}),
            },
            rationale: draft.rationale,
          },
          suggestion: draft.suggestion,
          status: 'pending',
        }
        merged.set(key, finding)
      }

      // 超限丢弃（宁缺毋滥：报告体量受控）。
      const findings = [...merged.values()].sort(bySeverity)
      while (findings.length > config.maxFindings) {
        const overflow = findings.pop()
        if (overflow !== undefined) {
          dropped.push({
            reason: `超出单份报告上限（${config.maxFindings} 条），已按严重度裁剪`,
            rule: overflow.rule,
            file: overflow.evidence.locator.file,
          })
        }
      }
      findings.forEach((finding, index) => {
        finding.id = `UX-${String(index + 1).padStart(4, '0')}`
      })

      const reportId = mintReportId()
      agent.session.append('ux/report', {
        reportId,
        title: args.title,
        findings,
      })

      let glossaryTerms = 0
      if (args.glossary_updates !== undefined && args.glossary_updates.length > 0) {
        const updates: GlossaryTerm[] = args.glossary_updates.map((update) => ({
          canonical: update.canonical,
          variants: update.variants,
          ...(update.note === undefined ? {} : { note: update.note }),
        }))
        const mergedGlossary = mergeGlossary(cwd, updates)
        glossaryTerms = mergedGlossary.terms.length
      } else {
        glossaryTerms = loadGlossary(cwd).terms.length
      }

      const result: ReportResult = {
        report_id: reportId,
        title: args.title,
        findings,
        dropped,
        glossary_terms: glossaryTerms,
        markdown: '',
      }
      result.markdown = renderReport(result, personaNames)
      return result
    },
  })
}
