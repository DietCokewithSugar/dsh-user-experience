/**
 * 跨走查指纹（v0.1.1 spec §6.2）。
 *
 * 隐式确认要回答的问题是"上次那条问题，这次还在不在"。这需要一个**在代码
 * 编辑之后仍然稳定**的标识——**不能用 `file:line`**，加一行代码位置就漂了。
 *
 * ```
 * fingerprint = hash(
 *   rule_id,          // R-06
 *   symbol_path,      // src/pages/Admin/UserTable.tsx::UserTable::handleDelete
 *   feature_digest    // 文案类取文案 hash；结构类取被指认元素的语法特征
 * )
 * ```
 *
 * - `persona_refs` **不进指纹**——同一问题被不同 persona 命中时是合并的；
 * - `surface` **不进指纹**——人话名称会变。
 *
 * 重命名会让 symbol_path 漂移，所以比对不是纯等值：**三元组中两项相同即
 * 视为同一问题**，进入模糊匹配。
 */

import { createHash } from 'node:crypto'

/** 指纹的三元组组成部分。 */
export interface FingerprintParts {
  /** 规则 ID（R-01 … R-27）。 */
  rule: string
  /** 符号路径：`file::symbol`，可再带一层最内层函数名。 */
  symbolPath: string
  /** 特征摘要：文案类取文案，结构类取语法特征描述。 */
  featureDigest: string
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 构造符号路径。行号**不参与**——加一行代码不该让指纹漂移。
 * @param file - 相对项目根的文件路径。
 * @param symbol - 组件 / 符号名（缺省时只用文件路径）。
 * @param member - 更内层的成员名（如事件处理函数），可选。
 * @returns `file::symbol::member` 形式的稳定路径。
 */
export function symbolPathOf(file: string, symbol?: string, member?: string): string {
  return [file, symbol, member].filter((part): part is string =>
    typeof part === 'string' && part.trim().length > 0).join('::')
}

/**
 * 归一化特征原文后取摘要：空白折叠 + 小写，避免格式化改动导致漂移。
 * @param feature - 文案原文或结构特征描述；空值时退到规则本身。
 * @param fallback - 特征缺失时的兜底串（通常是 rule + symbolPath）。
 * @returns 16 位十六进制摘要。
 */
export function featureDigestOf(feature: string | undefined, fallback: string): string {
  const raw = feature === undefined || feature.trim().length === 0 ? fallback : feature
  const normalized = raw.replace(/\s+/gu, ' ').trim().toLowerCase()
  return sha(normalized).slice(0, 16)
}

/**
 * 由三元组计算指纹。
 * @param parts - 规则、符号路径、特征摘要。
 * @returns 16 位十六进制指纹。
 */
export function fingerprintOf(parts: FingerprintParts): string {
  return sha([parts.rule, parts.symbolPath, parts.featureDigest].join('|')).slice(0, 16)
}

/**
 * 模糊匹配：三元组中**任意两项相同**即视为同一问题（spec §6.2 的重命名缓解）。
 * @param left - 一侧三元组。
 * @param right - 另一侧三元组。
 * @returns 是否视为同一问题。
 */
export function isSameFinding(left: FingerprintParts, right: FingerprintParts): boolean {
  const matches = [
    left.rule === right.rule,
    left.symbolPath === right.symbolPath,
    left.featureDigest === right.featureDigest,
  ].filter(Boolean).length
  return matches >= 2
}
