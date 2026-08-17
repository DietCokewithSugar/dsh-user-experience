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
import { createElement } from 'react';
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { JudgeFace } from './index';
/**
 * 组件完整 props：会话标准套件 + keyed node + 注册注入面（JudgeFace）。
 * 未声明 locale 命名空间时运行时不会传 `t`，故从 ChatNodeViewProps 中剔除。
 */
interface UxReportNodeViewProps extends Omit<ChatNodeViewProps<'ux-report'>, 't'>, JudgeFace {
}
/** 报告卡片组件：人话在前，技术细节折叠，review 模式提供批量确认。 */
export declare function UxReportNodeView({ node, judge }: UxReportNodeViewProps): ReturnType<typeof createElement>;
export {};
