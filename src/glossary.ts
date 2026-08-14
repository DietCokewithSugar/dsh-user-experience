/**
 * 术语表（`.ux/glossary.yml`）读写与增量合并（spec §5.4 / R-02）。
 *
 * R-02 是 9 条规则里跨文件比对最贵的一条：术语表持久化后，后续走查只对
 * 新增或变更的术语做增量判断，不重复全量比对。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'

export const GLOSSARY_FILE = '.ux/glossary.yml'

/** 一个术语条目：规范词 + 变体 + 判定备注。 */
export interface GlossaryTerm {
  /** 规范词（项目内应统一使用的词）。 */
  canonical: string
  /** 与规范词同义的其他写法。 */
  variants: string[]
  /** 判定备注（可选）。 */
  note?: string
}

export interface GlossaryFile {
  terms: GlossaryTerm[]
}

interface CacheEntry {
  mtimeMs: number
  glossary: GlossaryFile
}

const cache = new Map<string, CacheEntry>()

export function glossaryPath(root: string): string {
  return join(root, GLOSSARY_FILE)
}

/** 读取术语表；文件不存在时返回空表。 */
export function loadGlossary(root: string): GlossaryFile {
  const file = glossaryPath(root)
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    cache.delete(root)
    return { terms: [] }
  }
  const hit = cache.get(root)
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.glossary
  let glossary: GlossaryFile = { terms: [] }
  if (existsSync(file)) {
    const parsed = parse(readFileSync(file, 'utf8')) as unknown
    const terms = typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).terms
      : undefined
    if (Array.isArray(terms)) {
      glossary = {
        terms: terms.filter((term): term is GlossaryTerm => typeof term === 'object' && term !== null
          && typeof (term as GlossaryTerm).canonical === 'string'
          && Array.isArray((term as GlossaryTerm).variants)),
      }
    }
  }
  cache.set(root, { mtimeMs, glossary })
  return glossary
}

/** 校验并规范化一组术语更新。 */
export function validateTerms(updates: readonly GlossaryTerm[], where: string): GlossaryTerm[] {
  return updates.map((term, index) => {
    if (typeof term.canonical !== 'string' || term.canonical.trim().length === 0) {
      throw new TypeError(`${where}[${index}]：canonical 必须是非空字符串`)
    }
    if (!Array.isArray(term.variants) || term.variants.some((v) => typeof v !== 'string' || v.length === 0)) {
      throw new TypeError(`${where}[${index}]：variants 必须是非空字符串数组（可为空）`)
    }
    return {
      canonical: term.canonical.trim(),
      variants: [...new Set(term.variants.map((v) => v.trim()))],
      ...(term.note === undefined ? {} : { note: term.note }),
    }
  })
}

/**
 * 增量合并术语更新到 `.ux/glossary.yml`：
 * 同 canonical 条目合并变体并集，新条目追加；有变更才落盘。
 */
export function mergeGlossary(root: string, updates: readonly GlossaryTerm[]): GlossaryFile {
  const validated = validateTerms(updates, `${GLOSSARY_FILE} 更新`)
  if (validated.length === 0) return loadGlossary(root)
  const current = loadGlossary(root)
  const byCanonical = new Map(current.terms.map((term) => [term.canonical, term]))
  for (const update of validated) {
    const existing = byCanonical.get(update.canonical)
    if (existing === undefined) {
      byCanonical.set(update.canonical, update)
    } else {
      existing.variants = [...new Set([...existing.variants, ...update.variants])]
      if (update.note !== undefined) existing.note = update.note
    }
  }
  const glossary: GlossaryFile = { terms: [...byCanonical.values()] }
  const file = glossaryPath(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, stringify(glossary, { lineWidth: 100 }) + '\n', 'utf8')
  cache.set(root, { mtimeMs: statSync(file).mtimeMs, glossary })
  return glossary
}
