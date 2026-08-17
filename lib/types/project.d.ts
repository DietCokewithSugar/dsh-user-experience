/**
 * 项目探测与扫描范围收敛（spec §6 R3 / R6）。
 *
 * - `detectStack`：v0.2 技术栈范围 = React（TypeScript / JavaScript）+ Vue 3。
 *   检出非支持技术栈时明确告知不支持，不给低质量猜测（spec §边界场景 9）。
 * - `gatherFiles`：按用户给定的范围（文件/目录列表）与探测出的技术栈收集
 *   对应扩展名的源文件。大仓库不做全量扫描：范围建议由模型在 R6 流程中给出
 *   （架构说明文件优先，否则主动询问），本函数只负责执行收集。
 */
/** 支持的技术栈种类（驱动源文件收集与解析引擎分派）。 */
export type StackKind = 'react-ts' | 'react-js' | 'vue';
/** 技术栈探测结果。 */
export interface StackInfo {
    supported: boolean;
    /** 支持时的技术栈种类；不支持时为 undefined。 */
    kind?: StackKind;
    /** 人类可读的技术栈描述。 */
    stack: string;
    /** 不支持时给出的原因。 */
    reason?: string;
}
/** 默认跳过的目录名（扫描收集阶段）。 */
export declare const DEFAULT_EXCLUDES: string[];
/**
 * 探测项目技术栈。
 *
 * React：package.json 依赖含 react；TypeScript：存在 tsconfig.json 或
 * .ts/.tsx 源文件，否则按 React + JavaScript 处理。Vue：依赖含 vue（或
 * @vue/runtime-core）或存在 .vue 源文件；Vue 2 明确不支持（SFC 解析基于
 * @vue/compiler-sfc）。非支持栈（Svelte / 小程序等）给出明确原因。
 */
export declare function detectStack(root: string): StackInfo;
/** 收集到的单个文件。 */
export interface ScopeFile {
    /** 相对项目根的路径（用 / 分隔）。 */
    path: string;
    size: number;
}
export interface ScopeGather {
    files: ScopeFile[];
    truncated: boolean;
    skipped: number;
}
export declare function gatherFiles(root: string, paths: readonly string[], excludes: readonly string[], maxFiles: number, stack: StackKind): ScopeGather;
/** 收集与组件范围相邻的样式文件，供 CSS/布局候选分析。 */
export declare function gatherStyleFiles(root: string, paths: readonly string[], excludes: readonly string[], maxFiles: number): ScopeGather;
/** 项目根内最可能承载前端源码的目录建议（R6 范围建议的兜底素材）。 */
export declare function suggestSourceRoots(root: string): string[];
/** 读取文件文本（带 size 上限保护）。 */
export declare function readSourceFile(root: string, file: ScopeFile, maxBytes: number): string;
