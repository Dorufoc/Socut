import { create } from 'zustand'
import type { RecentProjectCard, RecentSortMode } from '@shared/recentProjects'
import { filterRecentProjects, sortRecentProjects } from '@shared/recentProjects'
import { useProjectStore } from './projectStore'

/**
 * 启动页「最近项目」状态。
 *
 * 主进程是唯一的数据源（history.json + covers/<id>.png）：这里只缓存卡片列表，
 * 排序/搜索全部交给 shared/recentProjects 的纯函数，渲染层不另写一套规则。
 * 排序方式跨会话记忆（localStorage），其余（查询、加载态）只在本会话内有效。
 */

const SORT_KEY = 'focusnews.recent.sort'
const READ_ERROR = '读取最近项目失败'
const RENAME_ERROR = '重命名失败，请稍后重试'
const REMOVE_ERROR = '移除失败，请稍后重试'

function readSortMode(): RecentSortMode {
  try {
    if (typeof localStorage === 'undefined') return 'recent'
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent'
  } catch {
    // 隐私模式/禁用存储时 localStorage 可能直接抛异常：排序回落默认值，启动页不能因此挂掉
    return 'recent'
  }
}

function persistSortMode(mode: RecentSortMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SORT_KEY, mode)
  } catch {
    // 同 readSortMode：记不住排序不是错误，静默忽略
  }
}

function projectApi(): Window['focusnews']['project'] | undefined {
  if (typeof window === 'undefined') return undefined
  return window.focusnews?.project
}

export interface RecentProjectsState {
  entries: RecentProjectCard[]
  loading: boolean
  error: string | null
  sortMode: RecentSortMode
  query: string

  /** 从主进程重新读取；失败时保留旧列表（启动页不因为一次 IPC 抖动变空） */
  refresh: () => Promise<void>
  /** 返回是否成功；失败时由调用方用 uiStore.setNotice 提示 */
  rename: (id: string, name: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  setSortMode: (mode: RecentSortMode) => void
  setQuery: (query: string) => void
}

export const useRecentProjectsStore = create<RecentProjectsState>((set) => ({
  entries: [],
  loading: false,
  error: null,
  sortMode: readSortMode(),
  query: '',

  refresh: async () => {
    set({ loading: true, error: null })
    const api = projectApi()
    if (!api || typeof api.recentList !== 'function') {
      // 测试环境 / preload 尚未注入：给友好错误而不是抛未处理拒绝
      set({ loading: false, error: READ_ERROR })
      return
    }
    try {
      const entries = await api.recentList()
      set({ entries, loading: false, error: null })
    } catch {
      // 保留旧 entries：主进程暂时不可用时，用户仍能看到上次读到的列表
      set({ loading: false, error: READ_ERROR })
    }
  },

  rename: async (id, name) => {
    const api = projectApi()
    if (!api || typeof api.renameRecent !== 'function') {
      set({ error: RENAME_ERROR })
      return false
    }
    try {
      const updated = await api.renameRecent(id, name)
      if (!updated) {
        set({ error: RENAME_ERROR })
        return false
      }
      set((state) => ({
        entries: state.entries.map((entry) => (entry.id === id ? updated : entry)),
        error: null
      }))
      // 正在编辑的工程被重命名时同步内存工程名；否则下一次自动保存会把旧名字写回索引/草稿。
      const project = useProjectStore.getState()
      if (project.currentEntryId === id) project.setName(updated.name)
      return true
    } catch {
      set({ error: RENAME_ERROR })
      return false
    }
  },

  remove: async (id) => {
    const api = projectApi()
    if (!api || typeof api.removeRecent !== 'function') {
      set({ error: REMOVE_ERROR })
      return false
    }
    try {
      await api.removeRecent(id)
      set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id), error: null }))
      return true
    } catch {
      set({ error: REMOVE_ERROR })
      return false
    }
  },

  setSortMode: (mode) => {
    persistSortMode(mode)
    set({ sortMode: mode })
  },

  setQuery: (query) => set({ query })
}))

/**
 * 可见卡片：先排序再按名称过滤（搜索不改排序）。
 * 输入数组不被修改（shared 的两个纯函数都返回副本）。
 */
export function selectVisibleEntries(
  state: Pick<RecentProjectsState, 'entries' | 'sortMode' | 'query'>
): RecentProjectCard[] {
  return filterRecentProjects(sortRecentProjects(state.entries, state.sortMode), state.query)
}
