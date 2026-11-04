import { create } from 'zustand'
import { DEFAULT_FPS, DEFAULT_RESOLUTION } from '@shared/constants'
import { applyClipStyleToAll, createClip, duplicateClip, normalizeProject } from '@shared/projectSchema'
import { snapTimeToFrame, timeToFrameAtOrAfter } from '@shared/fps'
import type { FontRecord, Fps, PresetId, Project, RefVideo, StyleOverrides, SubtitleClip } from '@shared/types'
import { getPreset } from '@shared/presets'

/** 工程状态（规格 §4.6）。所有时间值在写入时已吸附到帧边界，存储仍为秒。 */

export interface ProjectState {
  project: Project
  selectedClipId: string | null
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
  setRefVideo: (refVideo: RefVideo | undefined) => void
  setVfrPolicy: (policy: RefVideo['vfrPolicy']) => void
  setCompactMode: (mode: RefVideo['compactMode']) => void
  ackNon169: (value: boolean) => void
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
  setClipTimes: (id: string, startTime: number, endTime: number) => void
}

export function createInitialProject(): Project {
  return normalizeProject({
    version: 1,
    name: '未命名工程',
    resolution: { ...DEFAULT_RESOLUTION },
    fps: { ...DEFAULT_FPS },
    clips: [],
    fonts: []
  })!
}

/** 时间轴时长（秒）：无片段时给一个可编辑的短默认值。 */
export function timelineDurationSec(project: Project): number {
  if (project.clips.length === 0) return 5
  return project.clips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
}

function withClips(project: Project, clips: SubtitleClip[]): Project {
  return { ...project, clips: [...clips].sort((a, b) => a.startTime - b.startTime) }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: createInitialProject(),
  selectedClipId: null,
  fonts: [],
  revision: 0,
  currentPath: null,

  loadProject: (project, path) =>
    set((state) => ({
      project,
      currentPath: path ?? null,
      selectedClipId: project.clips[0]?.id ?? null,
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
    // 换帧率时保持秒不变，重新吸附入出点（规格 §4.4：时间点跨帧率一致）
    const clips = state.project.clips.map((clip) => ({
      ...clip,
      startTime: snapTimeToFrame(clip.startTime, fps),
      endTime: snapTimeToFrame(clip.endTime, fps)
    }))
    set({ project: { ...state.project, fps, clips }, revision: state.revision + 1 })
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

  selectClip: (id) => set({ selectedClipId: id }),

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
      const next: SubtitleClip = { ...clip }
      if (patch.content) next.content = { ...clip.content, ...patch.content }
      if (patch.styleOverrides) next.styleOverrides = mergeOverrides(clip.styleOverrides, patch.styleOverrides)
      if (patch.fontId) next.fontId = patch.fontId
      if (patch.animation) next.animation = { ...clip.animation, ...patch.animation }
      if (patch.presetId) {
        next.presetId = patch.presetId
        // 预设自带节奏与字体角色：切预设时把动画回到预设声明值
        const preset = getPreset(patch.presetId as PresetId)
        next.animation = { ...preset.animation }
      }
      return next
    })
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
  }
}))

function mergeOverrides(base: StyleOverrides, patch: StyleOverrides): StyleOverrides {
  const next: StyleOverrides = { ...base }
  if (patch.tokens) next.tokens = { ...(base.tokens ?? {}), ...patch.tokens }
  if (patch.barOpacity !== undefined) next.barOpacity = patch.barOpacity
  if (patch.titleGradient) next.titleGradient = { ...base.titleGradient, ...patch.titleGradient }
  if (patch.subtitleGradient) next.subtitleGradient = { ...base.subtitleGradient, ...patch.subtitleGradient }
  if (patch.compact !== undefined) next.compact = patch.compact
  if (patch.fontScale) next.fontScale = { ...(base.fontScale ?? {}), ...patch.fontScale }
  return next
}

export function selectedClip(state: ProjectState): SubtitleClip | null {
  if (!state.selectedClipId) return null
  return state.project.clips.find((clip) => clip.id === state.selectedClipId) ?? null
}
