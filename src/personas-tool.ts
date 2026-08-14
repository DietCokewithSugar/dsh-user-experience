/**
 * `ux_personas_write` 工具（spec §6 R1）：
 *
 * 把用户**确认后**的画像写入 `.ux/personas.yml`。这是 persona 文件的唯一
 * 写入口——AI 推断的画像只能作为草稿，必须经用户确认或修改后才能落盘
 * （spec §5.1 硬约束），该约束由工具描述 + 流程（/ux init 草稿 → 用户确认
 * → 本工具）共同保证。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { writePersonas } from './persona'

export interface PersonasWriteResult {
  written: number
  path: string
  personas: Array<{ id: string; name: string; share: number }>
}

/** 注册 `ux_personas_write` 工具。 */
export function uxPersonasWriteTool(): ToolDefinition {
  return defineTool({
    name: 'ux_personas_write',
    description: [
      '把用户确认后的目标用户画像写入项目根目录 .ux/personas.yml（仓库内一等公民文件，可 git 提交）。',
      '【硬约束】只能写入用户已确认/修改过的画像：AI 推断的画像仅是草稿，未经用户确认禁止调用本工具。',
      '画像 id 使用小写字母/数字/连字符；share 为占目标用户比例估计（(0,1]，全量画像之和宜 ≈ 1）。',
      '文件已存在时本调用整体覆盖（用户明确表示修改/增删画像后使用）。',
    ].join(' '),
    parameters: {
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
        description: '用户确认后的完整画像列表',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          written: { type: 'number' },
          path: { type: 'string' },
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
        const lines = [
          `已写入 ${result.written} 个目标用户画像到 ${result.path}（可 git 提交、团队共享）：`,
          ...result.personas.map((persona) => `- [${persona.id}] ${persona.name}（share ${persona.share}）`),
          '后续走查将以这些画像作为判定依据；文件已存在时会直接加载，不再重复询问。',
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
      const written = writePersonas(cwd, args.personas)
      return {
        written: written.length,
        path: '.ux/personas.yml',
        personas: written.map((persona) => ({ id: persona.id, name: persona.name, share: persona.share })),
      } satisfies PersonasWriteResult
    },
  })
}
