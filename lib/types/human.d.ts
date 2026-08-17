/**
 * 人话层（spec §R4 问题卡片话术）：把技术判定翻译成非技术读者读得懂的说法。
 *
 * 卡片与报告的第一屏只回答两件事——**在哪儿**（scene）与**发生了什么**
 * （summary / consequence）；规则 ID、文件行号、AST 断言这些技术内容退到
 * 第二屏（卡片折叠区 / 报告子条目），供人工确认后一键交给 AI 修改。
 *
 * Host（Markdown 报告）与 Client（卡片）共用本模块，保证两处话术一致；
 * 模块只依赖纯数据（规则目录 + 类型），不碰 node 内建模块，可被 client
 * bundle 内联。
 */
import type { FindingCategory, SeverityLevel } from './types';
/** 一个严重度等级的人话说法。 */
export interface SeverityWording {
    /** 等级名（P0 → 一级问题）。 */
    name: string;
    /** 一句话解释"这个等级意味着什么"（不含技术术语）。 */
    hint: string;
}
/**
 * P0…P3 的人话说法。等级本身由 impact × reach 矩阵推导（spec §5.3），
 * 这里只负责把矩阵结论翻译成"挡不挡路、影响多少人"。
 */
export declare const SEVERITY_WORDING: Record<SeverityLevel, SeverityWording>;
/** 取严重度的人话说法；未知等级原样回显（老报告重放时的兜底）。 */
export declare function severityWording(level: string): SeverityWording;
/** 问题分类的人话说法。 */
export declare const CATEGORY_WORDING: Record<FindingCategory, string>;
/** 取分类的人话说法；未知分类原样回显。 */
export declare function categoryWording(category: string): string;
/** 规则名（R-04 → 不可逆操作缺二次确认）；未知规则原样回显。 */
export declare function ruleName(rule: string): string;
/** 规则的完整说法（R-04 不可逆操作缺二次确认），用于技术细节区。 */
export declare function ruleWording(rule: string): string;
/**
 * 场景兜底：模型漏填 scene、或重放缺少人话字段的老报告时，
 * 用 symbol（组件名）→ 文件名 → 目录名的顺序凑一个"在哪儿"。
 */
export declare function sceneFallback(file: string, symbol?: string): string;
/** 摘要兜底：规则名 + 优化方向（仍比 AST 断言更接近人话）。 */
export declare function summaryFallback(rule: string, suggestion: string): string;
/** 交给 AI 的技术细节文本所需字段（UxFinding 与卡片视图都可适配）。 */
export interface HandoffFields {
    level: string;
    scene: string;
    summary: string;
    consequence?: string;
    rule: string;
    category: string;
    file: string;
    symbol?: string;
    line?: number;
    rationale: string;
    suggestion: string;
    personaNames: readonly string[];
}
/** 定位串：`src/pages/Order.tsx:47（OrderList）`。 */
export declare function locatorText(file: string, symbol?: string, line?: number): string;
/**
 * 单条问题的"复制给 AI"文本：人话结论在前，技术细节在后。
 * 人不需要读这段，它是给模型的输入。
 */
export declare function handoffText(finding: HandoffFields): string;
/** 整份报告的"复制给 AI"文本：带一句交付指令 + 逐条技术细节。 */
export declare function handoffBundle(title: string, reportId: string, findings: readonly HandoffFields[]): string;
