import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 跨模块的一次销账：所有改动先在副本上合成，再一次性落盘。
// 序列化或 setItem 抛错时缓存保持原样——整笔回退，不会出现标记改了、数字没动。
export function commitAll(patches: Record<string, EntryRow[]>): void {
  const next: Record<string, EntryRow[]> = { ...allRows() }
  for (const [key, rows] of Object.entries(patches)) {
    next[key] = clone(rows)
  }
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    // 抛错（如配额超限）时直接冒泡给调用方，cache 不动，调用方据此提示已回退。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
