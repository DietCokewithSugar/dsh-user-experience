import type { OutputLanguage } from './i18n'

/** Nielsen 十项可用性原则，作为所有产品类型共享的基础检查框架。 */
const NIELSEN_ZH = [
  '系统状态可见：操作、加载和后台处理要及时反馈',
  '符合现实世界：分类、术语和流程贴近用户任务与心智模型',
  '用户控制与自由：提供退出、返回、取消和撤销',
  '一致性与标准：相同概念、组件和操作保持一致',
  '预防错误：在错误发生前提供约束、默认值和确认',
  '识别优于回忆：让当前位置、可选路径和可执行操作可见',
  '灵活与高效：兼顾新用户引导和熟练用户的高频效率',
  '简洁设计：控制信息密度，突出主要任务',
  '帮助识别、诊断和恢复错误：说明原因与下一步',
  '帮助与文档：在复杂或首次使用场景提供就地指引',
] as const

const NIELSEN_EN = [
  'Visibility of system status: provide timely feedback for actions and background work',
  'Match with the real world: organize language and flows around user tasks and mental models',
  'User control and freedom: provide exit, back, cancel, and undo paths',
  'Consistency and standards: keep equivalent concepts, components, and actions consistent',
  'Error prevention: use constraints, defaults, and confirmation before errors occur',
  'Recognition rather than recall: expose location, destinations, and available actions',
  'Flexibility and efficiency: support first-time guidance and expert workflows',
  'Aesthetic and minimalist design: control information density and emphasize the primary task',
  'Recognize, diagnose, and recover from errors: explain the reason and the next action',
  'Help and documentation: provide contextual guidance for complex and first-use scenarios',
] as const

export function nielsenGuidance(language: OutputLanguage): readonly string[] {
  return language === 'zh-CN' ? NIELSEN_ZH : NIELSEN_EN
}

const PRIORITY_ZH = [
  '优先一：反馈与系统状态（R-01、R-06、R-17）',
  '优先二：表单与流程恢复（R-18～R-21）',
  '优先三：信息架构、导航与主要操作（R-13、R-15、R-16）',
  '其后：认知负荷、一致性、边缘状态、基础可用性与性能',
] as const

const PRIORITY_EN = [
  'Priority 1: feedback and system status (R-01, R-06, R-17)',
  'Priority 2: forms, control, and flow recovery (R-18–R-21)',
  'Priority 3: information architecture, navigation, and primary actions (R-13, R-15, R-16)',
  'Then: cognitive load, consistency, edge states, basic usability, and performance',
] as const

/** 按常见程度安排检查顺序；最终报告仍按严重度排序。 */
export function reviewPriority(language: OutputLanguage): readonly string[] {
  return language === 'zh-CN' ? PRIORITY_ZH : PRIORITY_EN
}
