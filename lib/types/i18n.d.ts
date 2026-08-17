/** 固定界面当前完整支持的语言；模型生成的 finding 文本仍可使用其他语言。 */
export type OutputLanguage = 'zh-CN' | 'en';
export type ConfiguredLanguage = 'auto' | OutputLanguage;
/** 把 BCP-47/自然语言名称归一到固定界面支持的语言。 */
export declare function normalizeLanguage(value: string | undefined): OutputLanguage | undefined;
/**
 * 从项目主 README 推断开发文档语言。双语仓库以 README.md 为准，因为它通常
 * 是默认落地页；无法判断时使用英语作为跨项目回退。
 */
export declare function detectProjectLanguage(root: string): OutputLanguage;
/**
 * 输出语言优先级：插件显式配置 > 当前请求中模型识别的语言 > 项目主文档语言。
 */
export declare function resolveOutputLanguage(root: string, configured: ConfiguredLanguage, requested?: string): OutputLanguage;
export declare function isChinese(language: OutputLanguage): boolean;
