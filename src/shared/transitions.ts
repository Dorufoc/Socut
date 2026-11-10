import { TRANSITION_DURATION } from './constants'
import { durationSecToFrames, frameIntervalSec, framesToDurationSec, snapTimeToFrame } from './fps'
import { inferMediaKind } from './audioClips'
import { speedValueOf } from './mediaClipAudio'
import type { Fps, MediaClip, MediaKind, Project, TransitionFamily, TransitionType } from './types'
import {
  TRANSITION_CATALOG,
  TRANSITION_FAMILIES as CATALOG_FAMILIES,
  TRANSITION_FAMILY_LABELS
} from './transitionCatalog'

import type { TransitionMeta } from './transitionCatalog'
export type { TransitionMeta } from './transitionCatalog'

/**
 * 转场（v10 / M7-E）纯口径：58 种 xfade 成片转场 → `xfade` 原语、中文名、族与方向。
 *
 * 设计纪律：
 * - **类型/元数据真值在 `transitionCatalog.ts`**；UI、时间轴标记与导出计划都读同一份。
 * - 数据落在切点**右侧片段**的 `transitionIn` 上；左侧 = 同轨、时间上紧邻的前一段。
 * - 时长居中跨切点（切点两侧各 T/2），吸附帧；手柄不足时按「前段尾 / 后段头 × 各自倍速」
 *   夹取，夹后不足 2 帧就不生效。
 * - 本文件不 import Node / Electron / DOM，主进程、渲染进程与测试共用。
 */

/** 族顺序 = 检查器网格的分组顺序（来自目录文件，保证唯一真值）。 */
export const TRANSITION_FAMILIES: readonly TransitionFamily[] = CATALOG_FAMILIES

export { TRANSITION_FAMILY_LABELS }

/** 59 条目录：58 个唯一 xfade + `blurV` 旧工程别名（顺序与目录声明一致）。 */
export const TRANSITIONS: TransitionMeta[] = [...TRANSITION_CATALOG]

export const TRANSITION_MAP: Record<TransitionType, TransitionMeta> = Object.fromEntries(
  TRANSITIONS.map((meta) => [meta.type, meta])
) as Record<TransitionType, TransitionMeta>

export interface TransitionFamilyGroup {
  family: TransitionFamily
  label: string
  transitions: TransitionMeta[]
}

/** 检查器分组网格的输入：族顺序固定，组内保持 TRANSITIONS 声明顺序。 */
export function transitionsByFamily(): TransitionFamilyGroup[] {
  return TRANSITION_FAMILIES.map((family) => ({
    family,
    label: TRANSITION_FAMILY_LABELS[family],
    transitions: TRANSITIONS.filter((meta) => meta.family === family)
  }))
}

export const DEFAULT_TRANSITION_DURATION_SEC: number = TRANSITION_DURATION.default

/** 素材元数据里与转场手柄有关的最小集合（图像 = 无限手柄）。 */
export interface TransitionMediaMeta {
  durationSec: number
  kind?: MediaKind
}

/**
 * 从工程里取某片段的素材元数据；素材缺失返回 null（按无手柄处理）。
 * `kind` 走与 UI 同一个 `inferMediaKind`，旧工程缺 `kind` 时也不会把图像判成视频。
 */
export function transitionMediaMetaOf(project: Project, clip: MediaClip | null): TransitionMediaMeta | null {
  if (!clip) return null
  const item = project.media.find((media) => media.id === clip.mediaId)
  if (!item) return null
  return { durationSec: item.meta.durationSec, kind: inferMediaKind(item.path, item.meta) }
}

/**
 * 同轨、按时间排序后的**紧邻前一段**；首段（或片段不在数组里）返回 null。
 * 只比较同一条媒体轨，跨轨不成立。
 */
export function previousMediaClipOnTrack(clips: readonly MediaClip[], clip: MediaClip): MediaClip | null {
  const sorted = clips
    .filter((item) => item.trackId === clip.trackId)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const index = sorted.findIndex((item) => item.id === clip.id)
  if (index <= 0) return null
  return sorted[index - 1] ?? null
}

/** 前段尾与后段头之间的时间轴空隙（0 = 紧贴；正常裁剪不应出现负值）。 */
export function transitionGapSec(prev: MediaClip, clip: MediaClip): number {
  return clip.timelineStartSec - prev.timelineEndSec
}

/** 「紧邻」容差 = 半帧：吸附后的切点允许落在半帧以内。 */
export function isTransitionAdjacent(prev: MediaClip, clip: MediaClip, fps: Fps): boolean {
  return Math.abs(transitionGapSec(prev, clip)) <= frameIntervalSec(fps) / 2 + 1e-9
}

export interface TransitionHandleInput {
  /** null = 首段，必然不可用 */
  prev: MediaClip | null
  clip: MediaClip
  prevMeta?: TransitionMediaMeta | null
  clipMeta?: TransitionMediaMeta | null
  /** 显式请求时长（类型点击时用）；缺省取片段当前时长 */
  requestedSec?: number
  fps: Fps
}

export type TransitionBlockReason = 'first' | 'gap' | 'no-type' | 'too-short' | 'no-tail' | 'no-head'

export type TransitionResolution =
  | { ok: true; durationSec: number; requestedSec: number; reason: null }
  | { ok: false; durationSec: 0; requestedSec: number; reason: TransitionBlockReason }

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function durationOf(clip: MediaClip): number {
  return Math.max(0, clip.timelineEndSec - clip.timelineStartSec)
}

/** 前段尾部可用的**时间轴**秒数（源手柄除以前段倍速）；图像 = 无限。 */
export function timelineTailSec(prev: MediaClip | null, prevMeta: TransitionMediaMeta | null | undefined): number {
  if (!prev) return 0
  if (prevMeta?.kind === 'image') return Number.POSITIVE_INFINITY
  const sourceTail = Math.max(0, (prevMeta?.durationSec ?? 0) - prev.sourceOutSec)
  return sourceTail / speedValueOf(prev.speed)
}

/** 后段头部可用的**时间轴**秒数（源入点除以本段倍速）；图像 = 无限。 */
export function timelineHeadSec(clip: MediaClip, clipMeta: TransitionMediaMeta | null | undefined): number {
  if (clipMeta?.kind === 'image') return Number.POSITIVE_INFINITY
  return Math.max(0, clip.sourceInSec) / speedValueOf(clip.speed)
}

/**
 * 手柄与片段时长决定的最大转场时长（原始秒，未吸附帧、未夹到 0.2–1.5）。
 * 检查器在「手柄不足」时用它显示可用值；导出计划（Task 7）也会复用同一口径。
 */
export function transitionMaxDurationSec(input: TransitionHandleInput): number {
  const prevDuration = input.prev ? durationOf(input.prev) : 0
  const clipDuration = durationOf(input.clip)
  return Math.min(
    TRANSITION_DURATION.max,
    prevDuration,
    clipDuration,
    2 * timelineTailSec(input.prev, input.prevMeta),
    2 * timelineHeadSec(input.clip, input.clipMeta)
  )
}

/**
 * 把请求时长夹到「片段时长 + 手柄 + 每条边 T/2」允许的最大值，再吸附帧。
 *
 * 长边口径：
 * - 前段尾部手柄 = `源素材时长 - sourceOut`，时间轴 = 源手柄 / 前段倍速；
 * - 后段头部手柄 = `sourceIn`，时间轴 = 源手柄 / 本段倍速；
 * - 图像两侧都视为无限；
 * - 转场窗口居中跨切点，所以任一边最多吃 T/2。
 */
export function resolveTransitionDuration(input: TransitionHandleInput): TransitionResolution {
  const current = input.clip.transitionIn
  const hasRequested = input.requestedSec !== undefined || current !== undefined
  const requestedSec = clamp(
    input.requestedSec ?? current?.durationSec ?? DEFAULT_TRANSITION_DURATION_SEC,
    TRANSITION_DURATION.min,
    TRANSITION_DURATION.max
  )

  const fail = (reason: TransitionBlockReason): TransitionResolution => ({
    ok: false,
    durationSec: 0,
    requestedSec,
    reason
  })

  // 原因优先级：first → gap → no-type → no-tail/no-head → too-short
  if (!input.prev) return fail('first')
  if (!isTransitionAdjacent(input.prev, input.clip, input.fps)) return fail('gap')
  if (!hasRequested) return fail('no-type')

  const tail = timelineTailSec(input.prev, input.prevMeta)
  const head = timelineHeadSec(input.clip, input.clipMeta)
  const limit = transitionMaxDurationSec(input)

  if (limit < TRANSITION_DURATION.min - 1e-9) {
    if (tail < TRANSITION_DURATION.min / 2 - 1e-9) return fail('no-tail')
    if (head < TRANSITION_DURATION.min / 2 - 1e-9) return fail('no-head')
    return fail('too-short')
  }

  const target = Math.min(requestedSec, limit)
  let durationSec = snapTimeToFrame(target, input.fps)
  // 就近吸附可能略超手柄；超出不足一帧时按帧量化接受，明显超出则向下取整，
  // 保证「手柄不足时不会静默吃进相邻内容」。
  if (durationSec > limit + 1e-9) {
    const interval = frameIntervalSec(input.fps)
    if (durationSec - limit > interval / 2 + 1e-9) {
      const flooredFrames = Math.floor(limit / interval + 1e-9)
      const floored = framesToDurationSec(flooredFrames, input.fps)
      if (floored >= TRANSITION_DURATION.min - 1e-9) durationSec = floored
    }
  }
  const maxFrames = Math.floor((TRANSITION_DURATION.max * input.fps.num) / input.fps.den + 1e-9)
  const frames = Math.min(durationSecToFrames(durationSec, input.fps, 0), maxFrames)
  if (frames < TRANSITION_DURATION.minFrames) return fail('too-short')

  return { ok: true, durationSec: framesToDurationSec(frames, input.fps), requestedSec, reason: null }
}

/** 转场窗口：居中跨切点，`[切点 - T/2, 切点 + T/2]`。 */
export function transitionWindow(
  _prev: MediaClip | null,
  clip: MediaClip,
  durationSec: number
): { startSec: number; endSec: number; cutSec: number } {
  const cutSec = clip.timelineStartSec
  const half = Math.max(0, durationSec) / 2
  return { startSec: cutSec - half, endSec: cutSec + half, cutSec }
}

/** 时相进度：窗口起点 0、切点 0.5、窗口终点 1；窗口外夹到两端。 */
export function transitionProgressAt(atSec: number, cutSec: number, durationSec: number): number {
  const duration = Math.max(0, durationSec)
  if (duration <= 1e-9) return 0
  const start = cutSec - duration / 2
  return clamp((atSec - start) / duration, 0, 1)
}

/** 把一条转场时长按「不超过半段」夹小；不足 2 帧 / 0.2s 时返回 null。 */
function halfClampSec(value: number, halfLimit: number, fps: Fps): number | null {
  if (!(halfLimit > 1e-9)) return null
  const frames = Math.floor((halfLimit * fps.num) / fps.den + 1e-9)
  if (frames < TRANSITION_DURATION.minFrames) return null
  const sec = framesToDurationSec(frames, fps)
  if (sec < TRANSITION_DURATION.min - 1e-9) return null
  return Math.min(value, sec)
}

/**
 * 清理失效转场（move / trim / split / remove / compact 后调用）：
 * 1. 没有同轨前段、不再紧邻、或手柄/时长解析失败 → 删除 `transitionIn`；
 * 2. 手柄变化后时长被夹小 → 写回解析值；
 * 3. 相邻两个转场同时超过共享片段的一半 → 当前一侧夹到半段（导出计划在 Task 7 细化）。
 *
 * 返回工程本身或新对象（无变化时保持原引用，方便调用方判断是否真的要写 revision）。
 */
export function cleanupInvalidTransitions(project: Project, fps: Fps): Project {
  const withTransition = project.mediaClips.filter((clip) => clip.transitionIn !== undefined)
  if (withTransition.length === 0) return project

  let changed = false
  let mediaClips = project.mediaClips.map((clip) => {
    if (!clip.transitionIn) return clip
    const prev = previousMediaClipOnTrack(project.mediaClips, clip)
    const resolution = resolveTransitionDuration({
      prev,
      clip,
      prevMeta: transitionMediaMetaOf(project, prev),
      clipMeta: transitionMediaMetaOf(project, clip),
      requestedSec: clip.transitionIn.durationSec,
      fps
    })
    if (!resolution.ok) {
      changed = true
      const next: MediaClip = { ...clip }
      delete next.transitionIn
      return next
    }
    if (Math.abs(resolution.durationSec - clip.transitionIn.durationSec) > 1e-9) {
      changed = true
      return { ...clip, transitionIn: { ...clip.transitionIn, durationSec: resolution.durationSec } }
    }
    return clip
  })

  // 共享片段的前后两个转场都超过半段时，把当前一侧夹到半段，避免两个窗口在片段中间重叠。
  const byTrack = new Map<string, MediaClip[]>()
  for (const clip of mediaClips) {
    const group = byTrack.get(clip.trackId)
    if (group) group.push(clip)
    else byTrack.set(clip.trackId, [clip])
  }
  const nextById = new Map<string, MediaClip>()
  for (const group of byTrack.values()) {
    const sorted = [...group].sort((a, b) => a.timelineStartSec - b.timelineStartSec)
    sorted.forEach((clip, index) => {
      if (!clip.transitionIn) return
      const prev = index > 0 ? sorted[index - 1] : null
      const next = index + 1 < sorted.length ? sorted[index + 1] : null
      let value = clip.transitionIn.durationSec
      const prevDuration = prev ? durationOf(prev) : 0
      const clipDuration = durationOf(clip)
      if (prev?.transitionIn && prev.transitionIn.durationSec > prevDuration / 2 + 1e-9 && value > prevDuration / 2 + 1e-9) {
        const clamped = halfClampSec(value, prevDuration / 2, fps)
        if (clamped !== null && clamped < value) value = clamped
      }
      if (next?.transitionIn && next.transitionIn.durationSec > clipDuration / 2 + 1e-9 && value > clipDuration / 2 + 1e-9) {
        const clamped = halfClampSec(value, clipDuration / 2, fps)
        if (clamped !== null && clamped < value) value = clamped
      }
      if (Math.abs(value - clip.transitionIn.durationSec) > 1e-9) {
        changed = true
        nextById.set(clip.id, { ...clip, transitionIn: { ...clip.transitionIn, durationSec: value } })
      }
    })
  }
  if (nextById.size > 0) mediaClips = mediaClips.map((clip) => nextById.get(clip.id) ?? clip)

  return changed ? { ...project, mediaClips } : project
}

// ---------------------------------------------------------------------------
// v10（Task 7）：转场导出计划
// ---------------------------------------------------------------------------

/**
 * 导出计划的最小输入：一段同轨媒体 + 它的输入序号与素材元数据。
 * `index` 是整体 `-i` 顺序里的输入下标（滤镜图里的 `[index:v]`）。
 */
export interface TransitionExportInputSegment {
  index: number
  clip: MediaClip
  meta: TransitionMediaMeta | null
}

export interface TransitionExportSegmentPlan {
  index: number
  clipId: string
  coreStartSec: number
  coreEndSec: number
  coreDurationSec: number
  speed: number
  /** 时间轴秒：入场转场占用的头部手柄（= T/2） */
  headHandleSec: number
  /** 时间轴秒：出场转场占用的尾部手柄（= T/2） */
  tailHandleSec: number
  /** 扩展后的源区间（视频夹到素材长度；图像可超出） */
  sourceInExtSec: number
  sourceOutExtSec: number
  /** 入场转场（相对 run 起点的 xfade offset） */
  transition?: {
    type: TransitionType
    xfade: string
    durationSec: number
    offsetInRunSec: number
  }
  runIndex: number
}

export interface TransitionExportRunPlan {
  runIndex: number
  startSec: number
  endSec: number
  segments: TransitionExportSegmentPlan[]
}

export interface TransitionExportPlan {
  runs: TransitionExportRunPlan[]
  hasTransitions: boolean
}

function buildTransitionRun(
  group: TransitionExportInputSegment[],
  runIndex: number,
  fps: Fps
): TransitionExportRunPlan {
  const startSec = group[0]?.clip.timelineStartSec ?? 0
  const plans: TransitionExportSegmentPlan[] = group.map((entry) => {
    const clip = entry.clip
    return {
      index: entry.index,
      clipId: clip.id,
      coreStartSec: clip.timelineStartSec,
      coreEndSec: clip.timelineEndSec,
      coreDurationSec: Math.max(0, clip.timelineEndSec - clip.timelineStartSec),
      speed: speedValueOf(clip.speed),
      headHandleSec: 0,
      tailHandleSec: 0,
      sourceInExtSec: clip.sourceInSec,
      sourceOutExtSec: clip.sourceOutSec,
      runIndex
    }
  })

  // 每对相邻片段：右侧的 transitionIn 决定一个居中跨切点的窗口。
  // 手柄上限直接用共享的 timelineHead/TailSec（与检查器/清理同一口径），
  // 取整到帧后再回写 T，避免「吸附后略超手柄」。
  for (let i = 1; i < group.length; i += 1) {
    const prevEntry = group[i - 1]!
    const entry = group[i]!
    const plan = plans[i]!
    const clip = entry.clip
    if (!clip.transitionIn) continue
    const resolution = resolveTransitionDuration({
      prev: prevEntry.clip,
      clip,
      prevMeta: prevEntry.meta,
      clipMeta: entry.meta,
      requestedSec: clip.transitionIn.durationSec,
      fps
    })
    if (!resolution.ok) continue

    const headLimit = timelineHeadSec(clip, entry.meta)
    const tailLimit = timelineTailSec(prevEntry.clip, prevEntry.meta)
    const limit = Math.min(resolution.durationSec, 2 * headLimit, 2 * tailLimit)
    if (!(limit > 1e-9)) continue
    const frames = Math.floor((limit * fps.num) / fps.den + 1e-9)
    if (frames < TRANSITION_DURATION.minFrames) continue
    const durationSec = framesToDurationSec(frames, fps)
    if (durationSec < TRANSITION_DURATION.min - 1e-9) continue

    plan.headHandleSec = durationSec / 2
    plans[i - 1]!.tailHandleSec = durationSec / 2
    plan.transition = {
      type: clip.transitionIn.type,
      xfade: TRANSITION_MAP[clip.transitionIn.type].xfade,
      durationSec,
      offsetInRunSec: clip.timelineStartSec - startSec - durationSec / 2
    }
  }

  let totalCore = 0
  for (const [i, plan] of plans.entries()) {
    const entry = group[i]!
    const isImage = entry.meta?.kind === 'image'
    const headSource = plan.headHandleSec * plan.speed
    const tailSource = plan.tailHandleSec * plan.speed
    if (isImage) {
      // 图像 = 无限手柄：源窗口可以超出素材时长；缺的头部由 `-loop` 撑出，
      // 但要保证「扩展源长度 / 倍速 = core + head + tail」，xfade 链才对得齐。
      const sourceInExt = Math.max(0, entry.clip.sourceInSec - headSource)
      plan.sourceInExtSec = sourceInExt
      plan.sourceOutExtSec = sourceInExt + (plan.coreDurationSec + plan.headHandleSec + plan.tailHandleSec) * plan.speed
    } else {
      const sourceDuration = entry.meta?.durationSec ?? 0
      plan.sourceInExtSec = Math.max(0, entry.clip.sourceInSec - headSource)
      plan.sourceOutExtSec = Math.min(sourceDuration, entry.clip.sourceOutSec + tailSource)
    }
    totalCore += plan.coreDurationSec
  }

  return { runIndex, startSec, endSec: startSec + totalCore, segments: plans }
}

/**
 * 单轨转场导出计划：按「相邻段（空隙 ≤ 半帧）」分组为 run，
 * 每段给出扩展源手柄、xfade offset 与音频仍用的核心源区间。
 *
 * 总时长恒等式：`Σ(扩展链长) - ΣT = ΣcoreDuration` —— 头部/尾部手柄互相抵消，
 * 所以 xfade 不会改变成片总时长（音频按核心 concat 也只占 ΣcoreDuration）。
 */
export function planTransitionExport(input: {
  /** 同一条轨上的片段（调用方按时间顺序给出；这里再排一次保险） */
  segments: TransitionExportInputSegment[]
  fps: Fps
}): TransitionExportPlan {
  const ordered = [...input.segments].sort(
    (a, b) => a.clip.timelineStartSec - b.clip.timelineStartSec || a.index - b.index
  )
  const runs: TransitionExportRunPlan[] = []
  const halfFrame = frameIntervalSec(input.fps) / 2 + 1e-9
  let group: TransitionExportInputSegment[] = []
  for (const entry of ordered) {
    if (group.length > 0) {
      const prev = group[group.length - 1]!
      const gap = entry.clip.timelineStartSec - prev.clip.timelineEndSec
      if (gap > halfFrame) {
        runs.push(buildTransitionRun(group, runs.length, input.fps))
        group = []
      }
    }
    group.push(entry)
  }
  if (group.length > 0) runs.push(buildTransitionRun(group, runs.length, input.fps))
  return {
    runs,
    hasTransitions: runs.some((run) => run.segments.some((segment) => segment.transition !== undefined))
  }
}
