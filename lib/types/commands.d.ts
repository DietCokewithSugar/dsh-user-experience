/**
 * `/ux` 仅保留为报告卡片按钮的隐藏判定通道。
 *
 * 用户侧不再使用 `/ux init` / `/ux scan` / `/ux help`：走查和画像都走自然语言。
 * 卡片按钮经客户端 remote 执行 `/ux judge …`；该子命令不出现在任何面向用户
 * 的提示、错误信息与文档中。
 */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { type ConfiguredLanguage } from './i18n';
/**
 * 注册隐藏的 `/ux` 判定通道。
 * 命令栏若仍能看到它，hint 故意留空，避免再教 init / scan。
 */
export declare function createUxCommand(language?: ConfiguredLanguage): CommandDefinition;
