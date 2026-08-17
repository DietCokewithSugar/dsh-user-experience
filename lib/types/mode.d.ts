/**
 * 运行模式与场景自动选择（v0.1.1 spec §4.1 / §4.2）。
 *
 * 三档模式：
 * - `auto`         全自动跑完直接出报告，不打断，不索要确认；
 * - `review`       出报告后一次性批量确认（可勾选多条一并提交）；
 * - `interactive`  逐条确认（v0.1 现状，保留给需要精细调优规则的用户）。
 *
 * **为什么要自动选择**：v0.1 把每一步都做成人工关卡，形态退化成命令行工具。
 * 但"该不该打断人"取决于**是谁发起的走查**：用户用自然语言点名走查时人就在
 * 等结果，给他批量确认；R7 在用户写代码写到一半时自动触发，这时弹确认清单
 * 等于打断他——agent 自己发起的走查，就该由 agent 自己消化，安静出报告。
 */
import type { LocalRules } from './local-rules';
import type { UxMode } from './types';
export type { UxMode };
/** 走查的触发来源：决定"该不该打断人"。 */
export type UxTrigger = 
/** 用户用自然语言主动发起走查。 */
'user'
/** R7 改动触发：agent 自己发起的走查。 */
 | 'auto-scan';
/** 插件配置里的模式项：`detect` 表示交给场景自动选择。 */
export type ConfiguredMode = UxMode | 'detect';
export interface ResolveModeInput {
    /** 本地规则或测试显式指定（`auto` / `review` / `interactive`）。 */
    explicit?: string | undefined;
    /** `.ux/rules.local.yml` 的偏好。 */
    localRules?: LocalRules | undefined;
    /** 插件配置（profile 层可覆盖）。 */
    configured?: ConfiguredMode | undefined;
    /** 本次走查的触发来源。 */
    trigger: UxTrigger;
    /** 环境变量视图（便于测试注入）；缺省读 `process.env`。 */
    env?: Record<string, string | undefined>;
}
export interface ResolvedMode {
    mode: UxMode;
    /** 命中的判定依据，写进提示词与报告，便于排查"为什么是这个模式"。 */
    reason: string;
}
/** 解析 `--mode=auto` / `--mode auto` 形式的显式指定，返回剩余输入。 */
export declare function extractModeFlag(rawInput: string): {
    mode?: string;
    rest: string;
};
/**
 * 按判定顺序解析本次走查的运行模式，先命中先生效：
 * 1. 命令行显式指定 `--mode`；
 * 2. `.ux/rules.local.yml` 的 `mode`；
 * 3. 插件配置（非 `detect` 时）；
 * 4. 自动探测：CI / headless → auto；R7 自动触发 → auto；用户发起 → review。
 * @param input - 各优先级的输入信号。
 * @returns 生效模式与命中的依据。
 */
export declare function resolveMode(input: ResolveModeInput): ResolvedMode;
/** 模式对应的、写进走查提示词的行为约束。 */
export declare function modeInstruction(mode: UxMode): string;
