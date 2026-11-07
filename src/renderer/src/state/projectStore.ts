import { create } from 'zustand'
import { DEFAULT_FPS, DEFAULT_RESOLUTION, MAX_TRACK_SEC, MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { applyClipStyleToAll, createClip, createId, duplicateClip, normalizeProject, splitSubtitleClipAt } from '@shared/projectSchema'
import { frameIntervalSec, snapTimeToFrame, timeToFrameAtOrAfter } from '@shared/fps'
import { compactMediaClips, splitMediaClipAt } from '@shared/mediaClips'
import { clampMoveToGap, clampTrimEnd, clampTrimStart, firstFreeStart, gapAround, type TimelineSpan } from '@shared/clipCollision'
import { resolveTargetAt, findSelectedRef, type TargetRef, type TimelineSelection, type TimelineTracks } from '@shared/timelineTargets'
import { useStabPreviewStore } from './stabPreviewStore'
import type {
  AudioClip,
  ClipAudio,
  ClipSpeed,
  FontRecord,
  Fps,
  MediaClip,
  MediaClipStab,
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
import { defaultMediaStab, normalizeMediaStab } from '@shared/mediaStab'
import { defaultClipAudio, defaultClipSpeed, normalizeClipAudio, normalizeClipSpeed, speedValueOf } from '@shared/mediaClipAudio'
import { IMAGE_STILL_SEC, applyAudioClipSpeed, inferMediaKind, makeAudioClip, moveAudioClip as applyMoveAudioClip, sortAudioClips, splitAudioClipAt, trimAudioClip as applyTrimAudioClip } from '@shared/audioClips'
import {
  addAudioTrack as appendAudioTrack,
  addMediaTrack as appendMediaTrack,
  isTrackLocked,
  moveTrack as moveTrackIn,
  removeTrack as removeTrackIn,
  renameTrack as renameTrackIn,
  setTrackHidden as setTrackHiddenIn,
  setTrackLocked as setTrackLockedIn,
  setTrackMuted as setTrackMutedIn,
  trackById
} from '@shared/tracks'

/** 工程状态（规格 §4.6）。所有时间值在写入时已吸附到帧边界，存储仍为秒。 */

/** 右侧检查器当前跟谁：刚点中的是字幕条、媒体段还是音频段（三者可同时处于选中态）。 */
export type SelectionKind = 'subtitle' | 'media' | 'audio'

export interface ProjectState {
  project: Project
  selectedClipId: string | null
  /** v2：媒体轨上选中的片段（拆分/删除/拖拽的目标） */
  selectedMediaClipId: string | null
  /** v7：音频轨上选中的片段 */
  selectedAudioClipId: string | null
  /** v3：当前选中的轨道 id（时间轴行高亮 / 新片段默认落点）；不持久化 */
  selectedTrackId: string | null
  /** v6：最后一次点选的类型——决定右侧检查器渲染字幕编辑器还是视频编辑器 */
  selectionKind: SelectionKind
  /** 字体库（内置 + 用户导入） */
  fonts: FontRecord[]
  /** 每次变更递增，驱动自动保存与预览重建 */
  revision: number
  currentPath: string | null
  /** 当前工程在最近工程索引里的身份（'autosave' 或 p+hash）；未知/null 时自动保存写入草稿 */
  currentEntryId: string | null
  /** 是否有未落盘改动（保存成功后由 adoptSavedEntry 清零） */
  isDirty: boolean
  /**
   * 工程被整体替换（打开工程文件 / 启动恢复自动存档）时自增。
   * 历史记账用它判「换工程了」——跨工程的撤销没有意义，看到它变化就清空整条历史。
   */
  projectEpoch: number

  loadProject: (project: Project, path?: string, entryId?: string | null) => void
  /**
   * 另存为 / 打开成功后接住主进程返回的新身份：
   * 只更新路径与 entryId，不推 revision（内容已经在磁盘上，自动保存不需要重写一遍）。
   */
  adoptSavedEntry: (path: string, entryId: string) => void
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
  insertMediaClip: (input: {
    mediaId: string
    timelineStartSec: number
    durationSec?: number
    sourceInSec?: number
    /** v3：落点轨道；缺省 = 当前选中媒体轨，再缺省 = 第一条媒体轨 */
    trackId?: string
  }) => MediaClip | null
  /** 整段平移（可跨轨）；与「仅重叠才右移后续片段」规则共用 alignAfterOverlap。 */
  moveMediaClip: (id: string, timelineStartSec: number, trackId?: string) => void
  /** 拖入/出点：时间轴与源坐标同幅度平移，保持时长恒等式。 */
  trimMediaClip: (id: string, patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  /** 删除一段（不动素材池；素材库卡片仍在）。 */
  removeMediaClip: (id: string) => void
  /**
   * 拆「当前该操作的那一段」（P3）：选中优先（字幕条 / 媒体段 / 音频段三类都算），
   * 未选中时拆播放头处媒体轨的最下一层。返回右半段 id；
   * 没有目标段、切点不在段内或任一半不足最短时长时返回 null，由 UI 提示。
   */
  splitTargetAt: (atSec: number) => string | null
  /** 删「当前该操作的那一段」（目标解析与 splitTargetAt 同源）。返回是否真的删掉了。 */
  removeTargetAt: (atSec: number) => boolean
  /**
   * 只删「当前选中的那一段」，没选中就什么都不做。
   * Delete 键走这条而不是 removeTargetAt：一个键盘就能删掉用户没选中的段太可疑。
   */
  removeSelected: () => boolean

  // ---------------------------------------------------------------- v6 画面编辑
  /** 写回媒体段的画面变换/调色（patch 为增量；全部默认时整键删除） */
  updateMediaClipVideo: (id: string, patch: Partial<MediaClipVideo>) => void
  /** 一条片段的所有画面编辑回到默认（缩放 100% / 无翻转 / 参数归零 / 曲线直线；v8：连防抖一起清） */
  resetMediaClipVideo: (id: string) => void

  // ---------------------------------------------------------------- v8 防抖
  /** 写回媒体段的防抖参数（patch 为增量；全部默认时整键删除） */
  updateMediaClipStab: (id: string, patch: Partial<MediaClipStab>) => void

  // ---------------------------------------------------------------- v9 音频与变速
  /** 写回媒体段原声的音量/渐入渐出（patch 为增量；全默认整键删除） */
  updateMediaClipAudio: (id: string, patch: Partial<ClipAudio>) => void
  /**
   * 写回媒体段变速。**源窗口不动**，时间轴出点按 `源窗口 / 倍速` 重算，
   * 所以 2x 会让片段在时间轴上缩短一半（不去推挤其他片段：叠层重叠是 v7 的正常形态）。
   */
  updateMediaClipSpeed: (id: string, patch: Partial<ClipSpeed>) => void
  /** 写回音频段的音量/渐入渐出 */
  updateAudioClipAudio: (id: string, patch: Partial<ClipAudio>) => void
  /** 写回音频段变速（同上：源窗口不动，时间轴长度伸缩） */
  updateAudioClipSpeed: (id: string, patch: Partial<ClipSpeed>) => void
  /** 本条音频的音量/渐变/变速全部回到默认（时间轴长度回到源窗口长度） */
  resetAudioClipFx: (id: string) => void

  // ---------------------------------------------------------------- v7 音频轨
  selectAudioClip: (id: string | null) => void
  /** 把音频素材丢到音频轨 [start, start + duration]；返回新片段（null = 素材缺失或区间退化） */
  insertAudioClip: (input: {
    mediaId: string
    timelineStartSec: number
    durationSec?: number
    sourceInSec?: number
    /** v3：落点音频轨；缺省 = 当前选中音频轨，再缺省 = 第一条音频轨 */
    trackId?: string
  }) => AudioClip | null
  /** 整段平移（可跨轨；音频允许互相重叠，不与其它段推挤） */
  moveAudioClip: (id: string, timelineStartSec: number, trackId?: string) => void
  /** 拖入点 / 出点（保持时长恒等式） */
  trimAudioClip: (id: string, patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  removeAudioClip: (id: string) => void
  /** v3：把媒体段换到另一条媒体轨（时间不变；目标轨同段有冲突时拒绝） */
  setMediaClipTrack: (id: string, trackId: string) => void
  /** v3：把音频段换到另一条音频轨 */
  setAudioClipTrack: (id: string, trackId: string) => void

  // ---------------------------------------------------------------- v3 轨道管理
  /** 选中轨道（时间轴行高亮 / 新片段默认落点） */
  selectTrack: (id: string | null) => void
  /** 在最上层新增媒体轨；达到上限返回 null */
  addMediaTrack: () => string | null
  /** 在最上层新增音频轨；达到上限返回 null */
  addAudioTrack: () => string | null
  /** 删除媒体轨（连同其上的片段）；最后一条轨不允许删 */
  removeMediaTrack: (id: string) => void
  /** 删除音频轨（连同其上的片段）；最后一条轨不允许删 */
  removeAudioTrack: (id: string) => void
  /** 调整媒体轨层级（0 = 最底层） */
  moveMediaTrack: (id: string, toIndex: number) => void
  /** 调整音频轨层级（0 = 最底层） */
  moveAudioTrack: (id: string, toIndex: number) => void
  /** 重命名轨道（媒体/音频/字幕三类都走它） */
  renameTrack: (id: string, name: string) => void
  setTrackMuted: (id: string, muted: boolean) => void
  setTrackHidden: (id: string, hidden: boolean) => void
  setTrackLocked: (id: string, locked: boolean) => void

  // ---------------------------------------------------------------- 时间轴工具
  /**
   * 主轨对齐：把所有媒体段按时间顺序从左到右紧贴排列（间隙 0，时长不变）。
   * 开关本身是 UI 态（uiStore），这个动作只负责把工程摆正；重复调用是幂等的。
   */
  compactTimeline: () => void
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
  // v7：音频轨也算进尺规总长，否则拖到后面的音频会跑出尺规
  const audioEnd = (project.audioClips ?? []).reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
  const furthest = Math.max(clipsEnd, mediaEnd, audioEnd)
  return furthest > 0 ? furthest : 5
}

/** 媒体轨总覆盖（含素材时长）：时间轴尺规至少容得下全部片段。 */
export function timelineMediaSpanSec(project: Project): number {
  return project.media.reduce((acc, item) => Math.max(acc, item.meta.durationSec), 0)
}

function withClips(project: Project, clips: SubtitleClip[]): Project {
  return { ...project, clips: [...clips].sort((a, b) => a.startTime - b.startTime) }
}

/** 字幕条 → 夹取函数用的区间（它用 startTime/endTime，与另两轨字段名不同）。 */
function subtitleSpan(clip: SubtitleClip): TimelineSpan {
  return { startSec: clip.startTime, endSec: clip.endTime }
}

/** 媒体段 / 音频段 → 夹取函数用的区间。 */
function trackSpan(clip: { timelineStartSec: number; timelineEndSec: number }): TimelineSpan {
  return { startSec: clip.timelineStartSec, endSec: clip.timelineEndSec }
}

function withMediaClips(project: Project, mediaClips: MediaClip[]): Project {
  return { ...project, mediaClips: [...mediaClips].sort((a, b) => a.timelineStartSec - b.timelineStartSec) }
}

/**
 * v7：入池前把素材补全成「带 kind 的完整条目」。
 * - 图像：ffprobe 读不出时长（单帧），给一个默认静帧时长，否则上轨后长度为 0；
 * - 音频：没有画面（width=0），不带兼容性确认；
 * - 视频：不写 kind（旧工程 JSON 形状不变）。
 */
function normalizeImportedMedia(item: MediaItem): MediaItem {
  const kind = item.kind ?? inferMediaKind(item.path, item.meta)
  const meta = kind === 'image' && !(item.meta.durationSec > 0) ? { ...item.meta, durationSec: IMAGE_STILL_SEC } : item.meta
  return { ...item, meta, ...(kind !== 'video' ? { kind } : {}) }
}

/** v7：音频轨写入口（按时间排序；空轨道时删掉整个键，保持 JSON 干净） */
function withAudioClips(project: Project, audioClips: AudioClip[]): Project {
  const sorted = sortAudioClips(audioClips)
  const next: Project = { ...project }
  if (sorted.length > 0) next.audioClips = sorted
  else delete next.audioClips
  return next
}

/** P3：拆分/删除的目标解析要看的三条轨。 */
function tracksOf(project: Project): TimelineTracks {
  return {
    clips: project.clips,
    mediaClips: project.mediaClips,
    audioClips: project.audioClips ?? [],
    mediaTracks: project.mediaTracks
  }
}

/**
 * P3：当前选中态。三个选中 id 可以并存，`selectionKind`（最后一次点选的类型）才是分流依据，
 * 所以下面三个都得带上，不能只挑一个非空的传。
 */
function selectionOf(state: ProjectState): TimelineSelection {
  return {
    clipId: state.selectedClipId,
    mediaClipId: state.selectedMediaClipId,
    audioClipId: state.selectedAudioClipId,
    kind: state.selectionKind
  }
}

/** 按解析出的目标段分派到三条轨各自的删除动作。 */
function removeTargetRef(store: ProjectState, target: TargetRef): void {
  if (target.kind === 'subtitle') store.removeClip(target.id)
  else if (target.kind === 'audio') store.removeAudioClip(target.id)
  else store.removeMediaClip(target.id)
}

/** v3：落点轨道解析——显式指定优先，其次当前选中轨，最后第一条同类轨道。 */
function pickMediaTrackId(project: Project, preferred: string | null | undefined): string {
  if (preferred && project.mediaTracks.some((track) => track.id === preferred)) return preferred
  return project.mediaTracks[0]!.id
}

function pickAudioTrackId(project: Project, preferred: string | null | undefined): string {
  if (preferred && project.audioTracks.some((track) => track.id === preferred)) return preferred
  return project.audioTracks[0]!.id
}

function spansOverlap(a: TimelineSpan, b: TimelineSpan): boolean {
  return a.startSec < b.endSec - 1e-9 && b.startSec < a.endSec - 1e-9
}

/** 三个开关分别写三类轨道（媒体/音频/字幕），找不到轨就原样返回。 */
function withTrackMuted(project: Project, id: string, muted: boolean): Project {
  const mediaTracks = setTrackMutedIn(project.mediaTracks, id, muted)
  if (mediaTracks !== project.mediaTracks) return { ...project, mediaTracks }
  const audioTracks = setTrackMutedIn(project.audioTracks, id, muted)
  if (audioTracks !== project.audioTracks) return { ...project, audioTracks }
  const [subtitleTrack] = setTrackMutedIn([project.subtitleTrack], id, muted)
  if (subtitleTrack && subtitleTrack !== project.subtitleTrack) return { ...project, subtitleTrack }
  return project
}

function withTrackHidden(project: Project, id: string, hidden: boolean): Project {
  const mediaTracks = setTrackHiddenIn(project.mediaTracks, id, hidden)
  if (mediaTracks !== project.mediaTracks) return { ...project, mediaTracks }
  const audioTracks = setTrackHiddenIn(project.audioTracks, id, hidden)
  if (audioTracks !== project.audioTracks) return { ...project, audioTracks }
  const [subtitleTrack] = setTrackHiddenIn([project.subtitleTrack], id, hidden)
  if (subtitleTrack && subtitleTrack !== project.subtitleTrack) return { ...project, subtitleTrack }
  return project
}

function withTrackLocked(project: Project, id: string, locked: boolean): Project {
  const mediaTracks = setTrackLockedIn(project.mediaTracks, id, locked)
  if (mediaTracks !== project.mediaTracks) return { ...project, mediaTracks }
  const audioTracks = setTrackLockedIn(project.audioTracks, id, locked)
  if (audioTracks !== project.audioTracks) return { ...project, audioTracks }
  const [subtitleTrack] = setTrackLockedIn([project.subtitleTrack], id, locked)
  if (subtitleTrack && subtitleTrack !== project.subtitleTrack) return { ...project, subtitleTrack }
  return project
}

/** 时长恒等式（timelineEnd - timelineStart === sourceOut - sourceIn）的唯一写入口。 */
function makeMediaClip(input: {
  id?: string
  mediaId: string
  trackId: string
  timelineStartSec: number
  timelineEndSec: number
  sourceInSec: number
  sourceOutSec: number
}): MediaClip {
  return {
    id: input.id ?? createId('mclip'),
    mediaId: input.mediaId,
    trackId: input.trackId,
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
  selectedAudioClipId: null,
  selectedTrackId: null,
  selectionKind: 'subtitle',
  fonts: [],
  revision: 0,
  currentPath: null,
  currentEntryId: null,
  isDirty: false,
  projectEpoch: 0,

  loadProject: (project, path, entryId) =>
    set((state) => ({
      project,
      currentPath: path ?? null,
      currentEntryId: entryId ?? null,
      isDirty: false,
      selectedClipId: project.clips[0]?.id ?? null,
      selectedMediaClipId: project.mediaClips[0]?.id ?? null,
      selectedAudioClipId: project.audioClips?.[0]?.id ?? null,
      selectedTrackId: null,
      // 打开工程默认先看字幕（这是主任务）；没有字幕条时才落到视频编辑器
      selectionKind: project.clips.length > 0 ? 'subtitle' : 'media',
      revision: state.revision + 1,
      projectEpoch: state.projectEpoch + 1
    })),

  adoptSavedEntry: (path, entryId) =>
    set({ currentPath: path, currentEntryId: entryId, isDirty: false }),

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
    const current = state.project.clips.find((clip) => clip.id === id)
    if (!current) return
    const minSec = frameIntervalSec(fps)
    // 只在「自己当前所在的空档」里移动/伸缩：撞到邻居就贴住，不推开别人
    const gap = gapAround(
      subtitleSpan(current),
      state.project.clips.filter((clip) => clip.id !== id).map(subtitleSpan)
    )
    let start = snapTimeToFrame(Math.max(0, startTime), fps)
    let end = snapTimeToFrame(Math.max(start + 0.001, endTime), fps)
    const startMoved = Math.abs(start - current.startTime) > 1e-9
    const endMoved = Math.abs(end - current.endTime) > 1e-9
    if (startMoved && endMoved) {
      // 整体拖拽：保持时长，夹在空档里
      const length = Math.max(minSec, end - start)
      start = clampMoveToGap(start, length, gap.startSec, gap.endSec)
      end = snapTimeToFrame(start + length, fps)
    } else if (startMoved) {
      start = clampTrimStart(start, gap.startSec, current.endTime - minSec)
    } else if (endMoved) {
      end = clampTrimEnd(end, current.startTime + minSec, gap.endSec)
    }
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
    const media: MediaItem = normalizeImportedMedia({ ...item, id: item.id ?? createId('media') })
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
    let start = snapTimeToFrame(Math.max(0, input.timelineStartSec), fps)
    const durationSec = Math.max(MIN_MEDIA_CLIP_SEC, input.durationSec ?? item.meta.durationSec)
    // 源入点后钳到最短时长，再向源尾部收：不足最短时长的落点拒收而不是静默截断
    const sourceIn = snapTimeToFrame(Math.max(0, input.sourceInSec ?? 0), fps)
    const sourceOut = snapTimeToFrame(Math.min(item.meta.durationSec, sourceIn + durationSec), fps)
    if (sourceOut - sourceIn < MIN_MEDIA_CLIP_SEC) return null
    // 新建段一律 1x（无 speed 键），所以 `(sourceOut - sourceIn) / 1` 与旧写法逐字节一致
    let end = snapTimeToFrame(start + (sourceOut - sourceIn), fps)
    if (end - start < MIN_MEDIA_CLIP_SEC) end = snapTimeToFrame(start + MIN_MEDIA_CLIP_SEC, fps)
    // v3：落点轨道（选中轨优先；轨道锁定则拒收）
    const trackId = pickMediaTrackId(state.project, input.trackId ?? state.selectedTrackId)
    if (isTrackLocked(trackById(state.project.mediaTracks, trackId))) return null
    // 落点被占：顺延到同一轨道后面的第一个空档（只选位置，不推动已有段）；一直放不下就拒收
    const length = end - start
    const placed = firstFreeStart(
      start,
      length,
      state.project.mediaClips
        .filter((other) => other.trackId === trackId)
        .map((other) => ({ startSec: other.timelineStartSec, endSec: other.timelineEndSec })),
      MAX_TRACK_SEC
    )
    if (placed === null) return null
    if (placed !== start) {
      start = placed
      end = snapTimeToFrame(start + length, fps)
    }
    const clip = makeMediaClip({
      mediaId: item.id,
      trackId,
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

  moveMediaClip: (id, timelineStartSec, trackId) => {
    const state = get()
    const fps = state.project.fps
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    const targetTrackId = pickMediaTrackId(state.project, trackId ?? current.trackId)
    if (isTrackLocked(trackById(state.project.mediaTracks, targetTrackId))) return
    const length = current.timelineEndSec - current.timelineStartSec
    // 只跟**同一目标轨道**的邻居抢空间：不同轨道允许时间重叠
    const others = state.project.mediaClips.filter(
      (c) => c.id !== id && c.trackId === targetTrackId
    )
    // 跨轨落点若压住目标轨已有片段：直接拒绝（不做静默覆盖/推挤）
    const requestedStart = snapTimeToFrame(Math.max(0, timelineStartSec), fps)
    let start: number
    if (targetTrackId !== current.trackId) {
      const requestedEnd = snapTimeToFrame(requestedStart + length, fps)
      if (others.some((other) => spansOverlap(trackSpan(other), { startSec: requestedStart, endSec: requestedEnd }))) {
        return
      }
      start = requestedStart
    } else {
      const gap = gapAround(trackSpan(current), others.map(trackSpan))
      // 夹在空档里：撞到邻居就贴住，绝不推开别人（"挪不过去就卡在原地"）
      start = clampMoveToGap(requestedStart, length, gap.startSec, gap.endSec)
    }
    const moved: MediaClip = {
      ...current,
      trackId: targetTrackId,
      timelineStartSec: start,
      timelineEndSec: snapTimeToFrame(start + length, fps)
    }
    const merged = state.project.mediaClips.map((c) => (c.id === id ? moved : c))
    // 空工程/已紧贴时不动工程，避免无意义地推高 revision（会触发自动保存）
    if (
      moved.trackId === current.trackId &&
      Math.abs(moved.timelineStartSec - current.timelineStartSec) < 1e-9 &&
      Math.abs(moved.timelineEndSec - current.timelineEndSec) < 1e-9
    ) {
      return
    }
    set({
      project: withMediaClips(state.project, merged),
      selectedMediaClipId: id,
      revision: state.revision + 1
    })
  },

  trimMediaClip: (id, patch) => {
    const state = get()
    const fps = state.project.fps
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    const item = state.project.media.find((m) => m.id === current.mediaId)
    const sourceDuration = item?.meta.durationSec ?? Number.POSITIVE_INFINITY
    // v9：拖边时时间轴位移与源位移之间差一个倍速（1x 时与旧写法逐字节一致）
    const speed = speedValueOf(current.speed)
    // 同层邻居决定这段能伸到哪：撞到邻居就停，绝不挤开别人
    const gap = gapAround(
      trackSpan(current),
      state.project.mediaClips
        .filter((c) => c.id !== id && c.trackId === current.trackId)
        .map(trackSpan)
    )
    let next = { ...current }
    if (patch.timelineStartSec !== undefined) {
      const start = snapTimeToFrame(
        clampTrimStart(
          Math.max(0, patch.timelineStartSec),
          gap.startSec,
          current.timelineEndSec - MIN_MEDIA_CLIP_SEC
        ),
        fps
      )
      const delta = start - current.timelineStartSec
      const sourceIn = snapTimeToFrame(Math.max(0, Math.min(sourceDuration - MIN_MEDIA_CLIP_SEC, current.sourceInSec + delta * speed)), fps)
      const duration = current.timelineEndSec - start
      next = {
        ...next,
        timelineStartSec: start,
        sourceInSec: sourceIn,
        sourceOutSec: snapTimeToFrame(sourceIn + duration * speed, fps)
      }
    }
    if (patch.timelineEndSec !== undefined) {
      const end = snapTimeToFrame(
        clampTrimEnd(patch.timelineEndSec, next.timelineStartSec + MIN_MEDIA_CLIP_SEC, gap.endSec),
        fps
      )
      const duration = end - next.timelineStartSec
      const sourceOut = snapTimeToFrame(
        Math.min(Math.max(sourceDuration, next.sourceInSec + MIN_MEDIA_CLIP_SEC * speed), next.sourceInSec + duration * speed),
        fps
      )
      next = {
        ...next,
        timelineEndSec: snapTimeToFrame(next.timelineStartSec + (sourceOut - next.sourceInSec) / speed, fps),
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
    const current = state.project.mediaClips.find((c) => c.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    const mediaClips = state.project.mediaClips.filter((c) => c.id !== id)
    const removedSelected = state.selectedMediaClipId === id
    const selectedMediaClipId = removedSelected ? (mediaClips[0]?.id ?? null) : state.selectedMediaClipId
    // v8.1：片段没了，它的防抖代理账本与磁盘缓存一起回收（fire-and-forget，不阻塞删轨）
    useStabPreviewStore.getState().clearForClip(id, true)
    set({
      project: withMediaClips(state.project, mediaClips),
      selectedMediaClipId,
      // 删掉了正在编辑的那条且再无媒体段：检查器退回字幕编辑器，不留一个空视频面板
      ...(removedSelected && selectedMediaClipId === null ? { selectionKind: 'subtitle' as const } : {}),
      revision: state.revision + 1
    })
  },

  splitTargetAt: (atSec) => {
    const state = get()
    const fps = state.project.fps
    const target = resolveTargetAt(tracksOf(state.project), selectionOf(state), atSec)
    if (!target) return null

    if (target.kind === 'subtitle') {
      if (state.project.subtitleTrack.locked) return null
      const clip = state.project.clips.find((item) => item.id === target.id)
      if (!clip) return null
      const result = splitSubtitleClipAt(clip, atSec, fps, () => createId('clip'))
      if (!result) return null
      const clips = state.project.clips.filter((item) => item.id !== clip.id).concat(result.left, result.right)
      set({
        project: withClips(state.project, clips),
        selectedClipId: result.right.id,
        selectionKind: 'subtitle',
        revision: state.revision + 1
      })
      return result.right.id
    }

    if (target.kind === 'audio') {
      const clip = (state.project.audioClips ?? []).find((item) => item.id === target.id)
      if (!clip) return null
      if (isTrackLocked(trackById(state.project.audioTracks, clip.trackId))) return null
      const result = splitAudioClipAt(clip, atSec, fps, () => createId('aclip'))
      if (!result) return null
      const audioClips = (state.project.audioClips ?? []).filter((item) => item.id !== clip.id).concat(result.left, result.right)
      set({
        project: withAudioClips(state.project, audioClips),
        selectedAudioClipId: result.right.id,
        selectionKind: 'audio',
        revision: state.revision + 1
      })
      return result.right.id
    }

    const clip = state.project.mediaClips.find((item) => item.id === target.id)
    if (!clip) return null
    if (isTrackLocked(trackById(state.project.mediaTracks, clip.trackId))) return null
    const result = splitMediaClipAt(clip, atSec, fps, () => createId('mclip'))
    if (!result) return null
    const mediaClips = state.project.mediaClips.filter((item) => item.id !== clip.id).concat(result.left, result.right)
    set({
      project: withMediaClips(state.project, mediaClips),
      selectedMediaClipId: result.right.id,
      // 拆完直接编辑右半段，检查器跟着切到视频视图
      selectionKind: 'media',
      revision: state.revision + 1
    })
    return result.right.id
  },

  removeTargetAt: (atSec) => {
    const state = get()
    const target = resolveTargetAt(tracksOf(state.project), selectionOf(state), atSec)
    if (!target) return false
    removeTargetRef(state, target)
    return true
  },

  removeSelected: () => {
    const state = get()
    const target = findSelectedRef(tracksOf(state.project), selectionOf(state))
    if (!target) return false
    removeTargetRef(state, target)
    return true
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
      // v8：「恢复默认」语义覆盖防抖（画面与稳定都回到不做任何处理）
      delete next.stab
      // v9：音频与变速也是“这一条的处理”，一并回到默认（时间轴长度回到源窗口长度）
      delete next.audio
      delete next.speed
      next.timelineEndSec = snapTimeToFrame(
        next.timelineStartSec + Math.max(MIN_MEDIA_CLIP_SEC, clip.sourceOutSec - clip.sourceInSec),
        state.project.fps
      )
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v8 防抖

  updateMediaClipStab: (id, patch) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      // 与 updateMediaClipVideo 同一套纪律：增量合并 → 纯函数归一 → 全默认整键删除
      const current = clip.stab ?? defaultMediaStab()
      const normalized = normalizeMediaStab({ ...current, ...patch })
      const next: MediaClip = { ...clip }
      if (normalized) next.stab = normalized
      else delete next.stab
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v9 音频与变速

  updateMediaClipAudio: (id, patch) => {
    const state = get()
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.audio ?? defaultClipAudio()
      const normalized = normalizeClipAudio({ ...current, ...patch })
      const next: MediaClip = { ...clip }
      if (normalized) next.audio = normalized
      else delete next.audio
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  updateMediaClipSpeed: (id, patch) => {
    const state = get()
    const fps = state.project.fps
    const mediaClips = state.project.mediaClips.map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.speed ?? defaultClipSpeed()
      const normalized = normalizeClipSpeed({ ...current, ...patch })
      const next: MediaClip = { ...clip }
      if (normalized) next.speed = normalized
      else delete next.speed
      // 源窗口不动，时间轴出点跟着倍速伸缩（1x 时就是源窗口长度，与旧恒等式一致）
      const sourceLen = Math.max(MIN_MEDIA_CLIP_SEC, clip.sourceOutSec - clip.sourceInSec)
      next.timelineEndSec = snapTimeToFrame(
        clip.timelineStartSec + Math.max(MIN_MEDIA_CLIP_SEC, sourceLen / speedValueOf(normalized)),
        fps
      )
      return next
    })
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  updateAudioClipAudio: (id, patch) => {
    const state = get()
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.audio ?? defaultClipAudio()
      const normalized = normalizeClipAudio({ ...current, ...patch })
      const next: AudioClip = { ...clip }
      if (normalized) next.audio = normalized
      else delete next.audio
      return next
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  updateAudioClipSpeed: (id, patch) => {
    const state = get()
    const fps = state.project.fps
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const current = clip.speed ?? defaultClipSpeed()
      const normalized = normalizeClipSpeed({ ...current, ...patch })
      return applyAudioClipSpeed(clip, normalized, fps)
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  resetAudioClipFx: (id) => {
    const state = get()
    const fps = state.project.fps
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const cleared: AudioClip = { ...clip }
      delete cleared.audio
      // 变速归位后时间轴长度要回到源窗口长度
      return applyAudioClipSpeed(cleared, undefined, fps)
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  // ---------------------------------------------------------------- v7 音频轨

  selectAudioClip: (id) =>
    set({ selectedAudioClipId: id, ...(id ? { selectionKind: 'audio' as const } : {}) }),

  insertAudioClip: (input) => {
    const state = get()
    const item = state.project.media.find((m) => m.id === input.mediaId)
    if (!item) return null
    // v3：落点轨道（选中轨优先；轨道锁定则拒收）
    const trackId = pickAudioTrackId(state.project, input.trackId ?? state.selectedTrackId)
    if (isTrackLocked(trackById(state.project.audioTracks, trackId))) return null
    const clip = makeAudioClip(
      {
        id: createId('aclip'),
        mediaId: input.mediaId,
        trackId,
        timelineStartSec: input.timelineStartSec,
        durationSec: input.durationSec ?? item.meta.durationSec,
        sourceInSec: input.sourceInSec ?? 0,
        sourceDurationSec: item.meta.durationSec
      },
      state.project.fps
    )
    if (!clip) return null
    // 落点被占：顺延到同一轨道后面的第一个空档（只选位置，不推动已有段）
    const placed = firstFreeStart(
      clip.timelineStartSec,
      clip.timelineEndSec - clip.timelineStartSec,
      (state.project.audioClips ?? [])
        .filter((other) => other.trackId === trackId)
        .map((other) => ({ startSec: other.timelineStartSec, endSec: other.timelineEndSec })),
      MAX_TRACK_SEC
    )
    if (placed === null) return null
    const placedClip =
      Math.abs(placed - clip.timelineStartSec) < 1e-9
        ? clip
        : applyMoveAudioClip(clip, placed, state.project.fps)
    const audioClips = [...(state.project.audioClips ?? []), placedClip]
    set({
      project: withAudioClips(state.project, audioClips),
      selectedAudioClipId: placedClip.id,
      revision: state.revision + 1
    })
    return placedClip
  },

  moveAudioClip: (id, timelineStartSec, trackId) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    const targetTrackId = pickAudioTrackId(state.project, trackId ?? current.trackId)
    if (isTrackLocked(trackById(state.project.audioTracks, targetTrackId))) return
    // 只跟同一目标轨道的邻居抢空间；撞到就贴住，不推开别人
    const others = (state.project.audioClips ?? []).filter(
      (clip) => clip.id !== id && clip.trackId === targetTrackId
    )
    // 跨轨落点若压住目标轨已有片段：直接拒绝（不做静默覆盖）
    const length = current.timelineEndSec - current.timelineStartSec
    const requestedStart = snapTimeToFrame(Math.max(0, timelineStartSec), state.project.fps)
    let start: number
    if (targetTrackId !== current.trackId) {
      const requestedEnd = snapTimeToFrame(requestedStart + length, state.project.fps)
      if (others.some((other) => spansOverlap(trackSpan(other), { startSec: requestedStart, endSec: requestedEnd }))) {
        return
      }
      start = requestedStart
    } else {
      const gap = gapAround(trackSpan(current), others.map(trackSpan))
      start = clampMoveToGap(requestedStart, length, gap.startSec, gap.endSec)
    }
    if (targetTrackId === current.trackId && Math.abs(start - current.timelineStartSec) < 1e-9) return
    const audioClips = (state.project.audioClips ?? []).map((clip) =>
      clip.id === id ? { ...applyMoveAudioClip(clip, start, state.project.fps), trackId: targetTrackId } : clip
    )
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  trimAudioClip: (id, patch) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    const others = (state.project.audioClips ?? []).filter(
      (clip) => clip.id !== id && clip.trackId === current.trackId
    )
    const gap = gapAround(trackSpan(current), others.map(trackSpan))
    const minSec = frameIntervalSec(state.project.fps)
    const clamped: { timelineStartSec?: number; timelineEndSec?: number } = {}
    if (patch.timelineStartSec !== undefined) {
      clamped.timelineStartSec = clampTrimStart(
        patch.timelineStartSec,
        gap.startSec,
        current.timelineEndSec - minSec
      )
    }
    if (patch.timelineEndSec !== undefined) {
      clamped.timelineEndSec = clampTrimEnd(
        patch.timelineEndSec,
        current.timelineStartSec + minSec,
        gap.endSec
      )
    }
    const audioClips = (state.project.audioClips ?? []).map((clip) => {
      if (clip.id !== id) return clip
      const item = state.project.media.find((m) => m.id === clip.mediaId)
      return applyTrimAudioClip(
        clip,
        clamped,
        state.project.fps,
        item?.meta.durationSec ?? Number.POSITIVE_INFINITY
      )
    })
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  removeAudioClip: (id) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    const audioClips = (state.project.audioClips ?? []).filter((clip) => clip.id !== id)
    const removedSelected = state.selectedAudioClipId === id
    const selectedAudioClipId = removedSelected ? (audioClips[0]?.id ?? null) : state.selectedAudioClipId
    set({
      project: withAudioClips(state.project, audioClips),
      ...(removedSelected ? { selectedAudioClipId } : {}),
      // 删掉了正在编辑的音频段且再无音频段：检查器退回字幕编辑器，不留一个空音频面板
      ...(removedSelected && selectedAudioClipId === null && state.selectionKind === 'audio'
        ? { selectionKind: 'subtitle' as const }
        : {}),
      revision: state.revision + 1
    })
  },

  // ---------------------------------------------------------------- v3 轨道

  selectTrack: (id) => set({ selectedTrackId: id }),

  addMediaTrack: () => {
    const state = get()
    const mediaTracks = appendMediaTrack(state.project.mediaTracks)
    if (mediaTracks === state.project.mediaTracks) return null
    const added = mediaTracks[mediaTracks.length - 1]!
    set({
      project: { ...state.project, mediaTracks },
      selectedTrackId: added.id,
      revision: state.revision + 1
    })
    return added.id
  },

  addAudioTrack: () => {
    const state = get()
    const audioTracks = appendAudioTrack(state.project.audioTracks)
    if (audioTracks === state.project.audioTracks) return null
    const added = audioTracks[audioTracks.length - 1]!
    set({
      project: { ...state.project, audioTracks },
      selectedTrackId: added.id,
      revision: state.revision + 1
    })
    return added.id
  },

  removeMediaTrack: (id) => {
    const state = get()
    const { mediaTracks, mediaClips } = state.project
    if (!mediaTracks.some((track) => track.id === id)) return
    const nextTracks = removeTrackIn(mediaTracks, id)
    if (nextTracks === mediaTracks) return
    const removed = mediaClips.filter((clip) => clip.trackId === id)
    const removedIds = new Set(removed.map((clip) => clip.id))
    set({
      project: {
        ...state.project,
        mediaTracks: nextTracks,
        mediaClips: mediaClips.filter((clip) => clip.trackId !== id)
      },
      ...(state.selectedMediaClipId && removedIds.has(state.selectedMediaClipId)
        ? { selectedMediaClipId: null }
        : {}),
      ...(state.selectedTrackId === id ? { selectedTrackId: nextTracks[0]?.id ?? null } : {}),
      revision: state.revision + 1
    })
  },

  removeAudioTrack: (id) => {
    const state = get()
    const { audioTracks } = state.project
    if (!audioTracks.some((track) => track.id === id)) return
    const nextTracks = removeTrackIn(audioTracks, id)
    if (nextTracks === audioTracks) return
    const kept = (state.project.audioClips ?? []).filter((clip) => clip.trackId !== id)
    const removedIds = new Set(
      (state.project.audioClips ?? []).filter((clip) => clip.trackId === id).map((clip) => clip.id)
    )
    const project: Project = { ...state.project, audioTracks: nextTracks }
    if (kept.length > 0) project.audioClips = sortAudioClips(kept)
    else delete project.audioClips
    set({
      project,
      ...(state.selectedAudioClipId && removedIds.has(state.selectedAudioClipId)
        ? { selectedAudioClipId: null }
        : {}),
      ...(state.selectedTrackId === id ? { selectedTrackId: nextTracks[0]?.id ?? null } : {}),
      revision: state.revision + 1
    })
  },

  moveMediaTrack: (id, toIndex) => {
    const state = get()
    const mediaTracks = moveTrackIn(state.project.mediaTracks, id, toIndex)
    if (mediaTracks === state.project.mediaTracks) return
    set({ project: { ...state.project, mediaTracks }, revision: state.revision + 1 })
  },

  moveAudioTrack: (id, toIndex) => {
    const state = get()
    const audioTracks = moveTrackIn(state.project.audioTracks, id, toIndex)
    if (audioTracks === state.project.audioTracks) return
    set({ project: { ...state.project, audioTracks }, revision: state.revision + 1 })
  },

  renameTrack: (id, name) => {
    const state = get()
    const project = state.project
    const mediaTracks = renameTrackIn(project.mediaTracks, id, name)
    if (mediaTracks !== project.mediaTracks) {
      set({ project: { ...project, mediaTracks }, revision: state.revision + 1 })
      return
    }
    const audioTracks = renameTrackIn(project.audioTracks, id, name)
    if (audioTracks !== project.audioTracks) {
      set({ project: { ...project, audioTracks }, revision: state.revision + 1 })
      return
    }
    const [subtitleTrack] = renameTrackIn([project.subtitleTrack], id, name)
    if (subtitleTrack && subtitleTrack !== project.subtitleTrack) {
      set({ project: { ...project, subtitleTrack }, revision: state.revision + 1 })
    }
  },

  setTrackMuted: (id, muted) => {
    const state = get()
    const project = withTrackMuted(state.project, id, muted)
    if (project !== state.project) set({ project, revision: state.revision + 1 })
  },

  setTrackHidden: (id, hidden) => {
    const state = get()
    const project = withTrackHidden(state.project, id, hidden)
    if (project !== state.project) set({ project, revision: state.revision + 1 })
  },

  setTrackLocked: (id, locked) => {
    const state = get()
    const project = withTrackLocked(state.project, id, locked)
    if (project !== state.project) set({ project, revision: state.revision + 1 })
  },

  setMediaClipTrack: (id, trackId) => {
    const state = get()
    const current = state.project.mediaClips.find((clip) => clip.id === id)
    if (!current || current.trackId === trackId) return
    if (!state.project.mediaTracks.some((track) => track.id === trackId)) return
    if (isTrackLocked(trackById(state.project.mediaTracks, current.trackId))) return
    if (isTrackLocked(trackById(state.project.mediaTracks, trackId))) return
    const conflict = state.project.mediaClips.some(
      (other) =>
        other.id !== id && other.trackId === trackId && spansOverlap(trackSpan(other), trackSpan(current))
    )
    if (conflict) return
    const mediaClips = state.project.mediaClips.map((clip) =>
      clip.id === id ? { ...clip, trackId } : clip
    )
    set({ project: withMediaClips(state.project, mediaClips), revision: state.revision + 1 })
  },

  setAudioClipTrack: (id, trackId) => {
    const state = get()
    const current = (state.project.audioClips ?? []).find((clip) => clip.id === id)
    if (!current || current.trackId === trackId) return
    if (!state.project.audioTracks.some((track) => track.id === trackId)) return
    if (isTrackLocked(trackById(state.project.audioTracks, current.trackId))) return
    if (isTrackLocked(trackById(state.project.audioTracks, trackId))) return
    const conflict = (state.project.audioClips ?? []).some(
      (other) =>
        other.id !== id && other.trackId === trackId && spansOverlap(trackSpan(other), trackSpan(current))
    )
    if (conflict) return
    const audioClips = (state.project.audioClips ?? []).map((clip) =>
      clip.id === id ? { ...clip, trackId } : clip
    )
    set({ project: withAudioClips(state.project, audioClips), revision: state.revision + 1 })
  },

  compactTimeline: () => {
    const state = get()
    const compacted = compactMediaClips(state.project.mediaClips, state.project.fps)
    // 已经紧贴时不动工程，避免无意义地推高 revision（会触发自动保存）
    const changed = compacted.some((clip) => {
      const before = state.project.mediaClips.find((item) => item.id === clip.id)
      return (
        !before ||
        Math.abs(before.timelineStartSec - clip.timelineStartSec) > 1e-6 ||
        Math.abs(before.timelineEndSec - clip.timelineEndSec) > 1e-6
      )
    })
    if (!changed) return
    set({ project: withMediaClips(state.project, compacted), revision: state.revision + 1 })
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
