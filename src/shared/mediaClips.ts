import { MIN_MEDIA_CLIP_SEC } from './constants'
import { durationSecToFrames, frameTimeSec, snapTimeToFrame, timeToFrameFloor } from './fps'
import { sourceSecForTimelineSec, sourceTimeAt, speedValueOf } from './mediaClipAudio'
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
  const speed = speedValueOf(clip.speed)
  const left: MediaClip = {
    ...clip,
    timelineEndSec: cut,
    // v9：切点往源上投影时要乘上倍速（变速段的 1s 时间轴吃掉 speed 秒源内容）
    sourceOutSec: snapTimeToFrame(clip.sourceInSec + sourceSecForTimelineSec(speed, deltaSec), fps)
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

/** 时间轴秒 → 该 mediaClip 对应源文件的秒；不在任何段内时返回 null（v9：含倍速）。 */
export function sourceTimeOf(tracks: MediaClip[], atSec: number): { clip: MediaClip; sourceSec: number } | null {
  const clip = findActiveMediaClip(tracks, atSec)
  if (!clip) return null
  return { clip, sourceSec: sourceTimeAt(clip, atSec) }
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

/**
 * v7 多层：同一时刻取层号最大的一段（画面不透明，所以**上层直接盖住下层**）。
 * 同层重叠时取后开始的那条（后放上去的在上）。
 */
export function topActiveMediaClip(tracks: MediaClip[], atSec: number): MediaClip | null {
  let best: MediaClip | null = null
  for (const clip of tracks) {
    if (atSec < clip.timelineStartSec || atSec >= clip.timelineEndSec) continue
    if (!best) {
      best = clip
      continue
    }
    const layer = clip.layer ?? 0
    const bestLayer = best.layer ?? 0
    if (layer > bestLayer || (layer === bestLayer && clip.timelineStartSec >= best.timelineStartSec)) best = clip
  }
  return best
}

/**
 * v7 多层：把「带层号的时间轴」压成一条**互不重叠、按时间排序**的可见轨道。
 *
 * 导出侧的基座假设“段与段不重叠、按顺序 concat”，所以在进入滤镜链之前，
 * 必须先按层号把重叠段解开（逐个时间区间取上层），而不是把两段都塞进去。
 * 相邻的同一素材片段会合并回去，避免把一条片段切成很多路输入。
 */
export function resolveVisibleMediaClips(tracks: MediaClip[]): MediaClip[] {
  if (tracks.length <= 1) return sortMediaClips(tracks)
  const sorted = sortMediaClips(tracks)
  const bounds = [...new Set(sorted.flatMap((clip) => [clip.timelineStartSec, clip.timelineEndSec]))].sort((a, b) => a - b)
  const out: MediaClip[] = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i]!
    const to = bounds[i + 1]!
    if (to - from <= 1e-9) continue
    const covering = sorted.filter((clip) => clip.timelineStartSec <= from + 1e-9 && clip.timelineEndSec >= to - 1e-9)
    if (covering.length === 0) continue
    const winner = covering.reduce((best, clip) => ((clip.layer ?? 0) >= (best.layer ?? 0) ? clip : best))
    // v9：源坐标是时间轴坐标×倍速的投影（1x 时与旧写法完全一致）
    const speed = speedValueOf(winner.speed)
    const last = out[out.length - 1]
    if (last && last.mediaId === winner.mediaId && (last.layer ?? 0) === (winner.layer ?? 0) && Math.abs(last.timelineEndSec - from) < 1e-9) {
      const offset = to - winner.timelineStartSec
      last.timelineEndSec = to
      last.sourceOutSec = winner.sourceInSec + offset * speed
      continue
    }
    const shift = from - winner.timelineStartSec
    out.push({
      ...winner,
      timelineStartSec: from,
      timelineEndSec: to,
      sourceInSec: winner.sourceInSec + shift * speed,
      sourceOutSec: winner.sourceInSec + (to - winner.timelineStartSec) * speed
    })
  }
  return out
}

/**
 * 主轨对齐（snap-together）：按时间轴顺序从左到右**紧贴排列**，间隙恒为 0。
 *
 * - 顺序 = 当前的 timelineStartSec 升序（稳定排序，先后来的保持先后）；
 * - 时长不变（按帧数转移，不会因秒的舍入漂移）；
 * - 字幕轨不受影响——它本来就不在主轨上，允许留空。
 */
export function compactMediaClips(tracks: MediaClip[], fps: Fps): MediaClip[] {
  let cursorFrame = 0
  return sortMediaClips(tracks).map((clip) => {
    const startFrame = timeToFrameFloor(clip.timelineStartSec, fps)
    const endFrame = timeToFrameFloor(clip.timelineEndSec, fps)
    const durationFrames = Math.max(1, endFrame - startFrame)
    const start = frameToSec(cursorFrame, fps)
    const end = frameToSec(cursorFrame + durationFrames, fps)
    cursorFrame += durationFrames
    return {
      ...clip,
      timelineStartSec: start,
      timelineEndSec: end,
      // v9：时长不变，所以源窗口也不变（乘上倍速才是“吃掉多少源”）
      sourceOutSec: snapTimeToFrame(clip.sourceInSec + sourceSecForTimelineSec(speedValueOf(clip.speed), end - start), fps)
    }
  })
}
