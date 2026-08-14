/**
 * 人话页面名（`surface`）的素材提取（v0.1.1 spec §3.4）。
 *
 * 卡片首屏要回答的第一个问题是"**哪个页面**出了事"。文件路径回答不了这个
 * 问题——它对人没有意义。所以走查要给出人话位置名，来源按优先级：
 *
 * 1. 路由配置中的 `title` / `meta.title`
 * 2. 页面根组件内的 `h1` 文本
 * 3. 面包屑或导航中指向该路由的链接文案
 * 4. 以上都没有时，由模型根据组件名与页面内容拟一个中文名称
 *
 * **兜底规则**：拟不出人话名称时用路由路径（`/admin/users`），但**不得**退化
 * 为文件路径。
 *
 * 本模块只负责提取 1-3 的**素材**（hints），交给模型选用或据以拟名；
 * 净化与兜底在 `ux_report` 定稿时执行（见 {@link sanitizeSurface}）。
 */

import ts from 'typescript'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { baseParse, NodeTypes } from '@vue/compiler-dom'
import type { ElementNode, TemplateChildNode, TextNode } from '@vue/compiler-dom'

/** 一个文件里提取到的人话位置素材。 */
export interface SurfaceHint {
  /** 相对项目根的文件路径（素材归属，不是给人看的位置名）。 */
  file: string
  /** 路由路径，如 `/admin/users`。 */
  route?: string
  /** 路由配置里的标题（`title` / `meta.title`）。 */
  routeTitle?: string
  /** 页面根组件内的 h1 文本。 */
  heading?: string
  /** 导航 / 面包屑中指向该路由的链接文案。 */
  navText?: string
  /** 组件 / 符号名（模型拟名时的素材）。 */
  symbol?: string
}

/** 路由表条目：路径 + 标题 + 指向的组件线索。 */
interface RouteEntry {
  route: string
  title?: string
  /** 元素/组件标识符名，如 `UserTable`。 */
  component?: string
  /** 懒加载 import 的模块说明符，如 `./pages/Admin/UserTable`。 */
  module?: string
}

/** 导航链接：目标路由 + 链接文案。 */
interface NavLink {
  route: string
  text: string
}

/** 一次扫描收集到的全项目素材。 */
export interface SurfaceIndex {
  routes: RouteEntry[]
  navLinks: NavLink[]
  /** 文件 → 该文件内的 h1 文本。 */
  headings: Map<string, string>
  /** 文件 → 主要导出的组件名。 */
  symbols: Map<string, string>
}

/** 新建一份空索引。 */
export function createSurfaceIndex(): SurfaceIndex {
  return { routes: [], navLinks: [], headings: new Map(), symbols: new Map() }
}

const TITLE_KEYS = new Set(['title', 'label', 'name'])
const NAV_TAGS = new Set(['Link', 'NavLink', 'router-link', 'RouterLink', 'a'])

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const text = node.text.trim()
    return text.length === 0 ? undefined : text
  }
  return undefined
}

/** 读取对象字面量里某个键的字符串值。 */
function stringProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name
    const propertyName = ts.isIdentifier(name) ? name.text
      : ts.isStringLiteral(name) ? name.text
        : undefined
    if (propertyName !== key) continue
    return literalText(property.initializer)
  }
  return undefined
}

/** 读取对象字面量里 `meta: { title }` 之类的嵌套标题。 */
function nestedTitle(object: ts.ObjectLiteralExpression): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name
    const propertyName = ts.isIdentifier(name) ? name.text : undefined
    if (propertyName !== 'meta' && propertyName !== 'handle') continue
    if (!ts.isObjectLiteralExpression(property.initializer)) continue
    for (const key of TITLE_KEYS) {
      const value = stringProperty(property.initializer, key)
      if (value !== undefined) return value
    }
  }
  return undefined
}

/** 从 `component: () => import('./x')` / `element: <X/>` 提取组件线索。 */
function componentHint(object: ts.ObjectLiteralExpression): { component?: string; module?: string } {
  const hint: { component?: string; module?: string } = {}
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = property.name
    const key = ts.isIdentifier(name) ? name.text : undefined
    if (key !== 'component' && key !== 'element' && key !== 'Component') continue
    const initializer = property.initializer
    if (ts.isIdentifier(initializer)) {
      hint.component = initializer.text
      continue
    }
    if (ts.isJsxSelfClosingElement(initializer) || ts.isJsxElement(initializer)) {
      const tag = ts.isJsxElement(initializer) ? initializer.openingElement.tagName : initializer.tagName
      if (ts.isIdentifier(tag)) hint.component = tag.text
      continue
    }
    // 懒加载：() => import('./pages/Admin/UserTable')
    const found = findImportSpecifier(initializer)
    if (found !== undefined) hint.module = found
  }
  return hint
}

function findImportSpecifier(node: ts.Node): string | undefined {
  let specifier: string | undefined
  const visit = (current: ts.Node): void => {
    if (specifier !== undefined) return
    if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = current.arguments[0]
      if (argument !== undefined) specifier = literalText(argument)
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return specifier
}

/** 从 JSX 属性里读取字符串值（`path="/admin"` 或 `to={'/admin'}`）。 */
function jsxAttributeText(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, key: string): string | undefined {
  for (const attribute of element.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue
    if (attribute.name.getText() !== key) continue
    const initializer = attribute.initializer
    if (initializer === undefined) continue
    if (ts.isStringLiteral(initializer)) return initializer.text.trim()
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
      return literalText(initializer.expression)
    }
  }
  return undefined
}

/** JSX 元素内的直接文本（导航链接文案）。 */
function jsxChildText(element: ts.JsxElement): string | undefined {
  const parts: string[] = []
  for (const child of element.children) {
    if (ts.isJsxText(child)) {
      const text = child.text.trim()
      if (text.length > 0) parts.push(text)
      continue
    }
    if (ts.isJsxExpression(child) && child.expression !== undefined) {
      const text = literalText(child.expression)
      if (text !== undefined) parts.push(text)
    }
  }
  const joined = parts.join('').trim()
  return joined.length === 0 ? undefined : joined
}

/**
 * 从一个 TS / TSX 源文件收集素材，合并进索引。
 * @param index - 累积索引（就地写入）。
 * @param file - 相对项目根的文件路径。
 * @param source - 源码文本。
 * @param scriptKind - 解析用的脚本种类。
 */
export function collectSurfaceHints(
  index: SurfaceIndex,
  file: string,
  source: string,
  scriptKind: ts.ScriptKind = ts.ScriptKind.TSX,
): void {
  let sourceFile: ts.SourceFile
  try {
    sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  } catch {
    return
  }

  const visit = (node: ts.Node): void => {
    // 路由对象字面量：{ path: '/admin/users', meta: { title: '用户管理' } }
    if (ts.isObjectLiteralExpression(node)) {
      const route = stringProperty(node, 'path')
      if (route !== undefined && route.length > 0) {
        const title = nestedTitle(node) ?? stringProperty(node, 'title')
        const hint = componentHint(node)
        index.routes.push({
          route,
          ...(title === undefined ? {} : { title }),
          ...(hint.component === undefined ? {} : { component: hint.component }),
          ...(hint.module === undefined ? {} : { module: hint.module }),
        })
      }
    }
    // JSX 路由：<Route path="/admin/users" element={<UserTable />} />
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText()
      if (tag === 'Route') {
        const route = jsxAttributeText(node, 'path')
        if (route !== undefined) {
          const title = jsxAttributeText(node, 'title')
          const element = node.attributes.properties.find((property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) && property.name.getText() === 'element')
          let component: string | undefined
          const initializer = element?.initializer
          if (initializer !== undefined && ts.isJsxExpression(initializer)
            && initializer.expression !== undefined) {
            const expression = initializer.expression
            const inner = ts.isJsxSelfClosingElement(expression) ? expression.tagName
              : ts.isJsxElement(expression) ? expression.openingElement.tagName
                : undefined
            if (inner !== undefined && ts.isIdentifier(inner)) component = inner.text
          }
          index.routes.push({
            route,
            ...(title === undefined ? {} : { title }),
            ...(component === undefined ? {} : { component }),
          })
        }
      }
      // 导航链接：<Link to="/admin/users">用户管理</Link>
      if (NAV_TAGS.has(tag) && ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent)) {
        const route = jsxAttributeText(node, 'to') ?? jsxAttributeText(node, 'href')
        const text = jsxChildText(node.parent)
        if (route !== undefined && text !== undefined) index.navLinks.push({ route, text })
      }
    }
    // 页面标题：<h1>用户管理</h1>
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'h1'
      && !index.headings.has(file)) {
      const text = jsxChildText(node)
      if (text !== undefined) index.headings.set(file, text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const symbol = exportedComponentName(sourceFile)
  if (symbol !== undefined) index.symbols.set(file, symbol)
}

/** 文件的主要导出组件名（首字母大写的导出函数 / 变量 / 类）。 */
function exportedComponentName(sourceFile: ts.SourceFile): string | undefined {
  let fallback: string | undefined
  for (const statement of sourceFile.statements) {
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
    if (!exported) continue
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const name = statement.name?.text
      if (name !== undefined && /^[A-Z]/u.test(name)) return name
      fallback ??= name
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        const name = declaration.name.text
        if (/^[A-Z]/u.test(name)) return name
        fallback ??= name
      }
    }
  }
  return fallback
}

/**
 * 从一个 Vue SFC 收集素材：模板里的 h1 与 router-link 文案。
 * @param index - 累积索引（就地写入）。
 * @param file - 相对项目根的 .vue 路径。
 * @param source - SFC 源码。
 */
export function collectVueSurfaceHints(index: SurfaceIndex, file: string, source: string): void {
  let descriptor
  try {
    descriptor = parseSfc(source, { filename: file }).descriptor
  } catch {
    return
  }
  const symbol = file.split('/').at(-1)?.replace(/\.vue$/u, '')
  if (symbol !== undefined && symbol.length > 0) index.symbols.set(file, symbol)

  const scriptBlocks = [descriptor.scriptSetup, descriptor.script]
    .filter((block): block is NonNullable<typeof block> => block !== null && block.content.trim().length > 0)
  for (const block of scriptBlocks) {
    collectSurfaceHints(index, file, block.content, ts.ScriptKind.TS)
  }

  const template = descriptor.template
  if (template === null || template.content.trim().length === 0) return
  let root
  try {
    root = baseParse(template.content, { onError: () => {} })
  } catch {
    return
  }
  const textOf = (element: ElementNode): string | undefined => {
    const parts = element.children
      .filter((child): child is TextNode => child.type === NodeTypes.TEXT)
      .map((child) => child.content.trim())
      .filter((text) => text.length > 0)
    const joined = parts.join('').trim()
    return joined.length === 0 ? undefined : joined
  }
  const walk = (children: readonly TemplateChildNode[]): void => {
    for (const child of children) {
      if (child.type !== NodeTypes.ELEMENT) continue
      const element = child
      if (element.tag === 'h1' && !index.headings.has(file)) {
        const text = textOf(element)
        if (text !== undefined) index.headings.set(file, text)
      }
      if (NAV_TAGS.has(element.tag)) {
        const to = element.props.find((prop) =>
          (prop.type === NodeTypes.ATTRIBUTE && (prop.name === 'to' || prop.name === 'href')))
        const route = to !== undefined && to.type === NodeTypes.ATTRIBUTE ? to.value?.content : undefined
        const text = textOf(element)
        if (route !== undefined && route.length > 0 && text !== undefined) {
          index.navLinks.push({ route, text })
        }
      }
      walk(element.children)
    }
  }
  walk(root.children)
}

/**
 * 一个文件的位置名候选。
 *
 * 各来源**分字段返回而不是只给一个有序数组**：数组只说得清优先级，说不清
 * "这个名字是从哪来的"，按位置读取就会把 h1 当成路由标题。
 */
export interface SurfaceCandidate {
  file: string
  /** 来源一：路由配置的 title / meta.title。 */
  routeTitle?: string
  /** 来源二：页面根组件内的 h1 文本。 */
  heading?: string
  /** 来源三：导航 / 面包屑中指向该路由的链接文案。 */
  navText?: string
  /** 关联到的路由路径（兜底用，绝不用文件路径兜底）。 */
  route?: string
  /** 组件 / 符号名（模型拟名时的素材）。 */
  symbol?: string
  /** 上面三项按优先级去重后的候选名列表。 */
  candidates: string[]
}

/** 路由条目是否指向该文件（组件名或懒加载模块说明符匹配）。 */
function routePointsTo(entry: RouteEntry, file: string, symbol: string | undefined): boolean {
  if (entry.component !== undefined && symbol !== undefined && entry.component === symbol) return true
  if (entry.module === undefined) return false
  const base = entry.module.replace(/^[./]+/u, '').replace(/\.(?:tsx?|jsx?|vue)$/u, '')
  const target = file.replace(/\.(?:tsx?|jsx?|vue)$/u, '')
  return base.length > 0 && (target.endsWith(base) || target.endsWith(`${base}/index`))
}

/**
 * 为一个文件计算人话位置名候选（spec §3.4 的优先级顺序）。
 * @param index - 扫描期累积的素材索引。
 * @param file - 相对项目根的文件路径。
 * @returns 候选名（可能为空）与关联路由。
 */
export function surfaceCandidatesFor(index: SurfaceIndex, file: string): SurfaceCandidate {
  const symbol = index.symbols.get(file)
  const entry = index.routes.find((route) => routePointsTo(route, file, symbol))
  const heading = index.headings.get(file)
  const navText = entry === undefined
    ? undefined
    : index.navLinks.find((link) => link.route === entry.route)?.text
  const candidates = [entry?.title, heading, navText]
    .filter((value): value is string => value !== undefined)
  return {
    file,
    ...(entry?.title === undefined ? {} : { routeTitle: entry.title }),
    ...(heading === undefined ? {} : { heading }),
    ...(navText === undefined ? {} : { navText }),
    ...(entry === undefined ? {} : { route: entry.route }),
    ...(symbol === undefined ? {} : { symbol }),
    candidates: [...new Set(candidates)],
  }
}

/** 看起来像文件路径 / 代码标识而非人话页面名。 */
export function looksLikeFilePath(value: string): boolean {
  return /\.(?:tsx?|jsx?|vue|css|scss)\b/u.test(value)
    || /(?:^|[\\/])(?:src|app|pages|components|views)[\\/]/u.test(value)
    || value.includes('\\')
    || /^[.~@]?\//u.test(value)
}

/**
 * 定稿时的 surface 净化与兜底：
 * 模型给的名字像文件路径 → 换成路由路径 → 再不行退到组件名。
 * **任何情况下都不会返回文件路径**（spec §8 验收）。
 * @param proposed - 模型给出的位置名（可能缺失或不合格）。
 * @param fallback - 兜底素材：路由路径与组件名。
 * @returns 可直接上界面的人话位置名。
 */
export function sanitizeSurface(
  proposed: string | undefined,
  fallback: { route?: string; symbol?: string },
): string {
  const trimmed = proposed?.trim() ?? ''
  if (trimmed.length > 0 && !looksLikeFilePath(trimmed)) return trimmed
  if (fallback.route !== undefined && fallback.route.trim().length > 0) return fallback.route.trim()
  if (fallback.symbol !== undefined && fallback.symbol.trim().length > 0) return fallback.symbol.trim()
  return '未命名页面'
}
