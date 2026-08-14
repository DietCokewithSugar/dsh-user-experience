import type { OutputLanguage } from './i18n'

/** 产品/业务类型决定走查重点，不改变规则的证据门槛。 */
export type ProductType =
  | 'consumer'
  | 'enterprise'
  | 'ecommerce'
  | 'content'
  | 'finance'
  | 'healthcare'
  | 'developer-tool'
  | 'internal-tool'
  | 'other'

export const PRODUCT_TYPES: readonly ProductType[] = [
  'consumer', 'enterprise', 'ecommerce', 'content', 'finance',
  'healthcare', 'developer-tool', 'internal-tool', 'other',
]

export function normalizeProductType(value: string | undefined): ProductType {
  return PRODUCT_TYPES.includes(value as ProductType) ? value as ProductType : 'other'
}

const FOCUS_ZH: Record<ProductType, readonly string[]> = {
  consumer: ['首次使用与引导', '主要操作是否容易发现', '移动端与弱网体验'],
  enterprise: ['高频任务效率', '信息密度与批量操作', '错误恢复与权限反馈'],
  ecommerce: ['商品发现与比较', '购物车/结算连续性', '价格、库存与信任信息'],
  content: ['阅读层级与可读性', '内容发现与导航', '长内容和列表浏览效率'],
  finance: ['风险与后果说明', '数据可信度和状态反馈', '不可逆操作保护'],
  healthcare: ['信息准确与可理解性', '隐私和风险提示', '关键任务容错'],
  'developer-tool': ['功能可发现性', '诊断信息与恢复路径', '高频操作效率'],
  'internal-tool': ['高信息密度下的层级', '批量操作效率', '误操作防护与恢复'],
  other: ['主要任务是否清楚', '状态反馈是否完整', '布局层级与操作效率'],
}

const FOCUS_EN: Record<ProductType, readonly string[]> = {
  consumer: ['first-use guidance', 'discoverability of primary actions', 'mobile and unstable-network experience'],
  enterprise: ['high-frequency task efficiency', 'information density and bulk actions', 'error recovery and permission feedback'],
  ecommerce: ['product discovery and comparison', 'cart/checkout continuity', 'price, stock, and trust information'],
  content: ['reading hierarchy and readability', 'content discovery and navigation', 'long-content and list browsing'],
  finance: ['risk and consequence communication', 'data trust and state feedback', 'protection for irreversible actions'],
  healthcare: ['accuracy and comprehension', 'privacy and risk communication', 'fault tolerance for critical tasks'],
  'developer-tool': ['feature discoverability', 'diagnostics and recovery paths', 'high-frequency operation efficiency'],
  'internal-tool': ['hierarchy under high information density', 'bulk-operation efficiency', 'mistake prevention and recovery'],
  other: ['clarity of the primary task', 'complete state feedback', 'layout hierarchy and operation efficiency'],
}

export function productReviewFocus(type: ProductType, language: OutputLanguage): readonly string[] {
  return language === 'zh-CN' ? FOCUS_ZH[type] : FOCUS_EN[type]
}
