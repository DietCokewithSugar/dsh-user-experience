import type { AstCandidate, AstExtractOptions } from './ast';
/**
 * CSS/SCSS/Less 的保守候选扫描。它只定位可能影响布局密度与视觉语言的信号；
 * R-10/R-12 仍要求真实页面截图，不能由 CSS 候选直接定稿。
 */
export declare function extractCssCandidates(file: string, source: string, options: AstExtractOptions): AstCandidate[];
