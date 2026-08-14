import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 固定界面当前完整支持的语言；模型生成的 finding 文本仍可使用其他语言。 */
export type OutputLanguage = 'zh-CN' | 'en'
export type ConfiguredLanguage = 'auto' | OutputLanguage

/** 把 BCP-47/自然语言名称归一到固定界面支持的语言。 */
export function normalizeLanguage(value: string | undefined): OutputLanguage | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'zh' || normalized.startsWith('zh-')
    || normalized.includes('chinese') || normalized.includes('中文')) return 'zh-CN'
  if (normalized === 'en' || normalized.startsWith('en-')
    || normalized.includes('english') || normalized.includes('英文')) return 'en'
  return undefined
}

/**
 * 从项目主 README 推断开发文档语言。双语仓库以 README.md 为准，因为它通常
 * 是默认落地页；无法判断时使用英语作为跨项目回退。
 */
export function detectProjectLanguage(root: string): OutputLanguage {
  const candidates = ['README.md', 'readme.md', 'README.zh.md']
  const file = candidates.map((name) => join(root, name)).find((path) => existsSync(path))
  if (file === undefined) return 'en'
  let text = ''
  try {
    text = readFileSync(file, 'utf8').slice(0, 12_000)
  } catch {
    return 'en'
  }
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const latin = text.match(/[A-Za-z]/gu)?.length ?? 0
  return han > latin * 0.35 ? 'zh-CN' : 'en'
}

/**
 * 输出语言优先级：插件显式配置 > 当前请求中模型识别的语言 > 项目主文档语言。
 */
export function resolveOutputLanguage(
  root: string,
  configured: ConfiguredLanguage,
  requested?: string,
): OutputLanguage {
  if (configured !== 'auto') return configured
  return normalizeLanguage(requested) ?? detectProjectLanguage(root)
}

export function isChinese(language: OutputLanguage): boolean {
  return language === 'zh-CN'
}
