/**
 * 端到端冒烟测试：在真实 dsh-session 的 Session 对象 + stub agent 上执行
 * 工具与命令，验证「扫描 → 定稿 → 会话事件 → 确认判定」全链路。
 *
 *   npx tsx scripts/e2e.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index'
import { writePersonas } from '../src/persona'
import { createUxCommand } from '../src/commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

let failures = 0
function check(label: string, actual: boolean, detail = ''): void {
  if (actual) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.error(`FAIL  ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

interface StubAgent {
  session: Session
  followup: (message: unknown) => void
}

const root = mkdtempSync(join(tmpdir(), 'dsh-ux-e2e-'))
try {
  // ── 项目夹具：React+TS 项目 + persona ────────────────────────────────────────
  mkdirSync(join(root, 'src', 'pages'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { react: '18.2.0' } }))
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  writeFileSync(join(root, 'src', 'pages', 'Order.tsx'), `
import { useState } from 'react'
export function OrderList() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const remove = async (id: string) => { await fetch('/api/orders/' + id, { method: 'DELETE' }); setOrders([]) }
  return (
    <div className="text-black">
      {loading ? <p>加载中</p> : orders.map((o) => <span>{o.name}</span>)}
      <button onClick={() => remove('1')}>确定</button>
    </div>
  )
}
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
  const followed: unknown[] = []
  const agent: StubAgent = { session, followup: (m) => followed.push(m) }

  // ── 注册接线，取出工具定义 ────────────────────────────────────────────────────
  const tools: Array<Record<string, unknown>> = []
  const stubCtx = {
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    tools: { register: (tool: Record<string, unknown>) => tools.push(tool) },
  }
  apply(stubCtx as never, {
    maxScanFiles: 300, maxCandidatesPerRule: 5, maxCandidatesPerFile: 25,
    maxFindings: 30, excludePatterns: [],
  })
  const byName = new Map(tools.map((tool) => [String(tool.name), tool]))
  const exec = (): { agent: StubAgent; signal: AbortSignal } => ({
    agent,
    signal: new AbortController().signal,
  })

  // ── 1. ux_scan：技术栈 + AST 候选 ───────────────────────────────────────────
  console.log('ux_scan')
  const scanTool = byName.get('ux_scan')
  const scanResult = await (scanTool?.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(
    { paths: ['src'] }, exec(),
  )
  check('技术栈支持 React+TS', scanResult.supported === true, JSON.stringify(scanResult.stack))
  check('收集到源文件', (scanResult.files as unknown[]).length === 1)
  check('R-09 快车道候选（text-black 无 dark:）', (scanResult.candidates as Array<{ rule: string; verified_by: string }>).some((c) => c.rule === 'R-09' && c.verified_by === 'ast'))
  check('R-06 候选（remove 的 fetch 无 catch）', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-06'))
  check('R-05 候选（loading 有、empty 无）', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-05'))
  check('R-04 候选（remove 无确认）', (scanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-04'))
  check('候选带 file locator', (scanResult.candidates as Array<{ file: string }>).every((c) => c.file === 'src/pages/Order.tsx'))

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
    <button @click="remove('1')">删除</button>
    <p>{{ item.name }}</p>
  </div>
</template>
`)
    const vueSession = Session.create(SessionId('e2e-vue'), undefined, {
      version: 0, id: SessionId('e2e-vue'), createdAt: Date.now(), cwd: vueRoot,
    })
    const vueAgent: StubAgent = { session: vueSession, followup: () => {} }
    const vueScanResult = await (scanTool?.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(
      { paths: ['src'] }, { agent: vueAgent, signal: new AbortController().signal },
    )
    check('Vue 3 项目 supported', vueScanResult.supported === true && String(vueScanResult.stack).includes('Vue'), JSON.stringify(vueScanResult.stack))
    check('Vue 收集 .vue 文件', (vueScanResult.files as Array<{ path: string }>).some((f) => f.path.endsWith('.vue')), JSON.stringify(vueScanResult.files))
    check('Vue R-09 快车道候选（text-black 无 dark:）', (vueScanResult.candidates as Array<{ rule: string; verified_by: string; file: string }>).some((c) => c.rule === 'R-09' && c.verified_by === 'ast' && c.file === 'src/components/List.vue'))
    check('Vue script 块 R-06 候选（await 无 catch）', (vueScanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-06'))
    check('Vue 模板 R-04 候选（remove 无确认）', (vueScanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-04'))
    check('Vue 模板 R-08 候选（{{ item.name }}）', (vueScanResult.candidates as Array<{ rule: string }>).some((c) => c.rule === 'R-08'))
  } finally {
    rmSync(vueRoot, { recursive: true, force: true })
  }

  // ── 2. ux_report：定稿 + 矩阵 + 合并 + 会话事件 ─────────────────────────────
  console.log('ux_report')
  const reportTool = byName.get('ux_report')
  const reportResult = await (reportTool?.execute as (args: unknown, exec: unknown) => Promise<Record<string, unknown>>)(
    {
      title: '订单流程走查',
      persona_ids: ['investor', 'ops'],
      findings: [
        {
          rule: 'R-09', category: 'theme-adaptation', persona_refs: ['investor', 'ops'],
          impact: 'high', verified_by: 'ast', file: 'src/pages/Order.tsx', symbol: 'OrderList',
          rationale: 'R-09 / className 写死 text-black 无 dark: 变体', suggestion: '改为主题变量或增加 dark: 变体',
        },
        {
          rule: 'R-06', persona_refs: ['investor'], impact: 'high', verified_by: 'model+ast',
          file: 'src/pages/Order.tsx', symbol: 'OrderList', rationale: 'remove 的 fetch 无 catch', suggestion: '补充失败提示',
        },
        // 同一 locator 同规则的第二条（来自另一个 persona）→ 应合并 persona_refs
        {
          rule: 'R-06', persona_refs: ['ops'], impact: 'low', verified_by: 'model+ast',
          file: 'src/pages/Order.tsx', symbol: 'OrderList', rationale: 'remove 的 fetch 无 catch', suggestion: '补充失败提示',
        },
        // 无 locator → 必须丢弃
        { rule: 'R-01', persona_refs: ['investor'], impact: 'high', file: '', rationale: 'x', suggestion: 'y' },
        // 未知规则 → 丢弃
        { rule: 'R-99', persona_refs: ['investor'], impact: 'high', file: 'src/pages/Order.tsx', rationale: 'x', suggestion: 'y' },
      ],
    },
    exec(),
  )
  const reportFindings = reportResult.findings as Array<{
    id: string; persona_refs: string[]; severity: { impact: string; reach: string; level: string }; status: string
  }>
  check('同 locator 同规则合并为一条', reportFindings.length === 2, JSON.stringify(reportFindings.map((f) => f.rule)))
  const merged = reportFindings.find((f) => f.rule === 'R-06')
  check('合并后 persona_refs 取并集', merged !== undefined && merged.persona_refs.length === 2, JSON.stringify(merged?.persona_refs))
  const r09 = reportFindings.find((f) => f.rule === 'R-09')
  check('R-09 全画像命中（share 1.0 → reach wide）', r09?.severity.reach === 'wide' && r09.severity.level === 'P0', JSON.stringify(r09?.severity))
  check('无 locator 与未知规则被丢弃', (reportResult.dropped as unknown[]).length === 2, JSON.stringify(reportResult.dropped))
  check('初始状态全部 pending', reportFindings.every((f) => f.status === 'pending'))
  check('报告含共性问题小节', String(reportResult.markdown).includes('共性问题'))
  check('报告标注 static 证据与视觉免责', String(reportResult.markdown).includes('static') && String(reportResult.markdown).includes('不覆盖视觉类问题'))
  check('报告含汇总（confirmed 0）', String(reportResult.markdown).includes('0 / 2'))

  // 会话事件落库
  const reportEvent = session.events.find((event) => event.type === 'ux/report')
  check('ux/report 事件写入会话日志', reportEvent !== undefined && reportEvent.data.findings.length === 2)

  // ── 3. /ux judge：确认判定写回 ──────────────────────────────────────────────
  console.log('/ux judge')
  const command = createUxCommand()
  const reportId = String(reportResult.report_id)
  const findingId = String(reportFindings[0]?.id)
  const invocation: CommandInvocation = {
    commandId: null as never, // 仅测试用：judge 路径不读 commandId
    agent: agent as never,
    rawInput: ` judge ${reportId} ${findingId} confirmed`,
    signal: new AbortController().signal,
  }
  const judgeResult = command.handler(invocation)
  check('judge 返回 success', judgeResult.kind === 'success')
  const statusEvent = session.events.find((event) => event.type === 'ux/finding-status')
  check('ux/finding-status 事件写入', statusEvent !== undefined
    && statusEvent.data.findingId === findingId && statusEvent.data.status === 'confirmed',
  JSON.stringify(statusEvent?.data))

  // ── 4. /ux scan 无 persona 时拦截（新建会话、空项目）────────────────────────
  console.log('/ux scan 守卫')
  const emptyRoot = mkdtempSync(join(tmpdir(), 'dsh-ux-empty-'))
  try {
    const emptySession = Session.create(SessionId('e2e-empty'), undefined, {
      version: 0, id: SessionId('e2e-empty'), createdAt: Date.now(), cwd: emptyRoot,
    })
    const emptyAgent: StubAgent = { session: emptySession, followup: () => {} }
    const scanInvocation: CommandInvocation = {
      commandId: null as never,
      agent: emptyAgent as never,
      rawInput: ' scan',
      signal: new AbortController().signal,
    }
    const blocked = command.handler(scanInvocation)
    check('无 persona 时 /ux scan 拒绝并提示先初始化', blocked.kind === 'error' && blocked.text.includes('/ux init'))
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }

  // ── 5. /ux init 已存在文件时直接加载不重复询问 ───────────────────────────────
  console.log('/ux init')
  const initInvocation: CommandInvocation = {
    commandId: null as never,
    agent: agent as never,
    rawInput: ' init',
    signal: new AbortController().signal,
  }
  const initResult = command.handler(initInvocation)
  check('已存在 persona 文件时直接加载（success 且无 followup）', initResult.kind === 'success' && followed.length === 0)
  check('init 输出包含已有画像', String((initResult as { text?: string }).text).includes('investor'))

  // ── 6. 客户端报告状态机（R4 重放核心）───────────────────────────────────────
  console.log('ConversationNodeDefinition（客户端状态机）')
  const { uxReportDefinition } = await import('../src/client/index')
  const reportEvents = session.events.filter((event) => event.type === 'ux/report' || event.type === 'ux/finding-status')
  const firstFindingId = reportEvents[0] !== undefined && reportEvents[0].type === 'ux/report'
    ? reportEvents[0].data.findings[0]?.id
    : undefined
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
    check('start 构建初始状态（全部 pending）', startState.findings.every((f) => f.status === 'pending') && startState.findings.length === 2)
    const updated = uxReportDefinition.update(
      { ...({} as never), state: startState },
      { event: updateMatch, view: undefined, role: 'update', location: { kind: 'session' } },
    )
    check('update 应用判定（confirmed）', updated.findings.some((f) => f.id === firstFindingId && f.status === 'confirmed'))
    const viewNode = uxReportDefinition.buildViewNode?.(
      { key: 'k', kind: 'ux-report', id: 'r', matches: [], start: undefined, state: updated, current: new Map() },
    )
    const viewData = (viewNode?.data ?? {}) as { findings: Array<{ status: string }> }
    check('buildViewNode 输出渲染数据（含确认状态）', viewData.findings.some((f) => f.status === 'confirmed'))
    check('节点 kind 为 ux-report', (viewNode as { kind?: string })?.kind === 'ux-report')
  } else {
    check('存在 start/update 事件配对', false, JSON.stringify(reportEvents.map((e) => e.type)))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
if (failures > 0) process.exitCode = 1
