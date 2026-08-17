/**
 * 常驻走查协议（系统提示词）。
 *
 * 用户侧不再使用 `/ux` / `/ux init` / `/ux scan`。模型根据自然语言意图
 * 自己决定是否上场；完整走查步骤写在这里，而不是写在命令的 followup 里。
 */

import { nielsenGuidance } from './heuristics'
import { HUMAN_COPY_RULE } from './human-copy'
import type { LoadedPersonas, Persona, PersonaStatus } from './types'

function renderPersonas(personas: readonly Persona[]): string {
  const lines = personas.map((persona) => [
    `- [${persona.id}] ${persona.name}（share ${persona.share}）`,
    `  场景：${persona.scenario}`,
    `  目标：${persona.goals.join('；')}`,
    `  能力：技术素养 ${persona.capability.tech_literacy} / 设备 ${persona.capability.device} / 网络 ${persona.capability.network}`
      + (persona.capability.accessibility_needs.length > 0
        ? ` / 无障碍 ${persona.capability.accessibility_needs.join(', ')}`
        : ''),
    `  关键路径：${persona.key_paths.join(' → ')}`,
  ].join('\n'))
  return lines.join('\n')
}

/** 意图门：什么时候上场，什么时候别动。 */
export function intentGate(): string {
  return [
    '[dsh-user-experience] UX 走查插件已启用。用户用自然语言调用你，不要让用户敲任何斜杠命令，也不要在回复里教命令格式。',
    '',
    '何时上场：',
    '- 用户说走查、看看体验、这个页面/流程好不好用、用户会不会懵、检查交互/表单/下单等；',
    '- 用户描述目标用户（「我们主要给运营用」）→ 整理或改画像，确认后调用 ux_personas_write。',
    '',
    '何时不要上场：',
    '- 改 bug、写函数、解释代码、纯实现讨论——不要突然开始走查，也不要插嘴问画像；',
    '- 用户正在改代码时，不要打断。改完前端后的自动走查由插件在回合收尾自己发起，那次必须安静。',
  ].join('\n')
}

/** 没有画像文件时：主动走查才确认，自动走查用草稿。 */
export function lazyInitProtocol(brief: string): string {
  return [
    '本项目还没有 .ux/personas.yml。没有可推断的用户才不出 UX 结论；有 README / 路由 / 产品描述就可以先猜。',
    '',
    '用户主动要走查时：',
    '1. 阅读 README / package.json / 路由与页面结构（项目素材简报附后），推断 1-3 个画像草稿，宁缺毋滥。',
    '2. 用短列表问一句「我按这些用户来看，对吗？」，每条只写名称、大致占比、一句话场景。不要倒 YAML。',
    '3. 用户说「就这些」或改一句之后，调用 ux_personas_write（status=confirmed）落盘，然后立刻走查。',
    '4. 完全没有线索时才问「这产品主要给谁用」。不要让用户先完成设置再享受能力。',
    '',
    '改动触发的自动走查（R7，agent 自己发起）时：',
    '- 立刻推断草稿并 ux_personas_write（status=draft），用草稿走查；',
    '- 全程不要提问、不要展示画像确认卡片、不要索要确认。',
    '',
    `项目素材简报：\n${brief.length > 0 ? brief : '（未收集到 README / package.json 摘要）'}`,
  ].join('\n')
}

/** 已有画像时的说明（含草稿校准）。 */
export function renderExistingPersonas(personas: readonly Persona[], status: PersonaStatus): string {
  if (status === 'draft') {
    return [
      '本项目目标用户画像是推断草稿（.ux/personas.yml status=draft），尚未经用户确认：',
      renderPersonas(personas),
      '',
      '用户主动走查时，用一句话说明「按这些用户来看」，不要再走完整确认关卡，除非用户要改。',
      '自动走查直接用这些草稿，不要提问。用户之后说「我们其实是给运营用的」再整理、确认、覆盖写入（status=confirmed）。',
    ].join('\n')
  }
  return [
    '本项目目标用户画像（.ux/personas.yml，走查的判定依据）：',
    renderPersonas(personas),
    '',
    '目标用户通常不变。用户要改画像时，整理后确认再调用 ux_personas_write（status=confirmed）覆盖写入。',
  ].join('\n')
}

/** 走查步骤与铁律（原 /ux scan followup，现为常驻协议）。 */
export function walkthroughProtocol(): string {
  return [
    'UX 走查协议（用户主动发起时按 review 模式；自动走查按插件注入的 auto 提示执行）：',
    '1. 确定范围：优先读架构说明提出范围建议；没有则问具体功能/页面/业务流程。范围未明前不扫大仓库。自动走查不要问范围，用改动所属的完整组件/页面。',
    '2. 根据 README、路由和当前流程判断 product_type；不同产品类型使用不同走查重点。',
    '3. 对每个 persona 调用 ux_scan（paths=范围目录，persona_id、product_type、language 显式传入），阅读候选核实，按该画像判定。',
    '4. 有浏览器/截图工具且项目可打开时检查相关路由和视口；只有附带截图、DOM 或尺寸证据才能标 rendered。按 persona 做完关键任务并记录步骤后才能标 interactive。不可用时退回 static，不得伪造。',
    '5. 全部画像走完后调用一次 ux_report 合并定稿。每条 finding 必须有 locator（file）和 persona_refs；写用户会遇到什么，不写代码里缺什么。',
    '6. 严重度由 impact（你给，是否阻断关键任务）× reach（命中画像 share 之和，>=0.5 为 wide）推导。一级 / 二级问题必须优先处理。',
    '7. R-02 仅当本轮没有一级 / 二级问题时才执行。宁缺毋滥，拿不准的候选丢掉。',
    `   Nielsen 基础框架：${nielsenGuidance('zh-CN').join('；')}。`,
    '   输出语言优先跟随当前用户，再跟随项目主 README。',
    '',
    '报告双读者：',
    `8. 给人看的：surface（人话页面名，拟不出用路由路径，不用文件路径）+ headline + description。${''}`,
    `   ${HUMAN_COPY_RULE.split('\n').join('\n   ')}`,
    '9. 给 AI 看的：locator / rule / verified_by / severity，填进 technical。',
    '',
    '确认闭环：',
    '10. 用户说「第 2 条不成立」「这几条都对」「三级以下全部忽略」时调用 ux_judge。不要让用户报 ID 或敲命令。',
    '    自动走查（auto）不要索要确认；只有一级 / 二级问题才用一句话提示。',
  ].join('\n')
}

/**
 * R2 入口用的完整系统提示词片段。
 * @param loaded - 已读出的画像文件；不存在时为 undefined。
 * @param brief - 无画像时附上的项目素材简报。
 */
export function buildPersonaSectionText(loaded: LoadedPersonas | undefined, brief: string): string {
  if (loaded === undefined) {
    return [intentGate(), lazyInitProtocol(brief), walkthroughProtocol()].join('\n\n')
  }
  return [
    intentGate(),
    renderExistingPersonas(loaded.personas, loaded.status),
    walkthroughProtocol(),
  ].join('\n\n')
}
