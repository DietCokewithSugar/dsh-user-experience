/**
 * 运行时冒烟测试（不依赖 DSH 框架的纯逻辑部分）：
 *
 *   npx tsx scripts/smoke.ts
 *
 * 覆盖：AST 候选引擎（9 条规则的代表性信号）、persona 文件读写往返、
 * glossary 增量合并、技术栈探测、严重度矩阵、插件 apply 注册接线。
 */

import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { extractCandidates } from '../src/ast'
import { buildAutoScanPrompt, isReviewableChange, relativizeChange, scanUnitsOf } from '../src/auto-scan'
import { extractVueCandidates } from '../src/vue'
import { featureDigestOf, fingerprintOf, isSameFinding, symbolPathOf } from '../src/fingerprint'
import { mergeGlossary, loadGlossary } from '../src/glossary'
import { comparableOf, HISTORY_FILE, metricsOf, recordScan, reconcile } from '../src/history'
import { codeSpeakReason } from '../src/human-copy'
import { loadLocalRules } from '../src/local-rules'
import { extractModeFlag, modeInstruction, resolveMode } from '../src/mode'
import { writePersonas, loadPersonas } from '../src/persona'
import { detectStack, gatherFiles } from '../src/project'
import {
  collectSurfaceHints, createSurfaceIndex, looksLikeFilePath, sanitizeSurface, surfaceCandidatesFor,
} from '../src/surface'
import { levelOf, reachOf, severityLabel } from '../src/types'
import type { UxFinding } from '../src/types'
import { apply, inject } from '../src/index'
import { RULES } from '../src/rules'

/** 测试用的完整插件配置（schema 默认值的等价物）。 */
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
}

let failures = 0
function check(label: string, actual: boolean, detail = ''): void {
  if (actual) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.error(`FAIL  ${label}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

// ── 1. AST 候选引擎 ────────────────────────────────────────────────────────────
console.log('AST 候选引擎')

const SAMPLE = `
import { useState } from 'react'
import { deleteItem } from './api'

export function PortfolioList() {
  const [items, setItems] = useState([])
  const [error, setError] = useState(null)
  const handleSubmit = async () => {
    await fetch('/api/save')
    setItems([])
  }
  const handleDelete = (id: string) => {
    deleteItem(id)
  }
  const load = async () => {
    try {
      await fetch('/api/list')
    } catch (e) {
      console.log('x')
    }
  }
  return (
    <div style={{ color: '#ffffff' }}>
      <h1 className="text-red-500 bg-white">持仓</h1>
      {items.length === 0 && <p>暂无数据</p>}
      {items.map((item) => <span>{item.name}</span>)}
      <button onClick={handleSubmit}>提交</button>
      <button onClick={() => handleDelete('1')}>删除</button>
    </div>
  )
}

export function AccountPage() {
  return <div className="text-slate-900">账户</div>
}

export function AccountPage2() {
  return <div>帐号设置</div>
}

export function Danger() {
  const clear = () => { clearAll() }
  if (!confirm('确定')) return
  return <button onClick={clear}>清空</button>
}
`

const candidates = extractCandidates('src/Portfolio.tsx', SAMPLE, { maxPerRule: 5, maxPerFile: 30 })
const byRule = new Map<string, number>()
for (const candidate of candidates) byRule.set(candidate.rule, (byRule.get(candidate.rule) ?? 0) + 1)

check('R-09 className 颜色类命中（text-red-500）', (byRule.get('R-09') ?? 0) >= 2, JSON.stringify(byRule))
check('R-09 style 硬编码色命中（#ffffff）', candidates.some((c) => c.rule === 'R-09' && c.note.includes('#ffffff')))
check('R-04 破坏性调用无确认命中（deleteItem，函数级判定）', candidates.some((c) => c.rule === 'R-04' && c.snippet.includes('deleteItem')))
check('R-04 同函数内有 confirm 的不误报（Danger 清空有确认）', !candidates.some((c) => c.rule === 'R-04' && (c.snippet.includes('clear') || c.snippet.includes('clearAll'))), candidates.filter((c) => c.rule === 'R-04').map((c) => c.snippet).join('|'))
check('R-06 await 无 catch 命中（handleSubmit）', candidates.some((c) => c.rule === 'R-06' && c.snippet.includes('await fetch')))
check('R-06 catch 无用户可见反馈命中（load）', candidates.some((c) => c.rule === 'R-06' && c.note.includes('catch 内未发现用户可见反馈')))
check('R-07 异步提交按钮无 disabled 命中', candidates.some((c) => c.rule === 'R-07' && c.snippet.includes('提交')))
check('R-08 直接渲染 item.name 命中', candidates.some((c) => c.rule === 'R-08' && c.snippet.includes('item.name')))
check('R-03 泛化确认文案命中（确定）', candidates.some((c) => c.rule === 'R-03' && c.note.includes('确定')))
check('R-02 术语候选提取（账户/帐号）', candidates.filter((c) => c.rule === 'R-02').some((c) => c.snippet.includes('账户') || c.snippet.includes('帐号')), candidates.filter((c) => c.rule === 'R-02').map((c) => c.snippet).join('|'))
check('R-05 有 loading 无 empty 的样本不误报（本样本有空态）', !candidates.some((c) => c.rule === 'R-05'), candidates.filter((c) => c.rule === 'R-05').map((c) => c.note).join('|'))
check('所有候选带 locator（file）', candidates.every((c) => c.file === 'src/Portfolio.tsx'))
check('R-09 候选 verified_by=ast', candidates.filter((c) => c.rule === 'R-09').every((c) => c.verified_by === 'ast'))

const SAMPLE_R05 = `
export function List() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  return (
    <div>
      {loading ? <p>加载中</p> : data.map((x) => <p>{x}</p>)}
    </div>
  )
}
`
const r05 = extractCandidates('src/List.tsx', SAMPLE_R05, { maxPerRule: 5, maxPerFile: 30 })
check('R-05 有 loading 无 empty 命中', r05.some((c) => c.rule === 'R-05'), JSON.stringify(r05.map((c) => c.rule)))

// ── 2. persona 文件读写 ────────────────────────────────────────────────────────
console.log('persona 读写')

const root = mkdtempSync(join(tmpdir(), 'dsh-ux-smoke-'))
try {
  check('空项目 loadPersonas 返回 undefined', loadPersonas(root) === undefined)
  const personas = [
    {
      id: 'novice-investor',
      name: '首次使用的个人投资者',
      scenario: '下班后用手机快速查看持仓',
      goals: ['快速确认盈亏'],
      capability: { tech_literacy: 'low', device: 'mobile', network: 'unstable', accessibility_needs: [] },
      key_paths: ['登录', '查看持仓'],
      share: 0.7,
    },
    {
      id: 'ops-staff',
      name: '后台运营',
      scenario: '批量处理记录',
      goals: ['批量删除'],
      capability: { tech_literacy: 'high', device: 'desktop', network: 'stable', accessibility_needs: [] },
      key_paths: ['批量操作'],
      share: 0.3,
    },
  ] as const
  const written = writePersonas(root, personas)
  check('writePersonas 落盘条数', written.length === 2)
  const loaded = loadPersonas(root)
  check('loadPersonas 往返一致', loaded !== undefined && loaded.length === 2 && loaded[0]?.id === 'novice-investor')

  // ── 3. 严重度矩阵 ──────────────────────────────────────────────────────────
  console.log('严重度矩阵')
  check('high+wide → P0', levelOf('high', 'wide') === 'P0')
  check('high+narrow → P1', levelOf('high', 'narrow') === 'P1')
  check('low+wide → P2', levelOf('low', 'wide') === 'P2')
  check('low+narrow → P3', levelOf('low', 'narrow') === 'P3')
  check('share 之和 >=0.5 → wide', reachOf([0.7]) === 'wide')
  check('share 之和 <0.5 → narrow', reachOf([0.3]) === 'narrow')
  check('多 persona share 之和推导 reach', reachOf([0.3, 0.3]) === 'wide')

  // ── 4. glossary 增量合并 ────────────────────────────────────────────────────
  console.log('glossary')
  mergeGlossary(root, [{ canonical: '账户', variants: ['帐号'] }])
  mergeGlossary(root, [{ canonical: '账户', variants: ['用户'] }, { canonical: '持仓', variants: [] }])
  const glossary = loadGlossary(root)
  check('同 canonical 合并变体并集', glossary.terms.some((t) => t.canonical === '账户' && t.variants.includes('帐号') && t.variants.includes('用户')))
  check('新 canonical 追加', glossary.terms.length === 2)

  // ── 5. 技术栈探测与文件收集 ─────────────────────────────────────────────────
  console.log('项目探测')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { react: '18' } }))
  writeFileSync(join(root, 'tsconfig.json'), '{}')
  const reactTsStack = detectStack(root)
  check('React+TS 项目 supported 且 kind=react-ts', reactTsStack.supported === true && reactTsStack.kind === 'react-ts', JSON.stringify(reactTsStack))
  const gathered = gatherFiles(root, ['src'], [], 100, 'react-ts')
  check('无 src 目录时收集为空', gathered.files.length === 0)

  // React + JavaScript：react 依赖、无 tsconfig、有 .jsx 源文件。
  rmSync(join(root, 'tsconfig.json'), { force: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { react: '18' } }))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'App.jsx'), `
export function App() {
  return <div className="text-red-500 bg-white">持仓</div>
}
`)
  writeFileSync(join(root, 'src', 'types.d.ts'), 'export interface X { a: number }\n')
  const reactJsStack = detectStack(root)
  check('React+JS 项目 supported 且 kind=react-js', reactJsStack.supported === true && reactJsStack.kind === 'react-js', JSON.stringify(reactJsStack))
  const jsxGathered = gatherFiles(root, ['src'], [], 100, 'react-js')
  check('.jsx 文件被收集（React+JS）', jsxGathered.files.length === 1 && jsxGathered.files[0]?.path === 'src/App.jsx', JSON.stringify(jsxGathered.files))
  check('.d.ts 被跳过（React+JS）', !jsxGathered.files.some((f) => f.path.endsWith('.d.ts')))
  const jsxCandidates = extractCandidates('src/App.jsx', readFileSync(join(root, 'src', 'App.jsx'), 'utf8'), { maxPerRule: 5, maxPerFile: 30 }, ts.ScriptKind.TSX)
  check('.jsx 引擎提取 R-09（text-red-500 无 dark:）', jsxCandidates.some((c) => c.rule === 'R-09' && c.verified_by === 'ast'), JSON.stringify(jsxCandidates.map((c) => c.rule)))

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { vue: '3.5.0' } }))
  const vueStack = detectStack(root)
  check('Vue 3 项目 supported 且 kind=vue', vueStack.supported === true && vueStack.kind === 'vue', JSON.stringify(vueStack))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { vue: '2.7.16' } }))
  const vue2Stack = detectStack(root)
  check('Vue 2 项目明确不支持', vue2Stack.supported === false && vue2Stack.stack.includes('Vue 2'), JSON.stringify(vue2Stack))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { vue: '3.5.0' } }))

  // ── 5b. Vue SFC 引擎 ─────────────────────────────────────────────────────────
  console.log('Vue SFC 引擎')
  const VUE_SFC = `<script setup lang="ts">
import { ref } from 'vue'

const items = ref<string[]>([])
const loading = ref(true)
const error = ref('')

async function removeItem(id: string) {
  await fetch('/api/items/' + id, { method: 'DELETE' })
  items.value = []
}

function load() {
  fetch('/api/list').catch(() => {
    console.log('x')
  })
}

function confirmRemove() {
  Modal.confirm('确定')
}
</script>

<template>
  <div>
    <h1 class="text-red-500 bg-white">持仓</h1>
    <p>账户信息</p>
    <span>帐号设置</span>
    <div v-if="error" class="error-tip">加载失败</div>
    <div v-if="loading">加载中</div>
    <ul>
      <li v-for="item in items" :key="item.id">{{ item.name }}</li>
    </ul>
    <a-popconfirm title="确定" ok-text="确定">
      <button @click="removeItem('1')">删除</button>
    </a-popconfirm>
    <button class="submit-btn" @click="clearAll()">清空</button>
    <button @click="save">保存</button>
    <div :class="isDark ? 'text-black' : 'bg-white'">状态</div>
    <div :style="{ color: '#ffffff' }">持仓</div>
  </div>
</template>
`
  writeFileSync(join(root, 'src', 'OrderList.vue'), VUE_SFC)
  const vueGathered = gatherFiles(root, ['src'], [], 100, 'vue')
  check('Vue 栈收集 .vue 文件', vueGathered.files.some((f) => f.path.endsWith('.vue')), JSON.stringify(vueGathered.files))
  const vueCandidates = extractVueCandidates('src/OrderList.vue', VUE_SFC, { maxPerRule: 5, maxPerFile: 30 })
  const vueByRule = new Map<string, number>()
  for (const candidate of vueCandidates) vueByRule.set(candidate.rule, (vueByRule.get(candidate.rule) ?? 0) + 1)
  const fileLines = VUE_SFC.split('\n').length
  const lineOfText = (text: string): number => VUE_SFC.split('\n').findIndex((line) => line.includes(text)) + 1
  const rulesHit = [...vueByRule.keys()].sort()
  check('Vue SFC 覆盖全部 9 条规则', JSON.stringify(rulesHit) === JSON.stringify(['R-01', 'R-02', 'R-03', 'R-04', 'R-05', 'R-06', 'R-07', 'R-08', 'R-09']), JSON.stringify(rulesHit))
  check('R-09 全部 verified_by=ast（class/:class/:style）', vueCandidates.filter((c) => c.rule === 'R-09').length >= 3 && vueCandidates.filter((c) => c.rule === 'R-09').every((c) => c.verified_by === 'ast'), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-09')))
  check('R-04 确认上下文内的删除按钮不误报（a-popconfirm 包裹）', !vueCandidates.some((c) => c.rule === 'R-04' && c.snippet.includes('removeItem')), vueCandidates.filter((c) => c.rule === 'R-04').map((c) => c.snippet).join('|'))
  check('R-04 无确认的清空按钮命中', vueCandidates.some((c) => c.rule === 'R-04' && c.snippet.includes('clearAll')), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-04')))
  check('R-05 有 loading 无 empty 命中（模板级）', vueCandidates.some((c) => c.rule === 'R-05'), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-05').map((c) => c.note)))
  check('R-06 script 块 await 无 catch 命中', vueCandidates.some((c) => c.rule === 'R-06' && c.snippet.includes('await fetch')), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-06').map((c) => c.snippet)))
  check('R-07 提交按钮无 pending 锁定命中', vueCandidates.filter((c) => c.rule === 'R-07').length >= 2, JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-07').map((c) => c.snippet)))
  check('R-08 插值直接渲染 item.name 命中', vueCandidates.some((c) => c.rule === 'R-08' && c.snippet.includes('item.name')), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-08')))
  check('R-01 错误分支无行动指引命中（加载失败）', vueCandidates.some((c) => c.rule === 'R-01' && c.snippet.includes('加载失败')), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-01').map((c) => c.snippet)))
  check('R-03 泛化确认文案命中（popconfirm + Modal.confirm）', (vueByRule.get('R-03') ?? 0) >= 2, JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-03').map((c) => c.snippet)))
  check('R-02 术语候选提取（账户/帐号）', vueCandidates.filter((c) => c.rule === 'R-02').some((c) => c.snippet.includes('账户') || c.snippet.includes('帐号')), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-02').map((c) => c.snippet)))
  // 行号平移：script 候选与 template 候选都指向整个 .vue 文件的真实行。
  check('template 候选行号平移到文件行（text-red-500）', vueCandidates.some((c) => c.rule === 'R-09' && c.line === lineOfText('text-red-500')), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-09').map((c) => `${c.line}:${c.snippet}`)))
  check('script 候选行号平移到文件行（await fetch）', vueCandidates.some((c) => c.rule === 'R-06' && c.line === lineOfText("await fetch('/api/items/")), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-06').map((c) => `${c.line}:${c.snippet}`)))
  check('所有候选行号不越界', vueCandidates.every((c) => c.line === undefined || (c.line >= 1 && c.line <= fileLines)), JSON.stringify(vueCandidates.filter((c) => c.line !== undefined && c.line > fileLines)))
  check('template 候选 symbol = 组件名', vueCandidates.filter((c) => c.rule === 'R-09').every((c) => c.symbol === 'OrderList'), JSON.stringify(vueCandidates.filter((c) => c.rule === 'R-09').map((c) => c.symbol)))
  check('所有候选带 file locator', vueCandidates.every((c) => c.file === 'src/OrderList.vue'))

  // ── 5c. 人话层（卡片第一屏话术 + 交给 AI 的技术细节）─────────────────────────
  console.log('人话层')
  check('P0 → 一级问题', severityWording('P0').name === '一级问题' && severityWording('P0').hint.length > 0)
  check('P3 → 四级问题', severityWording('P3').name === '四级问题')
  check('未知等级原样回显', severityWording('P9').name === 'P9')
  check('分类中文化', categoryWording('state-coverage') === '状态覆盖' && categoryWording('microcopy') === '文案表述')
  check('规则完整说法', ruleWording('R-04') === 'R-04 不可逆操作缺二次确认')
  check('scene 兜底优先取组件名', sceneFallback('src/pages/Order.tsx', 'OrderList') === 'OrderList')
  check('scene 兜底退到文件名', sceneFallback('src/pages/Order.tsx') === 'Order')
  check('scene 兜底：index 入口取目录名', sceneFallback('src/pages/Admin/index.tsx') === 'Admin')
  check('summary 兜底 = 规则名 + 建议', summaryFallback('R-04', '删除前加二次确认') === '不可逆操作缺二次确认：删除前加二次确认')
  const handoffFields = {
    level: 'P0', scene: '管理员页面 · 用户列表', summary: '删除用户没有二次确认，点一下就直接删掉了',
    consequence: '误删后找不回来', rule: 'R-04', category: 'state-coverage',
    file: 'src/pages/Admin/UserList.tsx', symbol: 'UserList', line: 42,
    rationale: 'remove 调用路径上不存在确认交互节点', suggestion: '删除前增加二次确认',
    personaNames: ['运营人员'],
  }
  const handoff = handoffText(handoffFields)
  check('复制给 AI：人话结论在前', handoff.startsWith('【一级问题】管理员页面 · 用户列表'), handoff.split('\n')[0])
  check('复制给 AI：带定位与技术细节', handoff.includes('src/pages/Admin/UserList.tsx:42（UserList）')
    && handoff.includes('R-04 不可逆操作缺二次确认（状态覆盖）')
    && handoff.includes('判定依据：') && handoff.includes('修复方向：'), handoff)
  const bundle = handoffBundle('订单流程走查', 'ux-rpt-1', [handoffFields, handoffFields])
  check('复制全部：带报告抬头与逐条编号', bundle.includes('UX 走查报告：订单流程走查（ux-rpt-1）')
    && bundle.includes('---- 1 ----') && bundle.includes('---- 2 ----'), bundle.slice(0, 120))

  // ── 6. 规则目录完整性 ────────────────────────────────────────────────────────
  console.log('规则目录')
  check('9 条规则齐全', RULES.length === 9)
  check('R-09 为快车道规则', RULES.find((r) => r.id === 'R-09')?.fastLane === true)
  check('R-02 为条件触发规则', RULES.find((r) => r.id === 'R-02')?.conditional === true)

  // ── 7. apply 注册接线（stub 服务）───────────────────────────────────────────
  console.log('apply 接线')
  const commands: unknown[] = []
  const sections: unknown[] = []
  const tools: unknown[] = []
  const listeners: string[] = []
  const stubCtx = {
    commands: { register: (def: unknown) => commands.push(def) },
    systemPrompt: { section: (sec: unknown) => sections.push(sec) },
    tools: { register: (tool: unknown) => tools.push(tool) },
    on: (event: string) => { listeners.push(event) },
  }
  apply(stubCtx as never, TEST_CONFIG)
  check('注册 /ux 命令', commands.length === 1)
  check('注册 ux:personas 提示词段', sections.length === 1)
  check('注册 4 个模型工具', tools.length === 4)
  check('工具名 = ux_scan / ux_report / ux_judge / ux_personas_write', tools.every((t) => {
    const name = (t as { name?: string }).name
    return name === 'ux_scan' || name === 'ux_report' || name === 'ux_judge' || name === 'ux_personas_write'
  }))
  check('R7 监听 tools/result 与 agent/turn-stopping',
    listeners.includes('tools/result') && listeners.includes('agent/turn-stopping'),
    listeners.join(','))
  check('/ux 的 hint 不含报告 ID / findingID 参数格式', (() => {
    const definition = commands[0] as { input?: { hint?: string }; description?: string }
    const text = `${definition.input?.hint ?? ''} ${definition.description ?? ''}`
    return !text.includes('报告ID') && !text.includes('findingID') && !text.includes('judge')
  })())
  check('依赖注入声明 = tools/commands/systemPrompt', inject.join(',') === 'tools,commands,systemPrompt')

  // ── 8. 运行模式与场景自动选择（v0.1.1 §4.2）──────────────────────────────────
  console.log('运行模式')
  check('显式 --mode 优先级最高', resolveMode({
    explicit: 'interactive', localRules: { mode: 'auto' }, configured: 'review',
    trigger: 'auto-scan', env: { CI: '1' },
  }).mode === 'interactive')
  check('rules.local.yml 次之', resolveMode({
    localRules: { mode: 'interactive' }, configured: 'review', trigger: 'user', env: {},
  }).mode === 'interactive')
  check('插件配置再次之', resolveMode({ configured: 'auto', trigger: 'user', env: {} }).mode === 'auto')
  check('CI 环境自动 auto', resolveMode({ configured: 'detect', trigger: 'user', env: { CI: 'true' } }).mode === 'auto')
  check('CI=0 不算 CI', resolveMode({ configured: 'detect', trigger: 'user', env: { CI: '0' } }).mode === 'review')
  check('R7 触发自动 auto', resolveMode({ configured: 'detect', trigger: 'auto-scan', env: {} }).mode === 'auto')
  check('用户发起默认 review', resolveMode({ configured: 'detect', trigger: 'user', env: {} }).mode === 'review')
  check('auto 模式提示词不索要确认、只在一级/二级问题时提示一句',
    modeInstruction('auto').includes('不要向用户索要确认')
    && modeInstruction('auto').includes('一级 / 二级问题')
    && !modeInstruction('auto').includes('逐条与用户确认'),
    modeInstruction('auto'))
  check('review 模式提示词给批量确认而非逐条打断',
    modeInstruction('review').includes('批量确认') && modeInstruction('review').includes('不要逐条打断'))
  const flag = extractModeFlag('订单流程 --mode=auto')
  check('--mode 解析并剥离', flag.mode === 'auto' && flag.rest === '订单流程', JSON.stringify(flag))
  const spaced = extractModeFlag('--mode review 首页')
  check('--mode <值> 空格形式也解析', spaced.mode === 'review' && spaced.rest === '首页', JSON.stringify(spaced))

  // ── 9. 人话文案与 surface 净化（v0.1.1 §3.4 / §3.5）─────────────────────────
  console.log('人话文案与 surface')
  check('严重度人话标签', severityLabel('P0') === '一级问题' && severityLabel('P3') === '四级问题')
  check('未知等级不回落成 P?', !severityLabel('P9').includes('P'))
  check('代码腔：catch 分支描述被判定',
    codeSpeakReason('handleDelete 的 catch 分支中没有调用 toast') !== undefined)
  check('代码腔：缺少 empty state 分支被判定',
    codeSpeakReason('缺少 empty state 分支') !== undefined)
  check('代码腔：文件路径被判定',
    codeSpeakReason('src/pages/Admin/UserTable.tsx 里没有处理失败') !== undefined)
  check('人话描述不被误杀',
    codeSpeakReason('删除失败时界面没有任何提示，用户以为删成功了') === undefined,
    String(codeSpeakReason('删除失败时界面没有任何提示，用户以为删成功了')))
  check('人话描述不被误杀（空态）',
    codeSpeakReason('列表为空时页面一片空白，看不出是没数据还是加载失败') === undefined,
    String(codeSpeakReason('列表为空时页面一片空白，看不出是没数据还是加载失败')))
  check('surface 保留人话名', sanitizeSurface('管理员页面', { route: '/admin' }) === '管理员页面')
  check('surface 文件路径退化到路由路径',
    sanitizeSurface('src/pages/Admin/UserTable.tsx', { route: '/admin/users', symbol: 'UserTable' }) === '/admin/users')
  check('无路由时退到组件名，仍不是文件路径',
    sanitizeSurface('src/pages/Admin/UserTable.tsx', { symbol: 'UserTable' }) === 'UserTable')
  check('缺省 surface 也不会是文件路径', !looksLikeFilePath(sanitizeSurface(undefined, {})))

  // 路由标题 / h1 / 导航文案的提取优先级
  const ROUTED = `
import { UserTable } from './pages/Admin/UserTable'
export const routes = [{ path: '/admin/users', meta: { title: '用户管理' }, component: UserTable }]
`
  const PAGE = `
export function UserTable() {
  return <div><h1>用户列表</h1></div>
}
`
  const surfaceIndex = createSurfaceIndex()
  collectSurfaceHints(surfaceIndex, 'src/routes.tsx', ROUTED)
  collectSurfaceHints(surfaceIndex, 'src/pages/Admin/UserTable.tsx', PAGE)
  const resolvedSurface = surfaceCandidatesFor(surfaceIndex, 'src/pages/Admin/UserTable.tsx')
  check('路由标题优先于 h1', resolvedSurface.candidates[0] === '用户管理', JSON.stringify(resolvedSurface))
  check('h1 作为次选', resolvedSurface.candidates.includes('用户列表'), JSON.stringify(resolvedSurface))
  check('路由路径可作兜底', resolvedSurface.route === '/admin/users', JSON.stringify(resolvedSurface))

  // ── 10. 指纹（v0.1.1 §6.2）──────────────────────────────────────────────────
  console.log('跨走查指纹')
  const partsA = {
    rule: 'R-06',
    symbolPath: symbolPathOf('src/pages/Admin/UserTable.tsx', 'UserTable', 'handleDelete'),
    featureDigest: featureDigestOf('handleDelete 无 catch', 'fallback'),
  }
  const partsSameAfterEdit = { ...partsA }
  check('指纹不含行号，加行不漂移', fingerprintOf(partsA) === fingerprintOf(partsSameAfterEdit))
  check('特征原文空白差异不影响摘要',
    featureDigestOf('handleDelete  无   catch', 'x') === featureDigestOf('handleDelete 无 catch', 'x'))
  const renamed = { ...partsA, symbolPath: symbolPathOf('src/pages/Admin/UserTable.tsx', 'UserGrid', 'handleDelete') }
  check('重命名后指纹变化', fingerprintOf(partsA) !== fingerprintOf(renamed))
  check('三元组两项匹配 → 仍是同一问题（模糊匹配）', isSameFinding(partsA, renamed))
  check('只有一项匹配 → 不是同一问题',
    !isSameFinding(partsA, { rule: 'R-06', symbolPath: 'other::X', featureDigest: featureDigestOf('别的问题', 'y') }))

  // ── 11. rules.local.yml 宽容解析（v0.1.1 §4.2 / §5）─────────────────────────
  console.log('rules.local.yml')
  const prefRoot = mkdtempSync(join(tmpdir(), 'dsh-ux-pref-'))
  try {
    check('文件不存在时返回空偏好', Object.keys(loadLocalRules(prefRoot)).length === 0)
    mkdirSync(join(prefRoot, '.ux'), { recursive: true })
    writeFileSync(join(prefRoot, '.ux', 'rules.local.yml'),
      'mode: auto\nautoScan:\n  enabled: false\n  debounceTurns: 3\ndisabledRules: [R-02]\nfocus: 错误提示\n')
    const prefs = loadLocalRules(prefRoot)
    check('认识 mode', prefs.mode === 'auto')
    check('认识 autoScan', prefs.autoScan?.enabled === false && prefs.autoScan.debounceTurns === 3)
    check('未知键宽容忽略', !Object.keys(prefs).includes('disabledRules'), JSON.stringify(prefs))
    writeFileSync(join(prefRoot, '.ux', 'rules.local.yml'), 'mode: 乱写\n:::不是 yaml\n')
    check('坏文件不抛错，退回默认', loadLocalRules(prefRoot).mode === undefined)
  } finally {
    rmSync(prefRoot, { recursive: true, force: true })
  }

  // ── 12. 历史账本与隐式确认（v0.1.1 §6.3 的三种消失情形）─────────────────────
  console.log('隐式确认')
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'dsh-ux-history-'))
  try {
    mkdirSync(join(ledgerRoot, 'src', 'pages'), { recursive: true })
    writeFileSync(join(ledgerRoot, 'src', 'pages', 'Fixed.tsx'), 'export const Fixed = () => null\n')
    writeFileSync(join(ledgerRoot, 'src', 'pages', 'NotScanned.tsx'), 'export const NotScanned = () => null\n')
    writeFileSync(join(ledgerRoot, 'src', 'pages', 'Deleted.tsx'), 'export const Deleted = () => null\n')

    const makeFinding = (id: string, file: string, rule: string): UxFinding => ({
      id,
      fingerprint: fingerprintOf({ rule, symbolPath: `${file}::C`, featureDigest: featureDigestOf(id, id) }),
      surface: '某页面',
      human: { headline: '出事了', description: '用户会遇到问题', severity_label: '一级问题' },
      technical: {
        locator: { file, symbol: 'C' },
        rule,
        category: 'state-coverage',
        verified_by: 'model',
        evidence_level: 'static',
        persona_refs: ['investor'],
        severity: { impact: 'high', impact_confidence: 'medium', reach: 'wide', level: 'P0' },
        rationale: '依据',
        suggestion: '建议',
      },
      status: 'pending',
    })
    const first = [
      makeFinding('UX-0001', 'src/pages/Fixed.tsx', 'R-06'),
      makeFinding('UX-0002', 'src/pages/NotScanned.tsx', 'R-05'),
      makeFinding('UX-0003', 'src/pages/Deleted.tsx', 'R-04'),
    ]
    recordScan(ledgerRoot, {
      reportId: 'rpt-1',
      scope: ['src/pages/Fixed.tsx', 'src/pages/NotScanned.tsx', 'src/pages/Deleted.tsx'],
      findings: first,
      featureDigests: new Map(first.map((f) => [f.id, featureDigestOf(f.id, f.id)])),
    })
    check('账本文件写出（.ux/history.jsonl）', existsSync(join(ledgerRoot, HISTORY_FILE)))

    // 第二轮：Fixed 被改掉且重新扫描；NotScanned 不在 scope；Deleted 的文件已被删除。
    rmSync(join(ledgerRoot, 'src', 'pages', 'Deleted.tsx'))
    const verdicts = reconcile(ledgerRoot, {
      scopeFiles: ['src/pages/Fixed.tsx', 'src/pages/Deleted.tsx'],
      current: [],
    })
    const byFile = new Map(verdicts.map((v) => [v.entry.file, v]))
    check('改掉且被重新扫描 → confirmed_implicit',
      byFile.get('src/pages/Fixed.tsx')?.status === 'confirmed_implicit', JSON.stringify(verdicts))
    check('位置未被扫描 → stale(scope-miss)',
      byFile.get('src/pages/NotScanned.tsx')?.status === 'stale'
      && byFile.get('src/pages/NotScanned.tsx')?.reason === 'scope-miss', JSON.stringify(verdicts))
    check('代码整块删除 → stale(removed)，不算改进',
      byFile.get('src/pages/Deleted.tsx')?.status === 'stale'
      && byFile.get('src/pages/Deleted.tsx')?.reason === 'removed', JSON.stringify(verdicts))
    check('隐式判定回写指向原报告与原 finding',
      byFile.get('src/pages/Fixed.tsx')?.entry.report_id === 'rpt-1'
      && byFile.get('src/pages/Fixed.tsx')?.entry.finding_id === 'UX-0001')

    const metrics = metricsOf(ledgerRoot)
    check('指标：确认 1 条', metrics.confirmed === 1, JSON.stringify(metrics))
    check('指标：stale 不计入分母', metrics.stale === 2 && metrics.effectiveRatio === 1, JSON.stringify(metrics))

    // 问题仍然存在时不该被判为已改进。
    const persisting = [makeFinding('UX-0007', 'src/pages/Fixed.tsx', 'R-07')]
    recordScan(ledgerRoot, {
      reportId: 'rpt-2',
      scope: ['src/pages/Fixed.tsx'],
      findings: persisting,
      featureDigests: new Map([['UX-0007', featureDigestOf('UX-0007', 'UX-0007')]]),
    })
    const second = reconcile(ledgerRoot, {
      scopeFiles: ['src/pages/Fixed.tsx'],
      current: [comparableOf(persisting[0] as UxFinding, featureDigestOf('UX-0007', 'UX-0007'))],
    })
    check('问题仍在时不产生隐式确认',
      !second.some((v) => v.entry.finding_id === 'UX-0007'), JSON.stringify(second))
    check('状态没变化时不重复落账', second.length === 0, JSON.stringify(second))

    // stale 不是终态：位置被重新扫描后仍可判定为已改进。
    const third = reconcile(ledgerRoot, { scopeFiles: ['src/pages/NotScanned.tsx'], current: [] })
    check('stale 条目在位置被重新扫描后转为 confirmed_implicit',
      third.some((v) => v.entry.file === 'src/pages/NotScanned.tsx' && v.status === 'confirmed_implicit'),
      JSON.stringify(third))
  } finally {
    rmSync(ledgerRoot, { recursive: true, force: true })
  }

  // ── 13. R7 改动过滤与扫描单元（v0.1.1 §5）───────────────────────────────────
  console.log('R7 改动过滤')
  check('前端组件改动纳入', isReviewableChange('src/pages/Admin/UserTable.tsx'))
  check('Vue SFC 改动纳入', isReviewableChange('src/components/List.vue'))
  check('纯后端改动排除', !isReviewableChange('server/api/orders.ts'))
  check('测试文件排除', !isReviewableChange('src/pages/UserTable.test.tsx'))
  check('配置文件排除', !isReviewableChange('vite.config.ts'))
  check('样式文件排除（本版规则不覆盖）', !isReviewableChange('src/styles/main.css'))
  check('绝对路径归一为相对路径',
    relativizeChange('/repo/src/a.tsx', '/repo') === 'src/a.tsx')
  check('项目外路径被拒', relativizeChange('/other/a.tsx', '/repo') === undefined)
  check('扫描单元取所属目录，不是单个文件',
    JSON.stringify(scanUnitsOf(['src/pages/Admin/UserTable.tsx', 'src/pages/Admin/Detail.tsx']))
      === JSON.stringify(['src/pages/Admin']))
  const autoPrompt = buildAutoScanPrompt(['src/pages/Admin'], ['src/pages/Admin/UserTable.tsx'])
  check('R7 提示词强制 auto 且不索要确认',
    autoPrompt.includes('"auto"') && autoPrompt.includes('不要向用户提问'))
  check('R7 提示词说明扫完整组件而非 diff',
    autoPrompt.includes('完整组件 / 页面') && autoPrompt.includes('diff'))
  check('R7 提示词只在一级/二级问题时提示', autoPrompt.includes('一级 / 二级问题'))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
if (failures > 0) process.exitCode = 1
