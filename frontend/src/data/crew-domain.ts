import type { EntryRow } from './types'

/**
 * 班组进退场领域逻辑（纯函数，不碰 localStorage，方便单测）。
 *
 * 在场人数的「唯一权威源」是班组台账：只统计状态为「在场」的班组，逐班组汇总。
 * 巡检台账、详情面板、运营概览都走这里的 presentHeadcount，不再另存一份计数器，
 * 从结构上杜绝退场漏扣、连点扣两遍、两边对不上。
 */

export const CREW_STATUS_WAITING = '待进场'
export const CREW_STATUS_PRESENT = '在场'
export const CREW_STATUS_LEFT = '已退场'
export const CREW_STATUS_STOPPED = '已停工'

export const ACTION_ENTER = '办理进场'
export const ACTION_LEAVE = '办理退场'
export const ACTION_STOP = '登记停工'
export const ACTION_RESUME = '复工'

/** 销账待办在巡检台账里的类型标记，与人工巡检记录区分开。 */
export const WRITEOFF_KIND = '班组退场销账'
export const WRITEOFF_OPEN = '待整改'
export const WRITEOFF_CLOSED = '已闭环'

/** 各状态允许直接提交的动作；没命中就按越级处理，并指出缺的那一步。 */
const NEXT_ACTIONS: Record<string, string[]> = {
  [CREW_STATUS_WAITING]: [ACTION_ENTER],
  [CREW_STATUS_PRESENT]: [ACTION_LEAVE, ACTION_STOP],
  [CREW_STATUS_LEFT]: [ACTION_ENTER],
  [CREW_STATUS_STOPPED]: [ACTION_RESUME, ACTION_LEAVE],
}

/** 越级提交时缺哪一步的明确提示。 */
const MISSING_STEP: Record<string, Record<string, string>> = {
  [CREW_STATUS_WAITING]: {
    [ACTION_LEAVE]: `班组尚未进场，不能直接退场，请先完成「${ACTION_ENTER}」`,
    [ACTION_STOP]: `班组尚未进场，不能登记停工，请先完成「${ACTION_ENTER}」`,
    [ACTION_RESUME]: `班组尚未进场，没有可复工的班组，请先完成「${ACTION_ENTER}」`,
  },
  [CREW_STATUS_PRESENT]: {
    [ACTION_ENTER]: '班组已经在场，无需重复进场',
    [ACTION_RESUME]: '班组正在正常作业，不属于停工状态，无需复工',
  },
  [CREW_STATUS_LEFT]: {
    [ACTION_LEAVE]: '班组已经退场，无需重复退场',
    [ACTION_STOP]: '班组已经退场，不能登记停工；如需停工请先重新办理进场',
    [ACTION_RESUME]: '班组已退场，复工不适用；请先重新办理进场',
  },
  [CREW_STATUS_STOPPED]: {
    [ACTION_ENTER]: '班组处于停工状态，请直接办理「复工」，不要重新进场',
    [ACTION_STOP]: '班组已经停工，不用重复登记',
  },
}

export function parseHeadcount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0
}

function normalizeDate(value: unknown): string {
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}

function entryDateOf(row: EntryRow): string {
  // 老数据没有进场日期：安全交底日期必然发生在进场时，借它作为排序与重排依据。
  return normalizeDate(row['进场日期']) || normalizeDate(row['安全交底日期'])
}

/** 兼容老数据：把一条班组记录校正成新口径。 */
export function normalizeCrew(row: EntryRow, fallbackProject: string): EntryRow {
  let status = String(row.status ?? '').trim()
  if (!NEXT_ACTIONS[status]) {
    // 老数据可能把在场状态写在字段里而不是状态位上。
    const legacy = String(row['在场状态'] ?? '').trim()
    status = NEXT_ACTIONS[legacy] ? legacy : CREW_STATUS_WAITING
  }

  const headcount = parseHeadcount(row['进场人数'])
  const entryDate = entryDateOf(row)
  const briefing =
    status === CREW_STATUS_LEFT ? '' : normalizeDate(row['安全交底日期']) || (entryDate || '')
  const leaveDate =
    status === CREW_STATUS_LEFT
      ? normalizeDate(row['退场日期']) || normalizeDate(row['安全交底日期'])
      : normalizeDate(row['退场日期'])

  return {
    ...row,
    status,
    pending: status !== CREW_STATUS_LEFT,
    abnormal: false,
    进场人数: headcount,
    进场日期: entryDate,
    安全交底日期: briefing,
    退场日期: leaveDate,
    在场状态: status === CREW_STATUS_PRESENT ? CREW_STATUS_PRESENT : status,
    所属项目: String(row['所属项目'] ?? fallbackProject),
  }
}

/** 存量班组按进场日期重排；缺日期的老记录排在最后，同日按编号稳定排序。 */
export function sortCrews(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort((a, b) => {
    const da = String(a['进场日期'] ?? '')
    const db = String(b['进场日期'] ?? '')
    if (!da && !db) return Number(a.id) - Number(b.id)
    if (!da) return 1
    if (!db) return -1
    if (da !== db) return da < db ? -1 : 1
    return Number(a.id) - Number(b.id)
  })
}

export function normalizeCrews(rows: EntryRow[], fallbackProject: string): EntryRow[] {
  return sortCrews(rows.map((row) => normalizeCrew(row, fallbackProject)))
}

export function presentCrews(rows: EntryRow[]): EntryRow[] {
  return rows.filter((row) => String(row.status) === CREW_STATUS_PRESENT)
}

/** 唯一权威在场人数：所有入口（列表统计、详情、巡检页、看板）都取这一份。 */
export function presentHeadcount(rows: EntryRow[]): number {
  return presentCrews(rows).reduce((sum, row) => sum + parseHeadcount(row['进场人数']), 0)
}

/** 越级拦截：返回 null 表示允许提交，否则返回应当提示用户的缺步说明。 */
export function guardTransition(status: string, action: string): string | null {
  const allowed = NEXT_ACTIONS[status] ?? []
  if (allowed.includes(action)) {
    return null
  }
  return MISSING_STEP[status]?.[action] ?? `当前状态「${status}」不能直接办理「${action}」，请按流程逐步提交`
}

/** 已退场班组的主要工种冻结入口判定（页面与服务共用一份结论）。 */
export function canChangeTrade(row: EntryRow): boolean {
  return String(row.status) !== CREW_STATUS_LEFT
}

export function isWriteoffRow(row: EntryRow): boolean {
  return String(row['记录类型'] ?? '') === WRITEOFF_KIND
}

export function openWriteoffs(rows: EntryRow[]): EntryRow[] {
  return rows.filter((row) => isWriteoffRow(row) && String(row.status) === WRITEOFF_OPEN)
}

export function closedWriteoffs(rows: EntryRow[]): EntryRow[] {
  return rows.filter((row) => isWriteoffRow(row) && String(row.status) === WRITEOFF_CLOSED)
}

/** 按班组编号找回它当前挂着的未闭环销账待办（保证反复退场只入一条）。 */
export function findOpenWriteoff(rows: EntryRow[], crewCode: string): EntryRow | undefined {
  return openWriteoffs(rows).find((row) => String(row['关联班组编号'] ?? '') === crewCode)
}
