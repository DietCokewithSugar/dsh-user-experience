/**
 * 运行时冒烟测试（不依赖 DSH 框架的纯逻辑部分）：
 *
 *   npx tsx scripts/smoke.ts
 *
 * 覆盖：AST 候选引擎（9 条规则的代表性信号）、persona 文件读写往返、
 * glossary 增量合并、技术栈探测、严重度矩阵、插件 apply 注册接线。
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { extractCandidates } from '../src/ast'
import { extractVueCandidates } from '../src/vue'
import { mergeGlossary, loadGlossary } from '../src/glossary'
import { writePersonas, loadPersonas } from '../src/persona'
import { detectStack, gatherFiles } from '../src/project'
import { levelOf, reachOf } from '../src/types'
import { apply, inject } from '../src/index'
import { RULES } from '../src/rules'

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
  const stubCtx = {
    commands: { register: (def: unknown) => commands.push(def) },
    systemPrompt: { section: (sec: unknown) => sections.push(sec) },
    tools: { register: (tool: unknown) => tools.push(tool) },
  }
  apply(stubCtx as never, {
    maxScanFiles: 300, maxCandidatesPerRule: 5, maxCandidatesPerFile: 25,
    maxFindings: 30, excludePatterns: [],
  })
  check('注册 /ux 命令', commands.length === 1)
  check('注册 ux:personas 提示词段', sections.length === 1)
  check('注册 3 个模型工具', tools.length === 3)
  check('工具名 = ux_scan / ux_report / ux_personas_write', tools.every((t) => {
    const name = (t as { name?: string }).name
    return name === 'ux_scan' || name === 'ux_report' || name === 'ux_personas_write'
  }))
  check('依赖注入声明 = tools/commands/systemPrompt', inject.join(',') === 'tools,commands,systemPrompt')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
if (failures > 0) process.exitCode = 1
