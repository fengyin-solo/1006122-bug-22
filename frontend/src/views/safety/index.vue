<template>
  <section class="page" data-module="safety">
    <header class="page-head">
      <div>
        <h2>安全巡检管理</h2>
        <p class="page-desc">人工巡检流转 + 班组退场销账待办。销账待办由班组进退场自动生成/闭环，在场人数与班组台账同源。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出安全巡检清单</button>
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

    <h3 class="section-title">退场销账隐患待办（随班组进退场自动销账）</h3>
    <p class="section-tip" v-if="!canMaintainWriteoff">
      当前账号为「{{ store.actor.name }}（{{ store.actor.role }} · {{ store.actor.project }}）」，
      责任划分只能由本项目劳资员维护，当前账号看不到维护入口。
    </p>
    <table class="data-table">
      <thead>
        <tr>
          <th>销账编号</th><th>关联班组</th><th>退场人数</th><th>退场日期</th>
          <th>销账事项</th><th>状态</th><th>责任划分</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in writeoffRows" :key="`xz-${String(row.id)}`">
          <td>{{ row['巡检编号'] }}</td>
          <td>{{ row['关联班组编号'] }} {{ row['关联班组名称'] }}</td>
          <td>{{ row['退场人数'] }}</td>
          <td>{{ row['退场日期'] || '—' }}</td>
          <td>{{ row['发现问题'] }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row['责任划分'] || '待划分' }}</td>
          <td class="row-actions">
            <template v-if="canMaintainWriteoff && row.status === writeoffOpen">
              <button class="link" type="button" @click="openDuty(row)">维护责任划分</button>
            </template>
            <span v-else-if="row.status !== writeoffOpen" class="muted-text">已闭环归档</span>
            <span v-else class="muted-text">仅本项目劳资员可维护</span>
          </td>
        </tr>
        <tr v-if="!writeoffRows.length">
          <td colspan="8" class="empty-state">暂无退场销账待办</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">人工巡检记录</h3>
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
        <tr v-for="row in manualRows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runManualAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!manualRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无人工巡检数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条记录（销账 {{ writeoffRows.length }} 条 + 人工巡检 {{ manualRows.length }} 条）</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 责任划分维护：服务层会再校验一次本项目劳资员身份 -->
    <div v-if="dutyTarget" class="drawer-mask" @click.self="closeDuty">
      <div class="modal">
        <h3>维护责任划分 · {{ dutyTarget['巡检编号'] }}</h3>
        <p class="modal-tip">关联班组：{{ dutyTarget['关联班组编号'] }} {{ dutyTarget['关联班组名称'] }}</p>
        <label class="filter-item">
          <span>责任划分</span>
          <textarea v-model="dutyValue" rows="3" placeholder="如：班组长王某负责人员清场，安全员李某负责资料归档"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeDuty">取消</button>
          <button class="btn primary" type="button" @click="saveDuty">保存</button>
        </div>
        <p v-if="dutyError" class="error-text">{{ dutyError }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { WRITEOFF_CLOSED, WRITEOFF_OPEN, closedWriteoffs, isWriteoffRow, openWriteoffs } from '@/data/crew-domain'
import {
  assignWriteoffDuty,
  currentPresentHeadcount,
  listSafetyRows,
} from '@/data/crew-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const store = useSessionStore()
const canMaintainWriteoff = computed(() => store.canMaintainWriteoff)
const writeoffOpen = WRITEOFF_OPEN

const meta = moduleMeta('safety')
const columns = ['巡检编号', '巡检区域', '巡检项目', '发现问题', '隐患等级', '整改期限', '巡检人员', '巡检状态']
const actions = ['提交巡检', '派发整改', '确认闭环']
const statuses = ['待巡检', '已巡检', '待整改', '已闭环']

const allRowsData = ref<EntryRow[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const message = ref('')
const messageOk = ref(true)

const writeoffRows = computed(() => [...openWriteoffs(allRowsData.value), ...closedWriteoffs(allRowsData.value)])
const manualRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  return allRowsData.value.filter((row) => {
    if (isWriteoffRow(row)) {
      return false
    }
    return pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim()))
  })
})
const total = computed(() => allRowsData.value.length)

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: allRowsData.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待整改隐患（含销账待办）', value: allRowsData.value.filter((row) => String(row.status) === '待整改').length },
  { label: '已闭环隐患', value: allRowsData.value.filter((row) => String(row.status) === WRITEOFF_CLOSED || String(row.status) === '已闭环').length },
  // 与班组页、详情抽屉同源：都是 crew-service 按「在场」班组派生的那一份。
  { label: '当前在场人数（源自班组台账）', value: headcount.value },
  { label: '退场销账待办', value: openWriteoffs(allRowsData.value).length },
])

const headcount = ref(0)

const dutyTarget = ref<EntryRow | null>(null)
const dutyValue = ref('')
const dutyError = ref('')

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

function runManualAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  notify(result.ok, result.message)
  reload()
}

function openDuty(row: EntryRow) {
  dutyTarget.value = row
  dutyValue.value = String(row['责任划分'] ?? '')
  dutyError.value = ''
}

function closeDuty() {
  dutyTarget.value = null
  dutyValue.value = ''
  dutyError.value = ''
}

function saveDuty() {
  if (!dutyTarget.value) {
    return
  }
  const result = assignWriteoffDuty(Number(dutyTarget.value.id), dutyValue.value, store.actor)
  if (!result.ok) {
    dutyError.value = result.message
    return
  }
  closeDuty()
  notify(true, result.message)
  reload()
}

function reload() {
  message.value = ''
  try {
    allRowsData.value = listSafetyRows()
    headcount.value = currentPresentHeadcount()
  } catch (error) {
    notify(false, error instanceof Error ? error.message : '安全巡检台账读取失败')
  }
}

onMounted(reload)
</script>
