import { SUBTITLE_TRACK_ID, TRACK_SOFT_LIMIT } from './constants'
import type {
  AudioClip,
  AudioTrack,
  MediaClip,
  MediaTrack,
  SubtitleClip,
  SubtitleTrack,
  Track
} from './types'

/**
 * 多轨道（PR / 达芬奇 / 剪映式）纯逻辑。
 *
 * 两条硬规则：
 * 1. **数组顺序 = 合成顺序**：索引 0 是最底层，索引越大越靠上。
 *    时间轴 UI 渲染时整体反转（第一行 = 最上层），合成器则按索引升序从底往上叠。
 * 2. **字幕轨不在数组里**：它固定一条、恒覆盖在所有画面之上，所以没有增删/排序。
 *
 * 本文件只做纯函数（不改入参、不碰 store），主进程 / 渲染进程 / 测试共用。
 */

export const MEDIA_TRACK_ID_PREFIX = 'track-media-'
export const AUDIO_TRACK_ID_PREFIX = 'track-audio-'

export interface TrackPatch {
  name?: string
  muted?: boolean
  hidden?: boolean
  locked?: boolean
}

function flags(patch: TrackPatch): Pick<MediaTrack, 'muted' | 'hidden' | 'locked'> {
  return {
    muted: patch.muted ?? false,
    hidden: patch.hidden ?? false,
    locked: patch.locked ?? false
  }
}

/**
 * 造一条媒体轨。`index` 同时作为默认 id 与显示名序号：
 * 迁移旧工程时按历史层号 0..max 逐条生成，保证 deterministic（同一份旧工程每次迁移结果一致）。
 */
export function makeMediaTrack(index: number, patch: TrackPatch = {}): MediaTrack {
  return {
    id: `${MEDIA_TRACK_ID_PREFIX}${index}`,
    kind: 'media',
    name: patch.name ?? `媒体 ${index + 1}`,
    ...flags(patch)
  }
}

/** 造一条音频轨（同 makeMediaTrack 的口径）。 */
export function makeAudioTrack(index: number, patch: TrackPatch = {}): AudioTrack {
  return {
    id: `${AUDIO_TRACK_ID_PREFIX}${index}`,
    kind: 'audio',
    name: patch.name ?? `音频 ${index + 1}`,
    ...flags(patch)
  }
}

/** 造字幕轨：id 固定，永远只有一条。 */
export function makeSubtitleTrack(patch: TrackPatch = {}): SubtitleTrack {
  return {
    id: SUBTITLE_TRACK_ID,
    kind: 'subtitle',
    name: patch.name ?? '字幕',
    ...flags(patch)
  }
}

/** 撤销一次 mapById 结果里的空操作：没有任何轨道被改时返回原数组（便于 store 跳过写 revision）。 */
function mapById<T extends Track>(tracks: T[], id: string, fn: (track: T) => T): T[] {
  let changed = false
  const next = tracks.map((track) => {
    if (track.id !== id) return track
    const updated = fn(track)
    if (updated !== track) changed = true
    return updated
  })
  return changed ? next : tracks
}

export function trackById<T extends Track>(tracks: readonly T[], id: string | null | undefined): T | undefined {
  if (!id) return undefined
  return tracks.find((track) => track.id === id)
}

export function trackIndexOf(tracks: readonly Track[], id: string | null | undefined): number {
  if (!id) return -1
  return tracks.findIndex((track) => track.id === id)
}

/**
 * UI 用顺序：整体反转。
 * 数组是「底 → 顶」，而时间轴上第一行必须是**最上层**（PR/剪映的视觉习惯），
 * 所以 UI 只拿这一份反转副本，别再自己 reverse（两次反转等于没转）。
 */
export function topFirst<T>(tracks: readonly T[]): T[] {
  return [...tracks].reverse()
}

/** 参与画面合成的轨道，按**绘制顺序**（底层 → 顶层）；隐藏轨被剔除。 */
export function visibleMediaTracks(tracks: readonly MediaTrack[]): MediaTrack[] {
  return tracks.filter((track) => !track.hidden)
}

/** 参与混音的轨道；静音轨被剔除。 */
export function audibleAudioTracks(tracks: readonly AudioTrack[]): AudioTrack[] {
  return tracks.filter((track) => !track.muted)
}

/** 该媒体轨上的片段（保持工程里的时间顺序）。 */
export function clipsOnMediaTrack(clips: readonly MediaClip[], trackId: string): MediaClip[] {
  return clips.filter((clip) => clip.trackId === trackId)
}

/** 该音频轨上的片段。 */
export function clipsOnAudioTrack(clips: readonly AudioClip[], trackId: string): AudioClip[] {
  return clips.filter((clip) => clip.trackId === trackId)
}

/** 该字幕轨上的片段（只有一条字幕轨，等价于全部字幕条）。 */
export function clipsOnSubtitleTrack(clips: readonly SubtitleClip[]): SubtitleClip[] {
  return [...clips]
}

export function isTrackLocked(track: Track | undefined): boolean {
  return track?.locked === true
}

/** 找下一个未被占用的 id 序号：删掉中间轨后再新增不会撞 id。 */
export function nextTrackNumber(tracks: readonly Track[]): number {
  let max = -1
  for (const track of tracks) {
    const match = /-(\d+)$/.exec(track.id)
    if (!match) continue
    const value = Number(match[1])
    if (Number.isFinite(value)) max = Math.max(max, value)
  }
  return max + 1
}

/** 找下一个未被占用的显示名序号（删轨后不留“媒体 2”空洞）。 */
export function nextTrackName(base: string, tracks: readonly Track[]): string {
  const used = new Set(tracks.map((track) => track.name))
  let n = 1
  while (used.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

/**
 * 在**最上层**新增一条媒体轨（数组末尾 = 顶层）。
 * 达到 `TRACK_SOFT_LIMIT` 软上限时原样返回（调用方据此提示“已达软上限”）。
 * 注意这是保护性上限，不是产品语义上的“最多 8 条”。
 */
export function addMediaTrack(tracks: MediaTrack[]): MediaTrack[] {
  if (tracks.length >= TRACK_SOFT_LIMIT) return tracks
  return [...tracks, makeMediaTrack(nextTrackNumber(tracks), { name: nextTrackName('媒体', tracks) })]
}

/** 在最上层新增一条音频轨（同一套软上限口径）；达到软上限时原样返回。 */
export function addAudioTrack(tracks: AudioTrack[]): AudioTrack[] {
  if (tracks.length >= TRACK_SOFT_LIMIT) return tracks
  return [...tracks, makeAudioTrack(nextTrackNumber(tracks), { name: nextTrackName('音频', tracks) })]
}

/** 删除一条轨道；最后一条不允许删（否则轨道内片段无处可去，由 store 先迁移片段再调它）。 */
export function removeTrack<T extends Track>(tracks: T[], id: string): T[] {
  if (tracks.length <= 1) return tracks
  const next = tracks.filter((track) => track.id !== id)
  return next.length === tracks.length ? tracks : next
}

/** 把轨道移动到目标索引（0 = 最底层）；索引自动夹取。 */
export function moveTrack<T extends Track>(tracks: T[], id: string, toIndex: number): T[] {
  const from = tracks.findIndex((track) => track.id === id)
  if (from < 0) return tracks
  const to = Math.min(tracks.length - 1, Math.max(0, Math.round(toIndex)))
  if (to === from) return tracks
  const next = [...tracks]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

export function renameTrack<T extends Track>(tracks: T[], id: string, name: string): T[] {
  const trimmed = name.trim().slice(0, 40)
  if (trimmed.length === 0) return tracks
  return mapById(tracks, id, (track) => (track.name === trimmed ? track : { ...track, name: trimmed }))
}

export function setTrackMuted<T extends Track>(tracks: T[], id: string, muted: boolean): T[] {
  return mapById(tracks, id, (track) => (track.muted === muted ? track : { ...track, muted }))
}

export function setTrackHidden<T extends Track>(tracks: T[], id: string, hidden: boolean): T[] {
  return mapById(tracks, id, (track) => (track.hidden === hidden ? track : { ...track, hidden }))
}

export function setTrackLocked<T extends Track>(tracks: T[], id: string, locked: boolean): T[] {
  return mapById(tracks, id, (track) => (track.locked === locked ? track : { ...track, locked }))
}

/**
 * 合成顺序表：媒体轨 id → 绘制序号（0 = 最底层）。
 * 导出/预览用它把「轨道数组顺序」换算成明确的层级，避免各处再自己 indexOf。
 */
export function mediaTrackOrder(tracks: readonly MediaTrack[]): Map<string, number> {
  return new Map(tracks.map((track, index) => [track.id, index]))
}
