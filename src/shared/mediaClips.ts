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
 * 「仅重叠才右移」的对齐：把 `tracks` 里与锚段**真正重叠**且**同轨道**的片段依次推到锚段末尾，
 * 保持时长不变；不重叠、异轨、以及锚段自身都原样返回。拆分与拖拽共用此函数。
 *
 * 这里必须逐条判定重叠，不能只看「锚段末尾 > 片段起点」：
 * 那样会把所有起点更早的片段（包括完全不重叠的前置段、其它轨道的段）全部按到锚段末尾，
 * 表现为「拖一段，别的段集体跳到同一位置、总时长突然变长、整条轴被重新缩放」。
 */
export function alignAfterOverlap(
  tracks: MediaClip[],
  anchor: MediaClip,
  fps: Fps
): MediaClip[] {
  const anchorTrackId = anchor.trackId
  // 只处理锚段所在轨道里真正被压住的片段，并按起点顺序依次后移，避免它们全部堆到同一起点
  const pushed = tracks
    .filter(
      (item) =>
        item.id !== anchor.id &&
        item.trackId === anchorTrackId &&
        mediaClipsOverlap(item, anchor)
    )
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)

  if (pushed.length === 0) return tracks

  const shifted = new Map<string, MediaClip>()
  let cursorSec = anchor.timelineEndSec
  for (const item of pushed) {
    const length = item.timelineEndSec - item.timelineStartSec
    const newStart = snapTimeToFrame(cursorSec, fps)
    const newEnd = snapTimeToFrame(newStart + length, fps)
    shifted.set(item.id, {
      ...item,
      timelineStartSec: newStart,
      timelineEndSec: newEnd,
      // 源入出点与时间轴位移无关（时长不变），保持原值
      sourceInSec: item.sourceInSec,
      sourceOutSec: item.sourceOutSec
    })
    cursorSec = newEnd
  }

  return tracks.map((item) => shifted.get(item.id) ?? item)
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
 * v7 多层：同一时刻取**合成顺序最靠上**的一段（轨道索引最大；画面不透明，上层直接盖住下层）。
 * 同轨重叠时取后开始的那条（后放上去的在上）。
 *
 * `trackOrder` = 媒体轨 id → 数组索引（0 = 最底层），由 `tracks.ts / mediaTrackOrder` 生成。
 * 隐藏轨应在调用前从入参里剔除（预览/导出都只传可见轨的片段）。
 */
export function topActiveMediaClip(
  tracks: MediaClip[],
  atSec: number,
  trackOrder: ReadonlyMap<string, number>
): MediaClip | null {
  let best: MediaClip | null = null
  for (const clip of tracks) {
    if (atSec < clip.timelineStartSec || atSec >= clip.timelineEndSec) continue
    if (!best) {
      best = clip
      continue
    }
    const rank = trackOrder.get(clip.trackId) ?? -1
    const bestRank = trackOrder.get(best.trackId) ?? -1
    if (rank > bestRank || (rank === bestRank && clip.timelineStartSec >= best.timelineStartSec)) best = clip
  }
  return best
}

/**
 * v3 多轨导出：一段「被压平后」的可见音频区间（只用于内嵌原声，不影响画面分层）。
 * 源坐标已按区间裁剪并乘上倍速。
 */
export interface ActiveMediaClipSpan {
  clip: MediaClip
  timelineStartSec: number
  timelineEndSec: number
  sourceInSec: number
  sourceOutSec: number
}

/**
 * v3 多轨导出的内嵌原声压平：按 `topActiveMediaClip` 的「取最上层」规则，
 * 把 [spanStartSec, spanEndSec] 切成互不重叠的区间，每段只保留**当前时刻最上层**的那条片段。
 *
 * 调用前应剔除隐藏/静音轨上的片段：静音轨不能通过“下层补声”泄漏出来。
 * 相邻且同一条片段的区间会合并，避免把一条片段拆成很多路音频输入。
 */
export function activeMediaClipSpans(
  clips: MediaClip[],
  trackOrder: ReadonlyMap<string, number>,
  spanStartSec: number,
  spanEndSec: number
): ActiveMediaClipSpan[] {
  if (clips.length === 0 || spanEndSec - spanStartSec <= 1e-9) return []
  const bounds = new Set<number>([spanStartSec, spanEndSec])
  for (const clip of clips) {
    const from = Math.max(clip.timelineStartSec, spanStartSec)
    const to = Math.min(clip.timelineEndSec, spanEndSec)
    if (to - from > 1e-9) {
      bounds.add(from)
      bounds.add(to)
    }
  }
  const sorted = [...bounds].sort((a, b) => a - b)
  const out: ActiveMediaClipSpan[] = []
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i]!
    const to = sorted[i + 1]!
    if (to - from <= 1e-9) continue
    const winner = topActiveMediaClip(clips, (from + to) / 2, trackOrder)
    if (!winner) continue
    const speed = speedValueOf(winner.speed)
    const sourceInSec = winner.sourceInSec + (from - winner.timelineStartSec) * speed
    const sourceOutSec = winner.sourceInSec + (to - winner.timelineStartSec) * speed
    const last = out[out.length - 1]
    if (last && last.clip.id === winner.id && Math.abs(last.timelineEndSec - from) < 1e-9) {
      last.timelineEndSec = to
      last.sourceOutSec = sourceOutSec
      continue
    }
    out.push({ clip: winner, timelineStartSec: from, timelineEndSec: to, sourceInSec, sourceOutSec })
  }
  return out
}

/**
 * v7 多层：把「带层号的时间轴」压成一条**互不重叠、按时间排序**的可见轨道。
 *
 * 导出侧的基座假设“段与段不重叠、按顺序 concat”，所以在进入滤镜链之前，
 * 必须先按层号把重叠段解开（逐个时间区间取上层），而不是把两段都塞进去。
 * 相邻的同一素材片段会合并回去，避免把一条片段切成很多路输入。
 */
export function resolveVisibleMediaClips(
  tracks: MediaClip[],
  trackOrder: ReadonlyMap<string, number>
): MediaClip[] {
  if (tracks.length <= 1) return sortMediaClips(tracks)
  const sorted = sortMediaClips(tracks)
  const bounds = [...new Set(sorted.flatMap((clip) => [clip.timelineStartSec, clip.timelineEndSec]))].sort((a, b) => a - b)
  const rankOf = (clip: MediaClip): number => trackOrder.get(clip.trackId) ?? -1
  const out: MediaClip[] = []
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i]!
    const to = bounds[i + 1]!
    if (to - from <= 1e-9) continue
    const covering = sorted.filter((clip) => clip.timelineStartSec <= from + 1e-9 && clip.timelineEndSec >= to - 1e-9)
    if (covering.length === 0) continue
    const winner = covering.reduce((best, clip) => (rankOf(clip) >= rankOf(best) ? clip : best))
    // v9：源坐标是时间轴坐标×倍速的投影（1x 时与旧写法完全一致）
    const speed = speedValueOf(winner.speed)
    const last = out[out.length - 1]
    if (last && last.mediaId === winner.mediaId && last.trackId === winner.trackId && Math.abs(last.timelineEndSec - from) < 1e-9) {
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
 * 主轨对齐（snap-together）：**每条轨道各自**按时间轴顺序从左到右紧贴排列，间隙恒为 0。
 *
 * - 只和同一 trackId 的片段排队（不同轨道是独立车道，不能互相挤走）；
 * - 顺序 = 当前的 timelineStartSec 升序（稳定排序，先后来的保持先后）；
 * - 时长不变（按帧数转移，不会因秒的舍入漂移）；
 * - 字幕轨不受影响——它本来就不在主轨上，允许留空。
 */
export function compactMediaClips(tracks: MediaClip[], fps: Fps): MediaClip[] {
  const groups = new Map<string, MediaClip[]>()
  for (const clip of tracks) {
    const group = groups.get(clip.trackId)
    if (group) group.push(clip)
    else groups.set(clip.trackId, [clip])
  }
  const out: MediaClip[] = []
  for (const group of groups.values()) {
    let cursorFrame = 0
    for (const clip of sortMediaClips(group)) {
      const startFrame = timeToFrameFloor(clip.timelineStartSec, fps)
      const endFrame = timeToFrameFloor(clip.timelineEndSec, fps)
      const durationFrames = Math.max(1, endFrame - startFrame)
      const start = frameToSec(cursorFrame, fps)
      const end = frameToSec(cursorFrame + durationFrames, fps)
      cursorFrame += durationFrames
      out.push({
        ...clip,
        timelineStartSec: start,
        timelineEndSec: end,
        // v9：时长不变，所以源窗口也不变（乘上倍速才是“吃掉多少源”）
        sourceOutSec: snapTimeToFrame(clip.sourceInSec + sourceSecForTimelineSec(speedValueOf(clip.speed), end - start), fps)
      })
    }
  }
  return sortMediaClips(out)
}
