/**
 * dsh-user-experience — Client 侧插件（Web 会话内报告卡片，spec §R4）。
 *
 * 通过本包的 `dsh.client` 声明被 Web 模块表发现（`exports["./client"]`）。
 * 职责：
 * - 注册 `ux-report` ConversationNodeDefinition：从会话日志的
 *   `ux/report`（start）与 `ux/finding-status`（update）事件增量组装报告
 *   状态，支持分页重放——确认状态是持久化会话状态，重新加载会话完整恢复；
 * - 在 `conversation.chat.node` 注册 keyed 渲染器：逐条渲染 finding，
 *   提供「成立 / 不成立」按钮；点击经 commands remote 执行 `/ux judge`，
 *   判定写回会话日志后由 Definition.update 驱动卡片实时更新。
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
import {
  categoryWording, ruleWording, sceneFallback,
  severityWording, summaryFallback,
} from '../human'
import type { UxFinding } from '../types'
import { UxReportNodeView } from './report-view'

/**
 * 渲染器可见的单条 finding 视图。分两层：
 * - 人话层（scene / summary / consequence / levelName / personaNames）——卡片第一屏；
 * - 技术层（rule / file / line / rationale / suggestion …）——折叠区，供复制给 AI。
 */
export interface UxFindingView {
  id: string
  /** 人话层：场景/页面。 */
  scene: string
  /** 人话层：一句话说明发生了什么。 */
  summary: string
  /** 人话层：对用户造成的后果。 */
  consequence?: string
  /** 人话层：严重度说法（一级问题…四级问题）。 */
  levelName: string
  /** 人话层：该等级意味着什么。 */
  levelHint: string
  /** 人话层：命中画像的名称（无名称时回退 id）。 */
  personaNames: readonly string[]
  rule: string
  /** 技术层：规则完整说法（R-04 不可逆操作缺二次确认）。 */
  ruleName: string
  category: string
  /** 技术层：分类的中文说法。 */
  categoryName: string
  /** 技术层：证据等级 / 验证来源（static / model+ast）。 */
  evidence: string
  level: string
  persona_refs: readonly string[]
  file: string
  symbol?: string
  line?: number
  rationale: string
  suggestion: string
  status: 'pending' | 'confirmed' | 'rejected'
}

/** 报告卡片数据（ChatNodeDataMap 注册值）。 */
export interface UxReportChatData {
  reportId: string
  title: string
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
  /** 画像 id → 名称（老事件没带 personas 时为空，展示回退到 id）。 */
  personaNames: ReadonlyMap<string, string>
  findings: readonly UxFinding[]
}

function locationOf(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/**
 * 事件数据 → 卡片视图。人话层字段按"事件里有就用、没有就兜底"处理：
 * 加了人话层之前写入的会话日志同样要能重放，那些老 finding 没有
 * scene / summary，落到 human.ts 的兜底推导上。
 */
function viewData(state: UxReportState): UxReportChatData {
  return {
    reportId: state.reportId,
    title: state.title,
    findings: state.findings.map((finding) => {
      const { file, symbol, line } = finding.evidence.locator
      const level = finding.severity.level
      const wording = severityWording(level)
      const scene = finding.scene?.trim() ?? ''
      const summary = finding.summary?.trim() ?? ''
      const consequence = finding.consequence?.trim() ?? ''
      return {
        id: finding.id,
        scene: scene.length > 0 ? scene : sceneFallback(file, symbol),
        summary: summary.length > 0 ? summary : summaryFallback(finding.rule, finding.suggestion),
        ...(consequence.length > 0 ? { consequence } : {}),
        levelName: wording.name,
        levelHint: wording.hint,
        personaNames: finding.persona_refs.map((ref) => state.personaNames.get(ref) ?? ref),
        rule: finding.rule,
        ruleName: ruleWording(finding.rule),
        category: finding.category,
        categoryName: categoryWording(finding.category),
        evidence: `${finding.evidence.level} / ${finding.evidence.verified_by}`,
        level,
        persona_refs: finding.persona_refs,
        file,
        ...(symbol === undefined ? {} : { symbol }),
        ...(line === undefined ? {} : { line }),
        rationale: finding.evidence.rationale,
        suggestion: finding.suggestion,
        status: finding.status,
      }
    }),
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
      personaNames: new Map((match.event.data.personas ?? []).map((persona) => [persona.id, persona.name])),
      findings: match.event.data.findings,
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

/** 注入面：judge 闭包持有 reportId 判定通道（经 commands remote 回 Host）。 */
export interface JudgeFace {
  judge: (reportId: string, findingId: string, status: 'confirmed' | 'rejected') => Promise<string | null>
}

export const inject = ['conversationEvents', 'slots', 'remote', 'remote.commands']

/** Client 插件主体。 */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(uxReportDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'ux-report',
    inject: (sessionId: SessionId): JudgeFace => ({
      judge: async (reportId, findingId, status): Promise<string | null> => {
        const result = await ctx.remote.commands.execute(
          sessionId,
          `/ux judge ${reportId} ${findingId} ${status}`,
        )
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /ux judge'
        return null
      },
    }),
  }, UxReportNodeView))
}

export type { ChatNodeViewProps }
