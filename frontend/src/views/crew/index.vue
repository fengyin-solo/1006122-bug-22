<template>
  <section class="page" data-module="crew">
    <header class="page-head">
      <div>
        <h2>班组进场管理</h2>
        <p class="page-desc">班组进退场一次销账：在场状态、进场人数、安全交底日期与巡检隐患待办同笔落账，重复退场只认一次。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出班组进场清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button class="link" type="button" @click="openTrade(row)">改工种</button>
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的班组记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条班组记录 · 列表按进场日期先后排序</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 详情抽屉：在场名单与在场人数都来自班组台账同一份口径 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>班组详情 · {{ detail['班组编号'] }}</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ displayValue(detail, field) || '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detail.status }}</dd>
          <dt>责任划分</dt>
          <dd>{{ detail['责任划分'] || '待劳资员在巡检销账待办中维护' }}</dd>
        </dl>

        <h4 class="sub-title">在场名单（当前共 {{ presentCount }} 人，与巡检页同源）</h4>
        <table class="data-table">
          <thead>
            <tr><th>班组编号</th><th>班组名称</th><th>主要工种</th><th>班组长</th><th>在场人数</th></tr>
          </thead>
          <tbody>
            <tr v-for="crew in presentList" :key="String(crew.id)">
              <td>{{ crew['班组编号'] }}</td>
              <td>{{ crew['班组名称'] }}</td>
              <td>{{ crew['主要工种'] }}</td>
              <td>{{ crew['班组长'] }}</td>
              <td>{{ crew['进场人数'] }}</td>
            </tr>
            <tr v-if="!presentList.length">
              <td colspan="5" class="empty-state">当前没有在场班组</td>
            </tr>
          </tbody>
        </table>
      </aside>
    </div>

    <!-- 主要工种编辑：已退场班组服务端直接驳回 -->
    <div v-if="tradeTarget" class="drawer-mask" @click.self="closeTrade">
      <div class="modal">
        <h3>修改主要工种 · {{ tradeTarget['班组编号'] }}</h3>
        <p class="modal-tip">
          当前状态「{{ tradeTarget.status }}」。
          <span v-if="tradeTarget.status === '已退场'" class="error-text">已退场班组工种冻结，需先重新进场。</span>
        </p>
        <label class="filter-item">
          <span>主要工种</span>
          <input v-model="tradeValue" placeholder="请输入主要工种" />
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeTrade">取消</button>
          <button class="btn primary" type="button" @click="saveTrade">保存</button>
        </div>
        <p v-if="tradeError" class="error-text">{{ tradeError }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  ACTION_ENTER,
  ACTION_LEAVE,
  ACTION_RESUME,
  ACTION_STOP,
  CREW_STATUS_LEFT,
  CREW_STATUS_PRESENT,
  CREW_STATUS_STOPPED,
  CREW_STATUS_WAITING,
} from '@/data/crew-domain'
import {
  changeMainTrade,
  checkinCrew,
  checkoutCrew,
  crewRows,
  currentPresentCrews,
  currentPresentHeadcount,
  stopCrew,
} from '@/data/crew-service'
import { moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('crew')
const columns = ['班组编号', '班组名称', '主要工种', '班组长', '进场人数', '进场日期', '安全交底日期', '退场日期', '联系电话', '在场状态']
const detailFields = ['班组名称', '主要工种', '班组长', '进场人数', '进场日期', '安全交底日期', '退场日期', '联系电话']
const filterFields = ['班组编号', '班组名称', '主要工种']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(true)
const filters = ref<Record<string, string>>({})

const detail = ref<EntryRow | null>(null)
const tradeTarget = ref<EntryRow | null>(null)
const tradeValue = ref('')
const tradeError = ref('')

const statusOrder = [CREW_STATUS_PRESENT, CREW_STATUS_STOPPED, CREW_STATUS_WAITING, CREW_STATUS_LEFT]
const statusSummary = computed(() =>
  statusOrder.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '在场班组', value: rows.value.filter((row) => String(row.status) === CREW_STATUS_PRESENT).length },
  { label: '在场人数（权威源：班组台账）', value: headcount },
  { label: '停工班组', value: rows.value.filter((row) => String(row.status) === CREW_STATUS_STOPPED).length },
])

// 在场人数与在场名单：详情面板、巡检页、看板取的是同一份（crew-service 统一汇总）。
const headcount = ref(0)
const presentList = ref<EntryRow[]>([])
const presentCount = computed(() => headcount.value)

function displayValue(row: EntryRow, column: string): string {
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

// 行内只放状态机允许的下一步动作，越级动作页面上就不出现；硬闯也会被服务层拦回。
function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case CREW_STATUS_WAITING:
      return [ACTION_ENTER]
    case CREW_STATUS_PRESENT:
      return [ACTION_LEAVE, ACTION_STOP]
    case CREW_STATUS_STOPPED:
      return [ACTION_RESUME, ACTION_LEAVE]
    case CREW_STATUS_LEFT:
      return [ACTION_ENTER]
    default:
      return []
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function runAction(action: string, row: EntryRow) {
  let result
  if (action === ACTION_LEAVE) {
    result = checkoutCrew(Number(row.id))
  } else if (action === ACTION_STOP) {
    result = stopCrew(Number(row.id))
  } else {
    result = checkinCrew(Number(row.id), action)
  }
  notify(result.ok, result.message)
  reload()
  if (detail.value && Number(detail.value.id) === Number(row.id)) {
    detail.value = rows.value.find((item) => Number(item.id) === Number(row.id)) ?? null
  }
}

function openDetail(row: EntryRow) {
  detail.value = row
}

function closeDetail() {
  detail.value = null
}

function openTrade(row: EntryRow) {
  tradeTarget.value = row
  tradeValue.value = String(row['主要工种'] ?? '')
  tradeError.value = ''
}

function closeTrade() {
  tradeTarget.value = null
  tradeValue.value = ''
  tradeError.value = ''
}

function saveTrade() {
  if (!tradeTarget.value) {
    return
  }
  const id = Number(tradeTarget.value.id)
  const result = changeMainTrade(id, tradeValue.value)
  if (!result.ok) {
    tradeError.value = result.message
    return
  }
  closeTrade()
  notify(true, result.message)
  reload()
  if (detail.value && Number(detail.value.id) === id) {
    detail.value = rows.value.find((item) => Number(item.id) === id) ?? null
  }
}

function reload() {
  message.value = ''
  try {
    const keyword = filters.value
    const all = crewRows()
    const pairs = Object.entries(keyword).filter(([, value]) => value.trim() !== '')
    rows.value = pairs.length
      ? all.filter((row) => pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())))
      : all
    total.value = rows.value.length
    headcount.value = currentPresentHeadcount()
    presentList.value = currentPresentCrews()
  } catch (error) {
    notify(false, error instanceof Error ? error.message : '班组台账读取失败')
  }
}

onMounted(reload)
</script>
