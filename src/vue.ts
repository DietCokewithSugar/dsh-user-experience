/**
 * Vue 3 SFC 走查引擎（v0.2 技术栈扩展）：
 *
 * 与 React 引擎（ast.ts）同一分工——模型判断为主、AST 求证为辅。一个 .vue
 * 文件被拆成两部分分别求证：
 *
 * - `<script>` / `<script setup>` 块：直接复用 TypeScript 编译器 API 引擎
 *   （R-01 错误分支文案、R-03 泛化确认调用、R-04 破坏性调用路径、R-06 异步
 *   无 catch）。块内行号被平移到整个 .vue 文件的行号（locator 精度）。
 * - `<template>` 块：用 `@vue/compiler-dom` 的 `baseParse` 得到真实模板 AST
 *   （ElementNode / DirectiveNode / InterpolationNode…），按 9 条规则目录在
 *   结构节点上提取候选——v-if/v-for/@click/:class/:style 都是结构化节点，
 *   不会把注释、字符串常量误判进来（对齐 spec 附录 A.1 的"为什么不用正则"）。
 *
 * 模板级判定是文件粒度（等价 React 引擎的函数粒度），比 React 引擎更粗：
 * 候选 note 中明确要求模型核实"信号与结论是否属于同一列表/同一操作"。
 */

import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'
import type { SFCBlock } from '@vue/compiler-sfc'
import { baseParse, NodeTypes } from '@vue/compiler-dom'
import type {
  AttributeNode, CompoundExpressionNode, DirectiveNode, ElementNode,
  ExpressionNode, ForNode, IfNode, InterpolationNode, SimpleExpressionNode,
  TemplateChildNode, TextNode,
} from '@vue/compiler-dom'
import { extractCandidates } from './ast'
import type { AstCandidate, AstExtractOptions } from './ast'
import {
  ACTION_WORD, COLOR_CLASS, COLOR_LITERAL_SEARCH, EMPTY_PATTERN,
  GENERIC_CONFIRM, LABEL_ATTRS, LOADING_PATTERN, SUBMIT_HANDLER,
  TRUNCATION_PATTERN,
} from './ast'

/** 模板中的确认交互元素（ant-design-vue / element-plus 等组件库惯例）。 */
const CONFIRM_TAG = /modal|dialog|popconfirm|confirm/iu

/** 模板事件处理器表达式中的破坏性调用（近似 DESTRUCTIVE_CALL 的源码级等价）。 */
const DESTRUCTIVE_HANDLER = /(?:^|[^\w$])(?:handle)?(?:delete|remove|clear|reset|drop|destroy|wipe)\w*\s*\(/iu

/** 错误分支条件信号（v-if / v-show 的表达式）。 */
const ERROR_CONDITION = /error|fail|失败|错误/iu

/** R-08 关注的外部字段前缀（与 React 引擎一致：item/row/record/data）。 */
const EXTERNAL_FIELD = /^(?:item|row|record|data)\.[A-Za-z_$][\w$]*$/u

/** 一个 .vue 文件中 script 与 template 各自的候选预算（合并 ≤ 2×maxPerFile）。 */
const SFC_BUDGET_FACTOR = 2

interface TemplateWalkState {
  templateText: string
  styleText: string
  hasFor: boolean
  loadingSite: { line: number; snippet: string } | undefined
}

/** 模板 walker 的候选预算与去重上下文（perRule 与 script 部分共享）。 */
interface VueCandidateCtx {
  file: string
  symbol: string
  options: AstExtractOptions
  perRule: Map<string, number>
  budget: number
  used: number
  candidates: AstCandidate[]
  termSeen: Set<string>
  termCount: number
}

function addVueCandidate(ctx: VueCandidateCtx, candidate: Omit<AstCandidate, 'file' | 'symbol'>): void {
  if (ctx.used >= ctx.budget) return
  const count = ctx.perRule.get(candidate.rule) ?? 0
  if (count >= ctx.options.maxPerRule) return
  ctx.perRule.set(candidate.rule, count + 1)
  ctx.used += 1
  ctx.candidates.push({ ...candidate, file: ctx.file, symbol: ctx.symbol })
}

/** 节点源码片段（折叠空白，截断到 160 字符）。 */
function snippetOf(node: { loc: { source: string } }, max = 160): string {
  const text = node.loc.source.replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 计算块内容在源文件中的首行偏移（0 起：内容第 1 行 = 文件第 offset+1 行）。 */
function contentLineOffset(source: string, block: SFCBlock): number {
  const content = block.content
  if (content.length === 0) return block.loc.start.line - 1
  const at = source.indexOf(content, block.loc.start.offset)
  const prefix = source.slice(0, at)
  return prefix.split('\n').length - 1
}

/** 术语候选可见文本过滤（与 React 引擎 jsxVisibleText 同口径）。 */
function visibleText(raw: string): string | undefined {
  const text = raw.replace(/\s+/gu, ' ').trim()
  if (text.length < 2 || text.length > 30) return undefined
  if (/^(https?:)?\/\//u.test(text)) return undefined
  if (/[{}<>;=()[\]]/u.test(text)) return undefined
  if (!/[\p{Script=Han}A-Za-z]/u.test(text)) return undefined
  if (/^\d+%?$/u.test(text)) return undefined
  return text
}

/** 指令的静态参数名（如 :class 的 arg="class"；动态参数返回 undefined）。 */
function directiveArgName(directive: DirectiveNode): string | undefined {
  const arg = directive.arg
  if (arg === undefined) return undefined
  return arg.type === NodeTypes.SIMPLE_EXPRESSION ? arg.content : undefined
}

/** 收集元素子树的用户可见文本（静态文本 + 字符串字面量插值）。 */
function collectVisibleText(children: readonly TemplateChildNode[], out: string[]): void {
  for (const child of children) {
    if (child.type === NodeTypes.TEXT) {
      const text = (child as TextNode).content.replace(/\s+/gu, ' ').trim()
      if (text.length > 0) out.push(text)
    } else if (child.type === NodeTypes.INTERPOLATION) {
      const expression = (child as InterpolationNode).content
      if (expression.type === NodeTypes.SIMPLE_EXPRESSION) {
        const simple = expression as SimpleExpressionNode
        if (simple.isStatic) {
          const text = simple.content.replace(/^['"]|['"]$/gu, '').trim()
          if (text.length > 0) out.push(text)
        }
      }
    } else if (child.type === NodeTypes.COMPOUND_EXPRESSION) {
      const parts: TemplateChildNode[] = []
      for (const part of (child as CompoundExpressionNode).children) {
        if (typeof part === 'string' || typeof part === 'symbol') continue
        if (part.type === NodeTypes.TEXT || part.type === NodeTypes.INTERPOLATION
          || part.type === NodeTypes.COMPOUND_EXPRESSION) {
          parts.push(part as TemplateChildNode)
        }
      }
      collectVisibleText(parts, out)
    }
  }
}

/** 遍历模板 AST：结构信号收集 + 逐节点候选求证。 */
function walkTemplate(root: { children: TemplateChildNode[] }, ctx: VueCandidateCtx, state: TemplateWalkState): void {
  const walkChildren = (
    children: readonly TemplateChildNode[],
    parentEl: ElementNode | null,
    grandEl: ElementNode | null,
  ): boolean => {
    let confirmInSubtree = false
    for (const child of children) {
      if (ctx.used >= ctx.budget) return confirmInSubtree
      switch (child.type) {
        case NodeTypes.ELEMENT: {
          const el = child as ElementNode
          if (walkElement(el, parentEl, grandEl)) confirmInSubtree = true
          break
        }
        case NodeTypes.TEXT: {
          recordTerm(ctx, (child as TextNode).content, child.loc.start.line)
          break
        }
        case NodeTypes.INTERPOLATION: {
          handleInterpolation(ctx, state, child as InterpolationNode)
          break
        }
        case NodeTypes.COMPOUND_EXPRESSION: {
          // 复合表达式：内部文本与插值仍需覆盖（如 "共 {{ total }} 条"）。
          for (const part of (child as CompoundExpressionNode).children) {
            if (typeof part === 'string' || typeof part === 'symbol') continue
            if (part.type === NodeTypes.TEXT) recordTerm(ctx, (part as TextNode).content, part.loc.start.line)
            else if (part.type === NodeTypes.INTERPOLATION) handleInterpolation(ctx, state, part as InterpolationNode)
          }
          break
        }
        case NodeTypes.IF: {
          for (const branch of (child as IfNode).branches) {
            walkChildren(branch.children, parentEl, grandEl)
          }
          break
        }
        case NodeTypes.FOR: {
          walkChildren((child as ForNode).children, parentEl, grandEl)
          break
        }
        default:
          break
      }
    }
    return confirmInSubtree
  }

  const walkElement = (
    el: ElementNode,
    parentEl: ElementNode | null,
    grandEl: ElementNode | null,
  ): boolean => {
    const isConfirmEl = CONFIRM_TAG.test(el.tag)
    // 先走子级（R-04 需要"子树内是否有确认元素"的后验信息）。
    const confirmInSubtree = walkChildren(el.children, el, parentEl)
    const inConfirmContext = isConfirmEl || confirmInSubtree
      || (parentEl !== null && CONFIRM_TAG.test(parentEl.tag))
      || (grandEl !== null && CONFIRM_TAG.test(grandEl.tag))

    const buttonLike = el.tag === 'button' || /Button|Btn/iu.test(el.tag)
    let onClickExp: ExpressionNode | undefined
    let covered = false
    const attrs = new Map<string, string>()

    for (const prop of el.props) {
      if (prop.type === NodeTypes.ATTRIBUTE) {
        const attr = prop as AttributeNode
        if (attr.value !== undefined) attrs.set(attr.name, attr.value.content)
        if (attr.name === 'disabled') covered = true
        // R-09：静态 class 属性写死颜色类且无 dark: 变体。
        if (attr.name === 'class' && attr.value !== undefined) {
          const value = attr.value.content
          const colorClasses = value.split(/\s+/u).filter((cls) => COLOR_CLASS.test(cls))
          if (colorClasses.length > 0 && !/dark:/u.test(value)) {
            addVueCandidate(ctx, {
              rule: 'R-09',
              line: prop.loc.start.line,
              snippet: snippetOf(prop),
              note: `class 写死颜色类但无 dark: 变体：${colorClasses.join(', ')}`,
              verified_by: 'ast',
            })
          }
        }
        // R-09：静态 style 属性硬编码颜色。
        if (attr.name === 'style' && attr.value !== undefined && COLOR_LITERAL_SEARCH.test(attr.value.content)) {
          addVueCandidate(ctx, {
            rule: 'R-09',
            line: prop.loc.start.line,
            snippet: snippetOf(prop),
            note: `style 内联硬编码颜色字面量：${attr.value.content.match(COLOR_LITERAL_SEARCH)?.[0] ?? ''}（未走主题变量）`,
            verified_by: 'ast',
          })
        }
        // R-02：类 label 属性。
        if (LABEL_ATTRS.has(attr.name) && attr.value !== undefined) {
          recordTerm(ctx, attr.value.content, prop.loc.start.line)
        }
      } else if (prop.type === NodeTypes.DIRECTIVE) {
        const directive = prop as DirectiveNode
        const argName = directiveArgName(directive)
        const expSource = directive.exp?.loc.source ?? ''

        // R-09：:class 绑定 / :style 绑定中的硬编码颜色。
        if (directive.name === 'bind') {
          if (argName === 'class') {
            const tokens = expSource.match(/[A-Za-z][\w-]*/gu) ?? []
            const colorClasses = tokens.filter((cls) => COLOR_CLASS.test(cls))
            if (colorClasses.length > 0 && !/dark:/u.test(expSource)) {
              addVueCandidate(ctx, {
                rule: 'R-09',
                line: prop.loc.start.line,
                snippet: snippetOf(prop),
                note: `:class 绑定写死颜色类但无 dark: 变体：${colorClasses.join(', ')}`,
                verified_by: 'ast',
              })
            }
          }
          if (argName === 'style' && COLOR_LITERAL_SEARCH.test(expSource)) {
            addVueCandidate(ctx, {
              rule: 'R-09',
              line: prop.loc.start.line,
              snippet: snippetOf(prop),
              note: `:style 绑定硬编码颜色字面量：${expSource.match(COLOR_LITERAL_SEARCH)?.[0] ?? ''}（未走主题变量）`,
              verified_by: 'ast',
            })
          }
          if (argName === 'disabled' || argName === 'loading') covered = true
        }

        // R-05：v-if 加载分支 + v-for 信号。
        if (directive.name === 'if' && LOADING_PATTERN.test(expSource) && state.loadingSite === undefined) {
          state.loadingSite = { line: prop.loc.start.line, snippet: snippetOf(el) }
        }
        if (directive.name === 'for') state.hasFor = true

        // R-01：错误条件分支的用户可见文案。
        if (directive.name === 'if' && ERROR_CONDITION.test(expSource)) {
          const texts: string[] = []
          collectVisibleText(el.children, texts)
          if (texts.length > 0 && texts.every((text) => !ACTION_WORD.test(text))) {
            addVueCandidate(ctx, {
              rule: 'R-01',
              line: el.loc.start.line,
              snippet: snippetOf(el),
              note: `v-if 错误分支的用户可见文案仅描述失败、无行动指引："${texts[0] ?? ''}"（文案质量需模型复核）`,
              verified_by: 'model',
            })
          }
        }

        // R-07 / R-04：事件处理器。
        if (directive.name === 'on' && argName !== undefined) {
          if (argName === 'click' || argName === 'submit' || argName === 'dblclick') {
            onClickExp = directive.exp ?? onClickExp
            if (!inConfirmContext && DESTRUCTIVE_HANDLER.test(expSource)) {
              addVueCandidate(ctx, {
                rule: 'R-04',
                line: prop.loc.start.line,
                snippet: snippetOf(prop),
                note: '模板事件处理器直接调用破坏性操作，该元素及其两级祖先/子树内未发现确认交互（Modal/Dialog/Popconfirm）；信号与结论是否同属一条操作路径由模型复核',
                verified_by: 'model+ast',
              })
            }
          }
        }
      }
    }

    // R-07：提交按钮无 pending 锁定。
    if (buttonLike && onClickExp !== undefined && handlerLooksAsync(onClickExp) && !covered) {
      addVueCandidate(ctx, {
        rule: 'R-07',
        line: el.loc.start.line,
        snippet: snippetOf(el),
        note: '异步提交按钮未见 pending 态绑定（无 disabled/:disabled/:loading），可重复触发',
        verified_by: 'model+ast',
      })
    }

    // R-03：Popconfirm 类确认文案泛化。
    if (/popconfirm/iu.test(el.tag)) {
      const genericTexts = ['title', 'ok-text', 'okText', 'confirm-text']
        .map((name) => attrs.get(name))
        .filter((value): value is string => value !== undefined && GENERIC_CONFIRM.test(value))
      if (genericTexts.length > 0) {
        addVueCandidate(ctx, {
          rule: 'R-03',
          line: el.loc.start.line,
          snippet: snippetOf(el),
          note: `不可逆操作确认文案泛化："${genericTexts[0] ?? ''}"（无对象与后果信息；是否真的不可逆由模型复核）`,
          verified_by: 'model',
        })
      }
    }

    return isConfirmEl || confirmInSubtree
  }

  walkChildren(root.children, null, null)
}

/** R-02 术语候选（去重、每文件 ≤12 条，与 React 引擎同口径）。 */
function recordTerm(ctx: VueCandidateCtx, raw: string, line: number): void {
  if (ctx.termCount >= 12) return
  const text = visibleText(raw)
  if (text === undefined || ctx.termSeen.has(text)) return
  ctx.termSeen.add(text)
  ctx.termCount += 1
  addVueCandidate(ctx, {
    rule: 'R-02',
    line,
    snippet: text,
    note: '术语候选：是否与其他位置用词同义，由模型判定（条件触发规则，仅无 P0/P1 时执行）',
    verified_by: 'model',
  })
}

/** R-08：插值直接渲染外部字段；R-02：字符串字面量插值作为术语候选。 */
function handleInterpolation(ctx: VueCandidateCtx, state: TemplateWalkState, node: InterpolationNode): void {
  const expression = node.content
  if (expression.type !== NodeTypes.SIMPLE_EXPRESSION) return
  const simple = expression as SimpleExpressionNode
  const text = simple.content.trim()
  if (simple.isStatic) {
    // 与 React 引擎的 JsxExpression 字符串字面量同口径：仅作术语候选。
    recordTerm(ctx, simple.content.replace(/^['"]|['"]$/gu, ''), node.loc.start.line)
    return
  }
  if (!EXTERNAL_FIELD.test(text)) return
  if (TRUNCATION_PATTERN.test(state.templateText) || TRUNCATION_PATTERN.test(state.styleText)) return
  addVueCandidate(ctx, {
    rule: 'R-08',
    line: node.loc.start.line,
    snippet: snippetOf(node),
    note: '插值直接渲染输入/外部字段，未发现截断或占位处理（truncate/ellipsis/line-clamp）',
    verified_by: 'model+ast',
  })
}

/** 模板事件处理器是否异步（含 await 或提交类处理器名）。 */
function handlerLooksAsync(exp: ExpressionNode | undefined): boolean {
  if (exp === undefined) return false
  const text = exp.loc.source
  if (/await/u.test(text)) return true
  const callee = /^\s*([A-Za-z_$][\w$]*)/u.exec(text)?.[1]
  return callee !== undefined && SUBMIT_HANDLER.test(callee)
}

/** 递归合并两条候选列表（脚本部分可能分多个 block 调用引擎）。 */
function pushCapped(
  target: AstCandidate[],
  perRule: Map<string, number>,
  options: AstExtractOptions,
  budget: number,
  candidates: readonly AstCandidate[],
): number {
  let added = 0
  for (const candidate of candidates) {
    if (added >= budget) break
    const count = perRule.get(candidate.rule) ?? 0
    if (count >= options.maxPerRule) continue
    perRule.set(candidate.rule, count + 1)
    target.push(candidate)
    added += 1
  }
  return added
}

/**
 * 从单个 .vue 文件提取候选证据。
 * @param file - 相对项目根路径（写入候选的 locator）。
 * @param source - 文件文本。
 * @param options - 候选数量上限配置。
 */
export function extractVueCandidates(
  file: string,
  source: string,
  options: AstExtractOptions,
): AstCandidate[] {
  let descriptor
  try {
    descriptor = parseSfc(source, { filename: file }).descriptor
  } catch {
    // SFC 无法解析时静默跳过：不给无 locator 的低质量猜测。
    return []
  }
  const candidates: AstCandidate[] = []
  const perRule = new Map<string, number>()
  const scriptBudget = options.maxPerFile
  let scriptUsed = 0

  // ── script / script setup：复用 TS 编译器 API 引擎，行号平移到文件行 ──
  const scriptBlocks = [descriptor.scriptSetup, descriptor.script]
    .filter((block): block is NonNullable<typeof block> => block !== null && block.content.trim().length > 0)
  for (const block of scriptBlocks) {
    if (scriptUsed >= scriptBudget) break
    const offset = contentLineOffset(source, block)
    const lang = block.lang ?? ''
    // lang="jsx"/"tsx" 的 script 块允许 JSX（render 函数写法），否则按 TS 解析。
    const kind = /x/iu.test(lang) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const extracted = extractCandidates(file, block.content, options, kind)
    for (const candidate of extracted) {
      if (candidate.line !== undefined) candidate.line += offset
    }
    scriptUsed += pushCapped(candidates, perRule, options, scriptBudget - scriptUsed, extracted)
  }

  // ── template：@vue/compiler-dom 真实 AST，逐节点提取结构证据 ──
  const template = descriptor.template
  if (template !== null && template.content.trim().length > 0) {
    const offset = contentLineOffset(source, template)
    const symbol = file.split('/').at(-1)?.replace(/\.vue$/u, '') ?? 'anonymous'
    let root
    try {
      root = baseParse(template.content, { onError: () => {} })
    } catch {
      root = undefined
    }
    if (root !== undefined) {
      const ctx: VueCandidateCtx = {
        file,
        symbol,
        options,
        perRule,
        budget: options.maxPerFile,
        used: 0,
        candidates: [],
        termSeen: new Set(),
        termCount: 0,
      }
      const state: TemplateWalkState = {
        templateText: template.content,
        styleText: descriptor.styles.map((style) => style.content).join('\n'),
        hasFor: false,
        loadingSite: undefined,
      }
      walkTemplate(root, ctx, state)
      for (const candidate of ctx.candidates) {
        if (candidate.line !== undefined) candidate.line += offset
      }
      candidates.push(...ctx.candidates)

      // R-05 收敛（模板级）：有加载分支、有 v-for 渲染、无空态覆盖。
      if (state.loadingSite !== undefined && state.hasFor && !EMPTY_PATTERN.test(state.templateText)) {
        const count = perRule.get('R-05') ?? 0
        if (count < options.maxPerRule && candidates.length < options.maxPerFile * SFC_BUDGET_FACTOR) {
          perRule.set('R-05', count + 1)
          candidates.push({
            rule: 'R-05',
            file,
            symbol,
            line: state.loadingSite.line + offset,
            snippet: state.loadingSite.snippet,
            note: '模板存在 v-if 加载分支与 v-for 渲染，但未发现空数组/空态分支（loading 有、empty 无；两者是否同属一个列表由模型复核）',
            verified_by: 'model+ast',
          })
        }
      }
    }
  }

  return candidates
}
