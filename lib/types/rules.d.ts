/**
 * 9 条高置信度静态规则目录（spec §6 R3）。
 *
 * 分工（spec 附录 A.3）：模型判断为主、AST 求证为辅。
 * - `astAssertable`：该规则有可结构化验证的断言（见 ast.ts 的实现）。
 * - `fastLane`：纯结构问题，AST 可直接出结论（零 token）。
 *   v0.1 只有 R-09 走快车道；R-04 / R-05 / R-07 视实测效果决定是否跟进。
 * - R-02 为条件触发规则：仅当本轮未发现 P0/P1 问题时才执行。
 */
import type { EvidenceLevel, FindingCategory } from './types';
export type RuleId = 'R-01' | 'R-02' | 'R-03' | 'R-04' | 'R-05' | 'R-06' | 'R-07' | 'R-08' | 'R-09' | 'R-10' | 'R-11' | 'R-12' | 'R-13' | 'R-14' | 'R-15' | 'R-16' | 'R-17' | 'R-18' | 'R-19' | 'R-20' | 'R-21' | 'R-22' | 'R-23' | 'R-24' | 'R-25' | 'R-26' | 'R-27';
export interface RuleDef {
    id: RuleId;
    name: string;
    category: FindingCategory;
    /** 检测信号（spec §6 表格）。 */
    signal: string;
    /** AST 可验证的结构断言（spec 附录 A.3 表格）。 */
    astAssertion: string;
    /** 是否存在 AST 结构性验证。 */
    astAssertable: boolean;
    /** 纯结构问题，AST 直接出结论。 */
    fastLane: boolean;
    /** 条件触发（仅当本轮无 P0/P1 时执行）。 */
    conditional: boolean;
    /** 该规则可以进入正式报告的最低证据等级。 */
    minimumEvidence: EvidenceLevel;
}
export declare const RULES: readonly RuleDef[];
/** 规则 ID 快速索引。 */
export declare const RULE_BY_ID: ReadonlyMap<string, RuleDef>;
/** 是否是合法规则 ID。 */
export declare function isRuleId(value: string): value is RuleId;
/** 规则对应的默认分类。 */
export declare function categoryOfRule(ruleId: string): FindingCategory;
