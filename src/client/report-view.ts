/**
 * UX 走查报告卡片渲染器（spec §R4 确认闭环；v0.1.1 §3.3 卡片重构）。
 *
 * **卡片默认呈现只回答人关心的三件事**：哪个页面、出了什么事、严不严重。
 *
 * ```
 * ┌────────────────────────────────────────────┐
 * │ [一级问题]  管理员页面                       │
 * │ 删除用户后没有任何提示                       │
 * │                                            │
 * │ 管理员点击删除后界面没有任何变化，无法判断    │
 * │ 操作是否成功，很可能重复点击导致误删多条记录。 │
 * │                                            │
 * │  [ 确认存在 ]  [ 不是问题 ]   ▸ 技术细节     │
 * └────────────────────────────────────────────┘
 * ```
 *
 * 文件路径、规则 ID、P0~P3 都在折叠区里——它们是给 AI 看的，展开后可一键
 * 复制成结构化 YAML。用户确认问题成立后，卡片还会提供一份现象导向的任务
 * Prompt：要求编码 AI 先补齐完整项目上下文，不预设具体代码改法。review 模式下
 * 卡片底部还有批量确认条：勾选多条一并提交，用户不需要知道任何 ID。
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
  padding: '10px 0',
}

const HEAD: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }

const BADGE: CSSProperties = {
  borderRadius: 999,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 600,
  whiteSpace: 'nowrap',
}

const SURFACE: CSSProperties = { fontSize: 13, fontWeight: 600 }

const HEADLINE: CSSProperties = { margin: '6px 0 2px', fontSize: 14, fontWeight: 600 }

const DESCRIPTION: CSSProperties = { margin: '4px 0 0', color: 'inherit', whiteSpace: 'pre-wrap' }

const ACTIONS: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }

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

const LINK_BUTTON: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'rgba(128, 128, 128, 1)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '3px 4px',
}

const TECHNICAL: CSSProperties = {
  marginTop: 8,
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px dashed rgba(128, 128, 128, 0.4)',
  background: 'rgba(128, 128, 128, 0.06)',
}

const CODE: CSSProperties = {
  margin: 0,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 11.5,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const STATUS_BADGE: Record<string, CSSProperties> = {
  confirmed_explicit: { color: '#3f9d63', fontWeight: 600, fontSize: 12 },
  confirmed_implicit: { color: '#3f9d63', fontWeight: 600, fontSize: 12 },
  rejected: { color: '#d06b64', fontWeight: 600, fontSize: 12 },
  stale: { color: 'rgba(128, 128, 128, 0.9)', fontWeight: 600, fontSize: 12 },
}

const COPY = {
  'zh-CN': {
    confirmed: '确认存在',
    rejected: '不是问题',
    status: {
      confirmed_explicit: '✓ 已确认存在',
      confirmed_implicit: '✓ 已改掉（下次走查中消失）',
      rejected: '✗ 不是问题',
      stale: '— 本次未覆盖，无法判定',
    } as Record<string, string>,
    select: '选择',
    prompt: '复制给 AI 的任务 Prompt',
    promptCopied: '已复制，可交给 AI',
    copyFailed: '复制失败，请重试',
    detailsOpen: '▾ 技术细节',
    detailsClosed: '▸ 技术细节',
    techCopied: '已复制，可直接粘给 AI',
    manualCopy: '复制失败，请手动选中上方文本',
    copyTech: '复制技术细节',
    report: 'UX 走查',
    allJudged: '已全部判定',
    total: '共',
    pending: '条待你判断',
    judged: '已判定',
    selected: '已选',
    selectMany: '勾选多条可一并提交',
    confirmSelected: '确认选中',
    rejectSelected: '选中的不是问题',
    ignoreMinor: '三级以下全部忽略',
    submitFailed: '判定提交失败',
    footer: '也可以直接描述要确认或排除的问题，不需要填写内部编号。',
  },
  en: {
    confirmed: 'Confirm',
    rejected: 'Not an issue',
    status: {
      confirmed_explicit: '✓ Confirmed',
      confirmed_implicit: '✓ Improved (gone after re-scan)',
      rejected: '✗ Not an issue',
      stale: '— Not covered by this scan',
    } as Record<string, string>,
    select: 'Select',
    prompt: 'Copy task Prompt for AI',
    promptCopied: 'Copied for AI',
    copyFailed: 'Copy failed; try again',
    detailsOpen: '▾ Technical details',
    detailsClosed: '▸ Technical details',
    techCopied: 'Copied for AI',
    manualCopy: 'Copy failed; select the text above',
    copyTech: 'Copy technical details',
    report: 'UX walkthrough',
    allJudged: 'all reviewed',
    total: 'Total',
    pending: 'awaiting review',
    judged: 'reviewed',
    selected: 'Selected',
    selectMany: 'Select findings to submit together',
    confirmSelected: 'Confirm selected',
    rejectSelected: 'Reject selected',
    ignoreMinor: 'Ignore level three/four',
    submitFailed: 'Could not save verdict',
    footer: 'You can also describe which findings to confirm or reject; no internal IDs are required.',
  },
}
type CardCopy = (typeof COPY)[keyof typeof COPY]

const BULK: CSSProperties = {
  borderTop: '1px solid rgba(128, 128, 128, 0.22)',
  paddingTop: 10,
  marginTop: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
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

/** 复制到剪贴板；剪贴板不可用时退回选中文本框让用户手动复制。 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

interface FindingRowProps {
  finding: UxFindingView
  busy: boolean
  selectable: boolean
  selected: boolean
  copy: CardCopy
  onToggle: (id: string) => void
  onJudge: (findingIds: readonly string[], verdict: 'confirmed' | 'rejected') => void
}

function FindingRow({
  finding, busy, selectable, selected, copy, onToggle, onJudge,
}: FindingRowProps): ReturnType<typeof createElement> {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [promptCopied, setPromptCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const levelStyle = LEVEL_STYLE[finding.level] ?? {}
  const pending = finding.status === 'pending'
  const confirmedByUser = finding.status === 'confirmed_explicit'

  return createElement('div', { style: FINDING },
    createElement('div', { style: HEAD },
      selectable && pending
        ? createElement('input', {
          type: 'checkbox',
          checked: selected,
          disabled: busy,
          onChange: () => onToggle(finding.id),
          'aria-label': `${copy.select}: ${finding.headline}`,
        })
        : null,
      createElement('span', { style: { ...BADGE, ...levelStyle } }, finding.severityLabel),
      createElement('span', { style: SURFACE }, finding.surface),
      pending
        ? null
        : createElement('span', { style: STATUS_BADGE[finding.status] ?? {} },
          copy.status[finding.status] ?? finding.status),
    ),
    createElement('p', { style: HEADLINE }, finding.headline),
    finding.description.length === 0
      ? null
      : createElement('p', { style: DESCRIPTION }, finding.description),
    createElement('div', { style: ACTIONS },
      pending
        ? createElement('button', {
          type: 'button',
          style: CONFIRM_BUTTON,
          disabled: busy,
          onClick: () => onJudge([finding.id], 'confirmed'),
        }, copy.confirmed)
        : null,
      pending
        ? createElement('button', {
          type: 'button',
          style: REJECT_BUTTON,
          disabled: busy,
          onClick: () => onJudge([finding.id], 'rejected'),
        }, copy.rejected)
        : null,
      confirmedByUser
        ? createElement('button', {
          type: 'button',
          style: CONFIRM_BUTTON,
          onClick: () => {
            void copyText(finding.deliveryPrompt).then((ok) => setPromptCopied(ok ? 'ok' : 'fail'))
          },
        }, promptCopied === 'ok' ? copy.promptCopied
          : promptCopied === 'fail' ? copy.copyFailed
            : copy.prompt)
        : null,
      createElement('button', {
        type: 'button',
        style: LINK_BUTTON,
        onClick: () => setExpanded(!expanded),
        'aria-expanded': expanded,
      }, expanded ? copy.detailsOpen : copy.detailsClosed),
    ),
    expanded
      ? createElement('div', { style: TECHNICAL },
        createElement('pre', { style: CODE }, finding.technicalYaml),
        createElement('button', {
          type: 'button',
          style: { ...LINK_BUTTON, paddingLeft: 0 },
          onClick: () => {
            void copyText(finding.technicalYaml).then((ok) => setCopied(ok ? 'ok' : 'fail'))
          },
        }, copied === 'ok' ? copy.techCopied
          : copied === 'fail' ? copy.manualCopy
            : copy.copyTech),
      )
      : null,
  )
}

/** 报告卡片组件：人话在前，技术细节折叠，review 模式提供批量确认。 */
export function UxReportNodeView({ node, judge }: UxReportNodeViewProps): ReturnType<typeof createElement> {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const data = node.data
  const copy = data.language === 'en' ? COPY.en : COPY['zh-CN']
  const sorted = [...data.findings].sort((left, right) =>
    (SEVERITY_ORDER[left.level] ?? 9) - (SEVERITY_ORDER[right.level] ?? 9))
  const pendingFindings = sorted.filter((finding) => finding.status === 'pending')
  const judged = data.findings.length - pendingFindings.length
  // auto 模式不打断人：不渲染批量确认条，单条按钮仍然长期可点。
  const selectable = data.mode === 'review' && pendingFindings.length > 1

  const submit = (findingIds: readonly string[], verdict: 'confirmed' | 'rejected'): void => {
    if (findingIds.length === 0) return
    setBusy(true)
    setError(null)
    void judge(data.reportId, findingIds, verdict)
      .then((failure) => {
        if (failure !== null) setError(failure)
        else setSelected([])
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setBusy(false))
  }

  const toggle = (id: string): void => {
    setSelected(selected.includes(id)
      ? selected.filter((item) => item !== id)
      : [...selected, id])
  }

  const minorPending = pendingFindings.filter((finding) =>
    finding.level === 'P2' || finding.level === 'P3').map((finding) => finding.id)

  return createElement('div', { style: CARD },
    createElement('p', { style: TITLE }, `${copy.report}: ${data.title}`),
    createElement('p', { style: META },
      pendingFindings.length === 0
        ? `${copy.total} ${data.findings.length}, ${copy.allJudged}`
        : `${copy.total} ${data.findings.length}, ${pendingFindings.length} ${copy.pending}`
          + `${judged > 0 ? ` (${copy.judged} ${judged})` : ''}`),
    ...sorted.map((finding) => createElement(FindingRow, {
      key: finding.id,
      finding,
      busy,
      selectable,
      selected: selected.includes(finding.id),
      copy,
      onToggle: toggle,
      onJudge: submit,
    })),
    selectable
      ? createElement('div', { style: BULK },
        createElement('span', { style: { fontSize: 12, color: 'rgba(128,128,128,0.9)' } },
          selected.length === 0 ? `${copy.selectMany}:` : `${copy.selected} ${selected.length}:`),
        createElement('button', {
          type: 'button',
          style: CONFIRM_BUTTON,
          disabled: busy || selected.length === 0,
          onClick: () => submit(selected, 'confirmed'),
        }, copy.confirmSelected),
        createElement('button', {
          type: 'button',
          style: REJECT_BUTTON,
          disabled: busy || selected.length === 0,
          onClick: () => submit(selected, 'rejected'),
        }, copy.rejectSelected),
        minorPending.length === 0
          ? null
          : createElement('button', {
            type: 'button',
            style: LINK_BUTTON,
            disabled: busy,
            onClick: () => submit(minorPending, 'rejected'),
          }, `${copy.ignoreMinor} (${minorPending.length})`),
      )
      : null,
    error === null ? null : createElement('p', { style: ERROR }, `${copy.submitFailed}: ${error}`),
    createElement('p', { style: FOOTER },
      copy.footer),
  )
}
