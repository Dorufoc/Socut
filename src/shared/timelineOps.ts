import { MIN_MEDIA_CLIP_SEC } from './constants'
import { frameIntervalSec, snapTimeToFrame } from './fps'
import { splitMediaClipAt } from './mediaClips'
import { speedValueOf } from './mediaClipAudio'
import type { Fps, MediaClip } from './types'

/**
 * M5 剪辑操作纯函数：波纹删除、片段合并。
 *
 * 两条纪律（与 `mediaClips.ts` 一致）：
 * 1. **时间轴以秒存储、写入前吸附到帧边界**：所有新起止点都过 `snapTimeToFrame`；
 * 2. **不碰 store / 不碰 UI**：只吃 `MediaClip[]` 返回新数组，由 `projectStore` 负责
 *    锁定轨判定、转场清理（`cleanupInvalidTransitions`）、选中态与撤销步进。
 *
 * 波纹删除只影响**同一轨道**且在原片段之后的片段：其它轨道是独立车道，
 * 左移它们会破坏用户已经摆好的画中画关系。
 */

export interface RippleDeleteResult {
  /** 删除并左移后的完整 mediaClips（含其它轨道的原样片段） */
  clips: MediaClip[]
  /** 被删除的那条（供调用方做选中态/缓存回收） */
  removedClip: MediaClip
  /** 被左移的片段 id（按时间顺序） */
  shiftedIds: string[]
}

/** 片段时长（秒）。变速不影响时间轴口径：时长就是 end - start。 */
function clipDurationSec(clip: MediaClip): number {
  return clip.timelineEndSec - clip.timelineStartSec
}

/**
 * 波纹删除：移除 `clipId`，并把**同一轨道上位于它之后**的片段整体左移它的时长，
 * 从而合上空出来的间隙。不同轨道、锁定轨（由调用方判定）不参与位移。
 *
 * 返回 null 表示片段不存在。删除后若某段的起点被夹到 0 以下（只会发生在脏数据上），
 * 一律贴到 0，不产生负时间。
 */
export function rippleDeleteMediaClip(
  clips: readonly MediaClip[],
  clipId: string,
  fps: Fps
): RippleDeleteResult | null {
  const removedClip = clips.find((clip) => clip.id === clipId)
  if (!removedClip) return null
  const durationSec = clipDurationSec(removedClip)
  if (durationSec <= 0) {
    return { clips: clips.filter((clip) => clip.id !== clipId), removedClip, shiftedIds: [] }
  }

  const shiftedIds: string[] = []
  const next = clips
    .filter((clip) => clip.id !== clipId)
    .map((clip) => {
      if (clip.trackId !== removedClip.trackId) return clip
      // 只移动「原片段结束之后（含相接）」的段；被删片段之前的段原地不动
      if (clip.timelineStartSec < removedClip.timelineEndSec - 1e-9) return clip
      const length = clipDurationSec(clip)
      const start = snapTimeToFrame(Math.max(0, clip.timelineStartSec - durationSec), fps)
      const end = snapTimeToFrame(start + length, fps)
      if (Math.abs(start - clip.timelineStartSec) < 1e-9 && Math.abs(end - clip.timelineEndSec) < 1e-9) {
        return clip
      }
      shiftedIds.push(clip.id)
      // 源入出点与时间轴位移无关（时长不变），保持原值
      return { ...clip, timelineStartSec: start, timelineEndSec: end }
    })

  return { clips: next, removedClip, shiftedIds }
}

/** 合并失败的原因：给 UI/CLI 稳定可判的字符串，而不是一句中文。 */
export type MediaClipMergeReason =
  | 'differentTrack'
  | 'notAdjacent'
  | 'differentMedia'
  | 'speedMismatch'
  | 'sourceGap'
  | 'paramsMismatch'

export type MediaClipMergeCheck = { ok: true } | { ok: false; reason: MediaClipMergeReason }

/** 供 UI 判断「这两段能不能合并」；与 `mergeMediaClips` 共用同一份判定。 */
export function canMergeMediaClips(
  left: MediaClip,
  right: MediaClip,
  fps: Fps
): MediaClipMergeCheck {
  if (left.trackId !== right.trackId) return { ok: false, reason: 'differentTrack' }
  // 相邻：右段起点必须贴在左段终点上（半帧容差，兼容帧率吸附的舍入）
  const toleranceSec = frameIntervalSec(fps) / 2 + 1e-9
  if (Math.abs(right.timelineStartSec - left.timelineEndSec) > toleranceSec) {
    return { ok: false, reason: 'notAdjacent' }
  }
  if (left.mediaId !== right.mediaId) return { ok: false, reason: 'differentMedia' }
  const leftSpeed = speedValueOf(left.speed)
  const rightSpeed = speedValueOf(right.speed)
  if (Math.abs(leftSpeed - rightSpeed) > 1e-9) return { ok: false, reason: 'speedMismatch' }
  // 源上必须连续：右段从源里接着左段的出点读，才是「原来就是一段」的拆分
  const sourceToleranceSec = Math.max(toleranceSec * leftSpeed, 1e-6)
  if (Math.abs(right.sourceInSec - left.sourceOutSec) > sourceToleranceSec) {
    return { ok: false, reason: 'sourceGap' }
  }
  // 画面/防抖/音频等参数必须一致，否则「合并」会静默丢掉其中一段的调色或增益
  if (JSON.stringify(left.video) !== JSON.stringify(right.video)) {
    return { ok: false, reason: 'paramsMismatch' }
  }
  if (JSON.stringify(left.stab) !== JSON.stringify(right.stab)) {
    return { ok: false, reason: 'paramsMismatch' }
  }
  if (JSON.stringify(left.audio) !== JSON.stringify(right.audio)) {
    return { ok: false, reason: 'paramsMismatch' }
  }
  return { ok: true }
}

/**
 * 合并同轨相邻的两段（顺序无关：内部按时间轴排序成 left/right）。
 *
 * 合并结果：
 * - 沿用**左段**的 id 与全部参数（画面/调色/防抖/音频/变速），时间轴终点与源出点取右段；
 * - 右段的 `transitionIn` 属于被抹掉的内部切点，一起丢弃；左段的入场转场保留。
 *
 * 返回 null 表示不存在或不可合并（原因见 `canMergeMediaClips`）。
 */
export function mergeMediaClips(
  clips: readonly MediaClip[],
  firstId: string,
  secondId: string,
  fps: Fps
): { clips: MediaClip[]; merged: MediaClip } | null {
  if (firstId === secondId) return null
  const first = clips.find((clip) => clip.id === firstId)
  const second = clips.find((clip) => clip.id === secondId)
  if (!first || !second) return null
  const [left, right] =
    first.timelineStartSec <= second.timelineStartSec ? [first, second] : [second, first]
  if (!canMergeMediaClips(left, right, fps).ok) return null
  const merged: MediaClip = {
    ...left,
    timelineEndSec: right.timelineEndSec,
    sourceOutSec: right.sourceOutSec
  }
  const next = clips
    .filter((clip) => clip.id !== left.id && clip.id !== right.id)
    .concat(merged)
  // 保持与 store 的 withMediaClips 相同的排序口径：按时间轴起点升序
  next.sort((a, b) => a.timelineStartSec - b.timelineStartSec || a.id.localeCompare(b.id))
  return { clips: next, merged }
}

/** 同轨上紧邻的下一段（按起点升序的下一个）；没有则 null。 */
export function nextMediaClipOnTrack(clips: readonly MediaClip[], clipId: string): MediaClip | null {
  const current = clips.find((clip) => clip.id === clipId)
  if (!current) return null
  const trackClips = clips
    .filter((clip) => clip.trackId === current.trackId && clip.id !== current.id)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const after = trackClips.find((clip) => clip.timelineStartSec >= current.timelineEndSec - 1e-9)
  return after ?? null
}

/** 同轨上紧邻的上一段（用于「向前合并」）；没有则 null。 */
export function previousMediaClipOnTrack(
  clips: readonly MediaClip[],
  clipId: string
): MediaClip | null {
  const current = clips.find((clip) => clip.id === clipId)
  if (!current) return null
  const trackClips = clips
    .filter((clip) => clip.trackId === current.trackId && clip.id !== current.id)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const before = [...trackClips]
    .reverse()
    .find((clip) => clip.timelineEndSec <= current.timelineStartSec + 1e-9)
  return before ?? null
}

/** 片段的最短可交付时长校验（供 UI 在合并/波纹后提示，不参与计算）。 */
export function isClipDurationValid(clip: MediaClip): boolean {
  return clipDurationSec(clip) >= MIN_MEDIA_CLIP_SEC - 1e-9
}

export interface FreezeFramePlanInput {
  clips: readonly MediaClip[]
  /** 被冻结的片段 id（必须是 @atSec 所在的那一段） */
  clipId: string
  /** 冻结发生的**时间轴**秒（会吸附到帧边界，并在段内重新夹取） */
  atSec: number
  fps: Fps
  /** 抽帧产物对应的 image 素材 id（由调用方先落盘 + 入池） */
  freezeMediaId: string
  /** 冻结片段时长（秒）；不足最短媒体时长时按最短值 */
  durationSec: number
  /** 冻结片段的新 id（调用方分配，保持 id 生成口径统一） */
  newClipId: string
  /** 拆分后右半段的新 id（调用方分配） */
  newRightId: string
}

export interface FreezeFramePlanResult {
  /** 插入冻结帧并右移后续片段后的完整 mediaClips */
  clips: MediaClip[]
  freezeClip: MediaClip
  leftClip: MediaClip
  rightClip: MediaClip
  /** 实际使用的切点（帧对齐后） */
  cutSec: number
}

/**
 * 冻结帧插入计划（纯函数）：
 *
 *   原段 [s, e]，切点 c
 *   → 左段 [s, c] + 冻结段 [c, c+D] + 右段 [c+D, e+D]
 *   后续同轨片段整体右移 D，源入出点不变（只挪时间轴位置）。
 *
 * 与拆分同一口径：右半段**不继承**原片段入场转场（转场属于原切点，左半段保留它）。
 * 切点落在段外、或任一半不足最短时长时返回 null。
 */
export function planFreezeFrame(input: FreezeFramePlanInput): FreezeFramePlanResult | null {
  const target = input.clips.find((clip) => clip.id === input.clipId)
  if (!target) return null
  const cutSec = snapTimeToFrame(input.atSec, input.fps)
  if (cutSec <= target.timelineStartSec + MIN_MEDIA_CLIP_SEC - 1e-9) return null
  if (cutSec >= target.timelineEndSec - MIN_MEDIA_CLIP_SEC + 1e-9) return null
  const split = splitMediaClipAt(target, cutSec, input.fps, () => input.newRightId)
  if (!split) return null

  const durationSec = snapTimeToFrame(Math.max(MIN_MEDIA_CLIP_SEC, input.durationSec), input.fps)
  const rightStartSec = snapTimeToFrame(cutSec + durationSec, input.fps)
  const freezeEndSec = rightStartSec
  const rightClip: MediaClip = {
    ...split.right,
    timelineStartSec: rightStartSec,
    timelineEndSec: snapTimeToFrame(rightStartSec + clipDurationSec(split.right), input.fps)
  }
  // 新切点不是原来的入场切点：右半段不继承转场（左半段保留自己的 transitionIn）
  delete rightClip.transitionIn

  const freezeClip: MediaClip = {
    id: input.newClipId,
    mediaId: input.freezeMediaId,
    trackId: target.trackId,
    timelineStartSec: cutSec,
    timelineEndSec: freezeEndSec,
    // 图像素材的源窗口与时长同长：schema 归一按 `sourceOut = sourceIn + duration × speed` 补
    sourceInSec: 0,
    sourceOutSec: snapTimeToFrame(freezeEndSec - cutSec, input.fps)
  }

  const next = input.clips
    .filter((clip) => clip.id !== target.id)
    .map((clip) => {
      if (clip.trackId !== target.trackId) return clip
      if (clip.timelineStartSec < cutSec - 1e-9) return clip
      // 切点及其后的片段（含刚拆出来的右半段）整体右移冻结时长
      const length = clipDurationSec(clip)
      const start = snapTimeToFrame(clip.timelineStartSec + durationSec, input.fps)
      return { ...clip, timelineStartSec: start, timelineEndSec: snapTimeToFrame(start + length, input.fps) }
    })
    .concat(split.left, rightClip, freezeClip)
  next.sort((a, b) => a.timelineStartSec - b.timelineStartSec || a.id.localeCompare(b.id))
  return { clips: next, freezeClip, leftClip: split.left, rightClip, cutSec }
}
