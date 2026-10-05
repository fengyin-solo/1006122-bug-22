<template>
  <section class="page" data-module="crew">
    <header class="page-head">
      <div>
        <h2>班组进场管理</h2>
        <p class="page-desc">维护施工班组登记与进退场。退场一次销账：在场状态、进场人数、安全交底日期同笔落账，巡检待办与在场人数同源。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" :disabled="!store.canMaintainCrew" @click="openCreate">登记施工班组</button>
        <button class="btn" type="button" @click="exportRows">导出班组进场清单</button>
      </div>
    </header>

    <p v-if="!store.canMaintainCrew" class="role-banner locked">
      责任划分：班组台账仅本项目劳资员可维护（当前：{{ store.account.name }} · {{ store.account.role }} · {{ store.account.project }}）。你可以查看清单与详情，但看不到任何改动入口。
    </p>
    <p v-else class="role-banner">
      当前责任人：{{ store.account.name }}（{{ store.account.project }} · 劳资员），可办理进退场、停工复工与工种维护。
    </p>

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
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <template v-if="store.canMaintainCrew">
              <button
                v-for="action in actionsFor(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无班组进场数据，可先登记施工班组</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条班组记录，存量班组按进场日期由早到晚重排</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="notice" class="ok-text">{{ notice }}</span>
    </footer>

    <!-- 详情面板：在场人数、在场名单与列表统计同源，均由班组台账现算 -->
    <div v-if="detailRow" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>班组详情</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-list">
          <div v-for="column in columns" :key="column" class="detail-item">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] === '' || detailRow[column] == null ? '—' : detailRow[column] }}</dd>
          </div>
        </dl>
        <div class="detail-sum">
          <span>本班组在册人数：{{ headcountOf(detailRow) }}</span>
          <span>全项目在场人数（同源）：{{ stats[1].value }}</span>
        </div>
        <h4 class="roster-title">在场名单（{{ roster.length }} 个班组 / {{ stats[1].value }} 人）</h4>
        <ul class="roster-list">
          <li v-for="item in roster" :key="String(item.id)">
            {{ item['班组名称'] }}（{{ item['主要工种'] }}）· 班组长 {{ item['班组长'] }} · {{ headcountOf(item) }} 人
          </li>
        </ul>
      </aside>
    </div>

    <!-- 修改工种：已退场的班组不弹此窗，域里也会再拦一次 -->
    <div v-if="tradeRow" class="drawer-mask" @click.self="closeTrade">
      <form class="modal" @submit.prevent="submitTrade">
        <h3>修改主要工种</h3>
        <p class="page-desc">班组：{{ tradeRow['班组名称'] }}（当前工种：{{ tradeRow['主要工种'] }}）</p>
        <input v-model="tradeValue" placeholder="输入新的主要工种" />
        <p v-if="tradeError" class="error-text">{{ tradeError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeTrade">取消</button>
          <button class="btn primary" type="submit">保存</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  crewStats,
  downloadEntries,
  listEntries,
  moduleMeta,
  presentRoster,
  runAction as applyAction,
} from '@/api/local-service'
import { parseHeadcount } from '@/domain/crew-domain'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('crew')
const columns = ['班组编号', '班组名称', '主要工种', '班组长', '进场人数', '进场日期', '安全交底日期', '联系电话', '在场状态']
const statuses = ['待进场', '在场', '已退场', '已停工']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const notice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 统计卡与详情面板都取自 crewStats()，现场人数只有这一份算法。
const stats = computed(() => {
  const summary = crewStats(rows.value)
  return [
    { label: '在场班组', value: summary.presentCrews },
    { label: '在场人数', value: summary.presentHeadcount },
    { label: '停工班组', value: summary.stoppedCrews },
    { label: '已退场班组', value: summary.exitedCrews },
  ]
})
const roster = computed(() => presentRoster(rows.value))

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 按当前状态给动作；越级动作直接不出，越级提交在域里还会明确指出缺哪一步。
function actionsFor(row: EntryRow): string[] {
  switch (String(row.status)) {
    case '待进场':
      return ['办理进场']
    case '在场':
      return ['办理退场', '登记停工', '修改工种']
    case '已退场':
      // 已退场不给出「修改工种」，要改得先重新进场。
      return ['重新进场']
    case '已停工':
      return ['复工到场', '修改工种']
    default:
      return []
  }
}

function headcountOf(row: EntryRow): number {
  return parseHeadcount(row['进场人数'])
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '施工班组登记入口尚未接入审批流'
}

const detailRow = ref<EntryRow | null>(null)
function openDetail(row: EntryRow) {
  detailRow.value = row
}
function closeDetail() {
  detailRow.value = null
}

const tradeRow = ref<EntryRow | null>(null)
const tradeValue = ref('')
const tradeError = ref('')
function openTrade(row: EntryRow) {
  tradeRow.value = row
  tradeValue.value = String(row['主要工种'] ?? '')
  tradeError.value = ''
}
function closeTrade() {
  tradeRow.value = null
  tradeValue.value = ''
  tradeError.value = ''
}
function submitTrade() {
  if (!tradeRow.value) {
    return
  }
  const result = applyAction(meta.key, Number(tradeRow.value.id), '修改工种', {
    trade: tradeValue.value,
    canMaintain: store.canMaintainCrew,
  })
  if (!result.ok) {
    tradeError.value = result.message
    return
  }
  notice.value = result.message
  closeTrade()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  notice.value = ''
  if (action === '修改工种') {
    openTrade(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action, {
    canMaintain: store.canMaintainCrew,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '班组进场列表读取失败'
  }
}

onMounted(reload)
</script>
