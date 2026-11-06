import type { AudioClip, ClipSpeed, Fps, MediaItem, MediaKind, VideoMeta } from './types'
import { IMPORTABLE_IMAGE_EXTENSIONS } from './constants'
import { snapTimeToFrame } from './fps'
import { speedValueOf } from './mediaClipAudio'

/** v7：图像素材上轨的默认时长（秒）；ffprobe 对单帧图读不出时长 */
export const IMAGE_STILL_SEC = 5

/**
 * 素材类型判定（唯一入口）。
 *
 * `kind` 是可选字段（旧工程没有），所以所有 UI 都必须走这里，
 * 不要自己写 `item.kind === 'audio'`——那样旧工程里的音频素材会漏判。
 */
export function mediaKindOf(item: Pick<MediaItem, 'kind' | 'meta'>): MediaKind {
  if (item.kind === 'audio' || item.kind === 'image' || item.kind === 'video') return item.kind
  return item.meta.width > 0 ? 'video' : 'audio'
}

/**
 * 导入时按扩展名 + 元数据推断类型：
 * 图像扩展名 → image（哪怕 ffprobe 报出了宽高）；无画面 → audio；其余 → video。
 */
export function inferMediaKind(path: string, meta: VideoMeta): MediaKind {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if ((IMPORTABLE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image'
  return meta.width > 0 ? 'video' : 'audio'
}

/**
 * 音频轨的纯逻辑（v7.1）。
 *
 * 与媒体段同一套时间轴口径（秒存储、帧对齐、时长恒等式），差别只有两点：
 * 1. 音频段**不参与画面合成**，只贡献声音；
 * 2. 同一时刻可以有多段同时发声（叠放层），所以「取当前段」返回的是**一组**而不是一段。
 *
 * 之所以单独成文件而不是复用 `mediaClips`：那边的规则（重叠时把后续片段右移、
 * 拆分、源入出点换算）都是为画面服务的，音频需要的是「混音」语义，
 * 混在一起会让两边都变难懂。
 */

/** 同一条音频轨最多叠多少层（超过就夹到上限，避免层高被压成 1px） */
export const MAX_CLIP_LAYER = 4

/** 最短音频段（秒）：与媒体段同一量级，避免拖成一条看不见的线 */
export const MIN_AUDIO_CLIP_SEC = 0.2

export function normalizeLayer(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 0
  return Math.min(MAX_CLIP_LAYER, Math.max(0, value))
}

export function sortAudioClips(clips: AudioClip[]): AudioClip[] {
  return [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec || normalizeLayer(a.layer) - normalizeLayer(b.layer))
}

/** 播放头处的全部音频段（按层号升序：底层先混，便于排查） */
export function activeAudioClips(clips: AudioClip[], atSec: number): AudioClip[] {
  return sortAudioClips(clips).filter((clip) => atSec >= clip.timelineStartSec && atSec < clip.timelineEndSec)
}

/** 音频轨的覆盖末端（导出时长与尺规都要算上它） */
export function audioClipsEndSec(clips: AudioClip[]): number {
  return clips.reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
}

/** 该层是否已被同层其它片段占用（叠放层不做自动让位，只做提示性判定） */
export function layerOccupied(clips: AudioClip[], layer: number, excludeId?: string): boolean {
  return clips.some((clip) => clip.id !== excludeId && normalizeLayer(clip.layer) === layer)
}

export interface InsertAudioInput {
  mediaId: string
  timelineStartSec: number
  durationSec: number
  sourceInSec?: number
  layer?: number
  /** 源文件总长（裁剪用；缺省视为足够长） */
  sourceDurationSec?: number
  /** v9：创建时的倍速（缺省 1x；>1x 时同一段源内容在时间轴上更短） */
  speed?: ClipSpeed
  id: string
}

/**
 * 生成一枚音频段：落点吸附到帧、时长夹到 [最短, 源可用长度]，
 * 越界时向轨道内收（与媒体段的插入规则同口径）。
 */
export function makeAudioClip(input: InsertAudioInput, fps: Fps): AudioClip | null {
  const speed = speedValueOf(input.speed)
  const sourceDuration = input.sourceDurationSec ?? Number.POSITIVE_INFINITY
  const sourceIn = snapTimeToFrame(Math.max(0, Math.min(input.sourceInSec ?? 0, Math.max(0, sourceDuration - MIN_AUDIO_CLIP_SEC))), fps)
  // 源能撑多久的时间轴 = 剩余源秒数 / 倍速
  const available = Math.max(0, (sourceDuration - sourceIn) / speed)
  const wanted = Math.min(input.durationSec, available)
  if (wanted < MIN_AUDIO_CLIP_SEC) return null
  const start = snapTimeToFrame(Math.max(0, input.timelineStartSec), fps)
  const end = snapTimeToFrame(start + Math.max(MIN_AUDIO_CLIP_SEC, wanted), fps)
  if (end <= start) return null
  return {
    id: input.id,
    mediaId: input.mediaId,
    timelineStartSec: start,
    timelineEndSec: end,
    sourceInSec: sourceIn,
    sourceOutSec: snapTimeToFrame(sourceIn + (end - start) * speed, fps),
    ...(normalizeLayer(input.layer) > 0 ? { layer: normalizeLayer(input.layer) } : {})
  }
}

/** 整段平移：夹在 >= 0，并**不**跟其他音频段互相推挤（混音允许重叠） */
export function moveAudioClip(clip: AudioClip, timelineStartSec: number, fps: Fps): AudioClip {
  const length = clip.timelineEndSec - clip.timelineStartSec
  const start = snapTimeToFrame(Math.max(0, timelineStartSec), fps)
  return { ...clip, timelineStartSec: start, timelineEndSec: snapTimeToFrame(start + length, fps) }
}

/**
 * 拖入点 / 出点：时间轴与源坐标按倍速同比例平移，保持时长恒等式
 * （`sourceOutSec - sourceInSec === (timelineEndSec - timelineStartSec) × 倍速`）。
 */
export function trimAudioClip(
  clip: AudioClip,
  patch: { timelineStartSec?: number; timelineEndSec?: number },
  fps: Fps,
  sourceDurationSec: number
): AudioClip {
  const speed = speedValueOf(clip.speed)
  const next: AudioClip = { ...clip }
  if (patch.timelineStartSec !== undefined) {
    const start = snapTimeToFrame(
      Math.max(0, Math.min(patch.timelineStartSec, clip.timelineEndSec - MIN_AUDIO_CLIP_SEC)),
      fps
    )
    const delta = start - clip.timelineStartSec
    const sourceIn = snapTimeToFrame(Math.max(0, Math.min(sourceDurationSec - MIN_AUDIO_CLIP_SEC, clip.sourceInSec + delta * speed)), fps)
    next.timelineStartSec = start
    next.sourceInSec = sourceIn
    next.sourceOutSec = snapTimeToFrame(sourceIn + (clip.timelineEndSec - start) * speed, fps)
    return next
  }
  if (patch.timelineEndSec !== undefined) {
    // 源剩余能撑的时间轴长度 = 剩余源秒数 / 倍速
    const maxEnd = clip.timelineStartSec + Math.max(MIN_AUDIO_CLIP_SEC, (sourceDurationSec - clip.sourceInSec) / speed)
    const end = snapTimeToFrame(Math.max(clip.timelineStartSec + MIN_AUDIO_CLIP_SEC, Math.min(patch.timelineEndSec, maxEnd)), fps)
    next.timelineEndSec = end
    next.sourceOutSec = snapTimeToFrame(clip.sourceInSec + (end - clip.timelineStartSec) * speed, fps)
  }
  return next
}

/**
 * v9：写入变速后的时间轴长度。
 *
 * 口径：**源窗口不动**，只把出点按 `源窗口 / 新倍速` 重新算回时间轴，
 * 所以 2x 会让片段在时间轴上缩短一半（与预览 `playbackRate` 与导出 `atempo` 同一语义）。
 */
export function applyAudioClipSpeed(clip: AudioClip, speed: ClipSpeed | undefined, fps: Fps): AudioClip {
  const value = speedValueOf(speed)
  const end = snapTimeToFrame(clip.timelineStartSec + Math.max(MIN_AUDIO_CLIP_SEC, (clip.sourceOutSec - clip.sourceInSec) / value), fps)
  const next: AudioClip = { ...clip, timelineEndSec: end }
  if (speed) next.speed = speed
  else delete next.speed
  return next
}

export interface AudioClipSplitResult {
  left: AudioClip
  right: AudioClip
}

/**
 * 在 `atSec`（自动吸附帧边界）处把一段音频切成两段（P3：工具栏拆分对音频段也生效）。
 *
 * 与媒体段同一口径：切点往源上投影时要乘上倍速（变速段 1s 时间轴吃掉 `speed` 秒源内容），
 * 音量/渐变/变速原样带到两半。任一半不足最短音频时长 → null。
 */
export function splitAudioClipAt(
  clip: AudioClip,
  atSec: number,
  fps: Fps,
  newId: (source: AudioClip) => string
): AudioClipSplitResult | null {
  const cut = snapTimeToFrame(atSec, fps)
  if (cut <= clip.timelineStartSec + MIN_AUDIO_CLIP_SEC - 1e-9) return null
  if (cut >= clip.timelineEndSec - MIN_AUDIO_CLIP_SEC + 1e-9) return null
  const speed = speedValueOf(clip.speed)
  const cutSourceSec = snapTimeToFrame(clip.sourceInSec + (cut - clip.timelineStartSec) * speed, fps)
  const left: AudioClip = { ...clip, timelineEndSec: cut, sourceOutSec: cutSourceSec }
  const right: AudioClip = { ...clip, id: newId(clip), timelineStartSec: cut, sourceInSec: cutSourceSec }
  return { left, right }
}
