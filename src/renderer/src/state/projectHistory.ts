import { create } from 'zustand'
import type { Project } from '@shared/types'
import { useProjectStore, type ProjectState, type SelectionKind } from './projectStore'

/**
 * P1：项目级撤销/重做。**只在本次启动轮次内有效**（内存态、不落盘），最多 100 步。
 *
 * 记账方式是「订阅式全量快照」，而不是给每个 store 动作配一条逆操作：
 * 工程里有 50 多个写入口（画面参数、曲线、防抖、叠层、变速……），逐条写逆操作
 * 迟早会漏，而漏一条就是「撤销了个寂寞」。这里改成每次边界处把**改动前**的整棵
 * 工程存成一个 JSON 串，撤销即恢复该快照——新增写入口自动被覆盖，无需再记账。
 *
 * 三步纪律：
 * 1. **一次连续编辑 = 一步**：命中边界才压栈（见 `boundaryOf`）——三轨段数变了、
 *    选中目标变了、上一步本身就是结构性改动（刚增删了段）、或距上次改动超过合并窗口。
 *    于是逐字敲一句话算一步、一次拖拽算一步，而「删除→再新建」不会被并成一步。
 * 2. **volatile 不进历史**：`project.ui`（左侧 Tab 位置随 UI 走）与素材缩略图
 *    （派生缓存）在快照里一律抹平，恢复时再从活态带回来。所以切 Tab 不产生步骤，
 *    撤销也不会把用户的 Tab 位置和已生成的缩略图刷掉。
 * 3. **换工程清空**：`projectEpoch` 一变（打开工程 / 启动恢复存档）就丢弃整条历史，
 *    跨工程的撤销没有意义。
 */

/** 历史上限：超出丢最旧 */
export const HISTORY_LIMIT = 100
/** 合并窗口：窗口内、同一目标上的连续改动算一步（逐字输入、逐帧拖拽都落在里面） */
export const COALESCE_WINDOW_MS = 500

/** 快照信封：工程 + 三个选中态。撤销时连选中一起还原，右侧检查器才不会指向别的段。 */
interface Envelope {
  p: Project
  c: string | null
  m: string | null
  a: string | null
  k: SelectionKind
}

interface HistoryState {
  /** 撤销栈：每一项是「该步改动前」的序列化信封，栈顶最近 */
  past: string[]
  /** 重做栈：栈顶是「撤销掉的那一份当前状态」 */
  future: string[]
  undo: () => void
  redo: () => void
  clear: () => void
}

/** 记账现场。工程 store 是单例，这几个变量跟着它一起单例即可。 */
const ledger = {
  /** 最近一次状态的快照（= 下一次边界要压进去的那一份「改动前」） */
  last: null as string | null,
  lastKey: '',
  lastCounts: '',
  /** 上一次改动是否增删了段：紧跟其后的第一次改动必须单独成步 */
  lastStructural: false,
  lastAt: 0,
  /** 撤销/重做自身的写入不再记账 */
  applying: false
}

function countsOf(envelope: Envelope): string {
  const { p } = envelope
  return `${p.clips.length}|${p.mediaClips.length}|${(p.audioClips ?? []).length}`
}

/** 步骤边界判据的输入：段数 + 选中态（含检查器指向哪一类） */
function keyOf(envelope: Envelope): string {
  return `${countsOf(envelope)}|${envelope.c}|${envelope.m}|${envelope.a}|${envelope.k}`
}

/** 抹掉 volatile 字段：Tab 位置整键删除，缩略图归零成占位串（与主进程协议一致）。 */
function withoutVolatile(project: Project): Project {
  const next: Project = { ...project }
  delete next.ui
  next.media = project.media.map((item) => (item.thumbnailUrl === '' ? item : { ...item, thumbnailUrl: '' }))
  return next
}

function envelopeOf(state: ProjectState): Envelope {
  return {
    p: withoutVolatile(state.project),
    c: state.selectedClipId,
    m: state.selectedMediaClipId,
    a: state.selectedAudioClipId,
    k: state.selectionKind
  }
}

function snapshotOf(state: ProjectState): { json: string; key: string; counts: string } {
  const envelope = envelopeOf(state)
  return { json: JSON.stringify(envelope), key: keyOf(envelope), counts: countsOf(envelope) }
}

/** 把 volatile 从活态带回来，再整棵工程写回 store（revision 自增以驱动预览与自动保存）。 */
function applyEnvelope(json: string): void {
  const envelope = JSON.parse(json) as Envelope
  ledger.applying = true
  try {
    useProjectStore.setState((state) => {
      const live = state.project
      const thumbs = new Map(live.media.map((item) => [item.id, item.thumbnailUrl]))
      const project: Project = {
        ...envelope.p,
        media: envelope.p.media.map((item) => {
          const url = thumbs.get(item.id)
          return url === undefined || url === '' ? item : { ...item, thumbnailUrl: url }
        }),
        ...(live.ui ? { ui: live.ui } : {})
      }
      return {
        project,
        selectedClipId: envelope.c,
        selectedMediaClipId: envelope.m,
        selectedAudioClipId: envelope.a,
        selectionKind: envelope.k,
        revision: state.revision + 1
      }
    })
  } finally {
    ledger.applying = false
  }
}

/**
 * 把记账现场对齐到给定状态：选中态变了、换工程了、撤销/重做落地了。
 *
 * `lastAt = 0` 是刻意的：这三种情况下“下一次改动”必须自成一步。否则
 * 「点选另一条 → 立刻改参数」会被当成同一步撤销不回来，「撤销后再改」也一样。
 * 合并窗口因此只管真正连续的编辑（逐字输入、逐帧拖拽）。
 */
function reseedFrom(state: ProjectState): void {
  const { json, key, counts } = snapshotOf(state)
  ledger.last = json
  ledger.lastKey = key
  ledger.lastCounts = counts
  ledger.lastStructural = false
  ledger.lastAt = 0
}

function reseed(): void {
  reseedFrom(useProjectStore.getState())
}

function pushPast(json: string): void {
  useHistoryStore.setState((state) => ({ past: [...state.past, json].slice(-HISTORY_LIMIT), future: [] }))
}

function record(next: ProjectState, previous: ProjectState | undefined): void {
  if (ledger.applying) return
  if (!previous) return
  if (next.project === previous.project) {
    // 只换了选中态或类型（点卡片、点段落）：本身不算一次编辑，但「下一次要压进去的那一份」
    // 必须带上当前选中——否则撤销回到的是一条根本没选中的旧状态。
    if (keyOf(envelopeOf(next)) === ledger.lastKey) return
    reseedFrom(next)
    return
  }
  if (next.projectEpoch !== previous.projectEpoch) {
    useHistoryStore.setState({ past: [], future: [] })
    reseedFrom(next)
    return
  }

  const { json, key, counts } = snapshotOf(next)
  // volatile-only 改动（切 Tab、写回缩略图）：既不成步，也不移动合并窗口的起点
  if (json === ledger.last) return

  const structural = counts !== ledger.lastCounts
  const firstEver = ledger.last === null
  const boundary =
    firstEver ||
    key !== ledger.lastKey ||
    structural ||
    ledger.lastStructural ||
    Date.now() - ledger.lastAt > COALESCE_WINDOW_MS

  if (boundary && ledger.last !== null) pushPast(ledger.last)

  ledger.last = json
  ledger.lastKey = key
  ledger.lastCounts = counts
  ledger.lastStructural = structural
  ledger.lastAt = Date.now()
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],

  undo: () => {
    const { past } = get()
    const target = past[past.length - 1]
    if (target === undefined) return
    const current = ledger.last
    set((state) => ({
      past: state.past.slice(0, -1),
      future: current === null ? state.future : [current, ...state.future].slice(0, HISTORY_LIMIT)
    }))
    applyEnvelope(target)
    reseed()
  },

  redo: () => {
    const { future } = get()
    const target = future[0]
    if (target === undefined) return
    const current = ledger.last
    set((state) => ({
      future: state.future.slice(1),
      past: current === null ? state.past : [...state.past, current].slice(-HISTORY_LIMIT)
    }))
    applyEnvelope(target)
    reseed()
  },

  clear: () => {
    set({ past: [], future: [] })
    reseed()
  }
}))

let unsubscribe: (() => void) | null = null

/**
 * 开始记账（App 挂载时调一次）。重复调用会先解掉上一条订阅，
 * 并以当前工程为基线清空历史，所以热重载与测试里都能安全重入。
 * 返回解订函数。
 */
export function attachProjectHistory(): () => void {
  detachProjectHistory()
  useHistoryStore.setState({ past: [], future: [] })
  reseed()
  unsubscribe = useProjectStore.subscribe((state, previous) => {
    record(state, previous)
  })
  return () => detachProjectHistory()
}

function detachProjectHistory(): void {
  unsubscribe?.()
  unsubscribe = null
}
