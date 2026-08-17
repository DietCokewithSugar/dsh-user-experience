/**
 * 端到端冒烟测试：在真实 dsh-session 的 Session 对象 + stub agent 上执行
 * 工具与命令，验证「扫描 → 定稿 → 会话事件 → 确认判定 → 隐式确认」全链路，
 * 逐条对应 v0.1.1 spec §8 的验收标准。
 *
 *   npx tsx scripts/e2e.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index'
import { writePersonas } from '../src/persona'
import { createUxCommand } from '../src/commands'
import { registerAutoScan } from '../src/auto-scan'
import { HISTORY_FILE } from '../src/history'
import { currentReport, resolveSelector } from '../src/judge-tool'
import { uxReportDefinition, normalizeFinding } from '../src/client/index'
import { UxReportNodeView } from '../src/client/report-view'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { deliveryPrompt, type UxFinding } from '../src/types'

let failures = 0
function check(label: string, actual: boolean, detail = ''): void {
  if (actual) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.error(`FAIL  ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

const TEST_CONFIG = {
  maxScanFiles: 300,
  maxCandidatesPerRule: 5,
  maxCandidatesPerFile: 25,
  maxFindings: 30,
  excludePatterns: [],
  mode: 'detect' as const,
  autoScan: true,
  autoScanEditTools: ['write', 'edit'],
  autoScanMaxFiles: 20,
  autoScanDebounceTurns: 1,
  outputLanguage: 'auto' as const,
}

interface StubAgent {
  id: string
  session: Session
  followup: (message: unknown) => void
  steer: (message: unknown) => void
}

const root = mkdtempSync(join(tmpdir(), 'dsh-ux-e2e-'))
try {
  // ── 项目夹具：React+TS 项目 + persona ────────────────────────────────────────
  mkdirSync(join(root, 'src', 'pages'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { react: '18.2.0' } }))
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  writeFileSync(join(root, 'src', 'routes.tsx'), `
import { OrderList } from './pages/Order'
export const routes = [{ path: '/orders', meta: { title: '订单页' }, component: OrderList }]
`)
  writeFileSync(join(root, 'src', 'pages', 'Order.tsx'), `
import { useState } from 'react'
export function OrderList() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const remove = async (id: string) => { await fetch('/api/orders/' + id, { method: 'DELETE' }); setOrders([]) }
  return (
    <div className="text-black">
      <h1>我的订单</h1>
      {loading ? <p>加载中</p> : orders.map((o) => <span>{o.name}</span>)}
      <button onClick={() => remove('1')}>确定</button>
    </div>
  )
}
`)
  writeFileSync(join(root, 'src', 'pages', 'order.css'), `
.toolbar {
  display: flex;
  gap: 4px;
  padding: 2px;
  margin: 3px 5px 7px 9px;
  row-gap: 11px;
  column-gap: 13px;
  padding-top: 15px;
}
.empty::before { content: "✨"; }
`)
  writePersonas(root, [{
    id: 'investor', name: '个人投资者', scenario: '下班后查看持仓', goals: ['快速确认盈亏'],
    capability: { tech_literacy: 'low', device: 'mobile', network: 'unstable', accessibility_needs: [] },
    key_paths: ['查看持仓'], share: 0.8,
  }, {
    id: 'ops', name: '运营人员', scenario: '批量处理订单', goals: ['批量删除'],
    capability: { tech_literacy: 'high', device: 'desktop', network: 'stable', accessibility_needs: [] },
    key_paths: ['订单处理'], share: 0.2,
  }])

  const session = Session.create(SessionId('e2e-session'), undefined, {
    version: 0, id: SessionId('e2e-session'), createdAt: Date.now(), cwd: root,
  })
  const steered: unknown[] = []
  const agent: StubAgent = {
    id: 'e2e-session',
    session,
    followup: () => {},
    steer: (m) => steered.push(m),
  }

  // ── 注册接线，取出工具定义 ────────────────────────────────────────────────────
  const tools: Array<Record<string, unknown>> = []
  const stubCtx = {
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    tools: { register: (tool: Record<string, unknown>) => tools.push(tool) },
    on: () => () => {},
  }
  apply(stubCtx as never, TEST_CONFIG)
  const byName = new Map(tools.map((tool) => [String(tool.name), tool]))
  const exec = (): { agent: StubAgent; signal: AbortSignal } => ({
    agent,
    signal: new AbortController().signal,
  })
  const run = async (name: string, args: unknown): Promise<Record<string, unknown>> =>
    (byName.get(name)?.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(args, exec())

  // ── 1. ux_scan：技术栈 + AST 候选 + 人话位置素材 ────────────────────────────
  console.log('ux_scan')
  const scanResult = await run('ux_scan', { paths: ['src'] })
  check('技术栈支持 React+TS', scanResult.supported === true, JSON.stringify(scanResult.stack))
  check('收集到源码与 CSS 文件', (scanResult.files as unknown[]).length === 3, JSON.stringify(scanResult.files))
  check('R-09 快车道候选（text-black 无 dark:）', (scanResult.candidates as Array<{ rule: string; verified_by: string }>).some((c) => c.rule === 'R-09' && c.verified_by === 'ast'))
  check('R-06 候选（remove 的 fetch 无 catch）', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-06'))
  check('R-05 候选（loading 有、empty 无）', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-05'))
  check('R-04 候选（remove 无确认）', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-04'))
  check('R-10 CSS/布局候选', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-10'))
  check('R-12 CSS Emoji 候选', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-12'))
  check('产品类型和对应走查重点进入扫描结果',
    scanResult.product_type === 'other' && (scanResult.review_focus as unknown[]).length > 0)
  check('Nielsen 十项原则进入走查上下文',
    (scanResult.heuristics as unknown[]).length === 10)
  check('高频问题检查顺序进入走查上下文',
    (scanResult.review_priority as unknown[]).length === 4)
  const hints = scanResult.surface_hints as Array<{ file: string; route?: string; routeTitle?: string; heading?: string }>
  const orderHint = hints.find((hint) => hint.file === 'src/pages/Order.tsx')
  check('surface 素材含路由标题与 h1',
    orderHint?.routeTitle === '订单页' && orderHint.heading === '我的订单', JSON.stringify(hints))
  check('surface 素材带路由路径兜底', orderHint?.route === '/orders', JSON.stringify(orderHint))

  // ── 1b. ux_scan：Vue 3 项目分派（SFC 模板 + script 复用 TS 引擎）───────────
  console.log('ux_scan（Vue 3）')
  const vueRoot = mkdtempSync(join(tmpdir(), 'dsh-ux-vue-'))
  try {
    mkdirSync(join(vueRoot, 'src', 'components'), { recursive: true })
    writeFileSync(join(vueRoot, 'package.json'), JSON.stringify({ name: 'demo-vue', dependencies: { vue: '3.5.0' } }))
    writeFileSync(join(vueRoot, 'src', 'components', 'List.vue'), `<script setup lang="ts">
import { ref } from 'vue'

const items = ref([])
async function remove(id: string) {
  await fetch('/api/items/' + id, { method: 'DELETE' })
}
</script>

<template>
  <div class="text-black">
    <h1>物料清单</h1>
    <button @click="remove('1')">删除</button>
    <p>{{ item.name }}</p>
  </div>
</template>
`)
    const vueSession = Session.create(SessionId('e2e-vue'), undefined, {
      version: 0, id: SessionId('e2e-vue'), createdAt: Date.now(), cwd: vueRoot,
    })
    const vueAgent: StubAgent = {
      id: 'e2e-vue', session: vueSession, followup: () => {}, steer: () => {},
    }
    const vueScanResult = await (byName.get('ux_scan')?.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(
      { paths: ['src'] }, { agent: vueAgent, signal: new AbortController().signal },
    )
    check('Vue 3 项目 supported', vueScanResult.supported === true && String(vueScanResult.stack).includes('Vue'), JSON.stringify(vueScanResult.stack))
    check('Vue 收集 .vue 文件', (vueScanResult.files as Array<{ path: string }>).some((f) => f.path.endsWith('.vue')), JSON.stringify(vueScanResult.files))
    check('Vue R-09 快车道候选（text-black 无 dark:）', (vueScanResult.candidates as Array<{ rule: string; verified_by: string; file: string }>).some((c) => c.rule === 'R-09' && c.verified_by === 'ast' && c.file === 'src/components/List.vue'))
    check('Vue script 块 R-06 候选（await 无 catch）', (vueScanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-06'))
    check('Vue 模板 R-04 候选（remove 无确认）', (vueScanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-04'))
    check('Vue 模板 R-08 候选（{{ item.name }}）', (vueScanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-08'))
    const vueHints = vueScanResult.surface_hints as Array<{ file: string; heading?: string }>
    check('Vue 模板 h1 进入 surface 素材',
      vueHints.some((hint) => hint.heading === '物料清单'), JSON.stringify(vueHints))
  } finally {
    rmSync(vueRoot, { recursive: true, force: true })
  }

  // ── 2. ux_report：定稿 + 矩阵 + 合并 + 三段式结构 ───────────────────────────
  console.log('ux_report')
  const reportResult = await run('ux_report', {
    title: '订单流程走查',
    language: 'zh-CN',
    product_type: 'internal-tool',
    persona_ids: ['investor', 'ops'],
    mode: 'review',
    findings: [
      {
        rule: 'R-09', category: 'theme-adaptation', persona_refs: ['investor', 'ops'],
        impact: 'high', verified_by: 'ast', file: 'src/pages/Order.tsx', symbol: 'OrderList',
        surface: '订单页', headline: '深色模式下订单页看不清',
        description: '手机开了深色模式后，订单页还是白底黑字，晚上看刺眼，部分文字几乎看不清。',
        feature: 'className text-black 无 dark 变体',
        rationale: 'R-09 / className 写死 text-black 无 dark: 变体', suggestion: '改为主题变量或增加 dark: 变体',
      },
      {
        rule: 'R-06', persona_refs: ['investor'], impact: 'high', verified_by: 'model+ast',
        file: 'src/pages/Order.tsx', symbol: 'OrderList',
        surface: '订单页', headline: '删除订单失败时没有任何提示',
        description: '点了删除以后，界面没有任何变化，用户分不清是删成功了还是网络断了，很可能重复点击。',
        feature: '删除订单 无失败反馈',
        rationale: 'remove 的 fetch 无 catch', suggestion: '补充失败提示',
      },
      // 同一 locator 同规则的第二条（来自另一个 persona）→ 应合并 persona_refs
      {
        rule: 'R-06', persona_refs: ['ops'], impact: 'low', verified_by: 'model+ast',
        file: 'src/pages/Order.tsx', symbol: 'OrderList',
        surface: '订单页', headline: '删除订单失败时没有任何提示',
        description: '批量处理时一条删除失败也看不出来，运营会以为全部删掉了。',
        rationale: 'remove 的 fetch 无 catch', suggestion: '补充失败提示',
      },
      // 无 locator → 必须丢弃
      {
        rule: 'R-01', persona_refs: ['investor'], impact: 'high', file: '',
        surface: '订单页', headline: 'x', description: '出错时用户不知道下一步该做什么', rationale: 'x', suggestion: 'y',
      },
      // 未知规则 → 丢弃
      {
        rule: 'R-99', persona_refs: ['investor'], impact: 'high', file: 'src/pages/Order.tsx',
        surface: '订单页', headline: 'x', description: '页面上看不到任何反馈', rationale: 'x', suggestion: 'y',
      },
      // 代码腔 description → 丢弃（写不出人话宁可不报）
      {
        rule: 'R-05', persona_refs: ['investor'], impact: 'low', file: 'src/pages/Order.tsx', symbol: 'OrderList',
        surface: '订单页', headline: '空列表没有兜底',
        description: 'OrderList 的条件渲染里缺少 empty state 分支',
        rationale: 'x', suggestion: 'y',
      },
      // surface 给了文件路径 → 净化为路由路径
      {
        rule: 'R-04', persona_refs: ['ops'], impact: 'low', file: 'src/pages/Order.tsx', symbol: 'OrderList',
        surface: 'src/pages/Order.tsx', headline: '删除前没有二次确认',
        description: '手滑点到删除就直接删了，没有再问一次，运营每天处理上百条很容易误删。',
        rationale: 'R-04', suggestion: '补充二次确认',
      },
      // R-10 只有 static 证据 → 视觉结论证据不足，必须丢弃
      {
        rule: 'R-10', persona_refs: ['ops'], impact: 'low', file: 'src/pages/order.css',
        surface: '订单页', headline: '操作区域显得拥挤',
        description: '多个操作紧挨在一起，用户很难快速区分主要操作与次要操作。',
        rationale: 'CSS 间距候选', suggestion: '重新检查操作分组',
        evidence_level: 'static',
      },
      // rendered 标签没有任何截图/DOM 引用 → 不能只升级标签
      {
        rule: 'R-13', persona_refs: ['investor'], impact: 'low', file: 'src/pages/Order.tsx',
        surface: '订单页', headline: '页面主要操作不清楚',
        description: '进入页面后同时看到多个操作，用户不能快速判断应该先做什么。',
        rationale: '首屏候选', suggestion: '检查主要操作层级',
        evidence_level: 'rendered',
      },
    ],
  })
  const reportFindings = reportResult.findings as UxFinding[]
  check('同 locator 同规则合并为一条', reportFindings.length === 3, JSON.stringify(reportFindings.map((f) => f.technical.rule)))
  const merged = reportFindings.find((f) => f.technical.rule === 'R-06')
  check('合并后 persona_refs 取并集', merged?.technical.persona_refs.length === 2, JSON.stringify(merged?.technical.persona_refs))
  const r09 = reportFindings.find((f) => f.technical.rule === 'R-09')
  check('R-09 全画像命中（share 1.0 → reach wide）', r09?.technical.severity.reach === 'wide' && r09.technical.severity.level === 'P0', JSON.stringify(r09?.technical.severity))
  check('严重度用人话标签', r09?.human.severity_label === '一级问题', String(r09?.human.severity_label))
  check('无 locator / 未知规则 / 代码腔 / 证据不足被丢弃', (reportResult.dropped as unknown[]).length === 5, JSON.stringify(reportResult.dropped))
  check('视觉规则没有 rendered 证据时不能定稿',
    (reportResult.dropped as Array<{ rule?: string; reason: string }>).some((item) =>
      item.rule === 'R-10' && item.reason.includes('rendered')))
  check('rendered/interactive 标签必须附带可复核证据',
    (reportResult.dropped as Array<{ rule?: string; reason: string }>).some((item) =>
      item.rule === 'R-13' && item.reason.includes('evidence_refs')))
  check('丢弃原因点名"写用户会遇到什么"', (reportResult.dropped as Array<{ reason: string }>).some((d) => d.reason.includes('用户会遇到什么')), JSON.stringify(reportResult.dropped))
  const sanitized = reportFindings.find((f) => f.technical.rule === 'R-04')
  check('surface 给文件路径时被净化为路由路径', sanitized?.surface === '/orders', String(sanitized?.surface))
  check('每条 finding 都有人话三件套', reportFindings.every((f) =>
    f.surface.length > 0 && f.human.headline.length > 0 && f.human.description.length > 0))
  check('每条 finding 都有指纹', reportFindings.every((f) => f.fingerprint.length === 16))
  check('初始状态全部 pending', reportFindings.every((f) => f.status === 'pending'))
  const handoffPrompt = deliveryPrompt(r09 as UxFinding)
  check('交付 Prompt 以现象和用户影响为核心',
    handoffPrompt.includes('观察到的现象：深色模式下订单页看不清')
    && handoffPrompt.includes('用户实际遇到的情况：手机开了深色模式后'))
  check('交付 Prompt 不泄漏局部代码推断出的具体改法',
    !handoffPrompt.includes('主题变量') && !handoffPrompt.includes('dark: 变体'), handoffPrompt)
  check('交付 Prompt 声明局部上下文边界并允许修改文案',
    handoffPrompt.includes('部分代码') && handoffPrompt.includes('可以直接修改文案'), handoffPrompt)
  const englishHandoff = deliveryPrompt(r09 as UxFinding, 'en')
  check('交付 Prompt 可输出英文',
    englishHandoff.includes('Observed behavior:') && englishHandoff.includes('complete project context'))
  check('报告含共性问题小节', String(reportResult.markdown).includes('共性问题'))
  check('报告记录产品类型与输出语言',
    reportResult.product_type === 'internal-tool' && reportResult.language === 'zh-CN')
  check('报告首屏用人话严重度而非 P0~P3', (() => {
    const markdown = String(reportResult.markdown)
    const heading = markdown.split('\n').filter((line) => line.startsWith('### '))
    return heading.length > 0 && heading.every((line) => !/P[0-3]/u.test(line)) && heading.some((line) => line.includes('一级问题'))
  })(), String(reportResult.markdown).split('\n').filter((l) => l.startsWith('### ')).join(' | '))
  check('报告不出现 judge 命令格式',
    !String(reportResult.markdown).includes('/ux judge') && !String(reportResult.markdown).includes('findingID'))
  check('review 模式给批量确认而非逐条', String(reportResult.markdown).includes('批量确认'))
  check('本次 scope 被记录（来自 ux_scan）', (reportResult.scope as string[]).includes('src/pages/Order.tsx'), JSON.stringify(reportResult.scope))
  check('账本已写出', existsSync(join(root, HISTORY_FILE)))

  // 会话事件落库
  const reportEvent = session.events.find((event) => event.type === 'ux/report')
  check('ux/report 事件写入会话日志', reportEvent !== undefined && reportEvent.data.findings.length === 3)
  check('ux/report 事件带 mode 与 scope',
    reportEvent?.type === 'ux/report' && reportEvent.data.mode === 'review' && reportEvent.data.scope.length > 0)

  // ── 3. ux_judge：自然语言判定，全程无 ID ────────────────────────────────────
  console.log('ux_judge（自然语言）')
  const judgeResult = await run('ux_judge', { targets: ['第 2 条'], verdict: 'rejected' })
  const secondId = reportFindings[1]?.id
  check('「第 2 条」命中第二条', (judgeResult.applied as Array<{ id: string }>)[0]?.id === secondId, JSON.stringify(judgeResult.applied))
  check('判定摘要不含任何 ID 参数格式',
    !String(judgeResult.summary).includes('ux-rpt-') && !String(judgeResult.summary).includes('UX-00'),
    String(judgeResult.summary))
  const statusEvent = session.events.find((event) => event.type === 'ux/finding-status')
  check('ux/finding-status 事件写入', statusEvent !== undefined
    && statusEvent.data.findingId === secondId && statusEvent.data.status === 'rejected',
  JSON.stringify(statusEvent?.data))

  const keywordResult = await run('ux_judge', { targets: ['深色'], verdict: 'confirmed' })
  check('关键词命中对应问题', (keywordResult.applied as Array<{ headline: string }>)[0]?.headline.includes('深色'), JSON.stringify(keywordResult.applied))
  check('确认后提示可复制交付 Prompt', String(keywordResult.summary).includes('复制给 AI 的任务 Prompt'))
  check('显式确认写入 confirmed_explicit', session.events.some((event) =>
    event.type === 'ux/finding-status' && event.data.status === 'confirmed_explicit'))
  // 批量选择器：只验证解析，不消耗待判定条目（后面的隐式确认要用）。
  const live = currentReport(session)
  const minorId = reportFindings.find((f) => f.technical.severity.level === 'P3')?.id
  check('「三级以下」批量选择器命中三级/四级问题',
    live !== undefined && JSON.stringify(resolveSelector(live, '三级以下')) === JSON.stringify([minorId]),
    JSON.stringify(live === undefined ? [] : resolveSelector(live, '三级以下')))
  check('「全部」批量选择器命中所有条目',
    live !== undefined && resolveSelector(live, '全部').length === reportFindings.length)
  check('英文 “below level three” 命中三级/四级问题',
    live !== undefined && JSON.stringify(resolveSelector(live, 'below level three')) === JSON.stringify([minorId]))
  check('英文 “item 2” 命中第二条',
    live !== undefined && resolveSelector(live, 'item 2')[0] === reportFindings[1]?.id)

  // ── 3b. /ux judge 脚本接口：卡片按钮的通道（显式 reportId + 逗号分隔批量）──
  console.log('/ux judge（脚本接口）')
  const command = createUxCommand('zh-CN')
  const judgedIds = reportFindings
    .filter((f) => f.technical.severity.level === 'P0')
    .map((f) => f.id)
  const batchResult = command.handler({
    commandId: null as never,
    agent: agent as never,
    rawInput: ` judge ${String(reportResult.report_id)} ${judgedIds.join(',')} confirmed`,
    signal: new AbortController().signal,
  } as CommandInvocation) as { kind: string; text: string }
  check('显式 reportId + 逗号分隔批量判定生效',
    batchResult.kind === 'success' && batchResult.text.includes(`${judgedIds.length} 条`), batchResult.text)
  const badArgs = command.handler({
    commandId: null as never,
    agent: agent as never,
    rawInput: ' judge',
    signal: new AbortController().signal,
  } as CommandInvocation) as { kind: string; text: string }
  check('判定接口的错误提示引导点按钮 / 说话，不给命令格式',
    badArgs.kind === 'error' && !badArgs.text.includes('<') && badArgs.text.includes('按钮'), badArgs.text)

  // ── 3c. 真实注册表契约：把命令喂给真的 CommandRuntime ──────────────────────
  //
  // v0.4.0 曾经用 `input: { hint: '' }` 表达"命令栏不给提示"，字符串断言全部
  // 通过，但真实注册表拒绝空 hint，插件 apply 第一行就抛，整个插件行起不来。
  // 这里不再用 stub：真的 boot 一个 cordis Context + CommandRuntime 注册一次，
  // 名称 / 描述 / handler / input 的完整契约由 Harness 自己来判。
  console.log('命令注册表契约（真实 CommandRuntime）')
  const registryCtx = new Context()
  registryCtx.plugin(CommandRuntime)
  await new Promise((resolve) => { setTimeout(resolve, 50) })
  let registrationError = ''
  try {
    registryCtx.commands.register(createUxCommand('zh-CN'))()
  } catch (error) {
    registrationError = error instanceof Error ? error.message : String(error)
  }
  check('createUxCommand() 能被真实 CommandRuntime 接受',
    registrationError === '', registrationError)
  check('空 hint 确实会被真实注册表拒绝（守卫本身有效）', (() => {
    try {
      registryCtx.commands.register({
        name: 'ux-probe',
        description: '守卫自检',
        input: { hint: '' },
        handler: () => ({ kind: 'success' as const }),
      })()
      return false
    } catch {
      return true
    }
  })())

  // ── 4. 隐式确认：问题被改掉后下一轮走查 ─────────────────────────────────────
  console.log('隐式确认')
  // 重新扫描同一范围，但这次只报一条（R-09 仍在），R-06 被"改掉"了。
  await run('ux_scan', { paths: ['src'] })
  const secondReport = await run('ux_report', {
    title: '订单流程复查',
    language: 'zh-CN',
    product_type: 'internal-tool',
    persona_ids: ['investor', 'ops'],
    mode: 'auto',
    findings: [{
      rule: 'R-09', category: 'theme-adaptation', persona_refs: ['investor', 'ops'],
      impact: 'high', verified_by: 'ast', file: 'src/pages/Order.tsx', symbol: 'OrderList',
      surface: '订单页', headline: '深色模式下订单页看不清',
      description: '手机开了深色模式后，订单页还是白底黑字，晚上看刺眼，部分文字几乎看不清。',
      feature: 'className text-black 无 dark 变体',
      rationale: 'R-09 / className 写死 text-black 无 dark: 变体', suggestion: '改为主题变量或增加 dark: 变体',
    }],
  })
  check('消失且位置被重新扫描 → 隐式确认', (secondReport.implicit_confirmed as number) >= 1, JSON.stringify(secondReport.implicit_confirmed))
  check('隐式确认回写到原报告的会话事件', session.events.some((event) =>
    event.type === 'ux/finding-status' && event.data.status === 'confirmed_implicit'))
  check('auto 模式不索要确认', !String(secondReport.markdown).includes('批量确认')
    && !String(secondReport.markdown).includes('逐条确认'), String(secondReport.markdown))
  check('auto 模式仍会为一级问题提示一句', String(secondReport.markdown).includes('一级 / 二级问题'))

  // ── 5. 用户侧命令不再发起走查，只引导自然语言 ────────────────────────────
  console.log('/ux 隐藏通道')
  const emptyRoot = mkdtempSync(join(tmpdir(), 'dsh-ux-empty-'))
  try {
    const emptySession = Session.create(SessionId('e2e-empty'), undefined, {
      version: 0, id: SessionId('e2e-empty'), createdAt: Date.now(), cwd: emptyRoot,
    })
    const emptyAgent: StubAgent = {
      id: 'e2e-empty', session: emptySession, followup: () => {}, steer: () => {},
    }
    const scanInvocation: CommandInvocation = {
      commandId: null as never,
      agent: emptyAgent as never,
      rawInput: ' scan',
      signal: new AbortController().signal,
    }
    const guided = command.handler(scanInvocation) as { kind: string; text: string }
    check('用户侧 /ux scan 不再拦截或启动走查', guided.kind === 'success')
    check('引导自然语言且不提 /ux init',
      guided.text.includes('自然语言') && !guided.text.includes('/ux init'), guided.text)
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }

  const help = command.handler({
    commandId: null as never, agent: agent as never, rawInput: '', signal: new AbortController().signal,
  } as CommandInvocation) as { text: string }
  check('/ux 空输入不含 judge、init、scan 与 ID 参数',
    !help.text.includes('judge') && !help.text.includes('init') && !help.text.includes('scan')
    && !help.text.includes('报告ID') && !help.text.includes('findingID'), help.text)

  // ── 6. /ux judge 的 latest 解析（不带报告 id 也能落到当前报告）──────────────
  const latestReport = currentReport(session)
  const latestResult = command.handler({
    commandId: null as never,
    agent: agent as never,
    rawInput: ` judge latest ${latestReport?.findings[0]?.id ?? ''} confirmed`,
    signal: new AbortController().signal,
  } as CommandInvocation) as { kind: string; text: string }
  check('latest 落到当前报告', latestResult.kind === 'success', latestResult.text)

  // ── 7. R7 自动走查：改动 → 回合收尾 → steer ─────────────────────────────────
  console.log('R7 自动走查')
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Handler[]>()
  const eventCtx = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => {}
    },
  }
  registerAutoScan(eventCtx as never, TEST_CONFIG)
  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) handler(...args)
  }
  const before = steered.length
  emit('tools/result',
    { name: 'edit', arguments: { file_path: join(root, 'src/pages/Order.tsx') }, agent },
    { isError: false, content: [] })
  emit('tools/result',
    { name: 'edit', arguments: { file_path: join(root, 'server/api/orders.ts') }, agent },
    { isError: false, content: [] })
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  check('前端改动触发自动走查', steered.length === before + 1, `steered=${steered.length}`)
  const steerText = ((steered.at(-1) as { content?: Array<{ text?: string }> })?.content?.[0]?.text) ?? ''
  check('走查范围是所属目录（完整组件/页面）', steerText.includes('"src/pages"'), steerText)
  check('纯后端改动不进范围', !steerText.includes('server/api'), steerText)
  check('R7 以 auto 模式且不打断用户', steerText.includes('"auto"') && steerText.includes('不要向用户提问'))
  emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  check('同一回合内不重复触发', steered.length === before + 1, `steered=${steered.length}`)

  const failedEditBefore = steered.length
  emit('tools/result',
    { name: 'edit', arguments: { file_path: join(root, 'src/pages/Other.tsx') }, agent },
    { isError: true, content: [], error: { name: 'x', code: 'y' } })
  emit('agent/turn-stopping', { agent, turn: 3, signal: new AbortController().signal })
  check('失败的编辑不触发走查', steered.length === failedEditBefore, `steered=${steered.length}`)

  // 关闭开关后不再触发
  mkdirSync(join(root, '.ux'), { recursive: true })
  writeFileSync(join(root, '.ux', 'rules.local.yml'), 'autoScan:\n  enabled: false\n')
  const disabledBefore = steered.length
  emit('tools/result',
    { name: 'write', arguments: { file_path: join(root, 'src/pages/Order.tsx') }, agent },
    { isError: false, content: [] })
  emit('agent/turn-stopping', { agent, turn: 5, signal: new AbortController().signal })
  check('rules.local.yml 可关闭自动走查', steered.length === disabledBefore, `steered=${steered.length}`)

  const draftRoot = mkdtempSync(join(tmpdir(), 'dsh-ux-draft-'))
  try {
    mkdirSync(join(draftRoot, 'src', 'pages'), { recursive: true })
    writeFileSync(join(draftRoot, 'package.json'), JSON.stringify({ name: 'draft-app', dependencies: { react: '18.2.0' } }))
    writeFileSync(join(draftRoot, 'src', 'pages', 'Home.tsx'), 'export function Home() { return <button>确定</button> }')
    const draftSession = Session.create(SessionId('e2e-draft'), undefined, {
      version: 0, id: SessionId('e2e-draft'), createdAt: Date.now(), cwd: draftRoot,
    })
    const draftSteered: unknown[] = []
    const draftAgent: StubAgent = {
      id: 'e2e-draft', session: draftSession, followup: () => {}, steer: (m) => draftSteered.push(m),
    }
    const draftHandlers = new Map<string, Handler[]>()
    const draftCtx = {
      on: (event: string, handler: Handler) => {
        draftHandlers.set(event, [...(draftHandlers.get(event) ?? []), handler])
        return () => {}
      },
    }
    registerAutoScan(draftCtx as never, TEST_CONFIG)
    const emitDraft = (event: string, ...args: unknown[]): void => {
      for (const handler of draftHandlers.get(event) ?? []) handler(...args)
    }
    emitDraft('tools/result',
      { name: 'edit', arguments: { file_path: join(draftRoot, 'src/pages/Home.tsx') }, agent: draftAgent },
      { isError: false, content: [] })
    emitDraft('agent/turn-stopping', { agent: draftAgent, turn: 1, signal: new AbortController().signal })
    const draftText = ((draftSteered.at(-1) as { content?: Array<{ text?: string }> })?.content?.[0]?.text) ?? ''
    check('无画像时自动走查仍触发', draftSteered.length === 1, `steered=${draftSteered.length}`)
    check('无画像时要求写入草稿且不提问',
      draftText.includes('status=draft') && draftText.includes('不要向用户提问'), draftText)
  } finally {
    rmSync(draftRoot, { recursive: true, force: true })
  }

  // ── 8. 客户端报告状态机（R4 重放核心）───────────────────────────────────────
  console.log('ConversationNodeDefinition（客户端状态机）')
  const reportEvents = session.events.filter((event) => event.type === 'ux/report' || event.type === 'ux/finding-status')
  check('match：ux/report → start', reportEvents.some((event) => uxReportDefinition.match(event)?.role === 'start'))
  check('match：ux/finding-status → update', reportEvents.some((event) => uxReportDefinition.match(event)?.role === 'update'))
  const startMatch = reportEvents.find((event) => uxReportDefinition.match(event)?.role === 'start')
  const updateMatch = reportEvents.find((event) => uxReportDefinition.match(event)?.role === 'update')
  if (startMatch !== undefined && startMatch.type === 'ux/report' && updateMatch !== undefined) {
    const matchStart = uxReportDefinition.match(startMatch)
    const startState = uxReportDefinition.start(
      { key: 'k', kind: 'ux-report', id: matchStart?.id ?? '', matches: [], start: undefined, state: undefined, current: new Map() },
      { event: startMatch, view: undefined, role: 'start', location: { kind: 'session' } },
      { previous: () => undefined },
    )
    check('start 构建初始状态（全部 pending）', startState.findings.every((f) => f.status === 'pending') && startState.findings.length === 3)
    check('start 携带运行模式', startState.mode === 'review', String(startState.mode))
    const updated = uxReportDefinition.update(
      { ...({} as never), state: startState },
      { event: updateMatch, view: undefined, role: 'update', location: { kind: 'session' } },
    )
    check('update 应用判定', updated.findings.some((f) => f.status !== 'pending'))
    const viewNode = uxReportDefinition.buildViewNode?.(
      { key: 'k', kind: 'ux-report', id: 'r', matches: [], start: undefined, state: updated, current: new Map() },
    )
    const viewData = (viewNode?.data ?? {}) as {
      mode: string
      language: string
      productType: string
      findings: Array<{
        status: string
        surface: string
        headline: string
        description: string
        technicalYaml: string
        deliveryPrompt: string
      }>
    }
    check('buildViewNode 输出渲染数据（含判定状态）', viewData.findings.some((f) => f.status !== 'pending'))
    check('节点 kind 为 ux-report', (viewNode as { kind?: string })?.kind === 'ux-report')
    check('卡片首屏字段不含文件路径 / 规则 ID / P0~P3', viewData.findings.every((f) => {
      const firstScreen = `${f.surface} ${f.headline} ${f.description}`
      return !firstScreen.includes('.tsx') && !/\bR-\d\d\b/u.test(firstScreen) && !/\bP[0-3]\b/u.test(firstScreen)
    }), JSON.stringify(viewData.findings.map((f) => `${f.surface}|${f.headline}`)))
    check('技术细节可整块复制（结构化 YAML）', viewData.findings.every((f) =>
      f.technicalYaml.includes('locator:') && f.technicalYaml.includes('rule:') && f.technicalYaml.includes('severity:')))
    check('卡片携带确认后可复制的现象导向 Prompt', viewData.findings.every((f) =>
      f.deliveryPrompt.includes('观察到的现象：')
      && f.deliveryPrompt.includes('不代表完整项目上下文')
      && !f.deliveryPrompt.includes('suggestion:')))
    const renderCard = (status: string, language = viewData.language): string => renderToStaticMarkup(createElement(
      UxReportNodeView as ComponentType<Record<string, unknown>>,
      {
        node: {
          data: {
            ...viewData,
            language,
            findings: viewData.findings.map((finding, index) =>
              index === 0 ? { ...finding, status } : finding),
          },
        },
        judge: async () => null,
      },
    ))
    check('未确认的问题不显示 AI 任务 Prompt 按钮',
      !renderCard('pending').includes('复制给 AI 的任务 Prompt'))
    check('用户显式确认后显示 AI 任务 Prompt 按钮',
      renderCard('confirmed_explicit').includes('复制给 AI 的任务 Prompt'))
    check('隐式确认代表已经改掉，不再显示修复 Prompt 按钮',
      !renderCard('confirmed_implicit').includes('复制给 AI 的任务 Prompt'))
    check('英文报告卡片使用英文操作文案',
      renderCard('confirmed_explicit', 'en').includes('Copy task Prompt for AI')
      && !renderCard('confirmed_explicit', 'en').includes('确认存在'))
    check('卡片带模式，review 才渲染批量条', viewData.mode === 'review')
  } else {
    check('存在 start/update 事件配对', false, JSON.stringify(reportEvents.map((e) => e.type)))
  }

  // v0.1 旧事件的兼容归一
  const legacy = normalizeFinding({
    id: 'UX-0001',
    rule: 'R-06',
    category: 'state-coverage',
    persona_refs: ['investor'],
    severity: { impact: 'high', reach: 'wide', level: 'P0' },
    evidence: { level: 'static', verified_by: 'model+ast', locator: { file: 'src/a.tsx', symbol: 'A' }, rationale: '旧依据' },
    suggestion: '旧建议',
    status: 'confirmed',
  })
  check('旧事件归一为三段式', legacy.human.headline === '旧依据' && legacy.technical.rule === 'R-06')
  check('旧事件的 surface 不退化为文件路径', !legacy.surface.includes('.tsx'), legacy.surface)
  check('旧状态映射到五态', legacy.status === 'confirmed_explicit')

  // ── 9. 真实证据引用满足门槛后，rendered / interactive finding 可以定稿 ─────
  console.log('多证据定稿')
  const evidenceReport = await run('ux_report', {
    title: '订单页视觉与流程复核',
    language: 'zh-CN',
    product_type: 'ecommerce',
    persona_ids: ['investor'],
    mode: 'review',
    scope_paths: ['src/pages/Order.tsx', 'src/pages/order.css'],
    findings: [{
      rule: 'R-12',
      persona_refs: ['investor'],
      impact: 'low',
      verified_by: 'model+browser',
      evidence_level: 'rendered',
      evidence_refs: ['screenshot: /orders at 390x844; emoji competes with the primary action'],
      file: 'src/pages/order.css',
      surface: '订单页',
      headline: '装饰符号抢占了主要操作的注意力',
      description: '进入订单页后，醒目的装饰符号比主要操作更先吸引注意，用户需要额外寻找下一步入口。',
      rationale: '移动端截图中装饰符号的视觉权重高于主要按钮',
      suggestion: '统一装饰元素与产品图标体系',
    }, {
      rule: 'R-14',
      persona_refs: ['investor'],
      impact: 'low',
      verified_by: 'model+browser',
      evidence_level: 'interactive',
      evidence_refs: ['task steps: orders → select → confirm → second confirm → result; repeated confirmation observed'],
      file: 'src/pages/Order.tsx',
      surface: '订单页',
      headline: '完成单次操作需要连续确认两次',
      description: '用户已经确认过操作对象后还会再次看到含义相同的确认步骤，完成任务需要重复判断。',
      rationale: '按个人投资者画像完成任务时记录到两个连续且含义相同的确认步骤',
      suggestion: '检查两次确认是否都承担必要的风险告知',
    }],
  })
  const evidenceFindings = evidenceReport.findings as UxFinding[]
  check('带截图引用的 R-12 可以作为 rendered finding 定稿',
    evidenceFindings.some((finding) =>
      finding.technical.rule === 'R-12'
      && finding.technical.evidence_level === 'rendered'
      && finding.technical.evidence_refs.length === 1))
  check('带 Persona 任务步骤的 R-14 可以作为 interactive finding 定稿',
    evidenceFindings.some((finding) =>
      finding.technical.rule === 'R-14'
      && finding.technical.evidence_level === 'interactive'
      && finding.technical.evidence_refs.length === 1))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
if (failures > 0) process.exitCode = 1
