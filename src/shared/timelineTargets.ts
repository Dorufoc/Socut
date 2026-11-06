import type { AudioClip, MediaClip, SubtitleClip } from './types'

/**
 * 时间轴工具栏的「这一刀/这一下删的是谁」（P3）。
 *
 * 规则（用户明确要求）：
 * 1. 拆分与删除都作用于**当前选中的段**——字幕条、媒体段、音频段三类都算；
 * 2. 没有任何选中时，默认落到**媒体轨**里播放头所覆盖的那一段，
 *    媒体轨叠多层时取最下面那一层（层号最大：它画在该轨最下的 lane，视觉上也盖在别人上面）；
 * 3. 连这一段都没有就返回 null，由 UI 提示「没有」，而不是静默什么也不做。
 *
 * 单独成文件而不是塞进 `mediaClips`：跨三条轨的选择语义不属于任何一条轨自己的规则，
 * 而且导出侧永远不该用它（导出只按时间合成，没有「选中」概念）。
 */

export type TimelineTrackKind = 'subtitle' | 'media' | 'audio'

export interface TimelineTracks {
  clips: SubtitleClip[]
  mediaClips: MediaClip[]
  audioClips: AudioClip[]
}

export interface TimelineSelection {
  clipId: string | null
  mediaClipId: string | null
  audioClipId: string | null
  /** 最后一次点选的类型：三个选中 id 可以并存，只有它决定「现在操作的是谁」 */
  kind: TimelineTrackKind
}

export interface TargetRef {
  kind: TimelineTrackKind
  id: string
}

/** 播放头是否落在这一段里：出点是开区间（与 `findActiveMediaClip` 同一口径） */
function covers(startSec: number, endSec: number, atSec: number): boolean {
  return atSec >= startSec - 1e-9 && atSec < endSec - 1e-9
}

/** 媒体轨在 `atSec` 处覆盖到的段中取最下面那一层（层号最大；同层取靠后的那条） */
export function findBottomMediaClipAt(mediaClips: MediaClip[], atSec: number): MediaClip | null {
  let best: MediaClip | null = null
  for (const clip of mediaClips) {
    if (!covers(clip.timelineStartSec, clip.timelineEndSec, atSec)) continue
    if (!best || (clip.layer ?? 0) >= (best.layer ?? 0)) best = clip
  }
  return best
}

/** 选中的那一段（选中类型指向的 id 必须还活在轨上，否则不算选中）。 */
export function findSelectedRef(tracks: TimelineTracks, selection: TimelineSelection): TargetRef | null {
  if (selection.kind === 'subtitle') {
    return selection.clipId && tracks.clips.some((clip) => clip.id === selection.clipId)
      ? { kind: 'subtitle', id: selection.clipId }
      : null
  }
  if (selection.kind === 'media') {
    return selection.mediaClipId && tracks.mediaClips.some((clip) => clip.id === selection.mediaClipId)
      ? { kind: 'media', id: selection.mediaClipId }
      : null
  }
  return selection.audioClipId && tracks.audioClips.some((clip) => clip.id === selection.audioClipId)
    ? { kind: 'audio', id: selection.audioClipId }
    : null
}

/** 拆分/删除的目标段：选中优先，其次播放头处的媒体轨最下层，都没有返回 null。 */
export function resolveTargetAt(
  tracks: TimelineTracks,
  selection: TimelineSelection,
  atSec: number
): TargetRef | null {
  const selected = findSelectedRef(tracks, selection)
  if (selected) return selected
  const fallback = findBottomMediaClipAt(tracks.mediaClips, atSec)
  return fallback ? { kind: 'media', id: fallback.id } : null
}
