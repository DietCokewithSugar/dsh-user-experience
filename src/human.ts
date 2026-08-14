/**
 * 人话层（spec §R4 问题卡片话术）：把技术判定翻译成非技术读者读得懂的说法。
 *
 * 卡片与报告的第一屏只回答两件事——**在哪儿**（scene）与**发生了什么**
 * （summary / consequence）；规则 ID、文件行号、AST 断言这些技术内容退到
 * 第二屏（卡片折叠区 / 报告子条目），供人工确认后一键交给 AI 修改。
 *
 * Host（Markdown 报告）与 Client（卡片）共用本模块，保证两处话术一致；
 * 模块只依赖纯数据（规则目录 + 类型），不碰 node 内建模块，可被 client
 * bundle 内联。
 */

import { RULE_BY_ID } from './rules'
import type { FindingCategory, SeverityLevel } from './types'

/** 一个严重度等级的人话说法。 */
export interface SeverityWording {
  /** 等级名（P0 → 一级问题）。 */
  name: string
  /** 一句话解释"这个等级意味着什么"（不含技术术语）。 */
  hint: string
}

/**
 * P0…P3 的人话说法。等级本身由 impact × reach 矩阵推导（spec §5.3），
 * 这里只负责把矩阵结论翻译成"挡不挡路、影响多少人"。
 */
export const SEVERITY_WORDING: Record<SeverityLevel, SeverityWording> = {
  P0: { name: '一级问题', hint: '大多数目标用户会被挡住，关键任务做不完' },
  P1: { name: '二级问题', hint: '部分目标用户会被挡住，关键任务做不完' },
  P2: { name: '三级问题', hint: '任务还能完成，但大多数目标用户体验受损' },
  P3: { name: '四级问题', hint: '任务还能完成，少数目标用户体验受损' },
}

/** 取严重度的人话说法；未知等级原样回显（老报告重放时的兜底）。 */
export function severityWording(level: string): SeverityWording {
  return SEVERITY_WORDING[level as SeverityLevel] ?? { name: level, hint: '' }
}

/** 问题分类的人话说法。 */
export const CATEGORY_WORDING: Record<FindingCategory, string> = {
  microcopy: '文案表述',
  'state-coverage': '状态覆盖',
  'theme-adaptation': '深色模式适配',
  'layout-density': '布局与信息密度',
  'navigation-guidance': '页面理解与操作指引',
  'interaction-flow': '交互流程',
  'information-architecture': '信息架构与导航',
  'form-flow': '表单与流程',
  consistency: '一致性',
  'edge-state': '边缘状态',
  'accessibility-performance': '基础可用性与性能',
}

/** 取分类的人话说法；未知分类原样回显。 */
export function categoryWording(category: string): string {
  return CATEGORY_WORDING[category as FindingCategory] ?? category
}

/** 规则名（R-04 → 不可逆操作缺二次确认）；未知规则原样回显。 */
export function ruleName(rule: string): string {
  return RULE_BY_ID.get(rule)?.name ?? rule
}

/** 规则的完整说法（R-04 不可逆操作缺二次确认），用于技术细节区。 */
export function ruleWording(rule: string): string {
  const name = RULE_BY_ID.get(rule)?.name
  return name === undefined ? rule : `${rule} ${name}`
}

/**
 * 场景兜底：模型漏填 scene、或重放缺少人话字段的老报告时，
 * 用 symbol（组件名）→ 文件名 → 目录名的顺序凑一个"在哪儿"。
 */
export function sceneFallback(file: string, symbol?: string): string {
  const named = symbol?.trim() ?? ''
  if (named.length > 0) return named
  const parts = file.split('/').filter((part) => part.length > 0)
  const base = parts[parts.length - 1] ?? file
  const stem = base.replace(/\.[^.]+$/u, '')
  // index.tsx / index.vue 这类入口文件，所在目录名更接近用户说的"页面"。
  if (/^index$/iu.test(stem)) return parts[parts.length - 2] ?? stem
  return stem.length > 0 ? stem : file
}

/** 摘要兜底：规则名 + 优化方向（仍比 AST 断言更接近人话）。 */
export function summaryFallback(rule: string, suggestion: string): string {
  const name = ruleName(rule)
  const advice = suggestion.trim()
  return advice.length > 0 ? `${name}：${advice}` : name
}

/** 交给 AI 的技术细节文本所需字段（UxFinding 与卡片视图都可适配）。 */
export interface HandoffFields {
  level: string
  scene: string
  summary: string
  consequence?: string
  rule: string
  category: string
  file: string
  symbol?: string
  line?: number
  rationale: string
  suggestion: string
  personaNames: readonly string[]
}

/** 定位串：`src/pages/Order.tsx:47（OrderList）`。 */
export function locatorText(file: string, symbol?: string, line?: number): string {
  return file
    + (line === undefined ? '' : `:${line}`)
    + (symbol === undefined || symbol.length === 0 ? '' : `（${symbol}）`)
}

/**
 * 单条问题的"复制给 AI"文本：人话结论在前，技术细节在后。
 * 人不需要读这段，它是给模型的输入。
 */
export function handoffText(finding: HandoffFields): string {
  const lines = [
    `【${severityWording(finding.level).name}】${finding.scene}`,
    `问题：${finding.summary}`,
  ]
  if (finding.consequence !== undefined && finding.consequence.length > 0) {
    lines.push(`影响：${finding.consequence}`)
  }
  if (finding.personaNames.length > 0) {
    lines.push(`涉及用户：${finding.personaNames.join('、')}`)
  }
  lines.push(
    `位置：${locatorText(finding.file, finding.symbol, finding.line)}`,
    `规则：${ruleWording(finding.rule)}（${categoryWording(finding.category)}）`,
    `判定依据：${finding.rationale}`,
    `修复方向：${finding.suggestion}`,
  )
  return lines.join('\n')
}

/** 整份报告的"复制给 AI"文本：带一句交付指令 + 逐条技术细节。 */
export function handoffBundle(
  title: string,
  reportId: string,
  findings: readonly HandoffFields[],
): string {
  const head = [
    `UX 走查报告：${title}（${reportId}）`,
    `以下 ${findings.length} 条问题待处理（已排除人工判定为「不是问题」的条目），请逐条按「修复方向」修改，`,
    '保持与现有代码风格一致，不要改动与问题无关的代码。',
    '',
  ].join('\n')
  const body = findings.map((finding, index) => `---- ${index + 1} ----\n${handoffText(finding)}`)
  return `${head}${body.join('\n\n')}`
}
