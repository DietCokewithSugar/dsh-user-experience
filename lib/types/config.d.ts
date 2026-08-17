/**
 * 插件配置与内部设置类型。
 *
 * 配置项可被 profile 的 cordis.patch.yml / --patch 层按 id `ux-experience`
 * 覆盖（spec 发布要求：可调值不硬编码，全部进 schema）。
 */
import Schema from '@deepseek-ai/schemastery';
import type { ConfiguredLanguage } from './i18n';
import type { ConfiguredMode } from './mode';
export interface Config {
    /** 单次扫描收集的最大源文件数。 */
    maxScanFiles: number;
    /** 每条规则每文件的最大候选数。 */
    maxCandidatesPerRule: number;
    /** 每文件的最大候选总数。 */
    maxCandidatesPerFile: number;
    /** 单份报告允许的最大 finding 数。 */
    maxFindings: number;
    /** 扫描收集时额外跳过的目录名。 */
    excludePatterns: string[];
    /**
     * 默认运行模式；`detect` 表示按场景自动选择（CI / R7 触发走 auto，
     * 用户主动发起走 review）。`.ux/rules.local.yml` 与 `--mode` 优先级更高。
     */
    mode: ConfiguredMode;
    /** 是否启用 R7 改动触发的自动走查（可在 .ux/rules.local.yml 中关闭）。 */
    autoScan: boolean;
    /** 视为"文件编辑"的工具名：其成功结果会被计入改动集合。 */
    autoScanEditTools: string[];
    /** 单次自动走查最多纳入的改动文件数（超出则截断，避免范围失控）。 */
    autoScanMaxFiles: number;
    /** 两次自动走查之间至少间隔的回合数。 */
    autoScanDebounceTurns: number;
    /** 报告与卡片语言；auto 时优先跟随用户请求，再回退到项目主 README。 */
    outputLanguage: ConfiguredLanguage;
}
export declare const Config: Schema<Config>;
/** 工具共享的内部设置（validate 后的 config 直接即此类型）。 */
export type UxConfig = Config;
