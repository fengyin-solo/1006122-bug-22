import { defineStore } from 'pinia'

import { CURRENT_PROJECT, ROLE_LABOR_CLERK } from '@/data/project'
import type { Actor } from '@/data/types'

// 演示账号：责任划分只对「本项目 + 劳资员」开放，其余账号只看得到台账，看不到维护入口。
export const DEMO_ACCOUNTS: Actor[] = [
  { account: 'lz001', name: '王劳资', role: ROLE_LABOR_CLERK, project: CURRENT_PROJECT },
  { account: 'aq001', name: '李安全', role: '安全员', project: CURRENT_PROJECT },
  { account: 'lz002', name: '赵劳资（二标段）', role: ROLE_LABOR_CLERK, project: '盾构隧道二标段项目' },
]

const DEFAULT_ACTOR = DEMO_ACCOUNTS[0]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: DEFAULT_ACTOR.name,
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    actor: { ...DEFAULT_ACTOR } as Actor,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    // 责任划分维护权：必须同时是本项目和劳资员，差一条都不给入口。
    canMaintainWriteoff: (state) =>
      state.actor.role === ROLE_LABOR_CLERK && state.actor.project === CURRENT_PROJECT,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    switchAccount(account: string) {
      const target = DEMO_ACCOUNTS.find((item) => item.account === account)
      if (!target) {
        return
      }
      this.actor = { ...target }
      this.operator = target.name
    },
  },
})
