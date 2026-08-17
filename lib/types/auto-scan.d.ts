/**
 * R7 改动触发的自动走查（v0.1.1 spec §5，本版从 P1 提升为 P0）。
 *
 * **这是"流水线"与"命令行工具"的分界线。** v0.1 少了这一环，插件就只剩一串
 * 手动命令，形态自然退化。有了它，agent 改完代码自己就把体验走查跑掉了。
 *
 * 实现挂在两个文档化的扩展点上（红线：不改 agent-loop）：
 * 1. `tools/result` —— 观察文件编辑类工具的最终结果，收集变更文件；
 * 2. `agent/turn-stopping` —— 回合收尾时 `agent.steer()` 送入走查提示，
 *    这正是框架里 `/loop` 的原生形态（监听器 steer，机器重读 inbox 再跑一步）。
 *
 * 三条关键约束：
 * - **扫描单元是被改动文件所属的完整组件 / 页面，不是 diff 的那几行**：体验
 *   问题大量是缺失型的（没有空态、没有错误分支、没有二次确认），这些在 diff
 *   里是不存在的行，扫 diff 必然漏掉。diff 只用来确定范围。
 * - **前端改动优先，纯后端改动默认排除**：用户不可感知的改动报出来只是噪音。
 * - **以 auto 模式运行，只在一级 / 二级问题时提示一句**：agent 自己发起的走查
 *   就该由 agent 自己消化，否则等于在用户写代码写到一半时打断他。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { PersonaStatus } from './types';
import type { UxConfig } from './config';
/** 自动走查时画像处于哪种状态，决定提示词是否要求先写草稿。 */
export type AutoScanPersonaState = 'missing' | PersonaStatus;
/**
 * 判断一个改动文件是否值得走查（前端、非测试、非构建产物）。
 * @param file - 相对项目根的路径。
 * @returns 是否纳入自动走查范围。
 */
export declare function isReviewableChange(file: string): boolean;
/**
 * 把工具参数里的 `file_path` 归一成相对项目根的路径。
 * @param filePath - 工具收到的路径（可能是绝对路径）。
 * @param cwd - 会话工作目录。
 * @returns 相对路径；越出项目根时 undefined。
 */
export declare function relativizeChange(filePath: string, cwd: string): string | undefined;
/**
 * 由改动文件推出走查范围：**取其所属目录**，因为扫描单元是完整组件 / 页面。
 * @param files - 改动文件（相对项目根）。
 * @returns 去重后的目录清单（文件位于项目根时退回该文件本身）。
 */
export declare function scanUnitsOf(files: Iterable<string>): string[];
/** R7 送给模型的走查提示。 */
export declare function buildAutoScanPrompt(units: readonly string[], files: readonly string[], personaState?: AutoScanPersonaState): string;
/**
 * 接线 R7：注册两个监听器。
 * @param ctx - 插件上下文（监听器随上下文卸载而解绑）。
 * @param config - 插件配置。
 */
export declare function registerAutoScan(ctx: Context, config: UxConfig): void;
