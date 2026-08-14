/**
 * `ux_scan` 工具（spec §6 R3）：源码走查的第一阶段。
 *
 * 职责边界（模型判断为主、AST 求证为辅）：
 * - 校验技术栈（React + TypeScript / React + JavaScript / Vue 3；不支持时
 *   明确告知，不给低质量猜测）；
 * - 按给定范围收集源文件（范围建议由 R6 流程在调用前完成）；
 * - 按技术栈分派解析引擎（React 源码走 TypeScript 编译器 API；Vue SFC 走
 *   @vue/compiler-sfc + compiler-dom，script 块复用 TS 引擎），产出带
 *   locator 的结构化候选证据；
 * - 返回给模型：文件清单 + 候选 + 既有术语表 + 后续步骤指引。
 *
 * 工具**不做**语义判断、不直接产出 finding：模型读候选、核实代码、按 persona
 * 判定后经 `ux_report` 落定。R-09 候选为 AST 快车道结论（verified_by: ast）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import ts from 'typescript'
import { extractCssCandidates } from './css'
import { extractCandidates } from './ast'
import { isChinese, resolveOutputLanguage, type OutputLanguage } from './i18n'
import { loadGlossary } from './glossary'
import { detectStack, gatherFiles, gatherStyleFiles, readSourceFile, suggestSourceRoots } from './project'
import type { StackKind } from './project'
import { normalizeProductType, productReviewFocus, type ProductType } from './product'
import { RULES } from './rules'
import { rememberScope } from './scope'
import {
  collectSurfaceHints, collectVueSurfaceHints, createSurfaceIndex, surfaceCandidatesFor,
} from './surface'
import type { SurfaceHint } from './surface'
import { HUMAN_COPY_RULE } from './human-copy'
import type { UxConfig } from './config'
import type { AstCandidate } from './ast'
import { extractVueCandidates } from './vue'

/** 单文件读取上限（防超大文件拖垮扫描）。 */
const MAX_FILE_BYTES = 512 * 1024

/** 候选总数上限（约束工具返回体量）。 */
const MAX_CANDIDATES_TOTAL = 200

const RULE_NAME_EN: Record<string, string> = {
  'R-01': 'Error message has no next action',
  'R-02': 'Inconsistent terminology',
  'R-03': 'Generic copy for irreversible action',
  'R-04': 'Irreversible action has no confirmation',
  'R-05': 'Loading state has no empty state',
  'R-06': 'Success path has no error path',
  'R-07': 'Submit remains enabled while pending',
  'R-08': 'No fallback for long content',
  'R-09': 'Missing dark/light theme adaptation',
  'R-10': 'Crowded layout or unclear grouping',
  'R-11': 'Long list has no browsing controls',
  'R-12': 'Decorative elements conflict with visual language',
  'R-13': 'Page purpose or primary action is unclear',
  'R-14': 'Critical task contains redundant interaction',
}

export interface ScanResult {
  supported: boolean
  stack: string
  reason?: string
  focus?: string
  persona_id?: string
  language: OutputLanguage
  product_type: ProductType
  review_focus: readonly string[]
  files: Array<{ path: string; size: number }>
  file_count: number
  truncated: boolean
  candidates: AstCandidate[]
  /** 人话位置名素材：每条 finding 的 surface 由模型据此选用或拟名。 */
  surface_hints: SurfaceHint[]
  glossary: Array<{ canonical: string; variants: string[]; note?: string }>
  guidance: string[]
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rule: { type: 'string', description: '规则 ID：R-01 … R-14' },
    file: { type: 'string', description: '相对项目根的文件路径（locator）' },
    symbol: { type: 'string', description: '组件 / 符号级定位' },
    line: { type: 'number', description: '行号（可选）' },
    snippet: { type: 'string', description: '原文片段（供模型核实）' },
    note: { type: 'string', description: 'AST 结构断言说明' },
    verified_by: { type: 'string', description: 'model | model+ast | ast' },
  },
} as const

/** 渲染扫描结果（模型面向文本）。 */
function renderScanResult(result: ScanResult): string {
  const zh = isChinese(result.language)
  if (!result.supported) {
    return zh ? [
      `【不支持的技术栈】${result.stack}`,
      result.reason ?? '当前版本支持 React（TypeScript / JavaScript）与 Vue 3。',
      '请明确告知用户不支持，不要给出低质量猜测。',
    ].join('\n') : [
      `[Unsupported stack] ${result.stack}`,
      'This version supports React (TypeScript/JavaScript) and Vue 3.',
      'Explain the unsupported stack; do not guess at findings.',
    ].join('\n')
  }
  const lines: string[] = []
  lines.push(zh
    ? `技术栈：${result.stack}；收集源码/样式文件 ${result.file_count} 个${result.truncated ? '（已达上限，范围请进一步收敛）' : ''}。`
    : `Stack: ${result.stack}; collected ${result.file_count} source/style files${result.truncated ? ' (limit reached; narrow the scope)' : ''}.`)
  lines.push(`${zh ? '产品类型' : 'Product type'}: ${result.product_type}; `
    + `${zh ? '本类产品重点' : 'review focus'}: ${result.review_focus.join(zh ? '、' : ', ')}`)
  const byRule = new Map<string, AstCandidate[]>()
  for (const candidate of result.candidates) {
    const list = byRule.get(candidate.rule) ?? []
    list.push(candidate)
    byRule.set(candidate.rule, list)
  }
  for (const rule of RULES.map((def) => def.id)) {
    const list = byRule.get(rule)
    if (list === undefined || list.length === 0) continue
    const ruleName = zh ? RULES.find((def) => def.id === rule)?.name ?? '' : RULE_NAME_EN[rule] ?? ''
    lines.push(`\n## ${rule} ${ruleName} (${list.length})`)
    for (const candidate of list) {
      const where = `${candidate.file}${candidate.line === undefined ? '' : `:${candidate.line}`}`
        + (candidate.symbol === undefined ? '' : `（${candidate.symbol}）`)
      lines.push(zh
        ? `- [${candidate.verified_by}] ${where}\n  断言: ${candidate.note}\n  片段: ${candidate.snippet}`
        : `- [${candidate.verified_by}] ${where}\n  Evidence: inspect this candidate against ${ruleName}\n  Snippet: ${candidate.snippet}`)
    }
  }
  if (result.candidates.length === 0) {
    lines.push(zh
      ? '\n（本轮源码/CSS 扫描未产生候选证据；模型仍可阅读代码发现语义问题。）'
      : '\n(No source/CSS candidates were produced; inspect the scoped code for semantic issues.)')
  }
  if (result.surface_hints.length > 0) {
    lines.push(zh
      ? '\n## 页面位置素材'
      : '\n## Page-location hints')
    for (const hint of result.surface_hints) {
      const parts = [
        hint.routeTitle === undefined ? undefined : `路由标题「${hint.routeTitle}」`,
        hint.heading === undefined ? undefined : `页面 h1「${hint.heading}」`,
        hint.navText === undefined ? undefined : `导航文案「${hint.navText}」`,
        hint.route === undefined ? undefined : `路由 ${hint.route}`,
        hint.symbol === undefined ? undefined : `组件 ${hint.symbol}`,
      ].filter((part): part is string => part !== undefined)
      lines.push(`- ${hint.file}：${parts.join('｜') || '（无素材，请据页面内容拟名）'}`)
    }
  }
  if (result.glossary.length > 0) {
    lines.push(`\n## 既有术语表（.ux/glossary.yml，仅需对新增/变更术语做增量判断）`)
    for (const term of result.glossary) {
      lines.push(`- ${term.canonical}：${term.variants.join(' / ') || '（无变体）'}`)
    }
  }
  lines.push(zh ? '\n## 后续步骤' : '\n## Next steps')
  for (const line of result.guidance) lines.push(`- ${line}`)
  return lines.join('\n')
}

/** 注册 `ux_scan` 工具。 */
export function uxScanTool(config: UxConfig): ToolDefinition {
  return defineTool({
    name: 'ux_scan',
    description: [
      '对 React（TypeScript / JavaScript）与 Vue 3 源码做 UX 走查的结构化扫描（第一阶段：AST 求证候选证据，模型判断为主）。',
      '返回文件清单与带 locator 的候选证据，供你读码核实后按当前 persona 判定。',
      'R-09（深色模式）候选由 AST 直接求证（verified_by=ast）可直接采用；其余候选需核实。',
      '不支持的技术栈（Svelte / Vue 2 / 小程序等）会返回 supported=false，需明确告知用户不支持。',
      '扫描完成后阅读可疑代码、判定候选、补记语义问题，最后调用 ux_report 汇总定稿。',
    ].join(' '),
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '相对项目根的文件/目录列表（如 ["src/pages/Order"]）；缺省扫描 src。范围应由 R6 流程确认后给出。',
      },
      focus: {
        type: 'string',
        description: '本次走查的功能/页面/流程描述（辅助判定）',
      },
      persona_id: {
        type: 'string',
        description: '当前走查的 persona id；多 persona 时逐个画像调用本工具独立走查',
      },
      language: {
        type: 'string',
        description: '输出语言（zh-CN 或 en）；优先跟随当前用户语言，缺省按插件配置和项目 README 推断。',
      },
      product_type: {
        type: 'string',
        enum: ['consumer', 'enterprise', 'ecommerce', 'content', 'finance', 'healthcare', 'developer-tool', 'internal-tool', 'other'],
        description: '根据 README、路由和当前业务流程判断的产品类型。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          supported: { type: 'boolean' },
          stack: { type: 'string' },
          reason: { type: 'string' },
          focus: { type: 'string' },
          persona_id: { type: 'string' },
          language: { type: 'string' },
          product_type: { type: 'string' },
          review_focus: { type: 'array', items: { type: 'string' } },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { path: { type: 'string' }, size: { type: 'number' } },
            },
          },
          file_count: { type: 'number' },
          truncated: { type: 'boolean' },
          candidates: { type: 'array', items: CANDIDATE_SCHEMA },
          surface_hints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string' },
                route: { type: 'string' },
                routeTitle: { type: 'string' },
                heading: { type: 'string' },
                navText: { type: 'string' },
                symbol: { type: 'string' },
              },
            },
          },
          glossary: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                canonical: { type: 'string' },
                variants: { type: 'array', items: { type: 'string' } },
                note: { type: 'string' },
              },
            },
          },
          guidance: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderScanResult(value as ScanResult) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('ux_scan：需要 agent 上下文（应在 agent loop 中调用）')
      }
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        throw new Error('ux_scan：当前会话没有工作目录（cwd），无法定位项目')
      }
      const language = resolveOutputLanguage(cwd, config.outputLanguage, args.language)
      const productType = normalizeProductType(args.product_type)
      const reviewFocus = [...productReviewFocus(productType, language)]
      const stack = detectStack(cwd)
      if (!stack.supported) {
        return {
          supported: false,
          stack: stack.stack,
          reason: stack.reason,
          language,
          product_type: productType,
          review_focus: reviewFocus,
          files: [],
          file_count: 0,
          truncated: false,
          candidates: [],
          surface_hints: [],
          glossary: [],
          guidance: ['告知用户不支持的原因（spec 边界场景 9），不要给出低质量猜测。'],
        } satisfies ScanResult
      }
      const stackKind: StackKind = stack.kind ?? 'react-ts'
      const gathered = gatherFiles(cwd, args.paths ?? [], config.excludePatterns, config.maxScanFiles, stackKind)
      const styles = gatherStyleFiles(
        cwd,
        args.paths ?? [],
        config.excludePatterns,
        Math.max(1, Math.floor(config.maxScanFiles / 3)),
      )
      const options = {
        maxPerRule: config.maxCandidatesPerRule,
        maxPerFile: config.maxCandidatesPerFile,
      }
      const candidates: AstCandidate[] = []
      const surfaceIndex = createSurfaceIndex()
      for (const file of gathered.files) {
        let source: string
        try {
          source = readSourceFile(cwd, file, MAX_FILE_BYTES)
        } catch {
          continue
        }
        // 位置素材要覆盖全部文件（路由表往往不在候选文件里），候选提取才受上限约束。
        if (stackKind === 'vue' && file.path.endsWith('.vue')) {
          collectVueSurfaceHints(surfaceIndex, file.path, source)
        } else {
          collectSurfaceHints(surfaceIndex, file.path, source,
            stackKind === 'vue' ? ts.ScriptKind.TS : ts.ScriptKind.TSX)
        }
        if (candidates.length >= MAX_CANDIDATES_TOTAL) continue
        // 按技术栈分派引擎：
        // - Vue SFC：SFC 拆分 + 模板 AST（script 块内部复用 TS 引擎）；
        // - Vue 项目的独立 .ts/.js 模块：按普通 TS 解析（无 JSX）；
        // - React 项目：统一 TSX 解析（.js 也可能含 JSX，TSX 是其超集）。
        let extracted: AstCandidate[]
        if (stackKind === 'vue' && file.path.endsWith('.vue')) {
          extracted = extractVueCandidates(file.path, source, options)
          extracted.push(...extractCssCandidates(file.path, source, options))
        } else if (stackKind === 'vue') {
          extracted = extractCandidates(file.path, source, options, ts.ScriptKind.TS)
        } else {
          extracted = extractCandidates(file.path, source, options, ts.ScriptKind.TSX)
        }
        candidates.push(...extracted.slice(0, MAX_CANDIDATES_TOTAL - candidates.length))
      }
      for (const file of styles.files) {
        if (candidates.length >= MAX_CANDIDATES_TOTAL) break
        let source: string
        try {
          source = readSourceFile(cwd, file, MAX_FILE_BYTES)
        } catch {
          continue
        }
        const extracted = extractCssCandidates(file.path, source, options)
        candidates.push(...extracted.slice(0, MAX_CANDIDATES_TOTAL - candidates.length))
      }

      // 位置素材只对"本轮出了候选的文件"输出，避免把整份路由表倒给模型。
      const hintFiles = new Set(candidates.map((candidate) => candidate.file))
      const surfaceHints: SurfaceHint[] = [...hintFiles].map((file) => {
        const { candidates: _ordered, ...hint } = surfaceCandidatesFor(surfaceIndex, file)
        return hint satisfies SurfaceHint
      })

      // 记录本次范围：隐式确认要靠它区分「扫了没发现」与「根本没扫」。
      const allFiles = [...gathered.files, ...styles.files]
      rememberScope(agent.session.id, allFiles.map((file) => file.path), surfaceIndex)

      const glossary = loadGlossary(cwd).terms
      return {
        supported: true,
        stack: stack.stack,
        language,
        product_type: productType,
        review_focus: reviewFocus,
        ...(args.focus === undefined ? {} : { focus: args.focus }),
        ...(args.persona_id === undefined ? {} : { persona_id: args.persona_id }),
        files: allFiles,
        file_count: allFiles.length,
        truncated: gathered.truncated || styles.truncated,
        candidates,
        surface_hints: surfaceHints,
        glossary,
        guidance: (isChinese(language) ? [
          '用 read 工具阅读候选的 file:line 片段核实断言；snippet 已附在候选上。',
          '每条 finding 必须给开发者可理解的 surface（如"管理员页面"）：优先用 surface_hints 里的路由标题 / h1 / 导航文案，'
            + '都没有就据组件名与页面内容拟名；拟不出时用路由路径，不能用文件路径。',
          HUMAN_COPY_RULE,
          `按 ${productType} 产品重点（${reviewFocus.join('、')}）和当前 persona 判定，不套用统一的信息密度或流程标准。`,
          'CSS/布局、Emoji、标题缺失候选只是截图检查入口，不能直接定稿。',
          '如果浏览器/截图工具可用且项目能打开，检查相关路由与视口并记录截图/DOM/尺寸引用；否则保持 static。',
          '只有实际按 persona 完成关键任务并记录步骤，才能使用 interactive。',
          'R-10/R-12/R-13 至少需要 rendered；R-14 至少需要 interactive。证据不足时丢弃，不得升级标签。',
          'R-09 候选已由 AST 求证（verified_by=ast），无需再核实颜色本身，直接采用。',
          '每条 finding 必须带 locator（file 必填，尽量带 symbol）；指不到位置的候选直接丢弃。',
          '拿不准的候选宁可丢弃——"发现问题总数"不是目标，宁缺毋滥。',
          '本轮无一级 / 二级问题时才执行 R-02 术语检查（条件触发），只对新增/变更术语做增量判断。',
          '多 persona 走查时：换 persona_id 重复本工具独立走查，最后统一调用一次 ux_report 合并定稿。',
          `可选范围建议：${suggestSourceRoots(cwd).join(', ') || '（未发现常规源码目录）'}`,
        ] : [
          'Read each candidate at file:line and verify the attached source snippet.',
          'Use a developer-readable page/flow name for surface; use route/title/heading hints, never a file path.',
          `Judge candidates for the current persona and ${productType} product focus: ${reviewFocus.join(', ')}.`,
          'CSS/layout, Emoji, and missing-heading candidates are inspection leads, not final visual findings.',
          'When browser/screenshot tools and a runnable app are available, inspect the route and viewport and record screenshot/DOM/measurement references; otherwise remain static.',
          'Use interactive only after completing the persona task and recording the steps.',
          'R-10/R-12/R-13 require rendered evidence; R-14 requires interactive evidence. Drop findings that do not meet the evidence threshold.',
          'R-09 candidates are AST-verified and can be used as static findings.',
          'Every finding needs a file locator and persona_refs. Prefer precision over finding count.',
          `Suggested roots: ${suggestSourceRoots(cwd).join(', ') || '(none found)'}`,
        ]),
      } satisfies ScanResult
    },
  })
}
