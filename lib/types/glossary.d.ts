/**
 * 术语表（`.ux/glossary.yml`）读写与增量合并（spec §5.4 / R-02）。
 *
 * R-02 是规则集中跨文件比对最贵的一条：术语表持久化后，后续走查只对
 * 新增或变更的术语做增量判断，不重复全量比对。
 */
export declare const GLOSSARY_FILE = ".ux/glossary.yml";
/** 一个术语条目：规范词 + 变体 + 判定备注。 */
export interface GlossaryTerm {
    /** 规范词（项目内应统一使用的词）。 */
    canonical: string;
    /** 与规范词同义的其他写法。 */
    variants: string[];
    /** 判定备注（可选）。 */
    note?: string;
}
export interface GlossaryFile {
    terms: GlossaryTerm[];
}
export declare function glossaryPath(root: string): string;
/** 读取术语表；文件不存在时返回空表。 */
export declare function loadGlossary(root: string): GlossaryFile;
/** 校验并规范化一组术语更新。 */
export declare function validateTerms(updates: readonly GlossaryTerm[], where: string): GlossaryTerm[];
/**
 * 增量合并术语更新到 `.ux/glossary.yml`：
 * 同 canonical 条目合并变体并集，新条目追加；有变更才落盘。
 */
export declare function mergeGlossary(root: string, updates: readonly GlossaryTerm[]): GlossaryFile;
