import { create } from 'zustand'
import { DEFAULT_FPS, DEFAULT_RESOLUTION, MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { applyClipStyleToAll, createClip, createId, duplicateClip, normalizeProject } from '@shared/projectSchema'
import { snapTimeToFrame, timeToFrameAtOrAfter } from '@shared/fps'
import { alignAfterOverlap, findActiveMediaClip, splitMediaClipAt } from '@shared/mediaClips'
import type {
  FontRecord,
  Fps,
  MediaClip,
  MediaClipVideo,
  MediaItem,
  PresetId,
  Project,
  RefVideo,
  StyleOverrides,
  SubtitleClip,
  WatermarkSettings
} from '@shared/types'
import { getPreset } from '@shared/presets'
import { clipWithPresetDefaults, hasKeys } from '@shared/clipStyle'
import { defaultMediaVideo, normalizeMediaVideo } from '@shared/mediaClipVideo'

/** 工程状态（规格 §4.6）。所有时间值在写入时已吸附到帧边界，存储仍为秒。 */

/** 右侧检查器当前跟谁：刚点中的是字幕条还是媒体段（两者可同时处于选中态）。 */
export type SelectionKind = 'subtitle' | 'media'

export interface ProjectState {
  project: Project
  selectedClipId: string | null
  /** v2：媒体轨上选中的片段（拆分/删除/拖拽的目标） */
  selectedMediaClipId: string | null
  /** v6：最后一次点选的类型——决定右侧检查器渲染字幕编辑器还是视频编辑器 */
  selectionKind: SelectionKind
  /** 字体库（内置 + 用户导入） */
  fonts: FontRecord[]
  /** 每次变更递增，驱动自动保存与预览重建 */
  revision: number
  currentPath: string | null

  loadProject: (project: Project, path?: string) => void
  setName: (name: string) => void
  setResolution: (width: number, height: number) => void
  setFps: (fps: Fps) => void
  setFonts: (fonts: FontRecord[]) => void

  /**
   * @deprecated v1 单参考视频写入口。v2 冒烟取证（runGateSmoke）仍走它写入再读回；
   * 正式路径是 addMedia + insertMediaClip。
   */
  setRefVideo: (refVideo: RefVideo | undefined) => void
  /** @deprecated 同上，枚级确认请使用 ackMedia* 系列 */
  setVfrPolicy: (policy: RefVideo['vfrPolicy']) => void
  /** @deprecated 同上 */
  setCompactMode: (mode: RefVideo['compactMode']) => void
  /** @deprecated 同上 */
  ackNon169: (value: boolean) => void
  /** @deprecated 同上 */
  ackHdr: (value: boolean) => void

  addClip: (atSec?: number) => string
  duplicateClipAction: (id: string) => string | null
  removeClip: (id: string) => void
  selectClip: (id: string | null) => void
  /**
   * 把当前片段的样式（预设/配色/字体/字号/动画）应用到全部片段，保留每段文字与入出点。
   * 返回被改写的片段数（不含源片段）。
   */
  applyStyleToAll: (sourceId: string) => number
  updateClip: (id: string, patch: Partial<Pick<SubtitleClip, 'content' | 'presetId' | 'fontId' | 'animation' | 'styleOverrides'>>) => void
  /** 清除本条全部自定义参数，回到当前预设的默认配置（文字与入出点不动） */
  resetClipStyle: (id: string) => void
  setClipTimes: (id: string, startTime: number, endTime: number) => void

  // ---------------------------------------------------------------- v2 素材池
  /** 导入一枚素材（已探测 + 已门禁确认）；同路径已存在时复用旧条目，返回 mediaId。 */
  addMedia: (item: Omit<MediaItem, 'id'> & { id?: string }) => string
  /** 移出素材池；默认连带删除引用它的 mediaClip（removeClips=false 用于「重新定位」换源不换轨）。 */
  removeMedia: (mediaId: string, options?: { removeClips?: boolean }) => void
  /** 换源（重新定位）：只改 path/meta/sourcePath，时间轴片段保持不动。 */
  relocateMedia: (mediaId: string, patch: Pick<MediaItem, 'path' | 'meta'> & Partial<Pick<MediaItem, 'sourcePath' | 'vfrPolicy'>>) => void
  renameMedia: (mediaId: string, name: string) => void
  setMediaCompactMode: (mediaId: string, mode: MediaItem['compactMode']) => void
  setMediaVfrPolicy: (mediaId: string, policy: MediaItem['vfrPolicy']) => void
  ackMediaNon169: (mediaId: string, value: boolean) => void
  ackMediaHdr: (mediaId: string, value: boolean) => void
  setMediaThumb: (mediaId: string, thumbnailUrl: string) => void

  // ---------------------------------------------------------------- 水印
  /** 写入 / 替换水印设置（导入成功后调用）；传 null 等于移除，工程回到无水印形态。 */
  setWatermark: (settings: WatermarkSettings | null) => void
  /** 只改开关，不动路径与尺寸（临时停用而不必重新导入） */
  setWatermarkEnabled: (enabled: boolean) => void

  // ---------------------------------------------------------------- v2 媒体轨
  selectMediaClip: (id: string | null) => void
  /**
   * 把素材放入时间轴 [timelineStartSec, timelineStartSec + durationSec]。
   * 源入出点吸附后不足最短时长时向内收；返回新片段（null = 素材不存在或区间退化）。
   */
  insertMediaClip: (input: { mediaId: string; timelineStartSec: number; durationSec?: number; sourceInSec?: number }) => MediaClip | null
  /** 整段平移：与「仅重叠才右移后续片段」规则共用 alignAfterOverlap。 */
  moveMediaClip: (id: string, timelineStartSec: number) => void
  /** 拖入/出点：时间轴与源坐标同幅度平移，保持时长恒等式。 */
  trimMediaClip: (id: string, patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  /** 删除一段（不动素材池；素材库卡片仍在）。 */
  removeMediaClip: (id: string) => void
  /**
   * 在 atSec（播放头）处拆分当前帧所在的片段：切点落在段内且两半都够长才生效。
   * 返回拆分出的右段 id；不可拆分返回 null。
   */
  splitAtFrame: (atSec: number) => string | null

  // ---------------------------------------------------------------- v6 画面编辑
  /** 写回媒体段的画面变换/调色（patch 为增量；全部默认时整键删除） */
  updateMediaClipVideo: (id: string, patch: Partial<MediaClipVideo>) => void
  /** 一条片段的所有画面编辑回到默认（缩放 100% / 无翻转 / 参数归零 / 曲线直线） */
  resetMediaClipVideo: (id: string) => void
}

export function createInitialProject(): Project {
  return normalizeProject({
    version: 2,
    name: '未命名工程',
    resolution: { ...DEFAULT_RESOLUTION },
    fps: { ...DEFAULT_FPS },
    clips: [],
    fonts: [],
    media: [],
    mediaClips: []
  })!
}

/** 时间轴时长（秒）：字幕轨与媒体轨双轨取最大覆盖，无片段时给一个可编辑的短默认值。 */
export function timelineDurationSec(project: Project): number {
  const clipsEnd = project.clips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
  const mediaEnd = project.mediaClips.reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
  const furthest = Math.max(clipsEnd, mediaEnd)
  return furthest > 0 ? furthest : 5
}

/** 媒体轨总覆盖（含素材时长）：时间轴尺规至少容得下全部片段。 */
export function timelineMediaSpanSec(project: Project): number {
  return project.media.reduce((acc, item) => Math.max(acc, item.meta.durationSec), 0)
}

function withClips(project: Project, clips: SubtitleClip[]): Project {
  return { ...project, clips: [...clips].sort((a, b) => a.startTime - b.startTime) }
}

function withMediaClips(project: Project, mediaClips: MediaClip[]): Project {
  return { ...project, mediaClips: [...mediaClips].sort((a, b) => a.timelineStartSec - b.timelineStartSec) }
}

/** 时长恒等式（timelineEnd - timelineStart === sourceOut - sourceIn）的唯一写入口。 */
function makeMediaClip(input: {
  id?: string
  mediaId: string
  timelineStartSec: number
  timelineEndSec: number
  sourceInSec: number
  sourceOutSec: number
}): MediaClip {
  return {
    id: input.id ?? createId('mclip'),
    mediaId: input.mediaId,
    timelineStartSec: input.timelineStartSec,
    timelineEndSec: input.timelineEndSec,
    sourceInSec: input.sourceInSec,
    sourceOutSec: input.sourceOutSec
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: createInitialProject(),
  selectedClipId: null,
  selectedMediaClipId: null,
  selectionKind: 'subtitle',
  fonts: [],
  revision: 0,
  currentPath: null,

  loadProject: (project, path) =>
    set((state) => ({
      project,
      currentPath: path ?? null,
      selectedClipId: project.clips[0]?.id ?? null,
      selectedMediaClipId: project.mediaClips[0]?.id ?? null,
      // 打开工程默认先看字幕（这是主任务）；没有字幕条时才落到视频编辑器
      selectionKind: project.clips.length > 0 ? 'subtitle' : 'media',
      revision: state.revision + 1
    })),

  setName: (name) =>
    set((state) => ({ project: { ...state.project, name }, revision: state.revision + 1 })),

  setResolution: (width, height) =>
    set((state) => ({
      project: { ...state.project, resolution: { width: Math.round(width), height: Math.round(height) } },
      revision: state.revision + 1
    })),

  setFps: (fps) => {
    const state = get()
    // 换帧率时保持秒不变，重新吸附入出点（规格 §4.4：时间点跨帧率一致）；媒体轨同步
    const clips = state.project.clips.map((clip) => ({
      ...clip,
      startTime: snapTimeToFrame(clip.startTime, fps),
      endTime: snapTimeToFrame(clip.endTime, fps)
    }))
    const mediaClips = state.project.mediaClips.map((clip) => ({
      ...clip,
      timelineStartSec: snapTimeToFrame(clip.timelineStartSec, fps),
      timelineEndSec: snapTimeToFrame(clip.timelineEndSec, fps),
      sourceInSec: snapTimeToFrame(clip.sourceInSec, fps),
      sourceOutSec: snapTimeToFrame(clip.sourceOutSec, fps)
    }))
    set({ project: { ...state.project, fps, clips, mediaClips }, revision: state.revision + 1 })
  },

  setFonts: (fonts) => set((state) => ({ fonts, revision: state.revision + 1 })),

  setRefVideo: (refVideo) =>
    set((state) => ({
      project: { ...state.project, ...(refVideo ? { refVideo } : { refVideo: undefined }) },
      revision: state.revision + 1
    })),

  setVfrPolicy: (policy) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return {
        project: { ...state.project, refVideo: { ...state.project.refVideo, vfrPolicy: policy } },
        revision: state.revision + 1
      }
    }),

  setCompactMode: (mode) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return {
        project: { ...state.project, refVideo: { ...state.project.refVideo, compactMode: mode } },
        revision: state.revision + 1
      }
    }),

  ackNon169: (value) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return {
        project: { ...state.project, refVideo: { ...state.project.refVideo, non169Ack: value } },
        revision: state.revision + 1
      }
    }),

  ackHdr: (value) =>
    set((state) => {
      if (!state.project.refVideo) return {}
      return { project: { ...state.project, refVideo: { ...state.project.refVideo, hdrAck: value } }, revision: state.revision + 1 }
    }),

  addClip: (atSec) => {
    const state = get()
    const fps = state.project.fps
    const start = atSec ?? (state.project.clips.length === 0 ? 0 : timelineDurationSec(state.project))
    const clip = createClip({ startTime: start, fps })
    const project = withClips(state.project, [...state.project.clips, clip])
    set({ project, selectedClipId: clip.id, revision: state.revision + 1 })
    return clip.id
  },

  duplicateClipAction: (id) => {
    const state = get()
    const clip = state.project.clips.find((c) => c.id === id)
    if (!clip) return null
    const copy = duplicateClip(clip, state.project.fps)
    const project = withClips(state.project, [...state.project.clips, copy])
    set({ project, selectedClipId: copy.id, revision: state.revision + 1 })
    return copy.id
  },

  removeClip: (id) => {
    const state = get()
    const clips = state.project.clips.filter((c) => c.id !== id)
    const selectedClipId = state.selectedClipId === id ? (clips[0]?.id ?? null) : state.selectedClipId
    set({ project: withClips(state.project, clips), selectedClipId, revision: state.revision + 1 })
  },

  selectClip: (id) => set({ selectedClipId: id, ...(id ? { selectionKind: 'subtitle' as const } : {}) }),

  applyStyleToAll: (sourceId) => {
    const state = get()
    const result = applyClipStyleToAll(state.project, sourceId)
    if (result.count === 0) return 0
    set({ project: withClips(result.project, result.project.clips), revision: state.revision + 1 })
    return result.count
  },

  updateClip: (id, patch) => {
    const state = get()
    const clips = state.project.clips.map((clip) => {
      if (clip.id !== id) return clip
      /**
       * 切预设（含重复点当前预设）= 即时应用该预设并把**全部**自定义参数回到它的默认配置：
       * 配色/透明度/渐变/字号缩放/紧凑清空、字体回默认、动画回预设声明的节奏；文字与入出点不动。
       * 同一次调用里显式传了其他字段时，仍按调用者给的叠加在上面（不让 patch 默默丢字段）。
       */
      const base = patch.presetId
        ? clipWithPresetDefaults({ ...clip }, getPreset(patch.presetId as PresetId))
        : { ...clip }
      if (patch.content) base.content = { ...base.content, ...patch.content }
      if (patch.styleOverrides) base.styleOverrides = mergeOverrides(base.styleOverrides, patch.styleOverrides)
      if (patch.fontId) base.fontId = patch.fontId
      if (patch.animation) base.animation = { ...base.animation, ...patch.animation }
      return base
    })
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
  },

  /** 清除本条全部自定义，回到当前预设的默认配置（与切预设同一口径，不碰文字与入出点）。 */
  resetClipStyle: (id) => {
    const state = get()
    const clips = state.project.clips.map((clip) =>
      clip.id === id ? clipWithPresetDefaults(clip, getPreset(clip.presetId)) : clip
    )
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
  },

  setClipTimes: (id, startTime, endTime) => {
    const state = get()
    const fps = state.project.fps
    const start = snapTimeToFrame(Math.max(0, startTime), fps)
    let end = snapTimeToFrame(Math.max(start + 0.001, endTime), fps)
    if (timeToFrameAtOrAfter(end, fps) - timeToFrameAtOrAfter(start, fps) < 1) {
      end = snapTimeToFrame(start + 0.2, fps)
    }
    const clips = state.project.clips.map((clip) => (clip.id === id ? { ...clip, startTime: start, endTime: end } : clip))
    set({ project: withClips(state.project, clips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v2 素材池

  addMedia: (item) => {
    const state = get()
    // 同路径复用：重复导入同一文件不产生第二枚卡片，也不断开既有片段的引用
    const existing = state.project.media.find((m) => m.path === item.path)
    if (existing) {
      set({
        project: {
          ...state.project,
          media: state.project.media.map((m) => (m.id === existing.id ? { ...m, ...item, id: existing.id } : m))
        },
        revision: state.revision + 1
      })
      return existing.id
    }
    const media: MediaItem = { ...item, id: item.id ?? createId('media') }
    set({ project: { ...state.project, media: [...state.project.media, media] }, revision: state.revision + 1 })
    return media.id
  },

  removeMedia: (mediaId, options) => {
    const state = get()
    const removeClips = options?.removeClips !== false
    const media = state.project.media.filter((m) => m.id !== mediaId)
    const mediaClips = removeClips
      ? state.project.mediaClips.filter((c) => c.mediaId !== mediaId)
      : state.project.mediaClips
    const selectedMediaClipId =
      !removeClips || !state.project.mediaClips.some((c) => c.id === state.selectedMediaClipId && c.mediaId === mediaId)
        ? state.selectedMediaClipId
        : (mediaClips[0]?.id ?? null)
    set({
      project: withMediaClips({ ...state.project, media }, mediaClips),
      selectedMediaClipId,
      revision: state.revision + 1
    })
  },

  relocateMedia: (mediaId, patch) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, ...patch } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  renameMedia: (mediaId, name) => {
    const state = get()
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, name: trimmed } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  setMediaCompactMode: (mediaId, mode) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, compactMode: mode } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  setMediaVfrPolicy: (mediaId, policy) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, vfrPolicy: policy } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  ackMediaNon169: (mediaId, value) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, non169Ack: value } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  ackMediaHdr: (mediaId, value) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, hdrAck: value } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  setMediaThumb: (mediaId, thumbnailUrl) => {
    const state = get()
    const media = state.project.media.map((m) => (m.id === mediaId ? { ...m, thumbnailUrl } : m))
    set({ project: { ...state.project, media }, revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- 水印

  setWatermark: (settings) => {
    const state = get()
    if (!settings) {
      // 移除 = 字段整个消失（而不是留一个 enabled:false 的空壳）：
      // 未导入水印的工程保持原有序列化形态，自动存档不会回洗出无意义字段
      const next: Project = { ...state.project }
      delete next.watermark
      set({ project: next, revision: state.revision + 1 })
      return
    }
    set({ project: { ...state.project, watermark: settings }, revision: state.revision + 1 })
  },

  setWatermarkEnabled: (enabled) => {
    const state = get()
    const current = state.project.watermark
    if (!current || current.enabled === enabled) return
    set({ project: { ...state.project, watermark: { ...current, enabled } }, revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v2 媒体轨

  selectMediaClip: (id) => set({ selectedMediaClipId: id, ...(id ? { selectionKind: 'media' as const } : {}) }),

  insertMediaClip: (input) => {
    const state = get()
    const fps = state.project.fps
    const item = state.project.media.find((m) => m.id === input.mediaId)
    if (!item) return null
    const start = snapTimeToFrame(Math.max(0, input.timelineStartSec), fps)
    const durationSec = Math.max(MIN_MEDIA_CLIP_SEC, input.durationSec ?? item.meta.durationSec)
    // 源入点后钳到最短时长，再向源尾部收：不足最短时长的落点拒收而不是静默截断
    const sourceIn = snapTimeToFrame(Math.max(0, input.sourceInSec ?? 0), fps)
    const sourceOut = snapTimeToFrame(Math.min(item.meta.durationSec, sourceIn + durationSec), fps)
    if (sourceOut - sourceIn < MIN_MEDIA_CLIP_SEC) return null
    let end = snapTimeToFrame(start + (sourceOut - sourceIn), fps)
    if (end - start < MIN_MEDIA_CLIP_SEC) end = snapTimeToFrame(start + MIN_MEDIA_CLIP_SEC, fps)
    const clip = makeMediaClip({
      mediaId: item.id,
      timelineStartSec: start,
      timelineEndSec: end,
      sourceInSec: sourceIn,
      sourceOutSec: sourceOut
    })
    set({
      project: withMediaClips(state.project, [...state.project.mediaClips, clip]),
      selectedMediaClipId: clip.id,
      revision: state.revision + 1
    })
    return clip
  },

  moveMediaClip: (id, timelineStartSec) => {
    const state = get()
    const fps = state.project.fps
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    const length = current.timelineEndSec - current.timelineStartSec
    const start = snapTimeToFrame(Math.max(0, timelineStartSec), fps)
    const moved: MediaClip = {
      ...current,
      timelineStartSec: start,
      timelineEndSec: snapTimeToFrame(start + length, fps)
    }
    // 规则：拖拽落点与其它片段重叠时才把后续片段整体右移（保持各自时长）
    const others = state.project.mediaClips.filter((c) => c.id !== id)
    set({
      project: withMediaClips(state.project, [moved, ...alignAfterOverlap(others, moved, fps)]),
      selectedMediaClipId: id,
      revision: state.revision + 1
    })
  },

  trimMediaClip: (id, patch) => {
    const state = get()
    const fps = state.project.fps
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    const item = state.project.media.find((m) => m.id === current.mediaId)
    const sourceDuration = item?.meta.durationSec ?? Number.POSITIVE_INFINITY
    let next = { ...current }
    if (patch.timelineStartSec !== undefined) {
      const start = snapTimeToFrame(
        Math.max(0, Math.min(patch.timelineStartSec, current.timelineEndSec - MIN_MEDIA_CLIP_SEC)),
        fps
      )
      const delta = start - current.timelineStartSec
      const sourceIn = snapTimeToFrame(Math.max(0, Math.min(sourceDuration - MIN_MEDIA_CLIP_SEC, current.sourceInSec + delta)), fps)
      const duration = current.timelineEndSec - start
      next = {
        ...next,
        timelineStartSec: start,
        sourceInSec: sourceIn,
        sourceOutSec: snapTimeToFrame(sourceIn + duration, fps)
      }
    }
    if (patch.timelineEndSec !== undefined) {
      const end = snapTimeToFrame(
        Math.max(next.timelineStartSec + MIN_MEDIA_CLIP_SEC, patch.timelineEndSec),
        fps
      )
      const duration = end - next.timelineStartSec
      const sourceOut = snapTimeToFrame(Math.min(Math.max(sourceDuration, next.sourceInSec + MIN_MEDIA_CLIP_SEC), next.sourceInSec + duration), fps)
      next = {
        ...next,
        timelineEndSec: snapTimeToFrame(next.timelineStartSec + (sourceOut - next.sourceInSec), fps),
        sourceOutSec: sourceOut
      }
    }
    set({
      project: withMediaClips(
        state.project,
        state.project.mediaClips.map((c) => (c.id === id ? next : c))
      ),
      revision: state.revision + 1
    })
  },

  removeMediaClip: (id) => {
    const state = get()
    const mediaClips = state.project.mediaClips.filter((c) => c.id !== id)
    const removedSelected = state.selectedMediaClipId === id
    const selectedMediaClipId = removedSelected ? (mediaClips[0]?.id ?? null) : state.selectedMediaClipId
    set({
      project: withMediaClips(state.project, mediaClips),
      selectedMediaClipId,
      // 删掉了正在编辑的那条且再无媒体段：检查器退回字幕编辑器，不留一个空视频面板
      ...(removedSelected && selectedMediaClipId === null ? { selectionKind: 'subtitle' as const } : {}),
      revision: state.revision + 1
    })
  },

  splitAtFrame: (atSec) => {
    const state = get()
    const fps = state.project.fps
    const target = findActiveMediaClip(state.project.mediaClips, atSec)
    if (!target) return null
    const result = splitMediaClipAt(target, atSec, fps, () => createId('mclip'))
    if (!result) return null
    const mediaClips = state.project.mediaClips
      .filter((c) => c.id !== target.id)
      .concat(result.left, result.right)
    set({
      project: withMediaClips(state.project, mediaClips),
      selectedMediaClipId: result.right.id,
      // 拆完直接编辑右半段，检查器跟着切到视频视图
      selectionKind: 'media',
      revision: state.revision + 1
    })
    return result.right.id
  },

  // ---------------------------------------------------------------- v6 画面编辑

  updateMediaClipVideo: (id, patch) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      // 增量合并到「当前值（缺省 = 默认值）」上，再交给纯函数夹心/剔除默认值
      const current = clip.video ?? defaultMediaVideo()
      const merged: MediaClipVideo = {
        ...current,
        ...patch,
        curves: patch.curves ?? { ...current.curves }
      }
      const normalized = normalizeMediaVideo(merged)
      const next: MediaClip = { ...clip }
      if (normalized) next.video = normalized
      else delete next.video
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  resetMediaClipVideo: (id) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      const next: MediaClip = { ...clip }
      delete next.video
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  }
}))

function mergeOverrides(base: StyleOverrides, patch: StyleOverrides): StyleOverrides {
  const next: StyleOverrides = { ...base }
  /**
   * `tokens` / `fontScale` 是**整组替换**（不是逐键合并）：面板负责交回「完整的自定义集合」，
   * 等于预设声明的键不在里面（见 shared/clipStyle 的差集函数）。
   * 逐键合并会把旧预设的陈旧同值覆盖留下来，切预设后它仍然压住新预设的配色。
   */
  if (patch.tokens !== undefined) {
    if (hasKeys(patch.tokens)) next.tokens = patch.tokens
    else delete next.tokens
  }
  if (patch.barOpacity !== undefined) {
    // 回到不透明（1）等于没有覆盖，整键删掉而不是留个 1
    if (Math.abs(patch.barOpacity - 1) >= 0.005) next.barOpacity = patch.barOpacity
    else delete next.barOpacity
  }
  if (patch.titleGradient) next.titleGradient = { ...base.titleGradient, ...patch.titleGradient }
  if (patch.subtitleGradient) next.subtitleGradient = { ...base.subtitleGradient, ...patch.subtitleGradient }
  if (patch.compact !== undefined) {
    if (patch.compact) next.compact = true
    else delete next.compact
  }
  if (patch.fontScale !== undefined) {
    // 100% 就是「没缩放」：这一层不依赖预设就能判定，直接在 store 层抹掉，
    // 避免面板/旧工程递上来的 {title:1} 之类噪声永久占住一个自定义席位
    const scales: { title?: number; subtitle?: number } = {}
    if (isScaled(patch.fontScale.title)) scales.title = patch.fontScale.title
    if (isScaled(patch.fontScale.subtitle)) scales.subtitle = patch.fontScale.subtitle
    if (hasKeys(scales)) next.fontScale = scales
    else delete next.fontScale
  }
  return next
}

/** 字号缩放是否偏离 100%（与滑杆粒度一致：小于 0.5% 的抖动不算自定义） */
function isScaled(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && Math.abs(value - 1) >= 0.005
}

export function selectedClip(state: ProjectState): SubtitleClip | null {
  if (!state.selectedClipId) return null
  return state.project.clips.find((clip) => clip.id === state.selectedClipId) ?? null
}
