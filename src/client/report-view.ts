/**
 * UX 走查报告卡片渲染器（spec §R4 确认闭环）。
 *
 * 逐条渲染 finding：严重度徽标、定位（file/symbol）、依据与建议，
 * pending 状态提供「成立 / 不成立」按钮；判定后按钮消失、状态内联展示。
 * 点击经注入面的 judge() → commands remote → Host 写入 `ux/finding-status`
 * 会话事件 → Definition.update 驱动本卡片实时刷新（无本地状态依赖）。
 *
 * 纯 React.createElement（无 JSX）；样式内联，不触碰全局主题与 DOM。
 */

import { createElement, useState, type CSSProperties } from 'react'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
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

const FINDING: CSSProperties = {
  borderTop: '1px solid rgba(128, 128, 128, 0.22)',
  padding: '8px 0',
}

const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }

const BADGE: CSSProperties = {
  borderRadius: 999,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const LOCATOR: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 }

const TEXT: CSSProperties = { margin: '4px 0', color: 'inherit' }

const SUGGEST: CSSProperties = { margin: '4px 0', color: 'rgba(128, 128, 128, 1)' }

const ACTIONS: CSSProperties = { display: 'flex', gap: 8, marginTop: 8 }

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

function findingRow(
  finding: UxFindingView,
  reportId: string,
  onJudge: (findingId: string, status: 'confirmed' | 'rejected') => void,
  busy: boolean,
): ReturnType<typeof createElement> {
  const levelStyle = LEVEL_STYLE[finding.level] ?? BADGE
  const locator = finding.file + (finding.line === undefined ? '' : `:${finding.line}`)
    + (finding.symbol === undefined ? '' : `（${finding.symbol}）`)
  return createElement('div', { key: finding.id, style: FINDING },
    createElement('div', { style: HEAD },
      createElement('span', { style: { ...BADGE, ...levelStyle } }, `${finding.level} ${finding.rule}`),
      createElement('span', { style: LOCATOR }, locator),
      finding.status === 'confirmed'
        ? createElement('span', { style: STATUS_BADGE.confirmed }, '✓ 已确认成立')
        : finding.status === 'rejected'
          ? createElement('span', { style: STATUS_BADGE.rejected }, '✗ 已确认不成立')
          : null,
    ),
    createElement('p', { style: TEXT }, finding.rationale),
    createElement('p', { style: SUGGEST }, `建议：${finding.suggestion}`),
    createElement('p', { style: META }, `命中画像：${finding.persona_refs.join('、')}｜分类：${finding.category}`),
    finding.status === 'pending'
      ? createElement('div', { style: ACTIONS },
        createElement('button', {
          type: 'button',
          style: CONFIRM_BUTTON,
          disabled: busy,
          onClick: () => onJudge(finding.id, 'confirmed'),
        }, '成立'),
        createElement('button', {
          type: 'button',
          style: REJECT_BUTTON,
          disabled: busy,
          onClick: () => onJudge(finding.id, 'rejected'),
        }, '不成立'),
      )
      : null,
  )
}

/** 报告卡片组件：按 P0→P3 渲染 findings，处理判定交互与瞬时错误。 */
export function UxReportNodeView({ node, judge }: UxReportNodeViewProps): ReturnType<typeof createElement> {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const data = node.data
  const sorted = [...data.findings].sort((left, right) =>
    (SEVERITY_ORDER[left.level] ?? 9) - (SEVERITY_ORDER[right.level] ?? 9))
  const confirmed = data.findings.filter((finding) => finding.status === 'confirmed').length

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

  return createElement('div', { style: CARD },
    createElement('p', { style: TITLE }, `UX 走查报告：${data.title}`),
    createElement('p', { style: META },
      `报告 ${data.reportId}｜共 ${data.findings.length} 条｜已确认 ${confirmed} 条（仅 confirmed 计入最终清单）`),
    ...sorted.map((finding) => findingRow(finding, data.reportId, onJudge, busyId !== null)),
    error === null ? null : createElement('p', { style: ERROR }, `判定提交失败：${error}`),
    createElement('p', { style: FOOTER },
      '证据等级 static：本版仅静态源码证据，不覆盖视觉类问题（对比度、热区尺寸、文字截断、焦点顺序）。'),
  )
}
