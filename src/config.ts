/**
 * 插件配置与内部设置类型。
 *
 * 配置项可被 profile 的 cordis.patch.yml / --patch 层按 id `ux-experience`
 * 覆盖（spec 发布要求：可调值不硬编码，全部进 schema）。
 */

import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'

export interface Config {
  /** 单次扫描收集的最大源文件数。 */
  maxScanFiles: number
  /** 每条规则每文件的最大候选数。 */
  maxCandidatesPerRule: number
  /** 每文件的最大候选总数。 */
  maxCandidatesPerFile: number
  /** 单份报告允许的最大 finding 数。 */
  maxFindings: number
  /** 扫描收集时额外跳过的目录名。 */
  excludePatterns: string[]
}

export const Config: Schema<Config> = Schema.object({
  maxScanFiles: Schema.number().default(300),
  maxCandidatesPerRule: Schema.number().default(5),
  maxCandidatesPerFile: Schema.number().default(25),
  maxFindings: Schema.number().default(30),
  excludePatterns: Schema.array(String).default([
    'node_modules', 'dist', 'build', 'out', 'coverage', '.git',
    'test', 'tests', '__tests__', 'spec', 'e2e', 'stories', 'mocks',
  ]),
})

/** 工具共享的内部设置（validate 后的 config 直接即此类型）。 */
export type UxConfig = Config
