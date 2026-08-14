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
import { extractCandidates } from './ast'
import { loadGlossary } from './glossary'
import { detectStack, gatherFiles, readSourceFile, suggestSourceRoots } from './project'
import type { StackKind } from './project'
import { RULES } from './rules'
import type { UxConfig } from './config'
import type { AstCandidate } from './ast'
import { extractVueCandidates } from './vue'

/** 单文件读取上限（防超大文件拖垮扫描）。 */
const MAX_FILE_BYTES = 512 * 1024

/** 候选总数上限（约束工具返回体量）。 */
const MAX_CANDIDATES_TOTAL = 200

export interface ScanResult {
  supported: boolean
  stack: string
  reason?: string
  focus?: string
  persona_id?: string
  files: Array<{ path: string; size: number }>
  file_count: number
  truncated: boolean
  candidates: AstCandidate[]
  glossary: Array<{ canonical: string; variants: string[]; note?: string }>
  guidance: string[]
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rule: { type: 'string', description: '规则 ID：R-01 … R-09' },
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
  if (!result.supported) {
    return [
      `【不支持的技术栈】${result.stack}`,
      result.reason ?? '当前版本支持 React（TypeScript / JavaScript）与 Vue 3。',
      '请明确告知用户不支持，不要给出低质量猜测。',
    ].join('\n')
  }
  const lines: string[] = []
  lines.push(`技术栈：${result.stack}；收集源文件 ${result.file_count} 个${result.truncated ? '（已达上限，范围请进一步收敛）' : ''}。`)
  const byRule = new Map<string, AstCandidate[]>()
  for (const candidate of result.candidates) {
    const list = byRule.get(candidate.rule) ?? []
    list.push(candidate)
    byRule.set(candidate.rule, list)
  }
  for (const rule of RULES.map((def) => def.id)) {
    const list = byRule.get(rule)
    if (list === undefined || list.length === 0) continue
    lines.push(`\n## ${rule} ${RULES.find((def) => def.id === rule)?.name ?? ''}（${list.length} 条候选）`)
    for (const candidate of list) {
      const where = `${candidate.file}${candidate.line === undefined ? '' : `:${candidate.line}`}`
        + (candidate.symbol === undefined ? '' : `（${candidate.symbol}）`)
      lines.push(`- [${candidate.verified_by}] ${where}\n  断言：${candidate.note}\n  片段：${candidate.snippet}`)
    }
  }
  if (result.candidates.length === 0) {
    lines.push('\n（本轮 AST 扫描未产生候选证据；模型仍可自行阅读代码发现语义问题。）')
  }
  if (result.glossary.length > 0) {
    lines.push(`\n## 既有术语表（.ux/glossary.yml，仅需对新增/变更术语做增量判断）`)
    for (const term of result.glossary) {
      lines.push(`- ${term.canonical}：${term.variants.join(' / ') || '（无变体）'}`)
    }
  }
  lines.push('\n## 后续步骤')
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
      const stack = detectStack(cwd)
      if (!stack.supported) {
        return {
          supported: false,
          stack: stack.stack,
          reason: stack.reason,
          files: [],
          file_count: 0,
          truncated: false,
          candidates: [],
          glossary: [],
          guidance: ['告知用户不支持的原因（spec 边界场景 9），不要给出低质量猜测。'],
        } satisfies ScanResult
      }
      const stackKind: StackKind = stack.kind ?? 'react-ts'
      const gathered = gatherFiles(cwd, args.paths ?? [], config.excludePatterns, config.maxScanFiles, stackKind)
      const options = {
        maxPerRule: config.maxCandidatesPerRule,
        maxPerFile: config.maxCandidatesPerFile,
      }
      const candidates: AstCandidate[] = []
      for (const file of gathered.files) {
        if (candidates.length >= MAX_CANDIDATES_TOTAL) break
        let source: string
        try {
          source = readSourceFile(cwd, file, MAX_FILE_BYTES)
        } catch {
          continue
        }
        // 按技术栈分派引擎：
        // - Vue SFC：SFC 拆分 + 模板 AST（script 块内部复用 TS 引擎）；
        // - Vue 项目的独立 .ts/.js 模块：按普通 TS 解析（无 JSX）；
        // - React 项目：统一 TSX 解析（.js 也可能含 JSX，TSX 是其超集）。
        let extracted: AstCandidate[]
        if (stackKind === 'vue' && file.path.endsWith('.vue')) {
          extracted = extractVueCandidates(file.path, source, options)
        } else if (stackKind === 'vue') {
          extracted = extractCandidates(file.path, source, options, ts.ScriptKind.TS)
        } else {
          extracted = extractCandidates(file.path, source, options, ts.ScriptKind.TSX)
        }
        candidates.push(...extracted.slice(0, MAX_CANDIDATES_TOTAL - candidates.length))
      }
      const glossary = loadGlossary(cwd).terms
      return {
        supported: true,
        stack: stack.stack,
        ...(args.focus === undefined ? {} : { focus: args.focus }),
        ...(args.persona_id === undefined ? {} : { persona_id: args.persona_id }),
        files: gathered.files,
        file_count: gathered.files.length,
        truncated: gathered.truncated,
        candidates,
        glossary,
        guidance: [
          '用 read 工具阅读候选的 file:line 片段核实断言；snippet 已附在候选上。',
          '按当前 persona 判定每条候选是否成立；AST 覆盖不到的语义问题（R-01 文案质量、R-03 是否真不可逆、R-02 同义判定）由你阅读代码后补充。',
          'R-09 候选已由 AST 求证（verified_by=ast），无需再核实颜色本身，直接采用。',
          '每条 finding 必须带 locator（file 必填，尽量带 symbol）；指不到位置的候选直接丢弃。',
          '每条 finding 还要写人话层：scene（在哪儿，如"管理员页面 · 用户列表"）、summary（发生了什么，一句话，不含文件名/规则 ID/代码术语）、'
            + 'consequence（对用户的后果）——卡片第一屏只给人看这三项，读者是产品/运营；rationale 与 suggestion 是折叠起来交给 AI 的技术细节。',
          '拿不准的候选宁可丢弃——"发现问题总数"不是目标，宁缺毋滥。',
          '本轮无 P0/P1 问题时才执行 R-02 术语检查（条件触发），只对新增/变更术语做增量判断。',
          '多 persona 走查时：换 persona_id 重复本工具独立走查，最后统一调用一次 ux_report 合并定稿。',
          `可选范围建议：${suggestSourceRoots(cwd).join(', ') || '（未发现常规源码目录）'}`,
        ],
      } satisfies ScanResult
    },
  })
}
