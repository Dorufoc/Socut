import { MIN_MEDIA_CLIP_SEC } from './constants'
import { durationSecToFrames, frameTimeSec, snapTimeToFrame, timeToFrameFloor } from './fps'
import type { Fps, MediaClip } from './types'

/**
 * 媒体轨纯函数：拆分、重叠判定、右移对齐、时间↔源坐标换算。
 * 与 `SubtitleClip` 保持同口径：时间值以秒存储，写入前吸附到当前帧率的帧边界。
 */

export interface SplitResult {
  /** 左半段：起点不变，终点落在切分帧 */
  left: MediaClip
  /** 右半段：起点从切分帧开始，终点沿用原段 */
  right: MediaClip
}

/** 在 `atSec`（自动吸附帧边界）处拆分给定 MediaClip；若切点不在段内或剩余不足最短时长则返回 null。 */
export function splitMediaClipAt(
  clip: MediaClip,
  atSec: number,
  fps: Fps,
  newId: (source: MediaClip) => string
): SplitResult | null {
  const cut = snapTimeToFrame(atSec, fps)
  const leftMin = clip.timelineStartSec + MIN_MEDIA_CLIP_SEC
  const rightMin = clip.timelineEndSec - MIN_MEDIA_CLIP_SEC
  if (cut <= leftMin - 1e-9 || cut >= rightMin + 1e-9) return null
  const deltaSec = cut - clip.timelineStartSec
  const left: MediaClip = {
    ...clip,
    timelineEndSec: cut,
    sourceOutSec: snapTimeToFrame(clip.sourceInSec + deltaSec, fps)
  }
  const right: MediaClip = {
    ...clip,
    id: newId(clip),
    timelineStartSec: cut,
    sourceInSec: left.sourceOutSec
  }
  return { left, right }
}

/** 时间轴上两段的区间是否严格重叠（边界相接不算重叠）。 */
export function mediaClipsOverlap(a: MediaClip, b: MediaClip): boolean {
  return a.timelineStartSec < b.timelineEndSec - 1e-9 && b.timelineStartSec < a.timelineEndSec - 1e-9
}

/**
 * 纯谓词：atSec（自动吸附帧边界）处能不能拆。
 * 与 `splitMediaClipAt` 同一套判定（切点在段内且两半都不短于最短时长），
 * 供 UI 在渲染期算按钮禁用态，不去调有副作用的拆分动作。
 */
export function canSplitMediaClipAt(tracks: MediaClip[], atSec: number, fps: Fps): boolean {
  const clip = findActiveMediaClip(tracks, atSec)
  if (!clip) return false
  const cut = snapTimeToFrame(atSec, fps)
  return cut > clip.timelineStartSec + MIN_MEDIA_CLIP_SEC - 1e-9 && cut < clip.timelineEndSec - MIN_MEDIA_CLIP_SEC + 1e-9
}

/**
 * 「仅重叠才右移」的对齐：把 `tracks` 里 id 不等于 `anchorId` 且与新版右段重叠的片段起点推到锚段末尾，
 * 保持其时长不变；无重叠则原样返回。拆分与拖拽排序共用此函数。
 */
export function alignAfterOverlap(
  tracks: MediaClip[],
  anchor: MediaClip,
  fps: Fps
): MediaClip[] {
  return tracks.map((item) => {
    if (item.id === anchor.id) return item
    if (anchor.timelineEndSec <= item.timelineStartSec + 1e-9) return item
    const length = item.timelineEndSec - item.timelineStartSec
    const newStart = snapTimeToFrame(anchor.timelineEndSec, fps)
    const newEnd = snapTimeToFrame(newStart + length, fps)
    return {
      ...item,
      timelineStartSec: newStart,
      timelineEndSec: newEnd,
      // 源入出点与时间轴位移无关（时长不变），保持原值
      sourceInSec: item.sourceInSec,
      sourceOutSec: item.sourceOutSec
    }
  })
}

/**
 * 时间轴某一刻落在哪一段媒体片段上：为 `null` 表示当前帧不在任何 mediaClip 覆盖内。
 * 半开区间 `[timelineStartSec, timelineEndSec)`，相邻段不冲突。
 */
export function findActiveMediaClip(tracks: MediaClip[], atSec: number): MediaClip | null {
  for (const clip of tracks) {
    if (atSec >= clip.timelineStartSec - 1e-9 && atSec < clip.timelineEndSec - 1e-9) return clip
  }
  return null
}

/** 时间轴秒 → 该 mediaClip 对应源文件的秒；不在任何段内时返回 null。 */
export function sourceTimeOf(tracks: MediaClip[], atSec: number): { clip: MediaClip; sourceSec: number } | null {
  const clip = findActiveMediaClip(tracks, atSec)
  if (!clip) return null
  const offsetSec = Math.max(0, atSec - clip.timelineStartSec)
  return { clip, sourceSec: clip.sourceInSec + offsetSec }
}

/** 给定 mediaClips，返回按 timelineStartSec 升序排列的副本；不修改入参。 */
export function sortMediaClips(tracks: MediaClip[]): MediaClip[] {
  return [...tracks].sort((a, b) => a.timelineStartSec - b.timelineStartSec)
}

/**
 * 把 mediaClips 的时间轴覆盖折算为「导出所需帧区间」：
 * 与字幕轨 `activeStartFrame/activeEndFrame` 联立决定实际输出帧数。
 */
export function mediaSpanFrames(tracks: MediaClip[], fps: Fps): { startFrame: number; endFrame: number } {
  if (tracks.length === 0) return { startFrame: 0, endFrame: 0 }
  let minSec = Number.POSITIVE_INFINITY
  let maxSec = 0
  for (const clip of tracks) {
    if (clip.timelineStartSec < minSec) minSec = clip.timelineStartSec
    if (clip.timelineEndSec > maxSec) maxSec = clip.timelineEndSec
  }
  if (!Number.isFinite(minSec)) return { startFrame: 0, endFrame: 0 }
  return {
    startFrame: timeToFrameFloor(Math.max(0, minSec), fps),
    endFrame: durationSecToFrames(Math.max(0, maxSec), fps, 0)
  }
}

/** 帧序号 → 秒（拆分按钮显示用）。 */
export function frameToSec(frame: number, fps: Fps): number {
  return frameTimeSec(frame, fps)
}
