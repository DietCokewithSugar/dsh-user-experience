/**
 * 阶段 0：两个可复用数据结构定稿（spec §5）。
 *
 * 这是本项目的核心资产：Persona 与 UXFinding 是"被接受的问题描述结构"，
 * 规则实现可以迭代替换，结构保持稳定。后续 v0.2 网站输入、v0.3 设计图输入
 * 都作为 provider 挂到这两个结构上（UXSource seam），而不是重写项目。
 *
 * v0.1.1 的形态修订落在 UXFinding 上：**报告有两个读者，要的信息完全不同**
 * （v0.1.1 spec §3.1）。人要"哪个页面、出了什么事、严不严重"，AI 要"精确位置、
 * 规则 ID、验证路径"。v0.1 把两者混在一张卡片里，对人像技术文档，对 AI 又不够
 * 结构化——折叠只是表现层的补丁，所以底层结构直接拆成 `surface` / `human` /
 * `technical` 三块。
 *
 * 同时在此声明会话事件族（SessionEventMap 合并），问题卡片与确认闭环
 * （spec §R4）依赖它重放。
 */
import type { OutputLanguage } from './i18n';
import type { ProductType } from './product';
/** 用户画像的能力画像。 */
export interface PersonaCapability {
    /** 技术素养。 */
    tech_literacy: 'low' | 'medium' | 'high';
    /** 主要设备。 */
    device: 'mobile' | 'desktop' | 'both';
    /** 网络环境。 */
    network: 'stable' | 'unstable';
    /** 无障碍需求，如 low_vision / motor。 */
    accessibility_needs: string[];
}
/** 画像文件的确认状态：推断草稿可先走查，用户确认后升为 confirmed。 */
export type PersonaStatus = 'draft' | 'confirmed';
/**
 * 一个目标用户画像。走查的**前置输入**：没有可推断的用户才不出结论。
 *
 * 推断草稿可以先用于走查（尤其是改动触发的自动走查，不能打断人）；
 * 用户主动走查时用一张短卡片确认，确认后升为 `confirmed`。
 * 锚点优先级：用户填写 > README/落地页/产品文案 > 代码结构。
 */
export interface Persona {
    /** 稳定 id（小写字母/数字/连字符），被 UXFinding.technical.persona_refs 引用。 */
    id: string;
    /** 人类可读名称。 */
    name: string;
    /** 使用场景一句话。 */
    scenario: string;
    /** 目标清单。 */
    goals: string[];
    capability: PersonaCapability;
    /** 关键路径（任务流），如 [登录, 查看持仓, 下单]。 */
    key_paths: string[];
    /** 占目标用户比例估计 (0, 1]；用于推导 finding 的 reach，不得人工估计。 */
    share: number;
}
/** `.ux/personas.yml` 的根结构。 */
export interface PersonaFile {
    /** 缺省视为已确认，兼容旧文件。 */
    status?: PersonaStatus;
    personas: Persona[];
}
/** 从磁盘读出的画像文件（status 已归一）。 */
export interface LoadedPersonas {
    status: PersonaStatus;
    personas: readonly Persona[];
}
/** 问题分类：文案、状态、主题、布局密度、导航指引与交互流程。 */
export type FindingCategory = 'microcopy' | 'state-coverage' | 'theme-adaptation' | 'layout-density' | 'navigation-guidance' | 'interaction-flow' | 'information-architecture' | 'form-flow' | 'consistency' | 'edge-state' | 'accessibility-performance';
/**
 * 证据等级：
 * - static：源码 / AST / CSS 证据；
 * - rendered：真实页面 DOM、元素尺寸或截图证据；
 * - interactive：按 persona 实际执行任务后的流程证据。
 */
export type EvidenceLevel = 'static' | 'rendered' | 'interactive';
/** 验证来源：模型、AST 或浏览器证据的组合。 */
export type VerifiedBy = 'model' | 'model+ast' | 'ast' | 'model+browser';
/** 影响轴：是否阻断该 persona 完成关键任务。 */
export type Impact = 'high' | 'low';
/** impact 判定的把握程度（v0.1.1 spec §3.2）。 */
export type ImpactConfidence = 'high' | 'medium' | 'low';
/**
 * 范围轴：受影响用户占目标用户的比例。
 * 由命中该问题的 persona 的 share 之和推导（>= 0.5 为 wide），不人工估计。
 */
export type Reach = 'wide' | 'narrow';
/**
 * 严重度：由 impact × reach 矩阵推导（spec §5.3）。
 * **v0.1.1 起 P0~P3 退为内部标识，不再上界面**——面向人的严重度走
 * {@link severityLabel} 的人话标签。
 */
export type SeverityLevel = 'P0' | 'P1' | 'P2' | 'P3';
/**
 * 问题判定状态（v0.1.1 spec §6.4 的五态状态机）：
 *
 * - `pending`             尚未判定
 * - `confirmed_explicit`  用户点了"确认存在"
 * - `confirmed_implicit`  下次走查中消失，且该位置确实被重新扫描——
 *                         这个信号比人工点确认更硬：点按钮只表示"我认为它成立"，
 *                         改掉了表示"它真的值得改"
 * - `rejected`            用户点了"不是问题"
 * - `stale`               该位置本次未被扫描，无法判定；不计入指标分母
 */
export type FindingStatus = 'pending' | 'confirmed_explicit' | 'confirmed_implicit' | 'rejected' | 'stale';
/** 判定的终态（会话事件里可写回的状态，pending 只在创建时出现）。 */
export type FindingVerdict = Exclude<FindingStatus, 'pending'>;
/** 用户主动做出的判定（卡片按钮 / 自然语言只能产出这两个）。 */
export type ExplicitVerdict = 'confirmed_explicit' | 'rejected';
/**
 * 问题定位。**硬约束：没有 locator 的问题不输出**（spec §5.2）——
 * 指不到位置的结论验证成本高于价值。
 */
export interface FindingLocator {
    /** 相对项目根的文件路径。 */
    file: string;
    /** 组件 / 符号级定位（行号可选）。 */
    symbol?: string;
    line?: number;
}
/** 给人看的那一半（v0.1.1 spec §3.2）：卡片首屏只渲染这块 + surface。 */
export interface FindingHuman {
    /** 一句话说清出了什么事，如"删除用户后没有任何提示"。 */
    headline: string;
    /**
     * 用户会遇到什么——**不写代码里缺什么**（spec §3.5 的硬性约束）。
     * ❌「handleDelete 的 catch 分支中没有调用 toast」
     * ✅「删除失败时界面没有任何提示，用户以为删成功了」
     */
    description: string;
    /** 人话严重度：一级 / 二级 / 三级 / 四级问题。 */
    severity_label: string;
}
/** 给 AI 看的那一半：折叠区，可整块复制粘贴给模型。 */
export interface FindingTechnical {
    locator: FindingLocator;
    /** 命中规则的 ID（R-01 … R-27）。 */
    rule: string;
    category: FindingCategory;
    /** 无效问题归因：来自哪条路径（model / model+ast / ast）。 */
    verified_by: VerifiedBy;
    /** 证据等级：源码、真实渲染或实际任务执行。 */
    evidence_level: EvidenceLevel;
    /** 截图、路由+视口或任务步骤等可复核证据；非 static finding 必须提供。 */
    evidence_refs: string[];
    /** 命中该问题的 persona 列表；长度 > 1 即为共性问题。 */
    persona_refs: string[];
    severity: {
        impact: Impact;
        impact_confidence: ImpactConfidence;
        reach: Reach;
        level: SeverityLevel;
    };
    /** 判定依据：规则 ID 或启发式条目原文。 */
    rationale: string;
    /** 优化方向描述（不给出具体代码，spec §用户故事 7）。 */
    suggestion: string;
}
/**
 * 一条用户体验问题。severity 的 level 由 impact × reach 推导；
 * reach 由 persona_refs 的 share 之和推导（多 persona 合并时自然上升）。
 */
export interface UxFinding {
    /** 报告内唯一 id（UX-0001 起）。 */
    id: string;
    /** 跨走查稳定标识（见 src/fingerprint.ts）；隐式确认据此比对。 */
    fingerprint: string;
    /**
     * 人话的位置名，如"管理员页面"。
     * **兜底也只能退到路由路径，不得退化为文件路径**——文件路径对人没有意义
     * （v0.1.1 spec §3.4）。
     */
    surface: string;
    human: FindingHuman;
    technical: FindingTechnical;
    status: FindingStatus;
}
/** 由 impact × reach 推导严重度等级。 */
export declare function levelOf(impact: Impact, reach: Reach): SeverityLevel;
/** 由命中 persona 的 share 之和推导 reach：>= 0.5 为 wide。 */
export declare function reachOf(shares: readonly number[]): Reach;
/** 严重度的人话标签；未知等级退到"待定级"，绝不回落成 `P?` 字面量。 */
export declare function severityLabel(level: string, language?: OutputLanguage): string;
/** 排序权重：P0 最前。 */
export declare const SEVERITY_ORDER: Record<string, number>;
/** 是否属于需要主动提示用户的严重度（一级 / 二级问题）。 */
export declare function isUrgent(level: string): boolean;
/** 判定是否计入"有效问题"（显式与隐式确认合并计入，spec §6.4）。 */
export declare function isConfirmed(status: FindingStatus): boolean;
/**
 * 把技术块渲染成结构化 YAML —— 卡片"一键复制"的内容，直接可粘给 AI
 * （v0.1.1 spec §3.3 / §8）。Host 与 Client 共用同一函数，避免两处漂移。
 * @param finding - 已定稿的 finding。
 * @returns 可直接粘贴的 YAML 文本（不含尾随换行）。
 */
export declare function technicalYaml(finding: UxFinding): string;
/**
 * 为已确认的问题生成可直接交给编码 AI 的任务 Prompt。
 *
 * Prompt 只描述已经观察到的现象、用户影响与验收目标，不携带 suggestion /
 * rationale，避免插件基于局部代码替 AI 预设实现方案。locator 只是帮助 AI
 * 开始调查的线索；Prompt 会明确要求先补齐完整项目上下文。
 */
export declare function deliveryPrompt(finding: UxFinding, language?: OutputLanguage): string;
/** 走查的运行模式（v0.1.1 spec §4.1）。 */
export type UxMode = 'auto' | 'review' | 'interactive';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * 一份 UX 走查报告成立：唯一 start 事件，携带整份 findings 快照。
         * @mode emit
         */
        'ux/report': {
            /** 报告稳定 id（如 ux-rpt-a1b2c3d4-1）；同一 id 最多一个 start。 */
            reportId: string;
            /** 报告标题。 */
            title: string;
            /** 本次走查的运行模式：卡片据此决定是否渲染批量确认条。 */
            mode: UxMode;
            /** 报告与卡片固定界面的语言。 */
            language: OutputLanguage;
            /** 本轮采用的产品/业务类型。 */
            productType: ProductType;
            /**
             * 本次实际扫描到的文件清单（相对项目根）。隐式确认必须区分
             * "扫了没发现"与"根本没扫"，比对时先判断 finding 的位置是否落在
             * 本次 scope 内（v0.1.1 spec §6.3）。
             */
            scope: string[];
            /** 整份 finding 快照（创建时全部为 pending）。 */
            findings: UxFinding[];
        };
        /**
         * 对一条 finding 的判定：update 事件，按 reportId 归属报告。
         * 来源有三种——卡片按钮、自然语言（ux_judge 工具）、下一次走查算出的
         * 隐式确认 / 失效标记。
         * @mode emit
         */
        'ux/finding-status': {
            reportId: string;
            findingId: string;
            status: FindingVerdict;
        };
    }
}
