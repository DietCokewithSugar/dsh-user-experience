/**
 * 阶段 0：两个可复用数据结构定稿（spec §5）。
 *
 * 这是本项目的核心资产：Persona 与 UXFinding 是"被接受的问题描述结构"，
 * 规则实现可以迭代替换，结构保持稳定。后续 v0.2 网站输入、v0.3 设计图输入
 * 都作为 provider 挂到这两个结构上（UXSource seam），而不是重写项目。
 *
 * 同时在此声明会话事件族（SessionEventMap 合并），问题卡片与确认闭环
 * （spec §R4）依赖它重放。
 */

import type {} from '@deepseek-ai/dsh-session/types'

// ── Persona（存储于仓库内 `.ux/personas.yml`，可 git 提交 / review / diff）──

/** 用户画像的能力画像。 */
export interface PersonaCapability {
  /** 技术素养。 */
  tech_literacy: 'low' | 'medium' | 'high'
  /** 主要设备。 */
  device: 'mobile' | 'desktop' | 'both'
  /** 网络环境。 */
  network: 'stable' | 'unstable'
  /** 无障碍需求，如 low_vision / motor。 */
  accessibility_needs: string[]
}

/**
 * 一个目标用户画像。走查的**前置输入**：无 persona 不出结论。
 *
 * 约束（spec §5.1）：AI 推断的画像只能作为草稿，必须经用户确认或修改后才
 * 写入文件并生效；锚点优先级为 用户填写 > README/落地页/产品文案 > 代码结构。
 */
export interface Persona {
  /** 稳定 id（小写字母/数字/连字符），被 UXFinding.persona_refs 引用。 */
  id: string
  /** 人类可读名称。 */
  name: string
  /** 使用场景一句话。 */
  scenario: string
  /** 目标清单。 */
  goals: string[]
  capability: PersonaCapability
  /** 关键路径（任务流），如 [登录, 查看持仓, 下单]。 */
  key_paths: string[]
  /** 占目标用户比例估计 (0, 1]；用于推导 finding 的 reach，不得人工估计。 */
  share: number
}

/** `.ux/personas.yml` 的根结构。 */
export interface PersonaFile {
  personas: Persona[]
}

// ── UXFinding ────────────────────────────────────────────────────────────────

/** 问题分类：v0.1 三类（微文案 / 状态覆盖 / 主题适配）。 */
export type FindingCategory = 'microcopy' | 'state-coverage' | 'theme-adaptation'

/** 证据等级：v0.1 固定 static；rendered / heuristic 为后续版本预留。 */
export type EvidenceLevel = 'static'

/** 验证来源：model（纯模型）/ model+ast（模型判定 + AST 求证）/ ast（纯 AST）。 */
export type VerifiedBy = 'model' | 'model+ast' | 'ast'

/** 影响轴：是否阻断该 persona 完成关键任务。 */
export type Impact = 'high' | 'low'

/**
 * 范围轴：受影响用户占目标用户的比例。
 * 由命中该问题的 persona 的 share 之和推导（>= 0.5 为 wide），不人工估计。
 */
export type Reach = 'wide' | 'narrow'

/** 严重度：由 impact × reach 矩阵推导（spec §5.3）。 */
export type SeverityLevel = 'P0' | 'P1' | 'P2' | 'P3'

/** 问题确认状态：pending → confirmed | rejected（确认闭环，spec §R4）。 */
export type FindingStatus = 'pending' | 'confirmed' | 'rejected'

/**
 * 问题定位。**硬约束：没有 locator 的问题不输出**（spec §5.2）——
 * 指不到位置的结论验证成本高于价值。
 */
export interface FindingLocator {
  /** 相对项目根的文件路径。 */
  file: string
  /** 组件 / 符号级定位（行号可选）。 */
  symbol?: string
  line?: number
}

/** 一条 finding 的证据块。 */
export interface FindingEvidence {
  level: EvidenceLevel
  /** 无效问题归因：来自哪条路径（model / model+ast / ast）。 */
  verified_by: VerifiedBy
  locator: FindingLocator
  /** 命中规则的 ID（R-01 … R-09）或启发式条目原文。 */
  rationale: string
}

/**
 * 一条用户体验问题。severity 的 level 由 impact × reach 推导；
 * reach 由 persona_refs 的 share 之和推导（多 persona 合并时自然上升）。
 *
 * 字段分两层：`scene` / `summary` / `consequence` 是**人话层**（卡片与报告
 * 的第一屏，非技术读者据此判断问题是否成立）；`evidence` / `suggestion` 是
 * **技术层**（折叠展示，确认后交给 AI 修改）。人话层字段在重放缺字段的老
 * 报告时由 human.ts 的兜底函数补齐。
 */
export interface UxFinding {
  /** 报告内唯一 id（UX-0001 起）。 */
  id: string
  /** 命中该问题的 persona 列表；长度 > 1 即为共性问题。 */
  persona_refs: string[]
  category: FindingCategory
  /** 规则 ID（R-01 … R-09）。 */
  rule: string
  /** 人话层：问题所在的场景/页面（如"管理员页面 · 用户列表"）。 */
  scene: string
  /** 人话层：一句话说明发生了什么（不含文件名、规则 ID、代码术语）。 */
  summary: string
  /** 人话层：对用户造成的后果（可选，一句话）。 */
  consequence?: string
  severity: {
    impact: Impact
    reach: Reach
    level: SeverityLevel
  }
  evidence: FindingEvidence
  /** 优化方向描述（不给出具体代码，spec §用户故事 7）。 */
  suggestion: string
  status: FindingStatus
}

// ── 严重度矩阵（spec §5.3）───────────────────────────────────────────────────

/** 由 impact × reach 推导严重度等级。 */
export function levelOf(impact: Impact, reach: Reach): SeverityLevel {
  if (impact === 'high') return reach === 'wide' ? 'P0' : 'P1'
  return reach === 'wide' ? 'P2' : 'P3'
}

/** 由命中 persona 的 share 之和推导 reach：>= 0.5 为 wide。 */
export function reachOf(shares: readonly number[]): Reach {
  const total = shares.reduce((sum, share) => sum + share, 0)
  return total >= 0.5 ? 'wide' : 'narrow'
}

// ── 会话事件族（spec §5.4 / §R4）─────────────────────────────────────────────
//
// 单次问题的确认判定是**阶段性事实**，写入会话日志（SessionEventMap），
// 不提交仓库。Client 侧通过 ConversationNodeDefinition 从这两个事件
// 增量组装报告卡片并重放。

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * 一份 UX 走查报告成立：唯一 start 事件，携带整份 findings 快照。
     * @mode emit
     */
    'ux/report': {
      /** 报告稳定 id（如 ux-rpt-a1b2c3d4-1）；同一 id 最多一个 start。 */
      reportId: string
      /** 报告标题。 */
      title: string
      /**
       * 本轮涉及的画像 id → 名称。卡片用名称而不是 id 说"影响谁"；
       * 事件仍以 id 为准，名称只是展示用快照（老事件可能没有该字段）。
       */
      personas?: Array<{ id: string; name: string }>
      /** 整份 finding 快照（创建时全部为 pending）。 */
      findings: UxFinding[]
    }
    /**
     * 用户对一条 finding 的确认判定：update 事件，按 reportId 归属报告。
     * @mode emit
     */
    'ux/finding-status': {
      reportId: string
      findingId: string
      status: 'confirmed' | 'rejected'
    }
  }
}
