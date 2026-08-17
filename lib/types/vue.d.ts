/**
 * Vue 3 SFC 走查引擎（v0.2 技术栈扩展）：
 *
 * 与 React 引擎（ast.ts）同一分工——模型判断为主、AST 求证为辅。一个 .vue
 * 文件被拆成两部分分别求证：
 *
 * - `<script>` / `<script setup>` 块：直接复用 TypeScript 编译器 API 引擎
 *   （R-01 错误分支文案、R-03 泛化确认调用、R-04 破坏性调用路径、R-06 异步
 *   无 catch）。块内行号被平移到整个 .vue 文件的行号（locator 精度）。
 * - `<template>` 块：用 `@vue/compiler-dom` 的 `baseParse` 得到真实模板 AST
 *   （ElementNode / DirectiveNode / InterpolationNode…），按规则目录在
 *   结构节点上提取候选——v-if/v-for/@click/:class/:style 都是结构化节点，
 *   不会把注释、字符串常量误判进来（对齐 spec 附录 A.1 的"为什么不用正则"）。
 *
 * 模板级判定是文件粒度（等价 React 引擎的函数粒度），比 React 引擎更粗：
 * 候选 note 中明确要求模型核实"信号与结论是否属于同一列表/同一操作"。
 */
import type { AstCandidate, AstExtractOptions } from './ast';
/**
 * 从单个 .vue 文件提取候选证据。
 * @param file - 相对项目根路径（写入候选的 locator）。
 * @param source - 文件文本。
 * @param options - 候选数量上限配置。
 */
export declare function extractVueCandidates(file: string, source: string, options: AstExtractOptions): AstCandidate[];
