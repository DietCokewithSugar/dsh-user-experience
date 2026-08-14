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
  | 'R-15' | 'R-16' | 'R-17' | 'R-18' | 'R-19'
  | 'R-20' | 'R-21' | 'R-22' | 'R-23' | 'R-24'
  | 'R-25' | 'R-26' | 'R-27'

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
  {
    id: 'R-15',
    name: '功能分类不符合用户任务',
    category: 'information-architecture',
    signal: '导航按组织架构或内部模块切分，目标用户难以找到完成任务所需功能',
    astAssertion: '源码只能提供路由和导航结构；必须按 persona 实际寻找功能并记录路径',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'interactive',
  },
  {
    id: 'R-16',
    name: '导航层级过深或缺少位置感',
    category: 'information-architecture',
    signal: '关键任务需要多次跳转，且页面缺少当前位置、上级和后续路径提示',
    astAssertion: '路由层级只能作为候选；点击深度和位置感必须通过任务执行验证',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'interactive',
  },
  {
    id: 'R-17',
    name: '长时间操作缺少进度反馈',
    category: 'state-coverage',
    signal: '加载、提交或后台处理存在等待过程，但没有 pending/progress/status 反馈',
    astAssertion: '异步流程中未发现 loading、pending、progress 或状态反馈信号',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-18',
    name: '表单字段或必填项过多',
    category: 'form-flow',
    signal: '单个任务要求填写大量字段，或将非必要信息设为必填',
    astAssertion: '源码可统计字段和 required 候选；必要性必须结合业务目标与页面确认',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'rendered',
  },
  {
    id: 'R-19',
    name: '表单校验反馈过晚',
    category: 'form-flow',
    signal: '用户完成整份表单或提交后才看到本可提前发现的字段错误',
    astAssertion: '校验触发时机需要输入和提交表单后验证',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'interactive',
  },
  {
    id: 'R-20',
    name: '中途退出会丢失表单进度',
    category: 'form-flow',
    signal: '长表单或多步骤流程无法暂存，返回或刷新后已填内容丢失',
    astAssertion: '必须实际填写、离开并恢复流程，记录数据是否保留',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'interactive',
  },
  {
    id: 'R-21',
    name: '缺少退出、取消或撤销路径',
    category: 'form-flow',
    signal: '用户进入流程后无法安全退出，或完成操作后没有合理撤销机制',
    astAssertion: '单个组件无法证明用户被困住；必须执行流程并检查退出与恢复路径',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'interactive',
  },
  {
    id: 'R-22',
    name: '选项过多且缺少默认值或推荐',
    category: 'layout-density',
    signal: '同一决策点提供大量同级选项，没有默认值、推荐项、搜索或分组',
    astAssertion: '源码可统计候选选项；认知负担必须结合实际页面和 persona 判断',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'rendered',
  },
  {
    id: 'R-23',
    name: '同一操作跨页面不一致',
    category: 'consistency',
    signal: '相同操作在不同页面使用不同位置、命名或交互方式',
    astAssertion: '需要比较多个真实页面或状态，单个源码位置不能定稿',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'rendered',
  },
  {
    id: 'R-24',
    name: '相似组件的行为不一致',
    category: 'consistency',
    signal: '视觉相同的组件行为不同，或行为相同但视觉表达明显不同',
    astAssertion: '必须操作并比较相似组件的真实行为',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'interactive',
  },
  {
    id: 'R-25',
    name: '首次使用、离线或无权限状态缺失',
    category: 'edge-state',
    signal: '页面只覆盖理想路径，没有首次使用、无网络、无权限等关键边缘状态',
    astAssertion: '在完整组件/页面范围内检查相应状态分支是否存在',
    astAssertable: true,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'static',
  },
  {
    id: 'R-26',
    name: '基础视觉可用性不足',
    category: 'accessibility-performance',
    signal: '对比度不足、字号过小或触控热区过小',
    astAssertion: '必须基于真实计算样式、元素尺寸和目标视口测量',
    astAssertable: false,
    fastLane: false,
    conditional: false,
    minimumEvidence: 'rendered',
  },
  {
    id: 'R-27',
    name: '响应速度影响关键任务',
    category: 'accessibility-performance',
    signal: '首屏、提交或关键交互等待时间过长，且缺少可接受的渐进反馈',
    astAssertion: '必须执行关键任务并记录等待时间和反馈过程',
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
