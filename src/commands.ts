/**
 * `/ux` 人工命令（spec §6 R1 / R4 / R6）：
 *
 * 注册到 `ctx.commands`，不消耗模型轮次。三个子命令：
 *
 * - `/ux init`    Persona 初始化（R1）：已初始化则直接展示；否则收集项目
 *                 素材简报并通过 `agent.followup()` 排队一个模型回合，由模型
 *                 生成 1-3 个画像草稿、交用户确认后调 `ux_personas_write` 落盘。
 * - `/ux scan`    走查发起（R6）：followup 排队范围确定流程（架构说明文件优先，
 *                 否则主动询问功能/页面/流程；模糊继续追问），随后逐 persona
 *                 走查并 ux_report 合并。
 * - `/ux judge`   问题确认闭环（R4）：报告卡片的「成立/不成立」按钮经客户端
 *                 remote 执行本命令，把判定写入 `ux/finding-status` 会话事件。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { collectInitBrief, loadPersonas, personasPath } from './persona'

const HELP_TEXT = [
  'dsh-user-experience 命令：',
  '  /ux init                    初始化/查看目标用户画像（.ux/personas.yml）',
  '  /ux scan [功能/页面描述]    发起一次 UX 走查（先确定范围，再逐 persona 走查）',
  '  /ux judge <报告ID> <findingID> <confirmed|rejected>   确认/否决报告卡片中的一条问题',
].join('\n')

/** `/ux init` 排队给模型的草稿任务说明（R1 路径一）。 */
function buildInitPrompt(brief: string): string {
  return [
    '[dsh-user-experience /ux init] 请为当前项目生成目标用户画像草稿：',
    '',
    '1. 先阅读项目的 README / package.json / 路由与页面结构（项目素材简报附在最后），',
    '   推断这个产品"给谁用"：生成 1-3 个画像草稿（宁缺毋滥，不要硬凑 3 个）。',
    '2. 每个画像包含：id（小写字母/数字/连字符）、name、scenario（一句话场景）、',
    '   goals（目标清单）、capability（tech_literacy: low|medium|high、device: mobile|desktop|both、',
    '   network: stable|unstable、accessibility_needs 列表）、key_paths（关键任务路径）、',
    '   share（占目标用户比例估计 (0,1]，全部画像之和宜 ≈ 1）。',
    '3. 把草稿逐条展示给用户，请用户确认、修改或增删（可用 ask_user_question 提问）。',
    '4. 【硬约束】只有用户确认后才能调用 ux_personas_write 写入 .ux/personas.yml；',
    '   未经确认禁止写文件。用户也可以跳过草稿直接口述画像，你整理成上述结构后',
    '   仍需用户确认再写入。',
    '',
    `项目素材简报：\n${brief.length > 0 ? brief : '（未收集到 README / package.json 摘要）'}`,
  ].join('\n')
}

/** `/ux scan` 排队给模型的范围确定与走查流程说明（R6 + R3 流程编排）。 */
function buildScanPrompt(userIntent: string): string {
  return [
    '[dsh-user-experience /ux scan] 发起一次 UX 走查，按以下顺序执行：',
    '',
    '一、确定走查范围（R6，大仓库不做全量扫描）：',
    '1. 优先查找项目内架构说明（ARCHITECTURE.md、AGENTS.md、README 的结构章节、docs 目录），',
    '   据此提出范围建议（功能/页面/业务流程 + 对应目录）并交用户确认。',
    '2. 没有架构说明时，主动询问用户本次想走查哪个功能/页面/业务流程，',
    '   并引导补充具体描述（如"下单流程：从选品到支付成功"）。',
    '3. 用户描述模糊时继续追问（如"看看首页"），范围未明确前不开始扫描。',
    '',
    '二、逐 persona 走查（若 .ux/personas.yml 不存在，先让用户执行 /ux init；无 persona 不出结论）：',
    '1. 对每个 persona：调用 ux_scan（paths=范围目录，persona_id=该画像）获取结构化候选证据；',
    '   阅读候选对应的代码片段核实，按该画像的 goals / capability / key_paths 判定问题是否成立；',
    '   补充 AST 覆盖不到的语义问题（错误文案质量、术语一致性等）。',
    '2. 所有画像走查完后，调用一次 ux_report 合并定稿（同一位置同一规则自动合并，persona_refs 取并集），',
    '   并把返回的 Markdown 报告呈现给用户。',
    '',
    '三、铁律：',
    '- 每条 finding 必须带 locator（file 必填），指不到位置的丢弃；',
    '- 拿不准的候选宁可丢弃，不要凑数；',
    '- R-02 术语检查仅当本轮没有 P0/P1 问题时才执行；',
    '- 报告只做"提醒开发者去看一眼"，不改代码。',
    '',
    ...(userIntent.length === 0 ? [] : [`用户补充的意向：${userIntent}`]),
  ].join('\n')
}

/** 解析并执行一个 /ux 子命令。 */
function runSubcommand(invocation: CommandInvocation): CommandResult {
  const raw = invocation.rawInput.trim()
  const [sub, ...rest] = raw.length === 0 ? ['help'] : raw.split(/\s+/u)
  const cwd = invocation.agent.session.header.cwd

  switch (sub) {
    case 'help':
      return { kind: 'success', text: HELP_TEXT }

    case 'init': {
      if (cwd === undefined) {
        return { kind: 'error', text: '当前会话没有工作目录（cwd），无法定位项目' }
      }
      const existing = loadPersonas(cwd)
      if (existing !== undefined) {
        const lines = [
          `已存在 ${personasPath(cwd)}，直接加载，不重复询问：`,
          ...existing.map((persona) => `- [${persona.id}] ${persona.name}（share ${persona.share}；设备 ${persona.capability.device}）`),
          '目标用户通常不变；如需修改画像，直接告诉模型，确认后由 ux_personas_write 覆盖写入。',
        ]
        return { kind: 'success', text: lines.join('\n') }
      }
      const brief = collectInitBrief(cwd)
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildInitPrompt(brief) }],
        source: { kind: 'plugin', plugin: 'dsh-user-experience' },
      }))
      return {
        kind: 'success',
        text: '已收集项目素材并启动画像初始化：模型将生成 1-3 个画像草稿并交你确认；确认后才会写入 .ux/personas.yml。',
      }
    }

    case 'scan': {
      if (cwd === undefined) {
        return { kind: 'error', text: '当前会话没有工作目录（cwd），无法定位项目' }
      }
      if (loadPersonas(cwd) === undefined) {
        return { kind: 'error', text: '项目还没有目标用户画像：请先 /ux init 并确认画像。无 persona 不出 UX 结论。' }
      }
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildScanPrompt(rest.join(' ')) }],
        source: { kind: 'plugin', plugin: 'dsh-user-experience' },
      }))
      return { kind: 'success', text: '走查已启动：模型将先确定走查范围，再逐 persona 走查并输出报告。' }
    }

    case 'judge': {
      if (cwd === undefined) {
        return { kind: 'error', text: '当前会话没有工作目录（cwd），无法定位项目' }
      }
      const reportId = rest[0]
      const findingId = rest[1]
      const status = rest[2]
      if (reportId === undefined || findingId === undefined
        || (status !== 'confirmed' && status !== 'rejected')) {
        return { kind: 'error', text: '用法：/ux judge <报告ID> <findingID> <confirmed|rejected>' }
      }
      try {
        invocation.agent.session.append('ux/finding-status', {
          reportId,
          findingId,
          status,
        })
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: `判定记录失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      return {
        kind: 'success',
        text: status === 'confirmed'
          ? `已记录 ${findingId} 为「成立」`
          : `已记录 ${findingId} 为「不成立」`,
      }
    }

    default:
      return { kind: 'error', text: `未知子命令 /ux ${sub}。\n${HELP_TEXT}` }
  }
}

/** 注册 `/ux` 命令。 */
export function createUxCommand(): CommandDefinition {
  return {
    name: 'ux',
    description: 'UX 走查：初始化目标用户画像、发起源码走查、确认/否决问题卡片',
    input: { hint: 'init | scan [范围描述] | judge <报告ID> <findingID> <confirmed|rejected>' },
    recordInput: true,
    handler: (invocation) => runSubcommand(invocation),
  }
}
