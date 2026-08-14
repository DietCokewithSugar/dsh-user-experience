/**
 * UX 走查报告卡片渲染器（spec §R4 确认闭环）。
 *
 * 卡片分两屏，因为读它的是产品/运营而不是编译器：
 * - 第一屏（默认可见）：**在哪儿**（场景）+ **发生了什么**（一句话人话）+
 *   **影响谁**，加严重度说法（一级…四级问题）与「确认是问题 / 不是问题」按钮。
 *   人只需要判断"这算不算问题"，不需要读错误成因。
 * - 第二屏（折叠）：文件位置、规则、判定依据、修复方向；配「复制给 AI」，
 *   把这段技术细节整段交给模型去改，人不必逐字阅读。
 *
 * 判定点击经注入面的 judge() → commands remote → Host 写入
 * `ux/finding-status` 会话事件 → Definition.update 驱动本卡片实时刷新
 * （判定状态无本地状态依赖；只有展开/复制这类瞬时视图状态留在组件内）。
 *
 * 纯 React.createElement（无 JSX）；样式内联，不触碰全局主题与 DOM。
 */

import { createElement, useState, type CSSProperties, type ReactNode } from 'react'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { handoffBundle, handoffText, locatorText } from '../human'
import type { JudgeFace, UxFindingView } from './index'

const SEVERITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/** 严重度徽标配色（中性化，深浅色模式下均可读）。 */
const LEVEL_STYLE: Record<string, CSSProperties> = {
  P0: { background: 'rgba(229, 83, 75, 0.14)', color: '#e5534b', border: '1px solid rgba(229, 83, 75, 0.45)' },
  P1: { background: 'rgba(233, 148, 40, 0.14)', color: '#d98b23', border: '1px solid rgba(233, 148, 40, 0.45)' },
  P2: { background: 'rgba(84, 145, 219, 0.14)', color: '#5489db', border: '1px solid rgba(84, 145, 219, 0.45)' },
  P3: { background: 'rgba(128, 128, 128, 0.12)', color: '#909090', border: '1px solid rgba(128, 128, 128, 0.35)' },
}

const CARD: CSSProperties = {
  border: '1px solid rgba(128, 128, 128, 0.35)',
  borderRadius: 8,
  padding: '12px 14px',
  margin: '8px 0',
  maxWidth: 720,
  fontSize: 13,
  lineHeight: 1.55,
}

const TITLE: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 }

const META: CSSProperties = { color: 'rgba(128, 128, 128, 0.9)', fontSize: 12, margin: '2px 0 10px' }

const HEADER_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
}

const FINDING: CSSProperties = {
  borderTop: '1px solid rgba(128, 128, 128, 0.22)',
  padding: '10px 0',
}

const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }

const BADGE: CSSProperties = {
  borderRadius: 999,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

/** 场景名：卡片第一屏的主语，"在哪儿发现的"。 */
const SCENE: CSSProperties = { fontSize: 13, fontWeight: 600 }

/** 一句话人话结论：卡片上字号最大的一行，人只需要读这句。 */
const SUMMARY: CSSProperties = { margin: '6px 0 0', fontSize: 13.5, lineHeight: 1.6 }

const CONSEQUENCE: CSSProperties = { margin: '4px 0 0', color: 'rgba(128, 128, 128, 1)' }

const AUDIENCE: CSSProperties = { margin: '4px 0 0', color: 'rgba(128, 128, 128, 0.9)', fontSize: 12 }

const ACTIONS: CSSProperties = { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }

const BUTTON_BASE: CSSProperties = {
  borderRadius: 6,
  border: '1px solid rgba(128, 128, 128, 0.45)',
  background: 'transparent',
  padding: '3px 12px',
  fontSize: 12,
  cursor: 'pointer',
}

const CONFIRM_BUTTON: CSSProperties = { ...BUTTON_BASE, color: '#3f9d63', borderColor: 'rgba(63, 157, 99, 0.55)' }

const REJECT_BUTTON: CSSProperties = { ...BUTTON_BASE, color: '#d06b64', borderColor: 'rgba(208, 107, 100, 0.55)' }

const COPY_BUTTON: CSSProperties = { ...BUTTON_BASE, color: 'inherit', opacity: 0.85 }

/** 折叠区开关：做成纯文字按钮，避免抢第一屏的注意力。 */
const TOGGLE_BUTTON: CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  marginTop: 8,
  fontSize: 12,
  color: 'rgba(128, 128, 128, 1)',
  cursor: 'pointer',
  textAlign: 'left',
}

const DETAIL_PANEL: CSSProperties = {
  marginTop: 6,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid rgba(128, 128, 128, 0.28)',
  background: 'rgba(128, 128, 128, 0.06)',
  fontSize: 12,
}

const DETAIL_LINE: CSSProperties = { margin: '2px 0' }

const LOCATOR: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
}

const STATUS_BADGE: Record<'confirmed' | 'rejected', CSSProperties> = {
  confirmed: { color: '#3f9d63', fontWeight: 600, fontSize: 12 },
  rejected: { color: '#d06b64', fontWeight: 600, fontSize: 12 },
}

const FOOTER: CSSProperties = {
  borderTop: '1px solid rgba(128, 128, 128, 0.22)',
  paddingTop: 8,
  marginTop: 8,
  color: 'rgba(128, 128, 128, 0.9)',
  fontSize: 12,
}

const ERROR: CSSProperties = { color: '#d06b64', fontSize: 12, marginTop: 6 }

/**
 * 组件完整 props：会话标准套件 + keyed node + 注册注入面（JudgeFace）。
 * 未声明 locale 命名空间时运行时不会传 `t`，故从 ChatNodeViewProps 中剔除。
 */
interface UxReportNodeViewProps extends Omit<ChatNodeViewProps<'ux-report'>, 't'>, JudgeFace {}

/**
 * 写入剪贴板：优先 Clipboard API，非安全上下文/权限拒绝时回落到临时
 * textarea + execCommand，两条路都不通才报失败（复制是辅助动作，不阻断确认）。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard !== undefined) {
      await clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底方案。
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

/** 单条 finding 的交互回调与瞬时状态。 */
interface RowHandlers {
  expanded: boolean
  busy: boolean
  copied: boolean
  onToggle: (findingId: string) => void
  onJudge: (findingId: string, status: 'confirmed' | 'rejected') => void
  onCopy: (key: string, text: string) => void
}

/** 折叠区：技术细节 + 「复制给 AI」。人确认问题时不需要读这一屏。 */
function detailPanel(finding: UxFindingView, handlers: RowHandlers): ReactNode {
  return createElement('div', { style: DETAIL_PANEL },
    createElement('p', { style: { ...DETAIL_LINE, ...LOCATOR } },
      locatorText(finding.file, finding.symbol, finding.line)),
    createElement('p', { style: DETAIL_LINE },
      `规则：${finding.ruleName}｜分类：${finding.categoryName}｜证据：${finding.evidence}`),
    createElement('p', { style: DETAIL_LINE }, `判定依据：${finding.rationale}`),
    createElement('p', { style: DETAIL_LINE }, `修复方向：${finding.suggestion}`),
    createElement('div', { style: ACTIONS },
      createElement('button', {
        type: 'button',
        style: COPY_BUTTON,
        onClick: () => handlers.onCopy(finding.id, handoffText(finding)),
      }, handlers.copied ? '已复制 ✓' : '复制给 AI'),
    ),
  )
}

function findingRow(finding: UxFindingView, handlers: RowHandlers): ReactNode {
  const levelStyle = LEVEL_STYLE[finding.level] ?? BADGE
  const audience = finding.personaNames.length === 0 ? '' : `影响用户：${finding.personaNames.join('、')}`
  return createElement('div', { key: finding.id, style: FINDING },
    createElement('div', { style: HEAD },
      createElement('span', { style: { ...BADGE, ...levelStyle } }, finding.levelName),
      createElement('span', { style: SCENE }, finding.scene),
      finding.status === 'confirmed'
        ? createElement('span', { style: STATUS_BADGE.confirmed }, '✓ 已确认是问题')
        : finding.status === 'rejected'
          ? createElement('span', { style: STATUS_BADGE.rejected }, '✗ 已标记为不是问题')
          : null,
    ),
    createElement('p', { style: SUMMARY }, finding.summary),
    finding.consequence === undefined
      ? null
      : createElement('p', { style: CONSEQUENCE }, `影响：${finding.consequence}`),
    createElement('p', { style: AUDIENCE },
      [audience, finding.levelHint].filter((part) => part.length > 0).join('｜')),
    finding.status === 'pending'
      ? createElement('div', { style: ACTIONS },
        createElement('button', {
          type: 'button',
          style: CONFIRM_BUTTON,
          disabled: handlers.busy,
          onClick: () => handlers.onJudge(finding.id, 'confirmed'),
        }, '确认是问题'),
        createElement('button', {
          type: 'button',
          style: REJECT_BUTTON,
          disabled: handlers.busy,
          onClick: () => handlers.onJudge(finding.id, 'rejected'),
        }, '不是问题'),
      )
      : null,
    createElement('button', {
      type: 'button',
      style: TOGGLE_BUTTON,
      'aria-expanded': handlers.expanded,
      onClick: () => handlers.onToggle(finding.id),
    }, `${handlers.expanded ? '▾' : '▸'} 技术细节（文件位置 / 判定依据 / 修复方向）`),
    handlers.expanded ? detailPanel(finding, handlers) : null,
  )
}

/** 报告卡片组件：按 P0→P3 渲染 findings，处理判定、展开与复制。 */
export function UxReportNodeView({ node, judge }: UxReportNodeViewProps): ReturnType<typeof createElement> {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([])
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const data = node.data
  const sorted = [...data.findings].sort((left, right) =>
    (SEVERITY_ORDER[left.level] ?? 9) - (SEVERITY_ORDER[right.level] ?? 9))
  const confirmed = data.findings.filter((finding) => finding.status === 'confirmed').length
  const rejected = data.findings.filter((finding) => finding.status === 'rejected').length
  const pending = data.findings.length - confirmed - rejected
  // 交给 AI 的是"没被否掉的问题"：已确认的必改，待确认的先带上，被判定不成立的排除。
  const handoff = sorted.filter((finding) => finding.status !== 'rejected')

  const onJudge = (findingId: string, status: 'confirmed' | 'rejected'): void => {
    setBusyId(findingId)
    setError(null)
    void judge(data.reportId, findingId, status)
      .then((failure) => {
        if (failure !== null) setError(failure)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setBusyId(null))
  }

  const onToggle = (findingId: string): void => {
    setExpandedIds((current) => current.includes(findingId)
      ? current.filter((id) => id !== findingId)
      : [...current, findingId])
  }

  const onCopy = (key: string, text: string): void => {
    void copyText(text).then((ok) => {
      if (ok) {
        setCopiedKey(key)
        setError(null)
      } else {
        setError('复制失败：浏览器拒绝了剪贴板访问，请手动选中技术细节复制。')
      }
    })
  }

  const counters = [
    pending > 0 ? `${pending} 条待你确认` : null,
    confirmed > 0 ? `已确认 ${confirmed} 条` : null,
    rejected > 0 ? `已排除 ${rejected} 条` : null,
  ].filter((part) => part !== null).join('｜') || '本轮没有发现问题'

  return createElement('div', { style: CARD },
    createElement('div', { style: HEADER_ROW },
      createElement('p', { style: TITLE }, `UX 走查报告：${data.title}`),
      handoff.length === 0
        ? null
        : createElement('button', {
          type: 'button',
          style: COPY_BUTTON,
          onClick: () => onCopy('report', handoffBundle(data.title, data.reportId, handoff)),
        }, copiedKey === 'report' ? '已复制 ✓' : `复制全部技术细节（${handoff.length} 条）`),
    ),
    createElement('p', { style: META },
      `${counters}｜逐条看「发生了什么」，认为确实是问题就点「确认是问题」；只有确认成立的才计入最终清单。`),
    ...sorted.map((finding) => findingRow(finding, {
      expanded: expandedIds.includes(finding.id),
      busy: busyId !== null,
      copied: copiedKey === finding.id,
      onToggle,
      onJudge,
      onCopy,
    })),
    error === null ? null : createElement('p', { style: ERROR }, `操作失败：${error}`),
    createElement('p', { style: FOOTER },
      '证据等级 static：本版仅静态源码证据，不覆盖视觉类问题（对比度、热区尺寸、文字截断、焦点顺序）。'),
  )
}
