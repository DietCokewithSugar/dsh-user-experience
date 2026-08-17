/**
 * 确认闭环的去 ID 化入口（v0.1.1 spec §4.3）。
 *
 * 判定由自然语言或卡片按钮完成。`/ux judge` 只是卡片按钮的隐藏通道，
 * 不出现在任何面向用户的提示里。会话里始终存在"当前报告"上下文，用户
 * 只需要点按钮或直接说话。
 *
 * 三种入口共用这里的解析：
 * - 卡片按钮 → `/ux judge`（脚本接口，不出现在任何面向用户的提示里）
 * - 自然语言 → `ux_judge` 工具（「第 2 条不成立」「这几条都对」）
 * - 批量操作 → 同上（「三级以下全部忽略」「全部确认」）
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Session } from '@deepseek-ai/dsh-session';
import { type OutputLanguage } from './i18n';
import type { ProductType } from './product';
import type { ExplicitVerdict, FindingStatus, UxFinding } from './types';
/** 会话中的"当前报告"。 */
export interface CurrentReport {
    reportId: string;
    title: string;
    language: OutputLanguage;
    productType: ProductType;
    findings: readonly UxFinding[];
    /** 折叠 `ux/finding-status` 之后的现状。 */
    statuses: Map<string, FindingStatus>;
}
/**
 * 取会话日志里最近一份报告，并折叠出每条 finding 的当前状态。
 * @param session - 当前会话。
 * @param reportId - 指定报告；缺省取最近一份。
 * @returns 当前报告；会话里还没有报告时 undefined。
 */
export declare function currentReport(session: Session, reportId?: string): CurrentReport | undefined;
/**
 * 把一个自然语言选择器解析成 finding id 列表。
 *
 * 支持：序号（`2` / `第 2 条` / `item 2`）、finding id（`UX-0002`）、
 * 批量词（`全部` / `三级以下` / `below level three` / `all`），以及
 * headline / surface 的关键词匹配。
 * @param report - 当前报告。
 * @param selector - 一个选择器文本。
 * @returns 命中的 finding id；无法解析时为空数组。
 */
export declare function resolveSelector(report: CurrentReport, selector: string): string[];
/** 一次判定的结果说明。 */
export interface JudgeOutcome {
    applied: Array<{
        id: string;
        headline: string;
        surface: string;
    }>;
    /** 无法解析的选择器原文。 */
    unresolved: string[];
}
/**
 * 应用一组判定：写入会话事件，并把显式判定记进长期账本。
 * @param session - 当前会话。
 * @param report - 当前报告。
 * @param targets - 选择器列表。
 * @param verdict - 判定终态。
 * @param root - 项目根目录（记账本用）。
 * @returns 实际生效的条目与无法解析的选择器。
 */
export declare function applyVerdicts(session: Session, report: CurrentReport, targets: readonly string[], verdict: ExplicitVerdict, root: string | undefined): JudgeOutcome;
export interface JudgeResult {
    report_id: string;
    verdict: ExplicitVerdict;
    applied: Array<{
        id: string;
        headline: string;
        surface: string;
    }>;
    unresolved: string[];
    summary: string;
}
/** 注册 `ux_judge` 工具（自然语言与批量判定的落点）。 */
export declare function uxJudgeTool(): ToolDefinition;
