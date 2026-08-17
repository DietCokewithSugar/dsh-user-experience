import type { OutputLanguage } from './i18n';
export declare function nielsenGuidance(language: OutputLanguage): readonly string[];
/** 按常见程度安排检查顺序；最终报告仍按严重度排序。 */
export declare function reviewPriority(language: OutputLanguage): readonly string[];
