/**
 * 走查偏好文件 `.ux/rules.local.yml` 的读取（spec §5.4 / v0.1.1 §4.2、§5）。
 *
 * 定位是**个人偏好**：不提交仓库（gitignore），不强加给团队。用户表达过一次
 * 的意愿不该在下一次走查中被再问一遍。
 *
 * 本版只认两个键——`mode`（运行模式）与 `autoScan`（R7 自动走查开关）。
 * 其余键（按 ID 关闭规则、重点关注方向、排除目录等 v0.1 P1 项）**宽容忽略**，
 * 后续补齐时不会破坏已有文件格式。解析失败同样不报错：偏好文件坏掉不应该
 * 阻断走查，退回默认即可。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { UxMode } from './types'

export const LOCAL_RULES_FILE = '.ux/rules.local.yml'

/** R7 自动走查的本地开关。 */
export interface AutoScanPreference {
  /** 是否启用改动触发的自动走查。 */
  enabled?: boolean
  /** 两次自动走查之间至少间隔多少个回合（防抖）。 */
  debounceTurns?: number
}

/** `.ux/rules.local.yml` 中本版认识的部分。 */
export interface LocalRules {
  /** 固定运行模式；缺省时走场景自动选择。 */
  mode?: UxMode
  autoScan?: AutoScanPreference
}

interface CacheEntry {
  stamp: string
  rules: LocalRules
}

/** cwd → 最近一次读取结果（mtime + size 一致才命中）。 */
const cache = new Map<string, CacheEntry>()

function stampOf(file: string): string | undefined {
  try {
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return undefined
  }
}

export function localRulesPath(root: string): string {
  return join(root, LOCAL_RULES_FILE)
}

function asMode(value: unknown): UxMode | undefined {
  return value === 'auto' || value === 'review' || value === 'interactive' ? value : undefined
}

function asAutoScan(value: unknown): AutoScanPreference | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const preference: AutoScanPreference = {}
  if (typeof record.enabled === 'boolean') preference.enabled = record.enabled
  if (typeof record.debounceTurns === 'number' && Number.isSafeInteger(record.debounceTurns)
    && record.debounceTurns >= 0) {
    preference.debounceTurns = record.debounceTurns
  }
  return preference
}

/**
 * 读取偏好文件；文件缺失、不可解析或键型不对时返回空偏好（不抛错）。
 * @param root - 项目根目录。
 * @returns 本版认识的偏好项。
 */
export function loadLocalRules(root: string): LocalRules {
  const file = localRulesPath(root)
  const stamp = stampOf(file)
  if (stamp === undefined) {
    cache.delete(root)
    return {}
  }
  const hit = cache.get(root)
  if (hit !== undefined && hit.stamp === stamp) return hit.rules
  let rules: LocalRules = {}
  if (existsSync(file)) {
    let parsed: unknown
    try {
      parsed = parse(readFileSync(file, 'utf8'))
    } catch {
      parsed = undefined
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const mode = asMode(record.mode)
      const autoScan = asAutoScan(record.autoScan)
      rules = {
        ...(mode === undefined ? {} : { mode }),
        ...(autoScan === undefined ? {} : { autoScan }),
      }
    }
  }
  cache.set(root, { stamp, rules })
  return rules
}
