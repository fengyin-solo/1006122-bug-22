import { commitAll, listRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 班组域：退场销账的唯一入口。
 *
 * 口径（两处取同一份）：
 *  - 在场状态以 crew.status 为准；「在场状态」字段只是镜像。
 *  - 在场人数不另存计数器（另存必然再漂移），一律由在场班组的「进场人数」求和：
 *      presentHeadcount = Σ 进场人数（仅 status === '在场'）。
 *    班组页统计、详情面板、巡检页的人数卡都调 presentHeadcount，同源。
 *  - 「进场人数」是当前在册人数：进场写入，退场一次销账清零，重新进场按存档人数恢复。
 */

export const CREW_KEY = 'crew'
export const SAFETY_KEY = 'safety'

export const CREW_STATUSES = ['待进场', '在场', '已退场', '已停工'] as const
export type CrewStatus = (typeof CREW_STATUSES)[number]

// 巡检待办里挂班组的隐藏键，靠它幂等：一个班组反复退场只对应一条待办。
export const CREW_TODO_MARK = '_crewTodo'

/** 人数只认非负整数；老数据里的空串、「待确认」之类一律按 0 兼容。 */
export function parseHeadcount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? Math.trunc(value) : 0
  }
  if (typeof value === 'string') {
    const n = Number(value.trim())
    if (value.trim() !== '' && Number.isFinite(n) && n >= 0) {
      return Math.trunc(n)
    }
  }
  return 0
}

/**
 * 老数据兼容：人数非数字归零；已退场的补齐销账（人数清零、交底日期清空）。
 * 无论本地存的「在场状态」字段是什么，都以 status 为准重写，杜绝两处打架。
 */
export function normalizeCrew(row: EntryRow): EntryRow {
  const status = CREW_STATUSES.includes(row.status as CrewStatus)
    ? (row.status as CrewStatus)
    : '待进场'
  let headcount = parseHeadcount(row['进场人数'])
  let briefing = row['安全交底日期']
  if (status === '已退场') {
    // 老台账尾巴：已退场却还把人算进去、交底日期还残留旧值——统一补齐。
    headcount = 0
    briefing = ''
  }
  return {
    ...row,
    status,
    pending: status === '待进场',
    '在场状态': status,
    '进场人数': headcount,
    '安全交底日期': briefing ?? '',
  }
}

/** 巡检台账规整：状态字段与 pending 保持一致（退场待办算待处理，闭环不算）。 */
export function normalizeSafety(row: EntryRow): EntryRow {
  const pendingStatuses = ['待巡检', '已巡检', '待整改']
  return {
    ...row,
    pending: pendingStatuses.includes(String(row.status)),
    '巡检状态': row.status,
  }
}

/** 重排键：按进场日期升序；老数据缺进场日期时依次用迁移时记下的交底日期、id 兜底。 */
function entrySortKey(row: EntryRow): [string, number] {
  const entryDate = String(row['进场日期'] ?? '').trim()
  if (entryDate) {
    return [entryDate, 0]
  }
  const fallback = String(row._entryDateFallback ?? '').trim()
  return [fallback || '9999-12-31', Number(row.id)]
}

function sortCrewRows(rows: EntryRow[]): EntryRow[] {
  // 缺进场日期的老记录：把当时的交底日期存成隐藏兜底键，清交底日期后排序仍稳定、不反复落盘。
  const withFallback = rows.map((row) => {
    const hasEntryDate = String(row['进场日期'] ?? '').trim() !== ''
    if (hasEntryDate || row._entryDateFallback) {
      return row
    }
    return { ...row, _entryDateFallback: String(row['安全交底日期'] ?? '').trim() }
  })
  return [...withFallback].sort((a, b) => {
    const [da, ia] = entrySortKey(a)
    const [db, ib] = entrySortKey(b)
    if (da !== db) {
      return da < db ? -1 : 1
    }
    return ia - ib
  })
}

/**
 * 存量班组迁移：规范化 + 按进场日期重排，并顺手修掉历史退场尾巴。
 * 巡检台账同笔规整。只读时返回内存里的规整副本，不落盘；
 * 只有确实发生改动才整体落盘，落盘失败保留旧数据（下次再迁），不影响本次读。
 */
export function ensureCrewData(): EntryRow[] {
  const crew = listRows(CREW_KEY)
  const safety = listRows(SAFETY_KEY)
  // 先按老数据的原始字段重排（缺进场日期时交底日期还没被清，能正确兜底），再规范化销账。
  const normalizedCrew = sortCrewRows(crew).map(normalizeCrew)
  const normalizedSafety = safety.map(normalizeSafety)
  const crewChanged = JSON.stringify(crew) !== JSON.stringify(normalizedCrew)
  const safetyChanged = JSON.stringify(safety) !== JSON.stringify(normalizedSafety)
  if (crewChanged || safetyChanged) {
    try {
      commitAll(
        crewChanged && safetyChanged
          ? { [CREW_KEY]: normalizedCrew, [SAFETY_KEY]: normalizedSafety }
          : crewChanged
            ? { [CREW_KEY]: normalizedCrew }
            : { [SAFETY_KEY]: normalizedSafety },
      )
    } catch {
      // 存不下就不写，内存用规整后的副本接着跑，绝不带着半截数据；下次读取再试。
    }
  }
  return normalizedCrew
}

/** 巡检页同源读取：与班组迁移同一笔数据，保证待办与人数同步。 */
export function ensureSafetyData(): EntryRow[] {
  ensureCrewData()
  return listRows(SAFETY_KEY).map(normalizeSafety)
}

export type CrewStats = {
  presentCrews: number
  presentHeadcount: number
  stoppedCrews: number
  exitedCrews: number
  waitingCrews: number
}

/** 唯一在场人数来源：列表、详情、巡检三处共用。 */
export function crewStats(rows: EntryRow[] = ensureCrewData()): CrewStats {
  const present = rows.filter((row) => String(row.status) === '在场')
  return {
    presentCrews: present.length,
    presentHeadcount: present.reduce(
      (sum, row) => sum + parseHeadcount(row['进场人数']),
      0,
    ),
    stoppedCrews: rows.filter((row) => String(row.status) === '已停工').length,
    exitedCrews: rows.filter((row) => String(row.status) === '已退场').length,
    waitingCrews: rows.filter((row) => String(row.status) === '待进场').length,
  }
}

/** 在场名单：只含在场班组，已退场的不会混进来。 */
export function presentRoster(rows: EntryRow[] = ensureCrewData()): EntryRow[] {
  return rows.filter((row) => String(row.status) === '在场')
}

/** 越级校验：每一步要求的前置状态，缺哪一步就点出来。 */
const REQUIRED_STATUS: Record<string, { from: CrewStatus; missingStep: string }> = {
  办理进场: { from: '待进场', missingStep: '班组尚未登记，先登记施工班组' },
  办理退场: { from: '在场', missingStep: '先办理进场并完成安全交底' },
  登记停工: { from: '在场', missingStep: '先办理进场，班组不在场不能登记停工' },
  重新进场: { from: '已退场', missingStep: '先完成过一次退场' },
  复工到场: { from: '已停工', missingStep: '先登记停工' },
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function findCrew(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

/** 该班组在巡检台账里挂的销账待办（没有则 undefined）。 */
export function findCrewTodo(crewId: number): EntryRow | undefined {
  return listRows(SAFETY_KEY).find(
    (row) => String(row[CREW_TODO_MARK] ?? '') === `crew:${crewId}`,
  )
}

type PreparedWriteoff = {
  crew: EntryRow[]
  safety: EntryRow[]
  message: string
}

/**
 * 退场一次销账（纯计算，不落盘）：
 * 在场状态、进场人数、安全交底日期在同一笔里改，巡检待办同笔写入。
 * 已退场再提交：幂等，不二次扣减、不重复入待办。
 */
function prepareExit(crew: EntryRow[], safety: EntryRow[], row: EntryRow): PreparedWriteoff {
  const crewName = String(row['班组名称'] ?? '')
  const original = parseHeadcount(row['进场人数'])
  const exited: EntryRow = {
    ...row,
    status: '已退场',
    pending: false,
    '在场状态': '已退场',
    '进场人数': 0,
    '安全交底日期': '',
    // 存档原人数，重新进场恢复；不影响任何统计。
    _lastHeadcount: original,
  }
  const nextCrew = crew.map((item) =>
    Number(item.id) === Number(row.id) ? exited : item,
  )

  const conclusion = `${crewName}退场销账：原在场${original}人已全数退场，在场人数扣减${original}人，安全交底记录已注销。`
  const existing = safety.find(
    (item) => String(item[CREW_TODO_MARK] ?? '') === `crew:${row.id}`,
  )
  let nextSafety: EntryRow[]
  if (existing) {
    // 反复提交也只入一条：已有待办就更新结论，不新增。
    nextSafety = safety.map((item) =>
      item === existing
        ? { ...item, status: '待整改', pending: true, '发现问题': conclusion }
        : item,
    )
  } else {
    const nextId = safety.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
    const todo: EntryRow = {
      id: nextId,
      status: '待整改',
      pending: true,
      abnormal: false,
      巡检编号: `CREW-TODO-${String(nextId).padStart(4, '0')}`,
      巡检区域: '班组进退场',
      巡检项目: '退场销账核验',
      发现问题: conclusion,
      隐患等级: '一般',
      整改期限: '',
      巡检人员: '劳资员',
      巡检状态: '待整改',
      [CREW_TODO_MARK]: `crew:${row.id}`,
    }
    nextSafety = [...safety, todo]
  }

  return {
    crew: nextCrew,
    safety: nextSafety,
    message: `${crewName}退场销账完成：在场状态置为已退场，在场人数扣减 ${original} 人，安全交底日期已注销，销账结论已入巡检待办。`,
  }
}

/**
 * 班组动作。返回 ok:false 时什么都没落盘。
 * 只有本项目劳资员（调用方先做 canMaintainCrew 判定）能进来；这里再兜底拦一次。
 */
export function runCrewAction(
  id: number,
  action: string,
  canMaintain: boolean,
  payload?: { trade?: string },
): ActionResult {
  if (!canMaintain) {
    return { ok: false, message: '责任划分：班组台账只能由本项目的劳资员维护，当前账号看不到改动入口' }
  }

  const crew = ensureCrewData()
  const row = findCrew(crew, id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的施工班组` }
  }
  const current = String(row.status) as CrewStatus

  if (action === '修改工种') {
    // 已退场不许改主要工种，要改得先重新进场。
    if (current === '已退场') {
      return { ok: false, message: '该班组已退场，主要工种锁定；要改请先办理「重新进场」' }
    }
    const trade = (payload?.trade ?? '').trim()
    if (!trade) {
      return { ok: false, message: '主要工种不能为空' }
    }
    try {
      commitAll({
        [CREW_KEY]: crew.map((item) =>
          Number(item.id) === id ? { ...item, '主要工种': trade } : item,
        ),
      })
    } catch {
      return { ok: false, message: '保存失败，已整笔回退，主要工种未改动' }
    }
    return { ok: true, message: `主要工种已更新为「${trade}」` }
  }

  const rule = REQUIRED_STATUS[action]
  if (!rule) {
    return { ok: false, message: `施工班组没有登记「${action}」这个动作` }
  }

  // 已退场重复提交退场：只扣一次，给幂等回执，不落任何数据。
  if (action === '办理退场' && current === '已退场') {
    return {
      ok: true,
      message: `${row['班组名称']}此前已完成退场销账，人数只扣一次，不重复处理`,
    }
  }
  if (current !== rule.from) {
    // 越级提交不予受理，明确指出缺的那一步。
    const targetStatus: Partial<Record<string, CrewStatus>> = {
      办理退场: '在场',
      登记停工: '在场',
      重新进场: '已退场',
      复工到场: '已停工',
    }
    const target = targetStatus[action]
    const hint =
      target && current === target
        ? `当前已是「${target}」，无需重复操作`
        : `当前状态「${current}」，${rule.missingStep}`
    return { ok: false, message: `越级提交不予受理：${hint}` }
  }

  if (action === '办理退场') {
    const safety = listRows(SAFETY_KEY)
    const prepared = prepareExit(crew, safety, row)
    try {
      commitAll({ [CREW_KEY]: prepared.crew, [SAFETY_KEY]: prepared.safety })
    } catch {
      // 存不下整体撤销：状态、人数、交底日期、巡检待办一个都不改。
      return { ok: false, message: '退场销账保存失败，已整笔回退，在场状态与在场人数均未改动' }
    }
    return { ok: true, message: prepared.message }
  }

  // 进场/重新进场/复工到场：回到在场。
  // 退场时把原人数存在 _lastHeadcount（哪怕是 0）；没有存档就沿用当前在册人数。
  const restoredHeadcount =
    row._lastHeadcount !== undefined
      ? parseHeadcount(row._lastHeadcount)
      : parseHeadcount(row['进场人数'])
  const briefing = today()
  const updated: EntryRow = {
    ...row,
    status: '在场',
    pending: false,
    '在场状态': '在场',
    '进场人数': restoredHeadcount,
    '安全交底日期': briefing,
  }
  delete (updated as Partial<Record<string, unknown>>)._lastHeadcount
  const nextCrew = crew.map((item) =>
    Number(item.id) === id ? updated : item,
  )

  // 重新进场：把巡检那边挂着的销账待办同笔闭环，始终同源。
  const existingTodo = listRows(SAFETY_KEY).find(
    (item) => String(item[CREW_TODO_MARK] ?? '') === `crew:${id}`,
  )
  let nextSafety: EntryRow[] | null = null
  if (existingTodo) {
    nextSafety = listRows(SAFETY_KEY).map((item) =>
      item === existingTodo
        ? {
            ...item,
            status: '已闭环',
            pending: false,
            巡检状态: '已闭环',
            发现问题: `${item['发现问题'] ?? ''} 班组已于${briefing}重新进场，销账待办闭环。`.trim(),
          }
        : item,
    )
  }

  try {
    commitAll(
      nextSafety
        ? { [CREW_KEY]: nextCrew, [SAFETY_KEY]: nextSafety }
        : { [CREW_KEY]: nextCrew },
    )
  } catch {
    return { ok: false, message: '保存失败，已整笔回退，班组状态未改动' }
  }
  const actionLabel =
    action === '办理进场' ? '办理进场' : action === '复工到场' ? '复工到场' : '重新进场'
  return {
    ok: true,
    message: `${row['班组名称']}已${actionLabel}：在场状态置为在场，在册 ${restoredHeadcount} 人，安全交底日期 ${briefing}`,
  }
}

/** 巡检页同源人数卡：直接取班组台账的统计，不自己再数一遍。 */
export function presentHeadcountForSafety(): number {
  return crewStats().presentHeadcount
}
