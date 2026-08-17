/**
 * `ux_personas_write` 工具：
 *
 * 把目标用户画像写入 `.ux/personas.yml`。这是 persona 文件的唯一写入口。
 * - status=draft：自动走查推断的草稿，允许未经用户确认落盘，避免打断写代码；
 * - status=confirmed：用户主动走查时确认或修改后的正式画像。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { UxConfig } from './config'
import { isChinese, resolveOutputLanguage, type OutputLanguage } from './i18n'
import { writePersonas } from './persona'

export interface PersonasWriteResult {
  written: number
  path: string
  status: 'draft' | 'confirmed'
  language: OutputLanguage
  personas: Array<{ id: string; name: string; share: number }>
}

/** 注册 `ux_personas_write` 工具。 */
export function uxPersonasWriteTool(config: UxConfig): ToolDefinition {
  return defineTool({
    name: 'ux_personas_write',
    description: [
      '把目标用户画像写入项目根目录 .ux/personas.yml（仓库内一等公民文件，可 git 提交）。',
      'status=draft：改动触发的自动走查可在未打扰用户的情况下写入推断草稿。',
      'status=confirmed：仅在用户主动走查并确认/修改画像后使用。不要让用户敲任何斜杠命令。',
      '画像 id 使用小写字母/数字/连字符；share 为占目标用户比例估计（(0,1]，全量画像之和宜 ≈ 1）。',
      '文件已存在时本调用整体覆盖。',
    ].join(' '),
    parameters: {
      language: {
        type: 'string',
        description: '输出语言（zh-CN 或 en）；跟随当前用户语言。',
      },
      status: {
        type: 'string',
        description: 'draft=推断草稿（自动走查）；confirmed=用户已确认。缺省 confirmed。',
        enum: ['draft', 'confirmed'],
      },
      personas: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '稳定 id，如 novice-investor' },
            name: { type: 'string', required: true, description: '人类可读名称' },
            scenario: { type: 'string', required: true, description: '使用场景一句话' },
            goals: { type: 'array', items: { type: 'string' }, required: true, description: '目标清单（非空）' },
            capability: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                tech_literacy: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
                device: { type: 'string', required: true, enum: ['mobile', 'desktop', 'both'] },
                network: { type: 'string', required: true, enum: ['stable', 'unstable'] },
                accessibility_needs: { type: 'array', items: { type: 'string' }, required: true, description: '如 low_vision / motor' },
              },
            },
            key_paths: { type: 'array', items: { type: 'string' }, required: true, description: '关键路径，如 [登录, 查看持仓, 下单]' },
            share: { type: 'number', required: true, description: '占目标用户比例估计 (0, 1]' },
          },
        },
        required: true,
        description: '完整画像列表',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          written: { type: 'number' },
          path: { type: 'string' },
          status: { type: 'string' },
          language: { type: 'string' },
          personas: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                share: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const result = value as PersonasWriteResult
        const draft = result.status === 'draft'
        const lines = isChinese(result.language) ? [
          draft
            ? `已写入 ${result.written} 个草稿画像到 ${result.path}（尚未经用户确认，自动走查可用）：`
            : `已写入 ${result.written} 个目标用户画像到 ${result.path}（可 git 提交、团队共享）：`,
          ...result.personas.map((persona) => `- [${persona.id}] ${persona.name}（share ${persona.share}）`),
          draft
            ? '之后用户说画像不对时再覆盖为正式画像。'
            : '后续走查将以这些画像作为判定依据。',
        ] : [
          draft
            ? `Wrote ${result.written} draft personas to ${result.path} (usable for automatic walkthroughs, not yet confirmed):`
            : `Wrote ${result.written} target personas to ${result.path} (commit this file to share it with the team):`,
          ...result.personas.map((persona) => `- [${persona.id}] ${persona.name} (share ${persona.share})`),
          draft
            ? 'Overwrite with confirmed personas when the user later corrects who the product is for.'
            : 'Future walkthroughs will use these personas as their evaluation context.',
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('ux_personas_write：需要 agent 上下文（应在 agent loop 中调用）')
      }
      const cwd = agent.session.header.cwd
      if (cwd === undefined) {
        throw new Error('ux_personas_write：当前会话没有工作目录（cwd），无法定位项目')
      }
      const status = args.status === 'draft' ? 'draft' : 'confirmed'
      const written = writePersonas(cwd, args.personas, status)
      return {
        written: written.length,
        path: '.ux/personas.yml',
        status,
        language: resolveOutputLanguage(cwd, config.outputLanguage, args.language),
        personas: written.map((persona) => ({ id: persona.id, name: persona.name, share: persona.share })),
      } satisfies PersonasWriteResult
    },
  })
}
