import { create } from 'zustand'
import type { CompatFlags } from '@shared/types'

/** UI 状态：模态队列、面板开关、预览播放态。高频播放头不进 store（见 usePreviewLoop）。 */

export type UiMode = 'basic' | 'advanced'

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

  setPlaying: (playing: boolean) => void
  setDisplayTime: (sec: number) => void
  setUiMode: (mode: UiMode) => void
  toggleSafeArea: () => void
  setPreviewFit: (mode: 'fit' | 'actual') => void
  setExportScope: (scope: 'timeline' | 'selected') => void
  /** 参考视频文件已不可用（被移动/删除）：禁用叠加导出并提示重新定位（规格 §8） */
  refVideoMissing: boolean
  setRefVideoMissing: (missing: boolean) => void
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
  dialogQueue: [],
  fontLoadingCount: 0,
  notice: null,

  setPlaying: (playing) => set({ playing }),
  setDisplayTime: (sec) => set({ displayTimeSec: sec }),
  setUiMode: (mode) => set({ uiMode: mode }),
  toggleSafeArea: () => set((state) => ({ showSafeArea: !state.showSafeArea })),
  setPreviewFit: (mode) => set({ previewFit: mode }),
  setExportScope: (scope) => set({ exportScope: scope }),
  setRefVideoMissing: (missing) => set({ refVideoMissing: missing }),
  pushPrompt: (prompt) => set((state) => ({ dialogQueue: [...state.dialogQueue, prompt] })),
  shiftPrompt: () => set((state) => ({ dialogQueue: state.dialogQueue.slice(1) })),
  beginFontLoad: () => set((state) => ({ fontLoadingCount: state.fontLoadingCount + 1 })),
  endFontLoad: () => set((state) => ({ fontLoadingCount: Math.max(0, state.fontLoadingCount - 1) })),
  setNotice: (notice) => set({ notice })
}))

/** 门禁是否仍阻塞（规格 §6：未确认不可继续）。 */
export function gateBlocked(flags: CompatFlags, ack: { non169: boolean; hdr: boolean; vfrResolved: boolean }): {
  blocked: boolean
  reason: string | null
} {
  if (flags.non169 && !ack.non169) return { blocked: true, reason: '非 16:9 尚未确认' }
  if (flags.hdr && !ack.hdr) return { blocked: true, reason: 'HDR 降级尚未确认' }
  if (flags.vfr && !ack.vfrResolved) return { blocked: true, reason: 'VFR 处理方式未选择' }
  return { blocked: false, reason: null }
}
