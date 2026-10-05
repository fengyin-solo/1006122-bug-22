import { defineStore } from 'pinia'

// 本项目（责任划分的边界）：只有挂在本项目下的劳资员才能维护班组台账。
export const CURRENT_PROJECT = '滨江路盾构隧道项目'

export type Account = {
  key: string
  name: string
  role: '劳资员' | '安全员' | '值班管理员'
  project: string
}

// 演示账号：前两个是本项目的，后两个一个跨项目、一个非同岗。
export const ACCOUNTS: Account[] = [
  { key: 'labor', name: '陈劳资', role: '劳资员', project: CURRENT_PROJECT },
  { key: 'safety', name: '周安全', role: '安全员', project: CURRENT_PROJECT },
  { key: 'other-project', name: '赵劳资', role: '劳资员', project: '沿江快速路项目' },
  { key: 'duty', name: '值班管理员', role: '值班管理员', project: CURRENT_PROJECT },
]

const ACCOUNT_KEY = 'shield-tunnel-construction:account'

function initialAccount(): Account {
  if (typeof window !== 'undefined' && window.localStorage) {
    const saved = window.localStorage.getItem(ACCOUNT_KEY)
    const found = ACCOUNTS.find((item) => item.key === saved)
    if (found) {
      return found
    }
  }
  return ACCOUNTS[0]
}

export const useSessionStore = defineStore('session', {
  state: () => {
    const account = initialAccount()
    return {
      account,
      operator: account.name,
      shiftLabel: '白班 08:00-20:00',
      scope: '盾构隧道掘进施工管理平台',
      project: CURRENT_PROJECT,
    }
  },
  getters: {
    canOperate: (state) => state.operator.length > 0,
    // 责任划分：班组台账只能由本项目的劳资员维护，别的项目账号或其他岗位看不到改动入口。
    canMaintainCrew: (state) =>
      state.account.role === '劳资员' && state.account.project === CURRENT_PROJECT,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchAccount(key: string) {
      const account = ACCOUNTS.find((item) => item.key === key)
      if (!account) {
        return
      }
      this.account = account
      this.operator = account.name
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(ACCOUNT_KEY, key)
      }
    },
  },
})
