import type { AstCandidate, AstExtractOptions } from './ast'

const EMOJI = /\p{Extended_Pictographic}/u
const SPACING_DECLARATION = /\b(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block))?\s*:\s*([0-9]+(?:\.[0-9]+)?)px\b/giu
const BLOCK = /([^{}]+)\{([^{}]*)\}/gu

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function snippet(text: string, max = 180): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

/**
 * CSS/SCSS/Less 的保守候选扫描。它只定位可能影响布局密度与视觉语言的信号；
 * R-10/R-12 仍要求真实页面截图，不能由 CSS 候选直接定稿。
 */
export function extractCssCandidates(
  file: string,
  source: string,
  options: AstExtractOptions,
): AstCandidate[] {
  const candidates: AstCandidate[] = []
  const perRule = new Map<string, number>()
  const add = (candidate: Omit<AstCandidate, 'file'>): void => {
    if (candidates.length >= options.maxPerFile) return
    const count = perRule.get(candidate.rule) ?? 0
    if (count >= options.maxPerRule) return
    perRule.set(candidate.rule, count + 1)
    candidates.push({ ...candidate, file })
  }

  const spacing = [...source.matchAll(SPACING_DECLARATION)]
  const values = new Set(spacing.map((match) => Number.parseFloat(match[1] ?? '0')).filter((value) => value > 0))
  if (spacing.length >= 8 && values.size >= 6) {
    const first = spacing[0]
    add({
      rule: 'R-10',
      line: lineAt(source, first?.index ?? 0),
      snippet: `spacing values: ${[...values].sort((a, b) => a - b).join(', ')}px`,
      note: '同一文件出现较多离散间距值，可能削弱页面分组与留白的一致性；必须结合真实页面截图确认',
      verified_by: 'model+ast',
    })
  }

  for (const match of source.matchAll(BLOCK)) {
    const selector = match[1] ?? ''
    const body = match[2] ?? ''
    const offset = match.index ?? 0
    const compactLayout = /display\s*:\s*(?:flex|grid)/iu.test(body)
      && /(?:^|;)\s*gap\s*:\s*(?:0|[1-4](?:\.\d+)?)px/iu.test(body)
      && /(?:^|;)\s*padding\s*:\s*(?:0|[1-4](?:\.\d+)?)px/iu.test(body)
    if (compactLayout) {
      add({
        rule: 'R-10',
        line: lineAt(source, offset),
        snippet: snippet(`${selector} { ${body} }`),
        note: 'flex/grid 容器同时使用很小的 gap 与 padding，可能造成内容拥挤；必须用对应视口截图确认',
        verified_by: 'model+ast',
      })
    }

    const content = /\bcontent\s*:\s*(['"])(.*?)\1/iu.exec(body)?.[2]
    if (content !== undefined && EMOJI.test(content)) {
      add({
        rule: 'R-12',
        line: lineAt(source, offset),
        snippet: snippet(`${selector} { content: "${content}" }`),
        note: 'CSS 伪元素使用 Emoji/装饰符号；是否与产品视觉语言一致需结合产品类型和截图判断',
        verified_by: 'model+ast',
      })
    }
  }

  return candidates
}
