/**
 * 常驻走查协议（系统提示词）。
 *
 * 用户侧不再使用 `/ux` / `/ux init` / `/ux scan`。模型根据自然语言意图
 * 自己决定是否上场；完整走查步骤写在这里，而不是写在命令的 followup 里。
 */
import type { LoadedPersonas, Persona, PersonaStatus } from './types';
/** 意图门：什么时候上场，什么时候别动。 */
export declare function intentGate(): string;
/** 没有画像文件时：主动走查才确认，自动走查用草稿。 */
export declare function lazyInitProtocol(brief: string): string;
/** 已有画像时的说明（含草稿校准）。 */
export declare function renderExistingPersonas(personas: readonly Persona[], status: PersonaStatus): string;
/** 走查步骤与铁律（原 /ux scan followup，现为常驻协议）。 */
export declare function walkthroughProtocol(): string;
/**
 * R2 入口用的完整系统提示词片段。
 * @param loaded - 已读出的画像文件；不存在时为 undefined。
 * @param brief - 无画像时附上的项目素材简报。
 */
export declare function buildPersonaSectionText(loaded: LoadedPersonas | undefined, brief: string): string;
