/**
 * `/ux` 人工命令（spec §6 R1 / R4 / R6；v0.1.1 §4）：
 *
 * 注册到 `ctx.commands`，不消耗模型轮次。子命令：
 *
 * - `/ux init`    Persona 初始化（R1）：已初始化则直接展示；否则收集项目
 *                 素材简报并通过 `agent.followup()` 排队一个模型回合，由模型
 *                 生成 1-3 个画像草稿、交用户确认后调 `ux_personas_write` 落盘。
 * - `/ux scan`    走查发起（R6）：followup 排队范围确定流程（架构说明文件优先，
 *                 否则主动询问功能/页面/流程；模糊继续追问），随后逐 persona
 *                 走查并 ux_report 合并。可用 `--mode=auto|review|interactive`
 *                 覆盖场景自动选择。
 * - `/ux judge`   **脚本调用接口**：报告卡片的按钮经客户端 remote 执行本命令。
 *                 v0.1.1 起它不出现在任何面向用户的提示、错误信息与文档中——
 *                 用户点按钮或直接说话即可，判定由 `ux_judge` 工具承接。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { applyVerdicts, currentReport } from './judge-tool'
import { isChinese, resolveOutputLanguage, type ConfiguredLanguage, type OutputLanguage } from './i18n'
import { loadLocalRules } from './local-rules'
import { extractModeFlag, modeInstruction, resolveMode } from './mode'
import { collectInitBrief, loadPersonas, personasPath } from './persona'
import type { ConfiguredMode } from './mode'
import type { ExplicitVerdict } from './types'

function helpText(language: OutputLanguage): string {
  return isChinese(language) ? [
    'dsh-user-experience 命令：',
    '  /ux init                    初始化/查看目标用户画像（.ux/personas.yml）',
    '  /ux scan [功能/页面描述]    发起一次 UX 走查（先确定范围，再逐 persona 走查）',
    '',
    '报告出来后，可以直接描述要确认或排除的问题，也可以点卡片上的按钮。',
  ].join('\n') : [
    'dsh-user-experience commands:',
    '  /ux init                    Initialize or view target personas (.ux/personas.yml)',
    '  /ux scan [feature/page]     Start a scoped, persona-based UX walkthrough',
    '',
    'After the report appears, describe which findings to confirm or reject, or use the card buttons.',
  ].join('\n')
}

function englishModeInstruction(mode: 'auto' | 'review' | 'interactive'): string {
  if (mode === 'auto') {
    return 'Run in auto mode: do not ask for confirmation; only notify the user when level-one/two findings exist.'
  }
  if (mode === 'interactive') {
    return 'Run in interactive mode: offer one finding at a time for confirmation after reporting.'
  }
  return 'Run in review mode: present the report first, then offer batch confirmation without interrupting for every finding.'
}

/** `/ux init` 排队给模型的草稿任务说明（R1 路径一）。 */
function buildInitPrompt(brief: string, language: OutputLanguage): string {
  if (!isChinese(language)) {
    return [
      '[dsh-user-experience /ux init] Create target-user persona drafts for the current project:',
      '',
      '1. Read the README, package.json, routes, and page structure (the project brief is appended below).',
      '   Infer who the product serves and create 1–3 persona drafts; do not invent extra personas for coverage.',
      '2. Include id, name, scenario, goals, capability (tech_literacy, device, network, accessibility_needs),',
      '   key_paths, and estimated share (0,1], with all shares approximately summing to 1.',
      '3. Present the drafts in English unless the user is using another language, and ask the user to confirm or edit them.',
      '4. Do not call ux_personas_write until the user confirms the drafts.',
      '',
      `Project brief:\n${brief.length > 0 ? brief : '(No README/package.json summary was collected.)'}`,
    ].join('\n')
  }
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
function buildScanPrompt(
  userIntent: string,
  mode: string,
  modeReason: string,
  language: OutputLanguage,
): string {
  if (!isChinese(language)) {
    return [
      '[dsh-user-experience /ux scan] Run a UX walkthrough in this order:',
      '',
      '1. Scope: use architecture docs first; otherwise ask for a specific feature, page, or business flow. Do not scan a large repository without a defined scope.',
      '2. Product context: infer product_type from README, routes, and the scoped flow (consumer/enterprise/ecommerce/content/finance/healthcare/developer-tool/internal-tool/other). Use type-specific expectations rather than one universal design standard.',
      '3. For each persona, call ux_scan with the scoped paths, persona_id, product_type, and language="en"; inspect the returned source/CSS candidates.',
      '4. Evidence upgrade: if browser or screenshot tools are available and the app can be opened, inspect relevant routes and viewports. Use rendered only with screenshot/DOM/measurement references. Run the persona key task and record steps before using interactive.',
      '5. Graceful degradation: if the app or browser tools are unavailable, continue with static evidence. Never claim rendered/interactive evidence and never fail the whole walkthrough because visual tools are unavailable.',
      `6. Call ux_report once with mode="${mode}", product_type, language="en", and all merged findings.`,
      '',
      'Requirements: every finding needs a file locator and persona_refs; describe what users observe, not missing code. R-10/R-12/R-13 require rendered evidence and R-14 requires interactive evidence. Do not output them from source candidates alone.',
      englishModeInstruction(mode as 'auto' | 'review' | 'interactive'),
      `Mode source: ${modeReason}`,
      ...(userIntent.length === 0 ? [] : ['', `User scope: ${userIntent}`]),
    ].join('\n')
  }
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
    '二、逐 persona 走查（若 .ux/personas.yml 不存在，先让用户初始化画像；无 persona 不出结论）：',
    '1. 先根据 README、路由和当前流程判断 product_type；不同产品类型使用不同走查重点，不套用单一设计标准。',
    '2. 对每个 persona：调用 ux_scan（paths=范围目录，persona_id=该画像，product_type=产品类型，language="zh-CN"）获取源码与 CSS 候选证据；',
    '   阅读候选对应的代码片段核实，按该画像的 goals / capability / key_paths 判定问题是否成立；',
    '   补充 AST 覆盖不到的语义问题。',
    '3. 如果当前会话有浏览器/截图工具且项目可以打开，检查相关路由和视口；只有附带截图、DOM 或尺寸证据时才能标 rendered。',
    '4. 实际按 persona 完成关键任务并记录步骤后，才能标 interactive。',
    '5. 浏览器或项目服务不可用时自动退回 static，不报错退出，也不得伪造 rendered/interactive 结论。',
    '6. 所有画像走查完后，调用一次 ux_report 合并定稿（同一位置同一规则自动合并，persona_refs 取并集），',
    `   product_type 使用上面判断的类型，language="zh-CN"，mode="${mode}"；把返回的 Markdown 报告呈现给用户。`,
    '',
    '三、铁律：',
    '- 每条 finding 必须带 locator（file 必填），指不到位置的丢弃；',
    '- 每条 finding 必须给 surface（人话页面名）与 headline / description（写用户会遇到什么，不写代码里缺什么）；',
    '- 拿不准的候选宁可丢弃，不要凑数；',
    '- R-02 术语检查仅当本轮没有一级 / 二级问题时才执行；',
    '- R-10/R-12/R-13 至少需要 rendered 证据；R-14 至少需要 interactive 证据；',
    '- 报告只做"提醒开发者去看一眼"，不改代码。',
    '',
    `四、${modeInstruction(mode as 'auto' | 'review' | 'interactive')}`,
    `（模式来源：${modeReason}）`,
    ...(userIntent.length === 0 ? [] : ['', `用户补充的意向：${userIntent}`]),
  ].join('\n')
}

/** 解析并执行一个 /ux 子命令。 */
function runSubcommand(
  invocation: CommandInvocation,
  configured: ConfiguredMode,
  configuredLanguage: ConfiguredLanguage,
): CommandResult {
  const raw = invocation.rawInput.trim()
  const [sub, ...rest] = raw.length === 0 ? ['help'] : raw.split(/\s+/u)
  const cwd = invocation.agent.session.header.cwd
  const requestLanguage = /\p{Script=Han}/u.test(raw) ? 'zh-CN' : undefined
  const language = resolveOutputLanguage(cwd ?? process.cwd(), configuredLanguage, requestLanguage)
  const zh = isChinese(language)

  switch (sub) {
    case 'help':
      return { kind: 'success', text: helpText(language) }

    case 'init': {
      if (cwd === undefined) {
        return { kind: 'error', text: '当前会话没有工作目录（cwd），无法定位项目' }
      }
      const existing = loadPersonas(cwd)
      if (existing !== undefined) {
        const lines = zh ? [
          `已存在 ${personasPath(cwd)}，直接加载：`,
          ...existing.map((persona) => `- [${persona.id}] ${persona.name}（share ${persona.share}；设备 ${persona.capability.device}）`),
          '目标用户通常不变；如需修改画像，直接告诉模型，确认后由 ux_personas_write 覆盖写入。',
        ] : [
          `${personasPath(cwd)} already exists and has been loaded:`,
          ...existing.map((persona) => `- [${persona.id}] ${persona.name} (share ${persona.share}; device ${persona.capability.device})`),
          'To change personas, describe the change; the model will ask for confirmation before writing it.',
        ]
        return { kind: 'success', text: lines.join('\n') }
      }
      const brief = collectInitBrief(cwd)
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildInitPrompt(brief, language) }],
        source: { kind: 'plugin', plugin: 'dsh-user-experience' },
      }))
      return {
        kind: 'success',
        text: zh
          ? '已收集项目素材并启动画像初始化：模型将生成 1-3 个画像草稿，确认后才会写入 .ux/personas.yml。'
          : 'Persona initialization started. The model will draft 1–3 personas and will not write .ux/personas.yml until you confirm them.',
      }
    }

    case 'scan': {
      if (cwd === undefined) {
        return { kind: 'error', text: '当前会话没有工作目录（cwd），无法定位项目' }
      }
      if (loadPersonas(cwd) === undefined) {
        return {
          kind: 'error',
          text: zh
            ? '这个项目还没有目标用户画像。请先初始化 UX 画像并确认草稿。'
            : 'This project has no target personas yet. Initialize and confirm UX personas before running a walkthrough.',
        }
      }
      const flag = extractModeFlag(rest.join(' '))
      const resolved = resolveMode({
        explicit: flag.mode,
        localRules: loadLocalRules(cwd),
        configured,
        trigger: 'user',
      })
      invocation.agent.followup(createUserMessage({
        content: [{ type: 'text', text: buildScanPrompt(flag.rest, resolved.mode, resolved.reason, language) }],
        source: { kind: 'plugin', plugin: 'dsh-user-experience' },
      }))
      return {
        kind: 'success',
        text: zh
          ? `走查已启动（${resolved.mode} 模式）：模型将先确定范围，再逐 persona 走查并输出报告。`
          : `UX walkthrough started in ${resolved.mode} mode. The model will scope the flow, review each persona, and produce a report.`,
      }
    }

    case 'judge': {
      // 脚本调用接口（卡片按钮的执行通道）：不面向用户，故错误文案也只对调用方有意义。
      const reportRef = rest[0]
      const targets = (rest[1] ?? '').split(',').map((part) => part.trim()).filter((part) => part.length > 0)
      const verdictWord = rest[2]
      if (reportRef === undefined || targets.length === 0
        || (verdictWord !== 'confirmed' && verdictWord !== 'rejected')) {
        return { kind: 'error', text: '判定参数不完整：点卡片上的按钮，或直接说「第 2 条不成立」。' }
      }
      const report = currentReport(
        invocation.agent.session,
        reportRef === 'latest' ? undefined : reportRef,
      )
      if (report === undefined) {
        return { kind: 'error', text: '找不到对应的走查报告，可能会话已被清理。' }
      }
      const verdict: ExplicitVerdict = verdictWord === 'rejected' ? 'rejected' : 'confirmed_explicit'
      let outcome
      try {
        outcome = applyVerdicts(invocation.agent.session, report, targets, verdict, cwd)
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: `判定记录失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (outcome.applied.length === 0) {
        return { kind: 'error', text: '没有匹配到要判定的问题。' }
      }
      const label = verdict === 'rejected' ? '不是问题' : '问题成立'
      const promptHint = verdict === 'confirmed_explicit'
        ? '；可在报告卡片中复制现象导向的任务 Prompt 交给 AI'
        : ''
      return {
        kind: 'success',
        text: outcome.applied.length === 1
          ? `已记录「${outcome.applied[0]?.headline ?? ''}」为「${label}」${promptHint}`
          : `已记录 ${outcome.applied.length} 条为「${label}」${promptHint}`,
      }
    }

    default:
      return {
        kind: 'error',
        text: zh
          ? `未知子命令 /ux ${sub}。\n${helpText(language)}`
          : `Unknown subcommand /ux ${sub}.\n${helpText(language)}`,
      }
  }
}

/**
 * 注册 `/ux` 命令。
 * @param configured - 插件配置里的模式项（`detect` 表示场景自动选择）。
 */
export function createUxCommand(
  configured: ConfiguredMode = 'detect',
  language: ConfiguredLanguage = 'auto',
): CommandDefinition {
  return {
    name: 'ux',
    description: 'UX 走查：初始化目标用户画像、发起源码走查',
    input: { hint: 'init | scan [范围描述] [--mode=auto|review|interactive]' },
    recordInput: true,
    handler: (invocation) => runSubcommand(invocation, configured, language),
  }
}
