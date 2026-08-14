/**
 * 指纹历史账本 `.ux/history.jsonl`（v0.1.1 spec §6 / §7）。
 *
 * **注意区分判定结果与指标账本**：单次判定（confirmed / rejected）是阶段性
 * 事实，留在会话日志里，不进仓库；本文件是**长期指标数据**——指纹、首次出现、
 * 末次出现、终态、每次走查的 scope。gitignore，不提交。
 *
 * 隐式确认的机制是：**下一次走查时某条 finding 消失了 = 用户把它改掉了 =
 * 这条问题成立**。用户什么都不用点，而且这个信号比人工点"确认存在"更硬。
 *
 * 但 finding 消失有三种可能（spec §6.3，整个机制最容易出错的地方）：
 * 1. 用户改掉了                   → 隐式确认成立
 * 2. 这次走查范围没覆盖到那里     → **不能判定**，置 stale，不计入指标分母
 * 3. 代码被整块删除 / 页面下线     → 不算"改进"，同样不计入
 *
 * 因此隐式确认**仅在同一 scope 被重新扫描时生效**，走查记录必须存下本次的 scope。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSameFinding, type FingerprintParts } from './fingerprint'
import { isConfirmed, type FindingStatus, type UxFinding } from './types'

export const HISTORY_FILE = '.ux/history.jsonl'

/** 账本中一条 finding 的折叠态。 */
export interface HistoryEntry {
  fingerprint: string
  rule: string
  symbol_path: string
  feature_digest: string
  /** 相对项目根的文件路径：scope 校验用。 */
  file: string
  /** 末次已知的人话页面名（仅供展示，不进指纹）。 */
  surface: string
  /** 末次出现所属的报告与 finding id：判定回写会话事件时要用。 */
  report_id: string
  finding_id: string
  first_seen: number
  last_seen: number
  status: FindingStatus
  /** 置为 stale 的原因：本次没扫到，还是代码已被删除。 */
  reason?: 'scope-miss' | 'removed'
}

/** 账本折叠结果。 */
export interface Ledger {
  entries: Map<string, HistoryEntry>
  /** 最近一次走查的 scope（相对项目根的文件清单）。 */
  lastScope: string[]
}

type ScanRecord = { kind: 'scan'; at: number; scope: string[] }
type FindingRecord = {
  kind: 'finding'
  at: number
  fingerprint: string
  rule: string
  symbol_path: string
  feature_digest: string
  file: string
  surface: string
  report_id: string
  finding_id: string
}
type VerdictRecord = {
  kind: 'verdict'
  at: number
  fingerprint: string
  status: FindingStatus
  reason?: 'scope-miss' | 'removed'
}
type HistoryRecord = ScanRecord | FindingRecord | VerdictRecord

export function historyPath(root: string): string {
  return join(root, HISTORY_FILE)
}

function appendRecords(root: string, records: readonly HistoryRecord[]): void {
  if (records.length === 0) return
  const file = historyPath(root)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
}

/**
 * 读取并折叠账本。坏行跳过——append-only 文件被外部工具截断时不应炸掉走查。
 * @param root - 项目根目录。
 * @returns 折叠后的账本。
 */
export function loadLedger(root: string): Ledger {
  const file = historyPath(root)
  const ledger: Ledger = { entries: new Map(), lastScope: [] }
  if (!existsSync(file)) return ledger
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ledger
  }
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let record: HistoryRecord
    try {
      record = JSON.parse(line) as HistoryRecord
    } catch {
      continue
    }
    if (record.kind === 'scan') {
      ledger.lastScope = Array.isArray(record.scope) ? record.scope : []
      continue
    }
    if (record.kind === 'finding') {
      const existing = ledger.entries.get(record.fingerprint)
      if (existing === undefined) {
        ledger.entries.set(record.fingerprint, {
          fingerprint: record.fingerprint,
          rule: record.rule,
          symbol_path: record.symbol_path,
          feature_digest: record.feature_digest,
          file: record.file,
          surface: record.surface,
          report_id: record.report_id,
          finding_id: record.finding_id,
          first_seen: record.at,
          last_seen: record.at,
          status: 'pending',
        })
        continue
      }
      existing.last_seen = record.at
      existing.file = record.file
      existing.surface = record.surface
      existing.report_id = record.report_id
      existing.finding_id = record.finding_id
      // 曾被判为"无法判定"的条目重新被扫到并再次出现：回到待判定。
      if (existing.status === 'stale') {
        existing.status = 'pending'
        delete existing.reason
      }
      continue
    }
    const entry = ledger.entries.get(record.fingerprint)
    if (entry === undefined) continue
    entry.status = record.status
    if (record.reason === undefined) delete entry.reason
    else entry.reason = record.reason
  }
  return ledger
}

/** 一条 finding 参与比对所需的最小信息。 */
export interface ComparableFinding extends FingerprintParts {
  fingerprint: string
}

/** 由已定稿的 finding 取出比对三元组。 */
export function comparableOf(finding: UxFinding, featureDigest: string): ComparableFinding {
  return {
    fingerprint: finding.fingerprint,
    rule: finding.technical.rule,
    symbolPath: [finding.technical.locator.file, finding.technical.locator.symbol]
      .filter((part): part is string => typeof part === 'string' && part.length > 0).join('::'),
    featureDigest,
  }
}

/** 一次隐式判定的结果。 */
export interface ImplicitVerdict {
  entry: HistoryEntry
  status: 'confirmed_implicit' | 'stale'
  reason?: 'scope-miss' | 'removed'
}

export interface ReconcileInput {
  /** 本次实际扫描到的文件清单（相对项目根）。 */
  scopeFiles: readonly string[]
  /** 本次报告中仍然存在的 finding 比对信息。 */
  current: readonly ComparableFinding[]
  /** 判定时间戳（便于测试注入）。 */
  at?: number
}

/**
 * 比对上一轮遗留的待判定条目，算出隐式确认与失效标记，并落账。
 *
 * 判定顺序刻意如此：**先查文件是否还在，再查是否在 scope 内**——代码被整块
 * 删除时文件仍可能落在 scope 里，若先判 scope 就会把"删代码"误判成"改进"。
 * @param root - 项目根目录。
 * @param input - 本次 scope、本次仍存在的 finding。
 * @returns 本次产生的隐式判定列表（调用方据此回写会话事件）。
 */
export function reconcile(root: string, input: ReconcileInput): ImplicitVerdict[] {
  const at = input.at ?? Date.now()
  const ledger = loadLedger(root)
  const scope = new Set(input.scopeFiles)
  const stillPresent = (entry: HistoryEntry): boolean => {
    if (input.current.some((finding) => finding.fingerprint === entry.fingerprint)) return true
    const parts: FingerprintParts = {
      rule: entry.rule,
      symbolPath: entry.symbol_path,
      featureDigest: entry.feature_digest,
    }
    // 重命名等导致的漂移：三元组两项匹配即视为同一问题，不算消失。
    return input.current.some((finding) => isSameFinding(parts, finding))
  }

  const verdicts: ImplicitVerdict[] = []
  for (const entry of ledger.entries.values()) {
    // stale 不是终态而是"还没判定"：位置一旦被重新扫描，它就该重新参与比对。
    if (entry.status !== 'pending' && entry.status !== 'stale') continue
    if (stillPresent(entry)) continue
    // 顺序刻意如此：先查文件是否还在。代码被整块删除时文件仍可能落在 scope 里，
    // 先判 scope 就会把"删代码"误判成"改进"。
    const computed: ImplicitVerdict = !existsSync(join(root, entry.file))
      ? { entry, status: 'stale', reason: 'removed' }
      : !scope.has(entry.file)
        ? { entry, status: 'stale', reason: 'scope-miss' }
        : { entry, status: 'confirmed_implicit' }
    // 状态没变就不再落账，免得同一条 stale 每轮都写一行。
    if (computed.status === entry.status && computed.reason === entry.reason) continue
    verdicts.push(computed)
  }

  appendRecords(root, verdicts.map((verdict) => ({
    kind: 'verdict' as const,
    at,
    fingerprint: verdict.entry.fingerprint,
    status: verdict.status,
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
  })))
  return verdicts
}

export interface RecordScanInput {
  reportId: string
  scope: readonly string[]
  findings: readonly UxFinding[]
  /** finding id → 特征摘要（指纹的第三项，账本比对要用）。 */
  featureDigests: ReadonlyMap<string, string>
  at?: number
}

/**
 * 记录一次走查：先写 scope，再写本轮每条 finding。
 * @param root - 项目根目录。
 * @param input - 报告 id、本次 scope、定稿 findings。
 */
export function recordScan(root: string, input: RecordScanInput): void {
  const at = input.at ?? Date.now()
  const records: HistoryRecord[] = [{ kind: 'scan', at, scope: [...input.scope] }]
  for (const finding of input.findings) {
    records.push({
      kind: 'finding',
      at,
      fingerprint: finding.fingerprint,
      rule: finding.technical.rule,
      symbol_path: [finding.technical.locator.file, finding.technical.locator.symbol]
        .filter((part): part is string => typeof part === 'string' && part.length > 0).join('::'),
      feature_digest: input.featureDigests.get(finding.id) ?? '',
      file: finding.technical.locator.file,
      surface: finding.surface,
      report_id: input.reportId,
      finding_id: finding.id,
    })
  }
  appendRecords(root, records)
}

/**
 * 记录一条显式判定（卡片按钮 / 自然语言），让长期指标也能看见人工确认。
 * @param root - 项目根目录。
 * @param fingerprint - 目标 finding 的指纹。
 * @param status - 判定终态。
 */
export function recordVerdict(root: string, fingerprint: string, status: FindingStatus): void {
  if (fingerprint.length === 0) return
  appendRecords(root, [{ kind: 'verdict', at: Date.now(), fingerprint, status }])
}

/** 长期指标（spec §8 指标一：有效问题占比）。 */
export interface Metrics {
  /** 确认成立（显式 + 隐式合并计入）。 */
  confirmed: number
  rejected: number
  pending: number
  /** 无法判定，**不计入分母**。 */
  stale: number
  /**
   * 有效问题占比（spec §8 指标一）。分母是**已判定的条目**（confirmed +
   * rejected）：`stale` 按 §6.4 排除，`pending` 也不进分母——尚未判定不等于
   * 判定为无效，把它算进去只会让指标随"没人去点"而失真。分母为 0 时 undefined。
   */
  effectiveRatio?: number
}

/**
 * 由账本计算长期指标。
 * @param root - 项目根目录。
 * @returns 各状态计数与有效问题占比。
 */
export function metricsOf(root: string): Metrics {
  const ledger = loadLedger(root)
  let confirmed = 0
  let rejected = 0
  let pending = 0
  let stale = 0
  for (const entry of ledger.entries.values()) {
    if (isConfirmed(entry.status)) confirmed += 1
    else if (entry.status === 'rejected') rejected += 1
    else if (entry.status === 'stale') stale += 1
    else pending += 1
  }
  const denominator = confirmed + rejected
  return {
    confirmed,
    rejected,
    pending,
    stale,
    ...(denominator === 0 ? {} : { effectiveRatio: confirmed / denominator }),
  }
}
