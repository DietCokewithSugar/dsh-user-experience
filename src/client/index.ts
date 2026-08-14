/**
 * dsh-user-experience — Client 侧插件（Web 会话内报告卡片，spec §R4）。
 *
 * 通过本包的 `dsh.client` 声明被 Web 模块表发现（`exports["./client"]`）。
 * 职责：
 * - 注册 `ux-report` ConversationNodeDefinition：从会话日志的
 *   `ux/report`（start）与 `ux/finding-status`（update）事件增量组装报告
 *   状态，支持分页重放——判定是持久化会话状态，重新加载会话完整恢复；
 * - 在 `conversation.chat.node` 注册 keyed 渲染器：首屏只给人话，技术细节
 *   折叠；review 模式下提供批量确认；点击经 commands remote 执行判定，
 *   写回会话日志后由 Definition.update 驱动卡片实时更新。
 *
 * 红线：渲染器只消费 node.data 与注入面，不扫描会话窗口或其他节点；
 * 跨插件协作走 cordis 服务（remote.commands），不 import 其他插件的运行值。
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ClientContext, ConversationLocation, ConversationNodeContext,
  ConversationNodeDefinition, SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
// 类型侧：加载 ChatNodeDataMap / SlotMap 合并（模块增强的目标必须在本程序中被引用）。
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { deliveryPrompt, severityLabel, technicalYaml } from '../types'
import type { FindingStatus, UxFinding, UxMode } from '../types'
import { UxReportNodeView } from './report-view'

/**
 * 渲染器可见的单条 finding 视图。
 *
 * **双读者在这里就是分开的**：`surface` / `severityLabel` / `headline` /
 * `description` 上首屏；`technicalYaml` 是折叠区里可一键复制的整块。
 * `level` 只用于配色，不显示字面量（P0~P3 是内部标识，不上界面）。
 */
export interface UxFindingView {
  id: string
  surface: string
  severityLabel: string
  headline: string
  description: string
  /** 内部严重度，仅用于徽标配色与排序。 */
  level: string
  /** 折叠区展示与复制的结构化技术细节。 */
  technicalYaml: string
  /** 用户确认问题后，可直接交给编码 AI 的现象导向任务 Prompt。 */
  deliveryPrompt: string
  status: FindingStatus
}

/** 报告卡片数据（ChatNodeDataMap 注册值）。 */
export interface UxReportChatData {
  reportId: string
  title: string
  /** 运行模式：review 才渲染批量确认条（auto 不打断人）。 */
  mode: UxMode
  findings: ReadonlyArray<UxFindingView>
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** dsh-user-experience 的 UX 走查报告卡片。 */
    'ux-report': UxReportChatData
  }
}

/** 组装器内部状态：携带完整 finding 对象，update 时替换单条状态。 */
interface UxReportState {
  reportId: string
  title: string
  mode: UxMode
  findings: readonly UxFinding[]
}

/** v0.1 的扁平 finding 形状（历史会话重放时仍可能出现）。 */
interface LegacyFinding {
  id: string
  rule?: string
  category?: string
  persona_refs?: string[]
  severity?: { impact?: string; reach?: string; level?: string }
  evidence?: {
    level?: string
    verified_by?: string
    locator?: { file?: string; symbol?: string; line?: number }
    rationale?: string
  }
  suggestion?: string
  status?: string
}

/**
 * 把任意版本的事件载荷归一成当前结构。
 *
 * v0.1 的日志里 finding 是扁平的（evidence / severity 在顶层，没有 human /
 * surface / fingerprint），历史会话重放时必须还能渲染——归一后 surface 退到
 * 组件名，headline 退到依据原文，**仍然不会显示文件路径**。
 * @param raw - 事件里的一条 finding（可能是旧形状）。
 * @returns 当前结构的 finding。
 */
export function normalizeFinding(raw: UxFinding | LegacyFinding): UxFinding {
  if ('human' in raw && 'technical' in raw) return raw
  const legacy = raw as LegacyFinding
  const level = legacy.severity?.level ?? 'P3'
  const locator = legacy.evidence?.locator ?? { file: '' }
  const rationale = legacy.evidence?.rationale ?? ''
  const status: FindingStatus = legacy.status === 'confirmed' ? 'confirmed_explicit'
    : legacy.status === 'rejected' ? 'rejected'
      : 'pending'
  return {
    id: legacy.id,
    fingerprint: '',
    surface: locator.symbol ?? '（历史报告，未记录页面名）',
    human: {
      headline: rationale.length > 0 ? rationale : '（历史报告，未记录问题描述）',
      description: legacy.suggestion ?? '',
      severity_label: severityLabel(level),
    },
    technical: {
      locator: {
        file: locator.file ?? '',
        ...(locator.symbol === undefined ? {} : { symbol: locator.symbol }),
        ...(locator.line === undefined ? {} : { line: locator.line }),
      },
      rule: legacy.rule ?? '',
      category: (legacy.category ?? 'state-coverage') as UxFinding['technical']['category'],
      verified_by: (legacy.evidence?.verified_by ?? 'model') as UxFinding['technical']['verified_by'],
      evidence_level: 'static',
      persona_refs: legacy.persona_refs ?? [],
      severity: {
        impact: (legacy.severity?.impact ?? 'low') as UxFinding['technical']['severity']['impact'],
        impact_confidence: 'medium',
        reach: (legacy.severity?.reach ?? 'narrow') as UxFinding['technical']['severity']['reach'],
        level: level as UxFinding['technical']['severity']['level'],
      },
      rationale,
      suggestion: legacy.suggestion ?? '',
    },
    status,
  }
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

function viewData(state: UxReportState): UxReportChatData {
  return {
    reportId: state.reportId,
    title: state.title,
    mode: state.mode,
    findings: state.findings.map((finding) => ({
      id: finding.id,
      surface: finding.surface,
      severityLabel: finding.human.severity_label,
      headline: finding.human.headline,
      description: finding.human.description,
      level: finding.technical.severity.level,
      technicalYaml: technicalYaml(finding),
      deliveryPrompt: deliveryPrompt(finding),
      status: finding.status,
    })),
  }
}

/** 报告状态机定义（导出供测试与复用；注册见 apply）。 */
export const uxReportDefinition: ConversationNodeDefinition<UxReportState> = {  kind: 'ux-report',
  target: 'chat',
  match: (event) => {
    if (event.type === 'ux/report') {
      return { id: event.data.reportId, role: 'start' }
    }
    if (event.type === 'ux/finding-status') {
      return { id: event.data.reportId, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'ux/report') throw new Error('ux-report requires ux/report')
    return {
      reportId: match.event.data.reportId,
      title: match.event.data.title,
      mode: match.event.data.mode ?? 'review',
      findings: match.event.data.findings.map(normalizeFinding),
    }
  },
  update: (context, match) => {
    // 注意：属性路径的窄化不会进入 map 回调闭包，先把判定数据解构到局部变量。
    if (match.event.type !== 'ux/finding-status') return context.state
    const { findingId, status } = match.event.data
    return {
      ...context.state,
      findings: context.state.findings.map((finding) => finding.id === findingId
        ? { ...finding, status }
        : finding),
    }
  },
  publication: () => 'immediate',
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'ux-report',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'visible',
      data: viewData(context.state),
    }
  },
}

/**
 * 注入面：judge 闭包持有判定通道（经 commands remote 回 Host）。
 * 支持一次提交多条——批量确认条就靠它。
 */
export interface JudgeFace {
  judge: (
    reportId: string,
    findingIds: readonly string[],
    verdict: 'confirmed' | 'rejected',
  ) => Promise<string | null>
}

export const inject = ['conversationEvents', 'slots', 'remote', 'remote.commands']

/** Client 插件主体。 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(uxReportDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'ux-report',
    inject: (sessionId: SessionId): JudgeFace => ({
      judge: async (reportId, findingIds, verdict): Promise<string | null> => {
        if (findingIds.length === 0) return null
        const result = await ctx.remote.commands.execute(
          sessionId,
          `/ux judge ${reportId} ${findingIds.join(',')} ${verdict}`,
        )
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return '判定通道不可用'
        return null
      },
    }),
  }, UxReportNodeView))
}

export type { ChatNodeViewProps }
