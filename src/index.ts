/**
 * dsh-user-experience — Host 侧插件入口。
 *
 * 一个 bundle 行（id `ux-experience`）同时承担：
 * 1. `/ux` 人工命令（persona 初始化 / 走查发起 / 问题确认）—— `ctx.commands`；
 * 2. Persona 上下文注入（R2）—— `ctx.systemPrompt.section()`，按当前 agent
 *    的 cwd 读取 `.ux/personas.yml`，无 persona 时注入初始化引导
 *    （无 persona 不出结论）；
 * 3. 三个模型工具—— `ux_scan`（AST 候选求证）、`ux_report`（定稿 + 严重度
 *    矩阵 + 多 persona 合并 + 会话事件）、`ux_personas_write`（画像落盘）。
 *
 * Client 侧（报告卡片 + 确认闭环）由本包 `./client` 子路径经 `dsh.client`
 * 声明被 Web 模块表发现，见 src/client/index.ts。
 *
 * 红线（spec §7）：本插件不修改 agent-loop——所有能力都挂在文档化的扩展点
 * （commands / systemPrompt.section / tools.register / SessionEventMap）上。
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createUxCommand } from './commands'
import { Config } from './config'
import type { Config as UxConfig } from './config'
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
  ctx.commands.register(createUxCommand())

  // R2：Persona 注入。文本是每次装配时求值的 provider，按 agent 的 cwd
  // 读取画像文件（mtime 缓存），所以多项目并存时各会话注入各自的画像。
  ctx.systemPrompt.section({
    name: 'ux:personas',
    order: 90,
    text: (context) => renderPersonaSection(context.agent),
  })

  ctx.tools.register(uxScanTool(config))
  ctx.tools.register(uxReportTool(config))
  ctx.tools.register(uxPersonasWriteTool())
}
