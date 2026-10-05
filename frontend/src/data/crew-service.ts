import { allRows, commitAll, listRows } from './local-store'
import { CURRENT_PROJECT, ROLE_LABOR_CLERK } from './project'
import {
  ACTION_ENTER,
  ACTION_LEAVE,
  ACTION_RESUME,
  ACTION_STOP,
  CREW_STATUS_LEFT,
  CREW_STATUS_PRESENT,
  CREW_STATUS_STOPPED,
  WRITEOFF_CLOSED,
  WRITEOFF_KIND,
  WRITEOFF_OPEN,
  canChangeTrade,
  findOpenWriteoff,
  guardTransition,
  isWriteoffRow,
  normalizeCrews,
  parseHeadcount,
  presentCrews,
  presentHeadcount,
  sortCrews,
} from './crew-domain'
import type { Actor, DomainActionResult, EntryRow } from './types'

/**
 * 班组进退场服务层：页面只调这里，不直接碰 store。
 * 退场、重新进场都是「一次销账」——班组台账和巡检隐患待办在 commitAll 里同生共死。
 */

const CREW_KEY = 'crew'
const SAFETY_KEY = 'safety'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nextWriteoffId(safetyRows: EntryRow[]): number {
  return safetyRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function crewCode(row: EntryRow): string {
  return String(row['班组编号'] ?? '')
}

/** 读出班组台账（始终是清洗、重排后的口径）。 */
export function crewRows(): EntryRow[] {
  return normalizeCrews(listRows(CREW_KEY), CURRENT_PROJECT)
}

/** 两处同源的在场人数：巡检页和班组页都调它。 */
export function currentPresentHeadcount(): number {
  return presentHeadcount(crewRows())
}

export function currentPresentCrews(): EntryRow[] {
  return presentCrews(crewRows())
}

export function listSafetyRows(): EntryRow[] {
  return listRows(SAFETY_KEY)
}

/**
 * 办理退场：一次销账。
 * 在场状态、进场人数口径、安全交底日期、退场日期 + 巡检隐患待办，一笔事务写完；
 * 任一处写不下就整笔回退。同班组反复提交只对应一条待办，只认一次账。
 */
export function checkoutCrew(id: number): DomainActionResult {
  const crews = crewRows()
  const index = crews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的施工班组` }
  }
  const target = crews[index]
  const status = String(target.status)

  if (status === CREW_STATUS_LEFT) {
    // 重复退场：台账不重复扣、待办不重复入，明确告诉用户这是第 2 次以上的空提交。
    const already = findOpenWriteoff(listRows(SAFETY_KEY), crewCode(target))
    return {
      ok: true,
      duplicate: true,
      message: already
        ? `班组「${crewCode(target)}」已退场，销账待办已存在，重复提交未重复扣款`
        : `班组「${crewCode(target)}」已退场，无需重复办理`,
    }
  }

  const blocked = guardTransition(status, ACTION_LEAVE)
  if (blocked) {
    return { ok: false, message: blocked }
  }

  const headcount = parseHeadcount(target['进场人数'])
  if (headcount <= 0) {
    // 交不上去的销账：前置校验不过就不动任何数据。
    return { ok: false, message: `班组「${crewCode(target)}」进场人数缺失或为 0，无法销账，请先补登` }
  }

  const leaveDate = today()
  const settledCrew: EntryRow = {
    ...target,
    status: CREW_STATUS_LEFT,
    pending: false,
    abnormal: false,
    安全交底日期: '',
    退场日期: leaveDate,
    在场状态: CREW_STATUS_LEFT,
  }

  const safetyRows = [...listRows(SAFETY_KEY)]
  // 只复用「未闭环」待办；上一周期已闭环的留档追溯，新退场周期新开一条。
  const openIndex = safetyRows.findIndex(
    (row) =>
      isWriteoffRow(row) &&
      String(row.status) === WRITEOFF_OPEN &&
      String(row['关联班组编号'] ?? '') === crewCode(target),
  )

  if (openIndex < 0) {
    const id = nextWriteoffId(safetyRows)
    safetyRows.push({
      id,
      status: WRITEOFF_OPEN,
      pending: true,
      abnormal: false,
      记录类型: WRITEOFF_KIND,
      巡检编号: `SAFE-XZ${String(id).padStart(4, '0')}`,
      巡检区域: '班组退场销账',
      巡检项目: '退场安全条件确认与销账',
      发现问题: `班组「${String(target['班组名称'] ?? crewCode(target))}」退场销账待确认：${headcount} 人清场、安全交底资料归档`,
      隐患等级: '一般',
      整改期限: leaveDate,
      巡检人员: '劳资+安全会签',
      巡检状态: WRITEOFF_OPEN,
      关联班组编号: crewCode(target),
      关联班组名称: String(target['班组名称'] ?? ''),
      退场人数: headcount,
      退场日期: leaveDate,
      责任划分: String(target['责任划分'] ?? ''),
      所属项目: String(target['所属项目'] ?? CURRENT_PROJECT),
    })
  }

  const nextCrews = sortCrews([...crews.slice(0, index), settledCrew, ...crews.slice(index + 1)])

  try {
    // 一次动作：两边同时落盘，commitAll 内部失败会恢复旧缓存，整笔回退。
    commitAll({ [CREW_KEY]: nextCrews, [SAFETY_KEY]: safetyRows })
  } catch {
    return { ok: false, message: '退场销账保存失败（存储不可用或空间不足），整笔已撤销，台账未改动' }
  }

  return {
    ok: true,
    message: `班组「${crewCode(target)}」已退场：${headcount} 人已销账，安全交底已归档，巡检隐患待办已生成`,
  }
}

/** 办理进场 / 已退场后的重新进场 / 停工后的复工。 */
export function checkinCrew(id: number, action: string = ACTION_ENTER): DomainActionResult {
  const crews = crewRows()
  const index = crews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的施工班组` }
  }
  const target = crews[index]
  const status = String(target.status)

  const blocked = guardTransition(status, action)
  if (blocked) {
    return { ok: false, message: blocked }
  }

  const headcount = parseHeadcount(target['进场人数'])
  if (headcount <= 0) {
    return { ok: false, message: `班组「${crewCode(target)}」进场人数缺失或为 0，不能进场，请先补登` }
  }

  const isReentry = status === CREW_STATUS_LEFT
  const enterDate = isReentry ? today() : String(target['进场日期'] ?? '') || today()
  const briefingDate = today()
  const active: EntryRow = {
    ...target,
    status: CREW_STATUS_PRESENT,
    pending: true,
    abnormal: false,
    进场日期: enterDate,
    安全交底日期: briefingDate,
    退场日期: '',
    在场状态: CREW_STATUS_PRESENT,
  }

  // 重新进场：原销账待办同步闭环归档，旧账不再挂在巡检台账上。
  const safetyRows = [...listRows(SAFETY_KEY)]
  let closedCount = 0
  for (let i = 0; i < safetyRows.length; i += 1) {
    const row = safetyRows[i]
    if (
      isWriteoffRow(row) &&
      String(row['关联班组编号'] ?? '') === crewCode(target) &&
      String(row.status) === WRITEOFF_OPEN
    ) {
      safetyRows[i] = { ...row, status: WRITEOFF_CLOSED, pending: false, 巡检状态: WRITEOFF_CLOSED, 闭环日期: briefingDate }
      closedCount += 1
    }
  }

  const nextCrews = sortCrews([...crews.slice(0, index), active, ...crews.slice(index + 1)])

  try {
    commitAll({ [CREW_KEY]: nextCrews, [SAFETY_KEY]: safetyRows })
  } catch {
    return { ok: false, message: '进场登记保存失败（存储不可用或空间不足），整笔已撤销，台账未改动' }
  }

  const suffix = isReentry ? '（重新进场）' : ''
  const writeoffNote = closedCount > 0 ? '，原退场销账待办已闭环' : ''
  return {
    ok: true,
    message: `班组「${crewCode(target)}」已${action === ACTION_RESUME ? '复工' : '进场'}${suffix}：${headcount} 人计入在场，安全交底日期 ${briefingDate}${writeoffNote}`,
  }
}

/** 登记停工。 */
export function stopCrew(id: number): DomainActionResult {
  return transitionOnly(id, ACTION_STOP, CREW_STATUS_STOPPED, '停工')
}

function transitionOnly(id: number, action: string, nextStatus: string, verb: string): DomainActionResult {
  const crews = crewRows()
  const index = crews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的施工班组` }
  }
  const target = crews[index]
  const blocked = guardTransition(String(target.status), action)
  if (blocked) {
    return { ok: false, message: blocked }
  }
  const updated: EntryRow = { ...target, status: nextStatus, pending: true, abnormal: false, 在场状态: nextStatus }
  const nextCrews = [...crews.slice(0, index), updated, ...crews.slice(index + 1)]
  try {
    commitAll({ [CREW_KEY]: nextCrews })
  } catch {
    return { ok: false, message: `班组${verb}保存失败，整笔已撤销，台账未改动` }
  }
  return { ok: true, message: `班组「${crewCode(target)}」已${verb}，当前状态「${nextStatus}」` }
}

/**
 * 改主要工种：已退场班组冻结，要改必须先重新进场。
 */
export function changeMainTrade(id: number, trade: string, actor?: Actor): DomainActionResult {
  const value = trade.trim()
  if (!value) {
    return { ok: false, message: '主要工种不能为空' }
  }
  const crews = crewRows()
  const index = crews.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的施工班组` }
  }
  const target = crews[index]
  if (!canChangeTrade(target)) {
    return {
      ok: false,
      message: '该班组已退场，主要工种已冻结；如需变更，请先重新办理进场后再修改',
    }
  }
  if (String(target['主要工种'] ?? '') === value) {
    return { ok: true, duplicate: true, message: '主要工种未变化，无需保存' }
  }
  const updated: EntryRow = { ...target, 主要工种: value }
  const nextCrews = [...crews.slice(0, index), updated, ...crews.slice(index + 1)]
  try {
    commitAll({ [CREW_KEY]: nextCrews })
  } catch {
    return { ok: false, message: '主要工种保存失败，整笔已撤销，台账未改动' }
  }
  void actor
  return { ok: true, message: `班组「${crewCode(target)}」主要工种已更新为「${value}」` }
}

/**
 * 维护销账待办的责任划分：仅限本项目劳资员。
 * 非本项目账号或非劳资员角色，服务层直接不受理，页面入口也不应展示。
 */
export function assignWriteoffDuty(writeoffId: number, duty: string, actor: Actor): DomainActionResult {
  const value = duty.trim()
  if (!value) {
    return { ok: false, message: '责任划分不能为空' }
  }
  if (actor.role !== ROLE_LABOR_CLERK || actor.project !== CURRENT_PROJECT) {
    return {
      ok: false,
      message: '责任划分只能由本项目劳资员维护：当前账号不是本项目劳资员，不予受理',
    }
  }
  const safetyRows = [...listRows(SAFETY_KEY)]
  const index = safetyRows.findIndex((row) => Number(row.id) === writeoffId && isWriteoffRow(row))
  if (index < 0) {
    return { ok: false, message: '没有找到对应的退场销账待办' }
  }
  const target = safetyRows[index]
  if (String(target['所属项目'] ?? CURRENT_PROJECT) !== CURRENT_PROJECT) {
    return { ok: false, message: '该待办属于其他项目，本项目账号无权改动' }
  }
  if (String(target.status) === WRITEOFF_CLOSED) {
    return { ok: false, message: '该销账待办已随班组重新进场闭环，不能再改责任划分' }
  }
  if (String(target['责任划分'] ?? '') === value) {
    return { ok: true, duplicate: true, message: '责任划分未变化，无需保存' }
  }
  const updated: EntryRow = { ...target, 责任划分: value }
  safetyRows[index] = updated

  // 两处同源：班组台账里也记下责任划分，巡检页与班组详情取的是同一份结论。
  const code = String(target['关联班组编号'] ?? '')
  const crews = crewRows()
  let crewChanged = false
  const nextCrews = crews.map((row) => {
    if (crewCode(row) === code && String(row['责任划分'] ?? '') !== value) {
      crewChanged = true
      return { ...row, 责任划分: value }
    }
    return row
  })

  try {
    commitAll({ [SAFETY_KEY]: safetyRows, ...(crewChanged ? { [CREW_KEY]: nextCrews } : {}) })
  } catch {
    return { ok: false, message: '责任划分保存失败，整笔已撤销，台账未改动' }
  }
  return { ok: true, message: `销账待办「${String(target['巡检编号'] ?? writeoffId)}」责任划分已更新` }
}

/**
 * 存量迁移：清洗老口径班组（退场残留交底日期、人数脏值、缺进场日期），
 * 按进场日期重排，并对已经退场的老记录补挂销账待办。幂等，可重复执行。
 */
export function migrateCrewLedger(): void {
  const store = allRows()
  const rawCrews = store[CREW_KEY] ?? []
  const crews = normalizeCrews(rawCrews, CURRENT_PROJECT)

  const safetyRows = [...(store[SAFETY_KEY] ?? [])]
  let safetyChanged = false
  for (const crew of crews) {
    if (String(crew.status) !== CREW_STATUS_LEFT) {
      continue
    }
    const code = crewCode(crew)
    const linked = safetyRows.some((row) => isWriteoffRow(row) && String(row['关联班组编号'] ?? '') === code)
    if (linked) {
      continue
    }
    const headcount = parseHeadcount(crew['进场人数'])
    const leaveDate = String(crew['退场日期'] ?? '') || String(crew['进场日期'] ?? '')
    const id = nextWriteoffId(safetyRows)
    safetyRows.push({
      id,
      status: WRITEOFF_OPEN,
      pending: true,
      abnormal: false,
      记录类型: WRITEOFF_KIND,
      巡检编号: `SAFE-XZ${String(id).padStart(4, '0')}`,
      巡检区域: '班组退场销账（存量补挂）',
      巡检项目: '退场安全条件确认与销账',
      发现问题: `存量退场班组「${String(crew['班组名称'] ?? code)}」补挂销账：${headcount} 人清场确认`,
      隐患等级: '一般',
      整改期限: leaveDate,
      巡检人员: '劳资+安全会签',
      巡检状态: WRITEOFF_OPEN,
      关联班组编号: code,
      关联班组名称: String(crew['班组名称'] ?? ''),
      退场人数: headcount,
      退场日期: leaveDate,
      责任划分: String(crew['责任划分'] ?? ''),
      所属项目: CURRENT_PROJECT,
    })
    safetyChanged = true
  }

  const crewChanged = JSON.stringify(rawCrews) !== JSON.stringify(crews)
  if (!crewChanged && !safetyChanged) {
    return
  }
  try {
    commitAll({ [CREW_KEY]: crews, ...(safetyChanged ? { [SAFETY_KEY]: safetyRows } : {}) })
  } catch {
    // 迁移失败不阻塞启动，下次打开继续幂等重试。
  }
}
