/**
 * `ux_report` 工具（spec §6 R3/R5 + 多 persona 合并；v0.1.1 §3/§4/§6）：
 *
 * 模型完成判定后的**唯一定稿入口**。职责：
 * - 校验 persona_refs（必须存在且非空；无 persona 不出结论）；
 * - 执行硬约束：没有 locator 的 finding 不输出（丢弃并给出原因）；
 * - 执行人话约束：写不出人话 description 的 finding 宁可不报（v0.1.1 §3.5/§9）；
 * - surface 净化：人话位置名兜底到路由路径，**绝不退化为文件路径**（§3.4）；
 * - 严重度矩阵：impact 由模型给出，reach 由命中 persona 的 share 之和推导，
 *   level 由矩阵推导（spec §5.3），上界面时换成人话标签（§3.3）；
 * - 多 persona 合并：同一 locator 同一规则合并为一条，persona_refs 取并集；
 * - 跨走查指纹 + 隐式确认：上一轮消失且位置被重新扫描的问题记为
 *   `confirmed_implicit`，没扫到的记为 `stale` 不计入指标（§6）；
 * - 以 `ux/report` 会话事件持久化（卡片与确认闭环的数据源）；
 * - R-02 术语判定增量合并进 `.ux/glossary.yml`；
 * - 输出 Markdown 报告：共性问题在前，各 persona 个性问题随后，按严重度排序。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type OutputLanguage } from './i18n';
import { type ProductType } from './product';
import { type EvidenceLevel, type Impact, type ImpactConfidence, type UxFinding, type UxMode, type VerifiedBy } from './types';
import type { UxConfig } from './config';
/** 模型提交的 finding 草稿。 */
export interface FindingDraft {
    rule: string;
    category?: string;
    persona_refs: string[];
    impact: Impact;
    impact_confidence?: ImpactConfidence;
    verified_by?: VerifiedBy;
    evidence_level?: EvidenceLevel;
    evidence_refs?: string[];
    file: string;
    symbol?: string;
    line?: number;
    surface?: string;
    headline: string;
    description: string;
    feature?: string;
    rationale: string;
    suggestion: string;
}
export interface ReportResult {
    report_id: string;
    title: string;
    mode: UxMode;
    language: OutputLanguage;
    product_type: ProductType;
    scope: string[];
    findings: UxFinding[];
    dropped: Array<{
        reason: string;
        rule?: string;
        file?: string;
    }>;
    /** 本次由"问题消失"推出的隐式确认条数。 */
    implicit_confirmed: number;
    /** 本次因位置未被扫描而无法判定的条数（不计入指标分母）。 */
    stale: number;
    glossary_terms: number;
    markdown: string;
    /** 本次走查使用的画像确认状态。 */
    persona_status: 'draft' | 'confirmed';
}
/** 注册 `ux_report` 工具。 */
export declare function uxReportTool(config: UxConfig): ToolDefinition;
