/**
 * 运行时冒烟测试（不依赖 DSH 框架的纯逻辑部分）：
 *
 *   npx tsx scripts/smoke.ts
 *
 * 覆盖：AST 候选引擎（9 条规则的代表性信号）、persona 文件读写往返、
 * glossary 增量合并、技术栈探测、严重度矩阵、插件 apply 注册接线。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractCandidates } from '../src/ast'
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
  check('React+TS 项目 supported', detectStack(root).supported === true, JSON.stringify(detectStack(root)))
  const gathered = gatherFiles(root, ['src'], [], 100)
  check('无 src 目录时收集为空', gathered.files.length === 0)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', dependencies: { vue: '3' } }))
  const stack = detectStack(root)
  check('Vue 项目明确不支持', stack.supported === false && stack.stack.includes('Vue'), JSON.stringify(stack))

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
