/**
 * AST 求证引擎（spec 附录 A）：
 *
 * 用 TypeScript 编译器 API 把代码解析成结构化的语法树，按规则目录提取
 * "可证伪的结构断言"。分工是：模型负责召回与语义判断，AST 负责精度——
 * 把模型的猜测降为可证伪的结构断言（`verified_by: model+ast`）；
 * R-09 是纯结构问题，AST 直接出结论（`verified_by: ast`，快车道，零 token）。
 *
 * 输出的 AstCandidate 是**候选证据**，不是最终 finding：
 * - 每条候选都带 locator 与原文片段，模型可以据此去读码核实；
 * - 模型确认后才经 `ux_report` 落为 finding；
 * - R-02 的候选仅提供术语位置，同义判断只能由模型完成（verified_by: model）。
 *
 * 为什么不用正则：搜 `text-black` 会把注释、字符串常量、变量名一起搜出来；
 * AST 知道它到底是不是 JSX 元素 className 属性里的类名（spec A.1）。
 */

import ts from 'typescript'
import type { RuleId } from './rules'
import type { VerifiedBy } from './types'

/** 一条 AST 候选证据。 */
export interface AstCandidate {
  rule: RuleId
  file: string
  symbol?: string
  line?: number
  snippet: string
  note: string
  /** 验证来源：model | model+ast | ast（与 wire schema 的 verified_by 字段一致）。 */
  verified_by: VerifiedBy
}

export interface AstExtractOptions {
  /** 每条规则每文件的最大候选数。 */
  maxPerRule: number
  /** 每文件的最大候选总数。 */
  maxPerFile: number
}

/** 深色模式相关的 Tailwind 颜色类（含任意值），不含纯布局类如 text-center。 */
export const COLOR_CLASS = /^(?:text|bg|border|ring|outline|fill|stroke|from|to|via|accent|caret|decoration|divide|placeholder|shadow)-(?:[a-z]+-\d+(?:\/\d+)?|\[(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))[^\]]*\]|black|white)(?:\/\d+)?$/u

/** 硬编码颜色字面量。 */
export const COLOR_LITERAL = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))$/u

/** 硬编码颜色字面量的子串搜索版本（Vue :style 绑定等整段表达式内检索）。 */
export const COLOR_LITERAL_SEARCH = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/u

/** 错误文案中的"行动指引"词。 */
export const ACTION_WORD = /重试|再试|刷新|稍后|点击|联系|查看|返回|取消|关闭|retry|refresh|try again|reload|contact|dismiss|undo|重连/u

/** 泛化的确认文案（无信息量）。 */
export const GENERIC_CONFIRM = /^(确定|确认|提交|继续|知道了|好的|OK|ok|Yes|yes|Submit|submit|Confirm|confirm|Yes,? I'?m sure)$/u

/** 截断 / 占位兜底的信号。 */
export const TRUNCATION_PATTERN = /truncate|ellipsis|clamp|line-clamp|text-overflow|word-break|break-all|overflow:\s*hidden|white-space:\s*nowrap/u

/** 文件内出现任意确认交互的信号。 */
export const CONFIRM_PATTERN = /confirm\(|Confirm|Dialog|Popconfirm|Modal\.|二次确认/u

/** 破坏性操作调用名。 */
export const DESTRUCTIVE_CALL = /^(?:handle)?(?:delete|remove|clear|reset|drop|destroy|wipe)\w*$/iu

/** 提交类异步处理器名。 */
export const SUBMIT_HANDLER = /submit|save|confirm|delete|remove/iu

/** 函数体中出现"空态覆盖"的信号。 */
export const EMPTY_PATTERN = /(?:\.length\s*(?:===|==|!==|!=|<=|>=|<|>)\s*0)|!\s*[\w[\].]*\.length|empty|isEmpty|hasData|暂无|空数据|空态|无数据|no data|no results|isBlank/iu

/** 函数体中出现"加载分支"的信号（作用于条件表达式条件文本）。 */
export const LOADING_PATTERN = /loading|pending|fetching|submitting/iu

/** 类 label 属性名（术语候选素材）。 */
export const LABEL_ATTRS = new Set(['placeholder', 'aria-label', 'label', 'title', 'alt'])

interface FunctionFrame {
  symbol: string
  node: ts.Node
  /** R-06：未覆盖的 await 站点。 */
  awaitSites: Array<{ node: ts.Node; snippet: string }>
  /** R-06：catch 子句列表。 */
  catchClauses: ts.CatchClause[]
  /** R-06：catch 内是否有用户可见反馈。 */
  catchFeedback: boolean
  /** R-05：加载分支站点。 */
  loadingSite: { node: ts.Node; snippet: string } | undefined
  /** R-05：是否存在列表渲染（.map）。 */
  hasMapRender: boolean
  /** R-04：破坏性调用站点。 */
  destructiveSites: Array<{ node: ts.Node; snippet: string }>
}

interface WalkContext {
  sourceFile: ts.SourceFile
  file: string
  options: AstExtractOptions
  candidates: AstCandidate[]
  perRule: Map<string, number>
  frames: FunctionFrame[]
  /** R-02 术语候选去重。 */
  termSeen: Set<string>
  termCount: number
}

function snippetOf(node: ts.Node, sf: ts.SourceFile, max = 160): string {
  const text = node.getText(sf).replace(/\s+/gu, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** 找到 node 的命名祖先函数名（向上查一层即可，栈里已是最内层）。 */
function enclosingSymbol(ctx: WalkContext): string | undefined {
  return ctx.frames.at(-1)?.symbol
}

function addCandidate(ctx: WalkContext, candidate: Omit<AstCandidate, 'file'>): void {
  if (ctx.candidates.length >= ctx.options.maxPerFile) return
  const count = ctx.perRule.get(candidate.rule) ?? 0
  if (count >= ctx.options.maxPerRule) return
  ctx.perRule.set(candidate.rule, count + 1)
  ctx.candidates.push({ ...candidate, file: ctx.file })
}

/** 节点是否位于 JSX 内部（用于区分用户可见文案与日志文案）。 */
function insideJsx(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined && !ts.isStatement(current)) {
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) return true
    current = current.parent
  }
  return false
}

/** 提取 catch 体内的用户可见文案候选（R-01）。 */
function collectErrorCopy(ctx: WalkContext, clause: ts.CatchClause): void {
  const literals: Array<{ text: string; node: ts.Node }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text.trim()
      if (text.length >= 4) {
        const visible = insideJsx(node) || isUserFacingCallArg(node)
        if (visible) literals.push({ text, node })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(clause)
  for (const literal of literals.slice(0, 3)) {
    if (ACTION_WORD.test(literal.text)) continue
    addCandidate(ctx, {
      rule: 'R-01',
      symbol: enclosingSymbol(ctx),
      line: lineOf(literal.node, ctx.sourceFile),
      snippet: snippetOf(literal.node, ctx.sourceFile),
      note: `catch/error 分支的用户可见文案仅描述失败、无行动指引："${literal.text}"（文案质量需模型复核）`,
      verified_by: 'model',
    })
  }
}

/** 字面量是否是用户可见调用的实参（alert/toast/message/…）。 */
function isUserFacingCallArg(node: ts.Node): boolean {
  const call = node.parent
  if (!ts.isCallExpression(call)) return false
  const callee = call.expression
  if (ts.isIdentifier(callee)) return /alert|toast|notify|message|error|warn/iu.test(callee.text)
  if (ts.isPropertyAccessExpression(callee)) return /alert|toast|notify|message|error|warn/iu.test(callee.name.text)
  return false
}

/** 一个函数结束时，收敛 R-05 / R-06 的候选。 */
function finalizeFrame(ctx: WalkContext, frame: FunctionFrame): void {
  // R-05：有 loading 分支、有列表渲染、无空态覆盖。
  if (frame.loadingSite !== undefined && frame.hasMapRender) {
    const text = frame.node.getText(ctx.sourceFile)
    if (!EMPTY_PATTERN.test(text)) {
      addCandidate(ctx, {
        rule: 'R-05',
        symbol: frame.symbol,
        line: lineOf(frame.loadingSite.node, ctx.sourceFile),
        snippet: frame.loadingSite.snippet,
        note: '列表存在加载分支，但未发现空数组/空态分支（loading 有、empty 无）',
        verified_by: 'model+ast',
      })
    }
  }
  // R-06：有 success 无 error。
  for (const site of frame.awaitSites.slice(0, 2)) {
    addCandidate(ctx, {
      rule: 'R-06',
      symbol: frame.symbol,
      line: lineOf(site.node, ctx.sourceFile),
      snippet: site.snippet,
      note: '异步调用无 catch / 无 try-catch 包裹，失败后用户看不到任何提示',
      verified_by: 'model+ast',
    })
  }
  if (frame.catchClauses.length > 0 && !frame.catchFeedback && frame.awaitSites.length > 0) {
    addCandidate(ctx, {
      rule: 'R-06',
      symbol: frame.symbol,
      line: lineOf(frame.catchClauses[0]!, ctx.sourceFile),
      snippet: snippetOf(frame.catchClauses[0]!, ctx.sourceFile),
      note: '异步调用有 catch，但 catch 内未发现用户可见反馈（无渲染/提示/状态更新）',
      verified_by: 'model+ast',
    })
  }
}

/** await 是否被 try-catch 或同链 .catch 覆盖。 */
function awaitCovered(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined && !ts.isStatement(current)) {
    if (ts.isTryStatement(current) && current.catchClause !== undefined) return true
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
      && current.expression.name.text === 'catch') {
      return true
    }
    current = current.parent
  }
  return false
}

/** catch 体内是否存在用户可见反馈（状态 setter / 提示调用 / JSX 渲染）。 */
function catchHasFeedback(clause: ts.CatchClause): boolean {
  let feedback = false
  const visit = (node: ts.Node): void => {
    if (feedback) return
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      feedback = true
      return
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && /^set[A-Z]|alert|toast|notify|message|show|open/iu.test(callee.text)) {
        feedback = true
        return
      }
      if (ts.isPropertyAccessExpression(callee) && /alert|toast|notify|message|confirm/iu.test(callee.name.text)) {
        feedback = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(clause)
  return feedback
}

function functionSymbol(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) {
    return node.name?.text ?? 'anonymous'
  }
  if (ts.isMethodDeclaration(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : 'anonymous'
  }
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  return 'anonymous'
}

function walk(node: ts.Node, ctx: WalkContext): void {
  if (ctx.candidates.length >= ctx.options.maxPerFile) return
  const frame = ctx.frames.at(-1)

  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
    const inner: FunctionFrame = {
      symbol: functionSymbol(node),
      node,
      awaitSites: [],
      catchClauses: [],
      catchFeedback: false,
      loadingSite: undefined,
      hasMapRender: false,
      destructiveSites: [],
    }
    ctx.frames.push(inner)
    ts.forEachChild(node, (child) => walk(child, ctx))
    ctx.frames.pop()
    finalizeFrame(ctx, inner)
    return
  }

  // ── R-06：await 站点与 catch 子句 ──
  if (frame !== undefined) {
    if (ts.isAwaitExpression(node)) {
      const chainRoot = outermostChain(node)
      if (!awaitCovered(chainRoot)) {
        frame.awaitSites.push({ node, snippet: snippetOf(chainRoot, ctx.sourceFile) })
      }
    }
    if (ts.isCatchClause(node)) {
      frame.catchClauses.push(node)
      if (catchHasFeedback(node)) frame.catchFeedback = true
      collectErrorCopy(ctx, node) // R-01
    }
  }

  // ── R-05：加载分支 / 列表渲染 / 空态 ──
  if (frame !== undefined) {
    if (ts.isConditionalExpression(node) && insideJsx(node)) {
      const conditionText = node.condition.getText(ctx.sourceFile)
      if (LOADING_PATTERN.test(conditionText) && frame.loadingSite === undefined) {
        frame.loadingSite = { node, snippet: snippetOf(node, ctx.sourceFile) }
      }
    }
    if (ts.isCallExpression(node) && insideJsx(node)
      && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
      frame.hasMapRender = true
    }
  }

  // ── R-09：className 颜色类 / style 硬编码颜色（快车道，AST 直接出结论）──
  if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'className'
    && node.initializer !== undefined && ts.isStringLiteral(node.initializer)) {
    const value = node.initializer.text
    const colorClasses = value.split(/\s+/u).filter((cls) => COLOR_CLASS.test(cls))
    if (colorClasses.length > 0 && !/dark:/u.test(value)) {
      addCandidate(ctx, {
        rule: 'R-09',
        symbol: enclosingSymbol(ctx),
        line: lineOf(node, ctx.sourceFile),
        snippet: snippetOf(node, ctx.sourceFile),
        note: `className 写死颜色类但无 dark: 变体：${colorClasses.join(', ')}`,
        verified_by: 'ast',
      })
    }
  }
  if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'style'
    && node.initializer !== undefined && ts.isJsxExpression(node.initializer)) {
    const styleExpr = node.initializer.expression
    if (styleExpr !== undefined && ts.isObjectLiteralExpression(styleExpr)) {
      for (const property of styleExpr.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) continue
        if (COLOR_LITERAL.test(property.initializer.text)) {
          addCandidate(ctx, {
            rule: 'R-09',
            symbol: enclosingSymbol(ctx),
            line: lineOf(property, ctx.sourceFile),
            snippet: snippetOf(property, ctx.sourceFile),
            note: `style 内联硬编码颜色字面量：${property.initializer.text}（未走主题变量）`,
            verified_by: 'ast',
          })
        }
      }
    }
  }

  // ── R-07：提交按钮无 pending 锁定 ──
  if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && isButtonLike(node)) {
    const attributes = jsxAttributes(node)
    const onClick = attributes.properties.find((attr): attr is ts.JsxAttribute =>
      ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && attr.name.text === 'onClick')
    const hasDisabled = attributes.properties.some((attr) =>
      ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name)
      && (attr.name.text === 'disabled' || attr.name.text === 'loading'))
    if (onClick !== undefined && onClick.initializer !== undefined
      && ts.isJsxExpression(onClick.initializer)) {
      const handler = onClick.initializer.expression
      if (handler !== undefined && handlerLooksAsync(handler) && !hasDisabled) {
        addCandidate(ctx, {
          rule: 'R-07',
          symbol: enclosingSymbol(ctx),
          line: lineOf(node, ctx.sourceFile),
          snippet: snippetOf(node, ctx.sourceFile),
          note: '异步提交按钮未见 pending 态绑定（无 disabled/loading），可重复触发',
          verified_by: 'model+ast',
        })
      }
    }
  }

  // ── R-04 / R-03：破坏性操作与确认交互 ──
  if (frame !== undefined && ts.isCallExpression(node)) {
    const callee = node.expression
    const calleeName = ts.isIdentifier(callee) ? callee.text
      : ts.isPropertyAccessExpression(callee) ? callee.name.text
        : undefined
    if (calleeName !== undefined && DESTRUCTIVE_CALL.test(calleeName)) {
      frame.destructiveSites.push({ node, snippet: snippetOf(node, ctx.sourceFile) })
    }
    if (calleeName !== undefined && /confirm$/iu.test(calleeName)) {
      const first = node.arguments[0]
      if (first !== undefined && ts.isStringLiteral(first) && GENERIC_CONFIRM.test(first.text.trim())) {
        addCandidate(ctx, {
          rule: 'R-03',
          symbol: enclosingSymbol(ctx),
          line: lineOf(node, ctx.sourceFile),
          snippet: snippetOf(node, ctx.sourceFile),
          note: `不可逆操作确认文案泛化："${first.text}"（无对象与后果信息；是否真的不可逆由模型复核）`,
          verified_by: 'model',
        })
      }
    }
  }

  // ── R-08：直接渲染外部输入字段，无截断兜底 ──
  if (frame !== undefined && ts.isPropertyAccessExpression(node) && insideJsx(node)) {
    const text = node.getText(ctx.sourceFile)
    if (/^item\.\w+|^data\.\w+|^row\.\w+|^record\.\w+/u.test(text) && !TRUNCATION_PATTERN.test(ctx.sourceFile.text)) {
      addCandidate(ctx, {
        rule: 'R-08',
        symbol: frame.symbol,
        line: lineOf(node, ctx.sourceFile),
        snippet: snippetOf(node.parent, ctx.sourceFile),
        note: '直接渲染输入/外部字段，未发现截断或占位处理（truncate/ellipsis/line-clamp）',
        verified_by: 'model+ast',
      })
    }
  }

  // ── R-02：术语候选（仅提取位置，同义由模型判断）──
  if (ctx.termCount < 12 && (ts.isJsxText(node) || isLabelLikeAttribute(node) || isJsxTextChild(node))) {
    const text = jsxVisibleText(node)
    if (text !== undefined) {
      const key = text
      if (!ctx.termSeen.has(key)) {
        ctx.termSeen.add(key)
        ctx.termCount += 1
        addCandidate(ctx, {
          rule: 'R-02',
          symbol: enclosingSymbol(ctx),
          line: lineOf(node, ctx.sourceFile),
          snippet: text,
          note: '术语候选：是否与其他位置用词同义，由模型判定（条件触发规则，仅无 P0/P1 时执行）',
          verified_by: 'model',
        })
      }
    }
  }

  ts.forEachChild(node, (child) => walk(child, ctx))
}

function outermostChain(node: ts.Node): ts.Node {
  let current = node
  while (current.parent !== undefined && !ts.isStatement(current.parent)
    && !ts.isExpressionStatement(current.parent)) {
    current = current.parent
  }
  return current
}

function isButtonLike(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const name = jsxTagName(node)
  if (ts.isIdentifier(name)) return name.text === 'button' || /Button|Btn/iu.test(name.text)
  return false
}

/** JsxElement / JsxSelfClosingElement 的 attributes（两种节点形态字段不同）。 */
function jsxAttributes(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes
}

/** JsxElement / JsxSelfClosingElement 的 tag 名。 */
function jsxTagName(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxTagNameExpression {
  return ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName
}

function handlerLooksAsync(expression: ts.Expression): boolean {
  if (ts.isArrowFunction(expression)) {
    if ((expression.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return true
    let hasAwait = false
    const visit = (node: ts.Node): void => {
      if (hasAwait) return
      if (ts.isAwaitExpression(node)) hasAwait = true
      ts.forEachChild(node, visit)
    }
    visit(expression.body)
    return hasAwait
  }
  if (ts.isIdentifier(expression)) return SUBMIT_HANDLER.test(expression.text)
  return false
}

/** JSX 文本或类 label 属性中的可见文本（术语候选素材）。 */
function jsxVisibleText(node: ts.Node): string | undefined {
  let raw = ''
  if (ts.isJsxText(node)) {
    raw = node.text.trim()
  } else if (ts.isStringLiteral(node)) {
    raw = node.text.trim()
  } else if (ts.isJsxExpression(node)) {
    const expression = node.expression
    if (expression === undefined || !ts.isStringLiteral(expression)) return undefined
    raw = expression.text.trim()
  } else {
    return undefined
  }
  if (raw.length < 2 || raw.length > 30) return undefined
  if (/^(https?:)?\/\//u.test(raw)) return undefined
  if (/[{}<>;=()[\]]/u.test(raw)) return undefined
  if (!/[\p{Script=Han}A-Za-z]/u.test(raw)) return undefined
  if (/^\d+%?$/u.test(raw)) return undefined
  return raw
}

function isLabelLikeAttribute(node: ts.Node): boolean {
  if (!ts.isJsxAttribute(node) || node.initializer === undefined) return false
  if (!ts.isIdentifier(node.name) || !LABEL_ATTRS.has(node.name.text)) return false
  return ts.isStringLiteral(node.initializer)
}

function isJsxTextChild(node: ts.Node): boolean {
  if (!ts.isJsxExpression(node)) return false
  const expression = node.expression
  return expression !== undefined && ts.isStringLiteral(expression)
}

/**
 * 从单个文件提取候选证据。
 * @param file - 相对项目根路径（写入候选的 locator）。
 * @param source - 文件文本。
 * @param options - 候选数量上限配置。
 * @param scriptKind - 解析方式：React 源码一律 TSX（.js 也可能含 JSX）；
 *   Vue `<script>` 块用 TS（无 JSX，lang=jsx/tsx 除外）。
 */
export function extractCandidates(
  file: string,
  source: string,
  options: AstExtractOptions,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TSX,
): AstCandidate[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const ctx: WalkContext = {
    sourceFile,
    file,
    options,
    candidates: [],
    perRule: new Map(),
    frames: [],
    termSeen: new Set(),
    termCount: 0,
  }
  // R-04 收敛走函数级判定（见 finalizeDestructive）。
  walk(sourceFile, ctx)
  return finalizeDestructive(sourceFile, ctx)
}

/** R-04 收敛：破坏性调用站点，其调用路径（向内两层函数）无确认交互 → 候选。 */
function finalizeDestructive(
  sourceFile: ts.SourceFile,
  ctx: WalkContext,
): AstCandidate[] {
  const sites: Array<{ node: ts.Node; frames: ts.Node[] }> = []
  const frames: Array<{ symbol: string; node: ts.Node }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      frames.push({ symbol: functionSymbol(node), node })
      ts.forEachChild(node, visit)
      frames.pop()
      return
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const calleeName = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : undefined
      if (calleeName !== undefined && DESTRUCTIVE_CALL.test(calleeName)) {
        sites.push({ node, frames: frames.map((frame) => frame.node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  for (const site of sites.slice(0, 3)) {
    // 路径级判定：由内向外检查至多两层包围函数。直通包装函数（如
    // () => clearAll()）自身没有确认交互，但确认节点通常存在于组件 / 处理
    // 函数层；两层之外不再上溯（等价于文件级，太粗）。模型复核最终结论。
    const pathFrames = site.frames.slice(-2)
    const covered = pathFrames.some((frame) => CONFIRM_PATTERN.test(frame.getText(sourceFile)))
    if (covered) continue
    addCandidate(ctx, {
      rule: 'R-04',
      symbol: undefined,
      line: lineOf(site.node, sourceFile),
      snippet: snippetOf(site.node, sourceFile),
      note: '破坏性操作调用，其调用路径（两层包围函数内）未发现确认交互（confirm/Modal/Dialog/Popconfirm）',
      verified_by: 'model+ast',
    })
  }
  return ctx.candidates
}
