/**
 * dsh-user-experience — Host 侧插件入口。
 *
 * 一个 bundle 行（id `ux-experience`）同时承担：
 * 1. `/ux` 仅作为报告卡片按钮的隐藏判定通道—— `ctx.commands`；
 *    用户用自然语言发起走查，不再使用 /ux init 或 /ux scan；
 * 2. Persona 上下文注入（R2）—— `ctx.systemPrompt.section()`，按当前 agent
 *    的 cwd 读取 `.ux/personas.yml`，无画像时注入懒初始化 + 意图门；
 * 3. 四个模型工具—— `ux_scan`（AST 候选求证 + 人话位置素材）、`ux_report`
 *    （定稿 + 严重度矩阵 + 多 persona 合并 + 指纹与隐式确认 + 会话事件）、
 *    `ux_judge`（自然语言与批量判定，用户不需要报任何 ID）、
 *    `ux_personas_write`（画像落盘）；
 * 4. R7 改动触发的自动走查（v0.1.1 从 P1 提升为 P0）—— `tools/result` 观察
 *    文件编辑、`agent/turn-stopping` 以 `/loop` 形态 steer 进走查。
 *
 * Client 侧（报告卡片 + 确认闭环）由本包 `./client` 子路径经 `dsh.client`
 * 声明被 Web 模块表发现，见 src/client/index.ts。
 *
 * 红线（spec §7）：本插件不修改 agent-loop——所有能力都挂在文档化的扩展点
 * （commands / systemPrompt.section / tools.register / SessionEventMap /
 * tools/result / agent/turn-stopping）上。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { registerAutoScan } from './auto-scan'
import { createUxCommand } from './commands'
import { Config } from './config'
import type { Config as UxConfig } from './config'
import { uxJudgeTool } from './judge-tool'
import { renderPersonaSection } from './persona'
import { uxPersonasWriteTool } from './personas-tool'
import { uxReportTool } from './report-tool'
import { uxScanTool } from './scan-tool'

export const name = 'dsh-user-experience'

/** 依赖的注册表服务：工具注册表、命令注册表、系统提示词。 */
export const inject = ['tools', 'commands', 'systemPrompt']

export { Config }

/**
 * Host 插件主体。
 * @param ctx - 带 tools / commands / systemPrompt 服务的上下文。
 * @param config - 校验后的插件配置（含 schema 默认值）。
 */
export function apply(ctx: Context, config: UxConfig): void {
  ctx.commands.register(createUxCommand(config.outputLanguage))

  // R2：Persona 注入。文本是每次装配时求值的 provider，按 agent 的 cwd
  // 读取画像文件（mtime 缓存），所以多项目并存时各会话注入各自的画像。
  ctx.systemPrompt.section({
    name: 'ux:personas',
    order: 90,
    text: (context) => renderPersonaSection(context.agent),
  })

  ctx.tools.register(uxScanTool(config))
  ctx.tools.register(uxReportTool(config))
  ctx.tools.register(uxJudgeTool())
  ctx.tools.register(uxPersonasWriteTool(config))

  // R7：改动触发的自动走查。这一环是"流水线"与"命令行工具"的分界线。
  registerAutoScan(ctx, config)
}
