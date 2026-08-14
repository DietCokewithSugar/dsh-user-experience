/**
 * 9 条高置信度静态规则目录（spec §6 R3）。
 *
 * 分工（spec 附录 A.3）：模型判断为主、AST 求证为辅。
 * - `astAssertable`：该规则有可结构化验证的断言（见 ast.ts 的实现）。
 * - `fastLane`：纯结构问题，AST 可直接出结论（零 token）。
 *   v0.1 只有 R-09 走快车道；R-04 / R-05 / R-07 视实测效果决定是否跟进。
 * - R-02 为条件触发规则：仅当本轮未发现 P0/P1 问题时才执行。
 */

import type { EvidenceLevel, FindingCategory } from './types'

export type RuleId =
  | 'R-01' | 'R-02' | 'R-03' | 'R-04'
  | 'R-05' | 'R-06' | 'R-07' | 'R-08' | 'R-09'
  | 'R-10' | 'R-11' | 'R-12' | 'R-13' | 'R-14'

export interface RuleDef {
  id: RuleId
  name: string
  category: FindingCategory
  /** 检测信号（spec §6 表格）。 */
  signal: string
  /** AST 可验证的结构断言（spec 附录 A.3 表格）。 */
  astAssertion: string
  /** 是否存在 AST 结构性验证。 */
  astAssertable: boolean
  /** 纯结构问题，AST 直接出结论。 */
  fastLane: boolean
  /** 条件触发（仅当本轮无 P0/P1 时执行）。 */
  conditional: boolean
  /** 该规则可以进入正式报告的最低证据等级。 */
  minimumEvidence: EvidenceLevel
}

export const RULES: readonly RuleDef[] = [
  {
    id: 'R-01',
    name: '错误提示无行动指引',
    category: 'microcopy',
    signal: 'catch / error 分支的用户可见文案只描述失败，无下一步建议',
    astAssertion: '仅能验证"这是错误分支中的用户可见文案"，文案质量本身无法验证',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-02',
    name: '术语不一致',
    category: 'microcopy',
    signal: '同一概念在不同页面使用不同词（如"账户/帐号/用户"混用）',
    astAssertion: '仅能提取候选术语位置，是否同义由模型判断',
    astAssertable: false,
    fastLane: false,
    conditional: true,
    minimumEvidence: 'static',
  },
  {
    id: 'R-03',
    name: '不可逆操作文案泛化',
    category: 'microcopy',
    signal: 'delete / remove / clear 类操作使用"确定""提交"等无信息量文案',
    astAssertion: '仅能提取确认文案字面量，是否泛化由模型判断',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-04',
    name: '不可逆操作缺二次确认',
    category: 'state-coverage',
    signal: '删除 / 清空类调用前无确认交互',
    astAssertion: '该调用路径上确实不存在确认交互节点',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-05',
    name: '有 loading 无 empty',
    category: 'state-coverage',
    signal: '列表渲染存在加载分支但无空数组分支',
    astAssertion: '条件渲染分支中确实不存在空数组分支',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-06',
    name: '有 success 无 error',
    category: 'state-coverage',
    signal: '异步调用无 catch，或 catch 内无用户可见反馈',
    astAssertion: '该异步调用确实无 catch，或 catch 内无渲染输出',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-07',
    name: '提交中按钮未禁用',
    category: 'state-coverage',
    signal: '异步提交流程中无 pending 态锁定',
    astAssertion: '提交流程中确实无 pending 态绑定到 disabled',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-08',
    name: '无超长内容兜底',
    category: 'state-coverage',
    signal: '直接渲染用户输入字段，无截断或占位处理',
    astAssertion: '该字段确实被直接渲染，无截断或占位处理',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-09',
    name: '深色 / 浅色模式适配缺失',
    category: 'theme-adaptation',
    signal: '硬编码颜色字面量未走主题变量；或 Tailwind 类名写死 text-*/bg-* 无 dark: 变体',
    astAssertion: '该 className 确实无对应 dark: 变体；该颜色确实是硬编码字面量',
    astAssertable: true,
    fastLane: true,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-10',
    name: '布局拥挤或分组层级不清',
    category: 'layout-density',
    signal: '同一区域承载过多操作，或间距/分组信号不足',
    astAssertion: '源码只能提取高密度操作与间距候选；必须结合真实截图确认视觉结果',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'rendered',
  },
  {
    id: 'R-11',
    name: '长列表缺少浏览控制',
    category: 'layout-density',
    signal: '列表直接渲染，未发现分页、虚拟滚动、折叠或数量限制',
    astAssertion: '列表渲染路径中未发现常见的分页/虚拟化/截断信号',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-12',
    name: '装饰元素与视觉语言不一致',
    category: 'layout-density',
    signal: 'Emoji、文字图标与图标库混用，可能破坏产品视觉一致性',
    astAssertion: '源码可定位 Emoji/装饰元素；是否影响审美必须结合产品类型与截图判断',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'rendered',
  },
  {
    id: 'R-13',
    name: '页面用途或主要操作不清',
    category: 'navigation-guidance',
    signal: '页面有多个操作，但缺少标题、用途说明、主要操作层级或首次使用指引',
    astAssertion: '源码只能提取标题和操作入口候选；是否容易理解必须结合首屏截图判断',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'rendered',
  },
  {
    id: 'R-14',
    name: '关键任务存在冗余交互',
    category: 'interaction-flow',
    signal: '完成关键任务需要不必要的跳转、重复输入、弹窗或确认步骤',
    astAssertion: '单个文件无法证明流程冗余；必须按 persona 实际执行任务并记录步骤',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'interactive',
  },
]

/** 规则 ID 快速索引。 */
export const RULE_BY_ID: ReadonlyMap<string, RuleDef> = new Map(
  RULES.map((rule) => [rule.id, rule]),
)

/** 是否是合法规则 ID。 */
export function isRuleId(value: string): value is RuleId {
  return RULE_BY_ID.has(value)
}

/** 规则对应的默认分类。 */
export function categoryOfRule(ruleId: string): FindingCategory {
  return RULE_BY_ID.get(ruleId)?.category ?? 'state-coverage'
}
