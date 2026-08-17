/**
 * Persona 文件读写与校验。
 *
 * 存储位置：`.ux/personas.yml`（仓库内一等公民文件）。
 * 推断草稿可先落盘（status=draft）供自动走查使用；用户确认后升为 confirmed。
 * 本模块负责结构校验与缓存（按 cwd + mtime）。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LoadedPersonas, Persona, PersonaStatus } from './types';
/** Persona 文件相对项目根的路径。 */
export declare const PERSONAS_FILE = ".ux/personas.yml";
export declare function personasPath(root: string): string;
/** 校验单条 persona，失败时抛出带上下文的 TypeError。 */
export declare function validatePersona(value: unknown, where: string): Persona;
/** 校验 personas 列表；id 必须唯一。 */
export declare function validatePersonas(values: readonly unknown[], where: string): Persona[];
/**
 * 读取项目根目录下的 persona 文件（含 status）。
 * @returns 画像与确认状态；文件不存在时返回 undefined。
 */
export declare function loadPersonaFile(root: string): LoadedPersonas | undefined;
/**
 * 读取项目根目录下的 persona 列表。
 * @returns persona 列表；文件不存在时返回 undefined。
 */
export declare function loadPersonas(root: string): readonly Persona[] | undefined;
/** 已存在 persona 文件时，persona id 是否合法。 */
export declare function personaExists(root: string, id: string): boolean;
/**
 * 写入 `.ux/personas.yml`（`ux_personas_write` 工具的唯一写入口）。
 * 写入前完整校验；返回落盘的 persona 列表。
 */
export declare function writePersonas(root: string, personas: readonly Persona[], status?: PersonaStatus): readonly Persona[];
/**
 * R2 入口：为一次系统提示词装配渲染 persona 片段。
 * 每次装配按当前 agent 的 cwd 读取文件（带 mtime 缓存）。
 */
export declare function renderPersonaSection(agent: Agent | undefined): string;
/** 收集生成画像草稿的素材简报：README 片段 + package.json + 顶层目录。 */
export declare function collectInitBrief(root: string): string;
