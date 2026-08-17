/**
 * AST 求证引擎（spec 附录 A）：
 *
 * 用 TypeScript 编译器 API 把代码解析成结构化的语法树，按规则目录提取
 * "可证伪的结构断言"。分工是：模型负责召回与语义判断，AST 负责精度——
 * 把模型的猜测降为可证伪的结构断言（`verified_by: model+ast`）；
 * R-09 是纯结构问题，AST 直接出结论（`verified_by: ast`，快车道，零 token）。
 *
 * 输出的 AstCandidate 是**候选证据**，不是最终 finding：
 * - 每条候选都带 locator 与原文片段，模型可以据此去读码核实；
 * - 模型确认后才经 `ux_report` 落为 finding；
 * - R-02 的候选仅提供术语位置，同义判断只能由模型完成（verified_by: model）。
 *
 * 为什么不用正则：搜 `text-black` 会把注释、字符串常量、变量名一起搜出来；
 * AST 知道它到底是不是 JSX 元素 className 属性里的类名（spec A.1）。
 */
import ts from 'typescript';
import type { RuleId } from './rules';
import type { VerifiedBy } from './types';
/** 一条 AST 候选证据。 */
export interface AstCandidate {
    rule: RuleId;
    file: string;
    symbol?: string;
    line?: number;
    snippet: string;
    note: string;
    /** 验证来源：model | model+ast | ast（与 wire schema 的 verified_by 字段一致）。 */
    verified_by: VerifiedBy;
}
export interface AstExtractOptions {
    /** 每条规则每文件的最大候选数。 */
    maxPerRule: number;
    /** 每文件的最大候选总数。 */
    maxPerFile: number;
}
/** 深色模式相关的 Tailwind 颜色类（含任意值），不含纯布局类如 text-center。 */
export declare const COLOR_CLASS: RegExp;
/** 硬编码颜色字面量。 */
export declare const COLOR_LITERAL: RegExp;
/** 硬编码颜色字面量的子串搜索版本（Vue :style 绑定等整段表达式内检索）。 */
export declare const COLOR_LITERAL_SEARCH: RegExp;
/** 错误文案中的"行动指引"词。 */
export declare const ACTION_WORD: RegExp;
/** 泛化的确认文案（无信息量）。 */
export declare const GENERIC_CONFIRM: RegExp;
/** 截断 / 占位兜底的信号。 */
export declare const TRUNCATION_PATTERN: RegExp;
/** 文件内出现任意确认交互的信号。 */
export declare const CONFIRM_PATTERN: RegExp;
/** 破坏性操作调用名。 */
export declare const DESTRUCTIVE_CALL: RegExp;
/** 提交类异步处理器名。 */
export declare const SUBMIT_HANDLER: RegExp;
/** 函数体中出现"空态覆盖"的信号。 */
export declare const EMPTY_PATTERN: RegExp;
/** 长列表控制信号：分页、虚拟化、窗口化、截断或显式数量限制。 */
export declare const LIST_CONTROL_PATTERN: RegExp;
/** 用户可见 Emoji / 图形符号。 */
export declare const EMOJI_PATTERN: RegExp;
/** 函数体中出现"加载分支"的信号（作用于条件表达式条件文本）。 */
export declare const LOADING_PATTERN: RegExp;
/** 类 label 属性名（术语候选素材）。 */
export declare const LABEL_ATTRS: Set<string>;
/**
 * 从单个文件提取候选证据。
 * @param file - 相对项目根路径（写入候选的 locator）。
 * @param source - 文件文本。
 * @param options - 候选数量上限配置。
 * @param scriptKind - 解析方式：React 源码一律 TSX（.js 也可能含 JSX）；
 *   Vue `<script>` 块用 TS（无 JSX，lang=jsx/tsx 除外）。
 */
export declare function extractCandidates(file: string, source: string, options: AstExtractOptions, scriptKind?: ts.ScriptKind): AstCandidate[];
