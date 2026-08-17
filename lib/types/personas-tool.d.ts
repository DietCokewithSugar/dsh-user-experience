/**
 * `ux_personas_write` 工具：
 *
 * 把目标用户画像写入 `.ux/personas.yml`。这是 persona 文件的唯一写入口。
 * - status=draft：自动走查推断的草稿，允许未经用户确认落盘，避免打断写代码；
 * - status=confirmed：用户主动走查时确认或修改后的正式画像。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { UxConfig } from './config';
import { type OutputLanguage } from './i18n';
export interface PersonasWriteResult {
    written: number;
    path: string;
    status: 'draft' | 'confirmed';
    language: OutputLanguage;
    personas: Array<{
        id: string;
        name: string;
        share: number;
    }>;
}
/** 注册 `ux_personas_write` 工具。 */
export declare function uxPersonasWriteTool(config: UxConfig): ToolDefinition;
