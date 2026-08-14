/**
 * `ux_report` 工具（spec §6 R3/R5 + 多 persona 合并；v0.1.1 §3/§4/§6）：
 *
 * 模型完成判定后的**唯一定稿入口**。职责：
 * - 校验 persona_refs（必须存在且非空；无 persona 不出结论）；
 * - 执行硬约束：没有 locator 的 finding 不输出（丢弃并给出原因）；
 * - 执行人话约束：写不出人话 description 的 finding 宁可不报（v0.1.1 §3.5/§9）；
 * - surface 净化：人话位置名兜底到路由路径，**绝不退化为文件路径**（§3.4）；
 * - 严重度矩阵：impact 由模型给出，reach 由命中 persona 的 share 之和推导，
 *   level 由矩阵推导（spec §5.3），上界面时换成人话标签（§3.3）；
 * - 多 persona 合并：同一 locator 同一规则合并为一条，persona_refs 取并集；
 * - 跨走查指纹 + 隐式确认：上一轮消失且位置被重新扫描的问题记为
 *   `confirmed_implicit`，没扫到的记为 `stale` 不计入指标（§6）；
 * - 以 `ux/report` 会话事件持久化（卡片与确认闭环的数据源）；
 * - R-02 术语判定增量合并进 `.ux/glossary.yml`；
 * - 输出 Markdown 报告：共性问题在前，各 persona 个性问题随后，按严重度排序。
 */

import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { featureDigestOf, fingerprintOf, symbolPathOf } from './fingerprint'
import { loadGlossary, mergeGlossary, type GlossaryTerm } from './glossary'
import { comparableOf, recordScan, reconcile, type ComparableFinding } from './history'
import { codeSpeakReason } from './human-copy'
import { loadLocalRules } from './local-rules'
import { resolveMode } from './mode'
import { loadPersonas } from './persona'
import { categoryOfRule, isRuleId } from './rules'
import { takeScope } from './scope'
import { sanitizeSurface, surfaceCandidatesFor, createSurfaceIndex } from './surface'
import {
  isUrgent, levelOf, reachOf, severityLabel, SEVERITY_ORDER,
  type Impact, type ImpactConfidence, type UxFinding, type UxMode, type VerifiedBy,
} from './types'
import type { UxConfig } from './config'

/** 模型提交的 finding 草稿。 */
export interface FindingDraft {
  rule: string
  category?: string
  persona_refs: string[]
  impact: Impact
  impact_confidence?: ImpactConfidence
  verified_by?: VerifiedBy
  file: string
  symbol?: string
  line?: number
  surface?: string
  headline: string
  description: string
  feature?: string
  rationale: string
  suggestion: string
}

export interface ReportResult {
  report_id: string
  title: string
  mode: UxMode
  scope: string[]
  findings: UxFinding[]
  dropped: Array<{ reason: string; rule?: string; file?: string }>
  /** 本次由"问题消失"推出的隐式确认条数。 */
  implicit_confirmed: number
  /** 本次因位置未被扫描而无法判定的条数（不计入指标分母）。 */
  stale: number
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
  return finding.technical.persona_refs.length > 1
}

function bySeverity(left: UxFinding, right: UxFinding): number {
  return (SEVERITY_ORDER[left.technical.severity.level] ?? 9)
    - (SEVERITY_ORDER[right.technical.severity.level] ?? 9)
}

/** 渲染一份 Markdown 报告（spec §R5；人话在前，技术细节缩进在后）。 */
function renderReport(result: ReportResult, personas: ReadonlyMap<string, string>): string {
  const lines: string[] = [
    `# UX 走查报告：${result.title}`,
    '',
    '> 证据等级：**static**（仅静态源码证据；本版不覆盖视觉类问题——对比度、热区尺寸、文字截断、焦点顺序）。',
    '',
  ]
  const findings = [...result.findings].sort(bySeverity)
  const common = findings.filter(isCommon)
  if (common.length > 0) {
    lines.push('## 共性问题（≥ 2 个画像独立命中，可信度更高）', '')
    for (const finding of common) lines.push(renderFinding(finding, personas), '')
  }
  const seen = new Set(common.map((finding) => finding.id))
  const perPersona = new Map<string, UxFinding[]>()
  for (const finding of findings) {
    if (seen.has(finding.id)) continue
    for (const ref of finding.technical.persona_refs) {
      const list = perPersona.get(ref) ?? []
      list.push(finding)
      perPersona.set(ref, list)
    }
  }
  for (const [personaId, list] of perPersona) {
    lines.push(`## 个性问题 — ${personas.get(personaId) ?? personaId}`, '')
    for (const finding of list) lines.push(renderFinding(finding, personas), '')
  }
  if (findings.length === 0) {
    lines.push('## 结果', '', '本轮未发现问题。宁缺毋滥：不要为了覆盖面凑数。', '')
  }

  const counts = new Map<string, number>()
  for (const finding of findings) {
    const label = finding.human.severity_label
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const countText = ['一级问题', '二级问题', '三级问题', '四级问题']
    .filter((label) => counts.has(label))
    .map((label) => `${label} × ${counts.get(label) ?? 0}`)
    .join('，') || '无'
  lines.push('## 汇总', '', `- 本轮输出 ${findings.length} 条（${countText}）`)
  if (result.implicit_confirmed > 0) {
    lines.push(`- 上一轮有 ${result.implicit_confirmed} 条问题在本次走查中消失、且位置确实被重新扫描 → 记为已改进（隐式确认）`)
  }
  if (result.stale > 0) {
    lines.push(`- ${result.stale} 条历史问题的位置本次未被扫描，无法判定，不计入指标`)
  }
  lines.push(...confirmationHint(result.mode, findings))
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

/**
 * 按模式给出确认提示。
 * **auto 模式不索要确认**——agent 自己发起的走查由 agent 自己消化，
 * 只在出现一级 / 二级问题时提示一句（v0.1.1 §4.2）。
 */
function confirmationHint(mode: UxMode, findings: readonly UxFinding[]): string[] {
  if (mode === 'auto') {
    const urgent = findings.filter((finding) => isUrgent(finding.technical.severity.level))
    if (urgent.length === 0) return []
    return [`- 其中 ${urgent.length} 条是一级 / 二级问题，建议看一眼；不急的话报告卡片随时可以回来判定`]
  }
  if (mode === 'interactive') {
    return ['- 逐条确认：卡片上点「确认存在 / 不是问题」，或直接说「第 2 条不成立」——不需要记任何编号']
  }
  return ['- 批量确认：卡片上勾选后一并提交，或直接说「这几条都对」「三级以下全部忽略」——不需要记任何编号']
}

/** 单条 finding：人话在前，技术细节缩进在后（双读者，§3.1）。 */
function renderFinding(finding: UxFinding, personas: ReadonlyMap<string, string>): string {
  const tech = finding.technical
  const locator = `${tech.locator.file}`
    + (tech.locator.line === undefined ? '' : `:${String(tech.locator.line)}`)
    + (tech.locator.symbol === undefined ? '' : `（${tech.locator.symbol}）`)
  const refs = tech.persona_refs.map((ref) => personas.get(ref) ?? ref).join('、')
  return [
    `### [${finding.human.severity_label}] ${finding.surface}｜${finding.human.headline}`,
    '',
    finding.human.description,
    '',
    '<details><summary>技术细节</summary>',
    '',
    `- 位置：\`${locator}\``,
    `- 规则：${tech.rule}（${tech.category}）｜证据：${tech.evidence_level} / ${tech.verified_by}`,
    `- 命中画像：${refs}｜内部编号：${finding.id} / ${tech.severity.level}`,
    `- 依据：${tech.rationale}`,
    `- 建议：${tech.suggestion}`,
    '',
    '</details>',
  ].join('\n')
}

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rule: { type: 'string', required: true, description: 'R-01 … R-09' },
    category: { type: 'string', description: 'microcopy | state-coverage | theme-adaptation；缺省按规则推导' },
    persona_refs: {
      type: 'array', items: { type: 'string' }, required: true,
      description: '命中该问题的 persona id 列表（非空）',
    },
    impact: {
      type: 'string', required: true, enum: ['high', 'low'],
      description: '是否阻断该 persona 完成关键任务',
    },
    impact_confidence: {
      type: 'string', enum: ['high', 'medium', 'low'],
      description: 'impact 判定的把握程度；缺省 medium',
    },
    verified_by: {
      type: 'string', enum: ['model', 'model+ast', 'ast'],
      description: '验证来源；缺省 model',
    },
    file: { type: 'string', required: true, description: '相对项目根的文件路径（locator 硬约束）' },
    symbol: { type: 'string', description: '组件 / 符号级定位' },
    line: { type: 'number', description: '行号（可选）' },
    surface: {
      type: 'string', required: true,
      description: '人话页面名，如"管理员页面"。优先取 ux_scan 的 surface_hints；拟不出时用路由路径。'
        + '**不要给文件路径**——文件路径对人没有意义，会被丢弃并替换。',
    },
    headline: {
      type: 'string', required: true,
      description: '一句话说清出了什么事，如"删除用户后没有任何提示"（不含文件名、规则 ID）',
    },
    description: {
      type: 'string', required: true,
      description: '用户会遇到什么（2-3 句）。❌「handleDelete 的 catch 分支中没有调用 toast」'
        + ' ✅「删除失败时界面没有任何提示，用户以为删成功了」。写不出人话就不要报这条。',
    },
    feature: {
      type: 'string',
      description: '跨走查比对用的特征：文案类给文案原文，结构类给被指认元素的语法特征（如 "handleDelete 无 catch"）',
    },
    rationale: { type: 'string', required: true, description: '判定依据：规则 ID 或启发式条目原文（技术细节，给 AI 看）' },
    suggestion: { type: 'string', required: true, description: '优化方向描述（不给具体代码）' },
  },
} as const

/** 注册 `ux_report` 工具。 */
export function uxReportTool(config: UxConfig): ToolDefinition {
  return defineTool({
    name: 'ux_report',
    description: [
      'UX 走查定稿：把你判定后的 findings 汇总成正式报告。',
      '每条 finding 分两半——给人看的（surface 人话页面名 + headline + description）与给 AI 看的（locator / rule / severity）。',
      'description 必须写"用户会遇到什么"，不写"代码里缺什么"；带代码腔的描述会被丢弃（写不出人话宁可不报）。',
      'surface 必须是人话位置名或路由路径，给文件路径会被替换。',
      '必须携带 persona_refs（每一条都非空且存在于 .ux/personas.yml）——无 persona 不出结论。',
      '硬约束：没有 locator（file）的 finding 会被丢弃并在报告中列出原因。',
      '严重度由矩阵推导：impact 由你给出，reach 由命中画像 share 之和推导（>=0.5 为 wide）；上界面时换成一级~四级问题。',
      '同一位置同一规则自动合并为一条（persona_refs 取并集），多 persona 走查只需调用一次。',
      '本工具还会比对上一轮的问题：消失且位置被重新扫描的记为已改进，位置没扫到的记为无法判定。',
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
      mode: {
        type: 'string',
        enum: ['auto', 'review', 'interactive'],
        description: '本次走查的运行模式；缺省按场景自动选择（发起走查时的提示里已给出）',
      },
      scope_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '本次实际走查到的文件清单；缺省自动取本会话 ux_scan 收集到的范围',
      },
      findings: {
        type: 'array',
        items: DRAFT_SCHEMA,
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
          mode: { type: 'string' },
          scope: { type: 'array', items: { type: 'string' } },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                fingerprint: { type: 'string' },
                surface: { type: 'string' },
                human: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    headline: { type: 'string' },
                    description: { type: 'string' },
                    severity_label: { type: 'string' },
                  },
                },
                technical: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    locator: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        file: { type: 'string' },
                        symbol: { type: 'string' },
                        line: { type: 'number' },
                      },
                    },
                    rule: { type: 'string' },
                    category: { type: 'string' },
                    verified_by: { type: 'string' },
                    evidence_level: { type: 'string' },
                    persona_refs: { type: 'array', items: { type: 'string' } },
                    severity: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        impact: { type: 'string' },
                        impact_confidence: { type: 'string' },
                        reach: { type: 'string' },
                        level: { type: 'string' },
                      },
                    },
                    rationale: { type: 'string' },
                    suggestion: { type: 'string' },
                  },
                },
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
          implicit_confirmed: { type: 'number' },
          stale: { type: 'number' },
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
        throw new Error('ux_report：项目还没有目标用户画像（.ux/personas.yml 不存在）。请先让用户确认画像再走查——无 persona 不出结论。')
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

      // 本次范围：优先取 ux_scan 累积的真实文件清单，退回模型显式给出的范围。
      const scanScope = takeScope(agent.session.id)
      const scope = scanScope !== undefined && scanScope.files.size > 0
        ? [...scanScope.files]
        : [...(args.scope_paths ?? [])]
      const surfaceIndex = scanScope?.surface ?? createSurfaceIndex()

      const mode: UxMode = args.mode === 'auto' || args.mode === 'review' || args.mode === 'interactive'
        ? args.mode
        : resolveMode({
          localRules: loadLocalRules(cwd),
          configured: config.mode,
          trigger: 'user',
        }).mode

      const dropped: ReportResult['dropped'] = []
      const merged = new Map<string, UxFinding>()
      const featureDigests = new Map<string, string>()

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
        const headline = draft.headline?.trim() ?? ''
        if (headline.length === 0) {
          dropped.push({ reason: '缺少 headline（一句话说清出了什么事）', rule: draft.rule, file: draft.file })
          continue
        }
        // 人话约束：写不出人话的 finding 宁可不报（v0.1.1 §9 风险表）。
        const codeSpeak = codeSpeakReason(draft.description ?? '')
        if (codeSpeak !== undefined) {
          dropped.push({
            reason: `${codeSpeak}——description 要写"用户会遇到什么"，不写"代码里缺什么"`,
            rule: draft.rule,
            file: draft.file,
          })
          continue
        }

        const file = draft.file.trim()
        const key = dedupeKey(draft.rule, file, draft.symbol)
        const existing = merged.get(key)
        if (existing !== undefined) {
          // 合并：persona_refs 取并集；impact 取更严重的一侧（high 优先）。
          existing.technical.persona_refs = [...new Set([...existing.technical.persona_refs, ...refs])]
          if (draft.impact === 'high' && existing.technical.severity.impact === 'low') {
            existing.technical.severity.impact = 'high'
          }
          // 人话层首条为准，只补空：先命中的画像已经把话说清楚了，不覆盖。
          const extra = draft.consequence?.trim() ?? ''
          if (existing.consequence === undefined && extra.length > 0) {
            existing.consequence = extra
          }
          continue
        }

        const category = draft.category === 'microcopy' || draft.category === 'state-coverage'
          || draft.category === 'theme-adaptation'
          ? draft.category
          : categoryOfRule(draft.rule)
        const impact: Impact = draft.impact === 'high' ? 'high' : 'low'
        const shares = refs.map((id) => shareById.get(id) ?? 0)
        const reach = reachOf(shares)
        const level = levelOf(impact, reach)
        const candidate = surfaceCandidatesFor(surfaceIndex, file)
        const surface = sanitizeSurface(draft.surface, {
          ...(candidate.route === undefined ? {} : { route: candidate.route }),
          ...(draft.symbol === undefined ? {} : { symbol: draft.symbol }),
        })
        const symbolPath = symbolPathOf(file, draft.symbol)
        const featureDigest = featureDigestOf(draft.feature, `${draft.rule}|${symbolPath}`)

        const finding: UxFinding = {
          id: '', // 定稿阶段统一编号
          fingerprint: fingerprintOf({ rule: draft.rule, symbolPath, featureDigest }),
          surface,
          human: {
            headline,
            description: draft.description.trim(),
            severity_label: severityLabel(level),
          },
          technical: {
            locator: {
              file,
              ...(draft.symbol === undefined ? {} : { symbol: draft.symbol }),
              ...(typeof draft.line === 'number' && Number.isSafeInteger(draft.line) ? { line: draft.line } : {}),
            },
            rule: draft.rule,
            category,
            verified_by: draft.verified_by === 'model+ast' || draft.verified_by === 'ast'
              ? draft.verified_by
              : 'model',
            evidence_level: 'static',
            persona_refs: refs,
            severity: {
              impact,
              impact_confidence: draft.impact_confidence === 'high' || draft.impact_confidence === 'low'
                ? draft.impact_confidence
                : 'medium',
              reach,
              level,
            },
            rationale: draft.rationale,
            suggestion: draft.suggestion,
          },
          status: 'pending',
        }
        merged.set(key, finding)
        featureDigests.set(finding.fingerprint, featureDigest)
      }

      // 超限丢弃（宁缺毋滥：报告体量受控）。
      const findings = [...merged.values()].sort(bySeverity)
      while (findings.length > config.maxFindings) {
        const overflow = findings.pop()
        if (overflow !== undefined) {
          dropped.push({
            reason: `超出单份报告上限（${config.maxFindings} 条），已按严重度裁剪`,
            rule: overflow.technical.rule,
            file: overflow.technical.locator.file,
          })
        }
      }
      findings.forEach((finding, index) => {
        finding.id = `UX-${String(index + 1).padStart(4, '0')}`
      })

      // ── 隐式确认：上一轮的问题这次还在不在（§6.3 的三种消失情形）──────────
      const comparable: ComparableFinding[] = findings.map((finding) =>
        comparableOf(finding, featureDigests.get(finding.fingerprint) ?? ''))
      const verdicts = reconcile(cwd, { scopeFiles: scope, current: comparable })
      const knownReports = new Set(agent.session.events
        .filter((event) => event.type === 'ux/report')
        .map((event) => event.data.reportId))
      for (const verdict of verdicts) {
        // 只对本会话见过的报告回写状态：卡片才有得刷新。
        if (!knownReports.has(verdict.entry.report_id)) continue
        agent.session.append('ux/finding-status', {
          reportId: verdict.entry.report_id,
          findingId: verdict.entry.finding_id,
          status: verdict.status,
        })
      }

      const reportId = mintReportId()
      agent.session.append('ux/report', { reportId, title: args.title, mode, scope, findings })

      // 账本按 finding id 索引特征摘要落盘（下一轮比对要用）。
      recordScan(cwd, {
        reportId,
        scope,
        findings,
        featureDigests: new Map(findings.map((finding) =>
          [finding.id, featureDigests.get(finding.fingerprint) ?? ''])),
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
        mode,
        scope,
        findings,
        dropped,
        implicit_confirmed: verdicts.filter((verdict) => verdict.status === 'confirmed_implicit').length,
        stale: verdicts.filter((verdict) => verdict.status === 'stale').length,
        glossary_terms: glossaryTerms,
        markdown: '',
      }
      result.markdown = renderReport(result, personaNames)
      return result
    },
  })
}
