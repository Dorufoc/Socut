import { create } from 'zustand'
import type { LeftTabValue, MediaItem } from '@shared/types'
import { detectCompat } from '@shared/probe'

/** UI 状态：模态队列、面板开关、预览播放态。高频播放头不进 store（见 usePreviewLoop）。 */

export type UiMode = 'basic' | 'advanced'

/**
 * 左侧栏 Tab（P6）：素材库 / 包装（字幕 + 片尾 + 水印）/ 导出 / 进度；
 * 写入 project.ui.leftTab 持久化。清单在 shared/types（LeftTabValue），这里只做别名。
 */
export type LeftTab = LeftTabValue

export type CompatDialogContent =
  | { kind: 'non169'; label: string }
  | { kind: 'hdr'; label: string }
  | { kind: 'vfr'; label: string }
  | { kind: 'vfrSecondConfirm'; label: string }
  | { kind: 'hugeExport'; label: string; detail: string; allowPng: boolean; diskShort: boolean }
  | { kind: 'confirm'; title: string; body: string; confirmText?: string }

export type DialogAnswer = 'ok' | 'cancel' | 'convert' | 'raw' | 'mov' | 'png'

export interface DialogPrompt {
  id: string
  dialog: CompatDialogContent
  resolve: (answer: DialogAnswer) => void
}

/** 时间轴工具栏的三个开关 */
export type TimelineTool = 'snapTogether' | 'magneticSnap' | 'hoverPreview'
export type TimelineTools = Record<TimelineTool, boolean>

export interface UiState {
  playing: boolean
  /** 播放头（秒），仅供 UI 文本显示，节流更新 */
  displayTimeSec: number
  /** 界面模式：基础模式只留常用入口，高级模式展开全部样式与编码选项 */
  uiMode: UiMode
  showSafeArea: boolean
  previewFit: 'fit' | 'actual'
  exportScope: 'timeline' | 'selected'
  dialogQueue: DialogPrompt[]
  fontLoadingCount: number
  notice: string | null
  /** v2：左侧栏当前 Tab（冷启动默认素材库；会话内切换会写回工程） */
  leftTab: LeftTab
  /**
   * 预览播放头跳转句柄（由 App 在挂载时注册）。
   * 样式面板改完参数后要把播放头落到「能看清当前样式」的帧上，否则改动发生在
   * 片段区间外，用户看到的是“改了但预览没反应”。不进任何持久化。
   */
  seekHandler: ((sec: number) => void) | null

  setPlaying: (playing: boolean) => void
  setDisplayTime: (sec: number) => void
  setUiMode: (mode: UiMode) => void
  toggleSafeArea: () => void
  setPreviewFit: (mode: 'fit' | 'actual') => void
  setExportScope: (scope: 'timeline' | 'selected') => void
  /** v2：素材池中文件已不可用的 mediaId 集合（被移动/删除）：非空即禁用叠加导出（规格 §8） */
  missingMediaIds: string[]
  setMissingMediaIds: (ids: string[]) => void
  /** @deprecated v1 单参考视频时代字段；保留读写口以免冒烟脚本改道，等价于 missingMediaIds 非空 */
  refVideoMissing: boolean
  setRefVideoMissing: (missing: boolean) => void
  setLeftTab: (tab: LeftTab) => void
  setSeekHandler: (handler: ((sec: number) => void) | null) => void
  /**
   * P4：预览轴的悬停帧（秒）。非空时预览改画这一帧，而 `displayTimeSec`（蓝线、
   * 时间码、拆分参照）一律不动；null = 没有悬停（或正在播放、预览轴整体禁用）。
   * 不进任何持久化：它只是「当前这一帧画面要画在哪」。
   */
  hoverPreviewSec: number | null
  setHoverPreview: (sec: number | null) => void
  /** 预览里的画面交互层（拖拽缩放/平移/旋转）：关掉后字幕点选恢复原样 */
  stageInteract: boolean
  toggleStageInteract: () => void
  /** 时间轴工具栏三个开关（不跨会话记忆，默认全关 = 与旧行为一致） */
  timelineTools: TimelineTools
  toggleTimelineTool: (tool: TimelineTool) => void
  /**
   * v9：正在发声的片段 id（媒体段或音频段），只有它会拿到实时频谱电平。
   * 由预览侧写入（只有它知道“现在谁在出声”），时间轴卡片只读它自己的那一份，
   * 所以选择器返回的是布尔值，不会因播放头逐帧变化而重渲染整条轨道。
   */
  liveClipId: string | null
  setLiveClipId: (id: string | null) => void
  pushPrompt: (prompt: DialogPrompt) => void
  shiftPrompt: () => void
  beginFontLoad: () => void
  endFontLoad: () => void
  setNotice: (notice: string | null) => void
}

export const useUiStore = create<UiState>((set) => ({
  playing: false,
  displayTimeSec: 0,
  // 规格：程序启动总是进入基础模式（不跨会话记住高级模式）
  uiMode: 'basic',
  showSafeArea: false,
  previewFit: 'fit',
  exportScope: 'timeline',
  refVideoMissing: false,
  missingMediaIds: [],
  leftTab: 'media',
  seekHandler: null,
  hoverPreviewSec: null,
  dialogQueue: [],
  fontLoadingCount: 0,
  notice: null,

  setPlaying: (playing) => set({ playing }),
  setDisplayTime: (sec) => set({ displayTimeSec: sec }),
  setUiMode: (mode) => set({ uiMode: mode }),
  toggleSafeArea: () => set((state) => ({ showSafeArea: !state.showSafeArea })),
  setPreviewFit: (mode) => set({ previewFit: mode }),
  setExportScope: (scope) => set({ exportScope: scope }),
  setMissingMediaIds: (ids) => set({ missingMediaIds: ids, refVideoMissing: ids.length > 0 }),
  setRefVideoMissing: (missing) => set({ refVideoMissing: missing }),
  setLeftTab: (tab) => set({ leftTab: tab }),
  setSeekHandler: (handler) => set({ seekHandler: handler }),
  // 同一个帧重复写入不产生新 state：鼠标每动一下都会走到这里
  setHoverPreview: (sec) => set((state) => (state.hoverPreviewSec === sec ? state : { hoverPreviewSec: sec })),
  // 默认开：选中媒体段就是来调画面的；万一挡住字幕点选，面板上一键关掉
  stageInteract: true,
  toggleStageInteract: () => set((state) => ({ stageInteract: !state.stageInteract })),
  timelineTools: { snapTogether: false, magneticSnap: false, hoverPreview: false },
  toggleTimelineTool: (tool) =>
    set((state) => ({ timelineTools: { ...state.timelineTools, [tool]: !state.timelineTools[tool] } })),
  liveClipId: null,
  setLiveClipId: (id) => set((state) => (state.liveClipId === id ? state : { liveClipId: id })),
  pushPrompt: (prompt) => set((state) => ({ dialogQueue: [...state.dialogQueue, prompt] })),
  shiftPrompt: () => set((state) => ({ dialogQueue: state.dialogQueue.slice(1) })),
  beginFontLoad: () => set((state) => ({ fontLoadingCount: state.fontLoadingCount + 1 })),
  endFontLoad: () => set((state) => ({ fontLoadingCount: Math.max(0, state.fontLoadingCount - 1) })),
  setNotice: (notice) => set({ notice })
}))

/**
 * 门禁是否仍阻塞（规格 §6：未确认不可继续）。
 * v2：确认位从工程级 refVideo 下放到素材池枚级——逐枚检查，第一枚未确认的即阻断，
 * 原因里带上展示名，用户能在素材库里找到是哪一枚。
 */
export function gateBlocked(media: MediaItem[]): { blocked: boolean; reason: string | null } {
  for (const item of media) {
    const flags = detectCompat(item.meta)
    if (flags.non169 && !item.non169Ack) return { blocked: true, reason: `《${item.name}》非 16:9 尚未确认` }
    if (flags.hdr && !item.hdrAck) return { blocked: true, reason: `《${item.name}》HDR 降级尚未确认` }
    if (flags.vfr && item.vfrPolicy === 'none') return { blocked: true, reason: `《${item.name}》VFR 处理方式未选择` }
  }
  return { blocked: false, reason: null }
}

/** 单枚素材的门禁状态（素材库卡片角标用）。 */
export function mediaGateState(item: MediaItem): { blocked: boolean; reason: string | null } {
  return gateBlocked([item])
}
