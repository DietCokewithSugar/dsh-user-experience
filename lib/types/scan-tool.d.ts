/**
 * `ux_scan` 工具（spec §6 R3）：源码走查的第一阶段。
 *
 * 职责边界（模型判断为主、AST 求证为辅）：
 * - 校验技术栈（React + TypeScript / React + JavaScript / Vue 3；不支持时
 *   明确告知，不给低质量猜测）；
 * - 按给定范围收集源文件（范围建议由 R6 流程在调用前完成）；
 * - 按技术栈分派解析引擎（React 源码走 TypeScript 编译器 API；Vue SFC 走
 *   @vue/compiler-sfc + compiler-dom，script 块复用 TS 引擎），产出带
 *   locator 的结构化候选证据；
 * - 返回给模型：文件清单 + 候选 + 既有术语表 + 后续步骤指引。
 *
 * 工具**不做**语义判断、不直接产出 finding：模型读候选、核实代码、按 persona
 * 判定后经 `ux_report` 落定。R-09 候选为 AST 快车道结论（verified_by: ast）。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type OutputLanguage } from './i18n';
import { type ProductType } from './product';
import type { SurfaceHint } from './surface';
import type { UxConfig } from './config';
import type { AstCandidate } from './ast';
export interface ScanResult {
    supported: boolean;
    stack: string;
    reason?: string;
    focus?: string;
    persona_id?: string;
    language: OutputLanguage;
    product_type: ProductType;
    review_focus: readonly string[];
    heuristics: readonly string[];
    review_priority: readonly string[];
    files: Array<{
        path: string;
        size: number;
    }>;
    file_count: number;
    truncated: boolean;
    candidates: AstCandidate[];
    /** 人话位置名素材：每条 finding 的 surface 由模型据此选用或拟名。 */
    surface_hints: SurfaceHint[];
    glossary: Array<{
        canonical: string;
        variants: string[];
        note?: string;
    }>;
    guidance: string[];
}
/** 注册 `ux_scan` 工具。 */
export declare function uxScanTool(config: UxConfig): ToolDefinition;
