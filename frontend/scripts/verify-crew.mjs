/* eslint-disable */
// 班组退场销账端到端校验：esbuild 打包后在 node 里跑，自带 localStorage 垫片。
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const harness = `
import { migrateCrewLedger, checkoutCrew, checkinCrew, stopCrew, changeMainTrade,
         assignWriteoffDuty, crewRows, currentPresentHeadcount, listSafetyRows } from '@/data/crew-service'
import { openWriteoffs, presentHeadcount, findOpenWriteoff } from '@/data/crew-domain'
import { resetRows } from '@/data/local-store'
import { CURRENT_PROJECT } from '@/data/project'

const results = []
function check(name, cond, extra='') { results.push({ name, ok: !!cond, extra }) }

// localStorage 垫片：可强制抛错模拟「存不下」。
let forceFail = false
const mem = new Map()
globalThis.window = { localStorage: {
  getItem: (k) => mem.has(k) ? mem.get(k) : null,
  setItem: (k, v) => { if (forceFail) throw new Error('QuotaExceeded'); mem.set(k, String(v)) },
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}}

function reset() {
  mem.clear(); forceFail = false
  resetRows('crew'); resetRows('safety')
  migrateCrewLedger()
}
const labor = { account: 'lz', name: '劳资', role: '劳资员', project: CURRENT_PROJECT }
const safety = { account: 'aq', name: '安全', role: '安全员', project: CURRENT_PROJECT }
const other = { account: 'lz2', name: '他项目劳资', role: '劳资员', project: '二标段' }

// ---- 1. 存量迁移：老脏数据清洗 + 按进场日期重排 ----
reset()
let crews = crewRows()
check('存量按进场日期升序重排', crews.map(r => r['班组编号']).join(',') === 'CREW-0003,CREW-0001,CREW-0002,CREW-0004,CREW-0005',
  crews.map(r => r['班组编号']+':'+r['进场日期']).join(','))
const c3 = crews.find(r => r['班组编号'] === 'CREW-0003')
check('已退场老记录交底日期残留被清空', c3['安全交底日期'] === '')
check('已退场老记录在场状态不再残留在场', c3['在场状态'] === '已退场' && c3.status === '已退场')
check('已退场老记录不进在场人数', currentPresentHeadcount() === 22, 'hc=' + currentPresentHeadcount())
check('存量已退场补挂一条销账待办', openWriteoffs(listSafetyRows()).filter(w => w['关联班组编号']==='CREW-0003').length === 1)

// ---- 2. 正常退场：一次销账三联动 ----
reset()
const before = currentPresentHeadcount()
const id1 = crewRows().find(r => r['班组编号']==='CREW-0001').id
const r1 = checkoutCrew(id1)
check('退场成功', r1.ok, r1.message)
const after1 = crewRows().find(r => Number(r.id)===id1)
check('退场状态=已退场', after1.status==='已退场')
check('退场清安全交底日期', after1['安全交底日期']==='')
check('退场写下退场日期', after1['退场日期'] !== '')
check('在场人数扣减一次', currentPresentHeadcount() === before - 12,
  before + '->' + currentPresentHeadcount())
check('巡检台账新增销账待办', !!findOpenWriteoff(listSafetyRows(), 'CREW-0001'))
// 两处同源
check('巡检侧与班组侧在场人数同源', presentHeadcount(crewRows()) === currentPresentHeadcount())
// 在场名单不含已退场
check('在场名单无已退场班组', require_presentCodes().indexOf('CREW-0001') < 0)
function require_presentCodes() { return crewRows().filter(r=>r.status==='在场').map(r=>r['班组编号']) }

// ---- 3. 同一张退场单连点两回：只扣一次、只入一条 ----
const r2 = checkoutCrew(id1)
check('重复退场不报错(幂等)', r2.ok && r2.duplicate, r2.message)
check('重复退场人数不二次扣减', currentPresentHeadcount() === before - 12)
const todos = openWriteoffs(listSafetyRows()).filter(w=>w['关联班组编号']==='CREW-0001')
check('重复退场只一条待办', todos.length === 1)

// ---- 4. 越级提交：指出缺哪一步 ----
reset()
const waiting = crewRows().find(r => r['班组编号']==='CREW-0005')
const skip = checkoutCrew(waiting.id)
check('待进场直接退场被拒', !skip.ok && skip.ok !== undefined)
check('越级提示指出先办理进场', skip.message.includes('办理进场'), skip.message)
const left = crewRows().find(r => r['班组编号']==='CREW-0003')
const stopOnLeft = stopCrew(left.id)
check('已退场登记停工被拒并提示先进场', !stopOnLeft.ok && stopOnLeft.message.includes('进场'), stopOnLeft.message)

// ---- 5. 已退场不许改工种 ----
reset()
const leftId = crewRows().find(r=>r['班组编号']==='CREW-0003').id
const trade = changeMainTrade(leftId, '电焊工')
check('已退场改工种被拒', !trade.ok && trade.message.includes('重新办理进场'), trade.message)
check('工种值未被改动', crewRows().find(r=>Number(r.id)===leftId)['主要工种'] === '同步注浆')
// 在场可改
const presentId = crewRows().find(r=>r['班组编号']==='CREW-0001').id
const trade2 = changeMainTrade(presentId, '盾构操作')
check('在场可改工种', trade2.ok, trade2.message)
// 重新进场后可改
checkinCrew(leftId, '办理进场')
const trade3 = changeMainTrade(leftId, '电焊工')
check('重新进场后可改工种', trade3.ok, trade3.message)

// ---- 6. 责任划分：仅本项目劳资员 ----
reset()
const wid = openWriteoffs(listSafetyRows()).find(w=>w['关联班组编号']==='CREW-0003').id
check('安全员无维护入口(服务层拒绝)', !assignWriteoffDuty(wid, '王某负责', safety).ok)
check('他项目劳资员被拒', !assignWriteoffDuty(wid, '王某负责', other).ok)
const okDuty = assignWriteoffDuty(wid, '班组长负责清场', labor)
check('本项目劳资员可维护', okDuty.ok, okDuty.message)
check('责任划分两处同源(班组台账也落)',
  crewRows().find(r=>r['班组编号']==='CREW-0003')['责任划分'] === '班组长负责清场')
const dup = assignWriteoffDuty(wid, '班组长负责清场', labor)
check('责任划分重复提交不重复落账', dup.ok && dup.duplicate)

// ---- 7. 重新进场自动闭环旧待办，且再退场仍只一条（跨周期） ----
reset()
const cid = crewRows().find(r=>r['班组编号']==='CREW-0003').id
const beforeTodos = listSafetyRows().filter(w=>w['关联班组编号']==='CREW-0003').length
const reEnter = checkinCrew(cid, '办理进场')
check('已退场可重新进场', reEnter.ok, reEnter.message)
const reRow = crewRows().find(r=>Number(r.id)===cid)
check('重新进场恢复交底日期', reRow['安全交底日期'] !== '' && reRow['退场日期']==='')
check('重新进场人数重新计入', currentPresentHeadcount() === 28, 'hc=' + currentPresentHeadcount())
const oldTodo = listSafetyRows().find(w=>w['关联班组编号']==='CREW-0003')
check('原销账待办随重新进场闭环', oldTodo.status === '已闭环')
checkoutCrew(cid)
const openAgain = openWriteoffs(listSafetyRows()).filter(w=>w['关联班组编号']==='CREW-0003')
check('再退场新开一条待办(新周期)', openAgain.length === 1)
const allOfCrew = listSafetyRows().filter(w=>w['关联班组编号']==='CREW-0003')
check('历史闭环待办保留可追溯', allOfCrew.length === beforeTodos + 1)

// ---- 8. 存不下整笔回退（事务原子性）----
reset()
const target = crewRows().find(r=>r['班组编号']==='CREW-0001')
const hc0 = currentPresentHeadcount()
const safetyCount0 = listSafetyRows().length
const snapCrews = JSON.stringify(crewRows())
forceFail = true
const fail = checkoutCrew(target.id)
forceFail = false
check('存储失败动作返回失败', !fail.ok, fail.message)
check('存储失败在场人数回退', currentPresentHeadcount() === hc0)
check('存储失败不新增待办', listSafetyRows().length === safetyCount0)
check('存储失败班组台账回退', JSON.stringify(crewRows()) === snapCrews)
// 回退后正常动作仍可用
check('回退后可正常再次退场', checkoutCrew(target.id).ok)

// ---- 9. 停工→复工 状态机 ----
reset()
const stopId = crewRows().find(r=>r['班组编号']==='CREW-0004').id
check('停工班组复工成功', checkinCrew(stopId, '复工').ok)
check('复工后在场人数计入', currentPresentHeadcount() === 26, 'hc=' + currentPresentHeadcount())
const presentRow = crewRows().find(r=>r['班组编号']==='CREW-0001')
const enterAgain = checkinCrew(presentRow.id, '办理进场')
check('在场重复进场被拒', !enterAgain.ok && enterAgain.message.includes('重复进场'), enterAgain.message)

// ---- 汇总 ----
let failed = 0
for (const r of results) {
  console.log((r.ok ? 'PASS' : 'FAIL') + ' | ' + r.name + (r.extra ? ' | ' + r.extra : ''))
  if (!r.ok) failed++
}
console.log('\\n共 ' + results.length + ' 项，失败 ' + failed + ' 项')
if (failed) process.exit(1)
`

const dir = mkdtempSync(join(tmpdir(), 'crew-test-'))
const entry = join(dir, 'harness.ts')
writeFileSync(entry, harness)

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(dir, 'out.mjs'),
  alias: { '@': join(process.cwd(), 'src') },
  logLevel: 'silent',
})

await import(pathToFileURL(join(dir, 'out.mjs')).href)
