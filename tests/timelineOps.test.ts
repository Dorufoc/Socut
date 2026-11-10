import { describe, expect, it } from 'vitest'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import {
  canMergeMediaClips,
  isClipDurationValid,
  mergeMediaClips,
  nextMediaClipOnTrack,
  planFreezeFrame,
  previousMediaClipOnTrack,
  rippleDeleteMediaClip
} from '@shared/timelineOps'
import type { MediaClip } from '@shared/types'

/** M5 剪辑操作纯函数：波纹删除与相邻片段合并。 */

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    id: over.id ?? 'mclip-a',
    mediaId: over.mediaId ?? 'media-1',
    trackId: over.trackId ?? DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: over.timelineStartSec ?? 0,
    timelineEndSec: over.timelineEndSec ?? 2,
    sourceInSec: over.sourceInSec ?? 0,
    sourceOutSec: over.sourceOutSec ?? 2,
    ...(over.speed ? { speed: over.speed } : {}),
    ...(over.video ? { video: over.video } : {}),
    ...(over.audio ? { audio: over.audio } : {}),
    ...(over.transitionIn ? { transitionIn: over.transitionIn } : {})
  }
}

function ids(clips: readonly MediaClip[]): string[] {
  return clips.map((item) => item.id)
}

describe('timelineOps.rippleDeleteMediaClip', () => {
  it('删除中间段：同轨后续片段整体左移被删时长，前段与异轨不动', () => {
    const a = clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0, sourceOutSec: 2 })
    const b = clip({ id: 'b', timelineStartSec: 2, timelineEndSec: 5, sourceInSec: 0, sourceOutSec: 3 })
    const c = clip({ id: 'c', timelineStartSec: 5, timelineEndSec: 9, sourceInSec: 0, sourceOutSec: 4 })
    const other = clip({
      id: 'other',
      trackId: 'track-media-1',
      timelineStartSec: 6,
      timelineEndSec: 8,
      sourceInSec: 0,
      sourceOutSec: 2
    })
    const result = rippleDeleteMediaClip([a, b, c, other], 'b', FPS_30)!
    expect(ids(result.clips)).toEqual(['a', 'c', 'other'])
    expect(result.removedClip.id).toBe('b')
    // 时长守恒：c 仍是 4s，只是起点从 5 左移到 2
    const movedC = result.clips.find((item) => item.id === 'c')!
    expect(movedC.timelineStartSec).toBe(2)
    expect(movedC.timelineEndSec).toBe(6)
    expect(movedC.sourceInSec).toBe(0)
    expect(movedC.sourceOutSec).toBe(4)
    // 异轨片段不参与位移
    const untouched = result.clips.find((item) => item.id === 'other')!
    expect(untouched.timelineStartSec).toBe(6)
    expect(result.shiftedIds).toEqual(['c'])
  })

  it('删除首段会把后面的段一路拉到 0；中间的既有空隙保留', () => {
    const a = clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 2 })
    const b = clip({ id: 'b', timelineStartSec: 4, timelineEndSec: 7, sourceInSec: 0, sourceOutSec: 3 })
    const result = rippleDeleteMediaClip([a, b], 'a', FPS_30)!
    const movedB = result.clips.find((item) => item.id === 'b')!
    // 原空隙 2s（2→4）保留：左移 2s 后落在 2
    expect(movedB.timelineStartSec).toBe(2)
    expect(movedB.timelineEndSec).toBe(5)
  })

  it('变速段按时间轴时长位移，而不是按源窗口长度', () => {
    // 2x：时间轴占 4s，源窗口只吃掉 8s
    const fast = clip({
      id: 'fast',
      timelineStartSec: 0,
      timelineEndSec: 4,
      sourceInSec: 0,
      sourceOutSec: 8,
      speed: { speed: 2, maintainPitch: true }
    })
    const after = clip({ id: 'after', timelineStartSec: 4, timelineEndSec: 6, sourceInSec: 0, sourceOutSec: 2 })
    const result = rippleDeleteMediaClip([fast, after], 'fast', FPS_30)!
    const moved = result.clips.find((item) => item.id === 'after')!
    expect(moved.timelineStartSec).toBe(0)
    expect(moved.timelineEndSec).toBe(2)
  })

  it('左移结果吸附到帧边界', () => {
    const a = clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1.017 })
    const b = clip({ id: 'b', timelineStartSec: 3, timelineEndSec: 5, sourceInSec: 0, sourceOutSec: 2 })
    const result = rippleDeleteMediaClip([a, b], 'a', FPS_30)!
    const moved = result.clips.find((item) => item.id === 'b')!
    // 起点 = 3 - 1.017 = 1.983 → 吸附到 30fps 帧边界
    expect(moved.timelineStartSec).toBeCloseTo(1.9666667, 6)
    expect(moved.timelineEndSec - moved.timelineStartSec).toBeCloseTo(2, 6)
  })

  it('片段不存在返回 null；删除唯一片段得到空数组', () => {
    expect(rippleDeleteMediaClip([clip({ id: 'a' })], 'missing', FPS_30)).toBeNull()
    const result = rippleDeleteMediaClip([clip({ id: 'a' })], 'a', FPS_30)!
    expect(result.clips).toEqual([])
    expect(result.shiftedIds).toEqual([])
  })
})

describe('timelineOps.canMergeMediaClips / mergeMediaClips', () => {
  const left = clip({
    id: 'left',
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 10,
    sourceOutSec: 12,
    transitionIn: { type: 'dissolve', durationSec: 0.5 }
  })
  const right = clip({
    id: 'right',
    timelineStartSec: 2,
    timelineEndSec: 4,
    sourceInSec: 12,
    sourceOutSec: 14
  })

  it('同轨相邻、同素材、源连续时判定可合并', () => {
    expect(canMergeMediaClips(left, right, FPS_30)).toEqual({ ok: true })
  })

  it('合并结果沿用左段 id/参数，终点与源出点取右段，内部转场丢弃', () => {
    const result = mergeMediaClips([left, right], 'left', 'right', FPS_30)!
    expect(result.clips).toHaveLength(1)
    const merged = result.merged
    expect(merged.id).toBe('left')
    expect(merged.timelineStartSec).toBe(0)
    expect(merged.timelineEndSec).toBe(4)
    expect(merged.sourceInSec).toBe(10)
    expect(merged.sourceOutSec).toBe(14)
    // 左段入场转场保留，右段（内部切点）的转场不存在
    expect(merged.transitionIn).toEqual({ type: 'dissolve', durationSec: 0.5 })
  })

  it('两段传入顺序无关：内部按时间轴排序成左右段', () => {
    const result = mergeMediaClips([right, left], 'right', 'left', FPS_30)!
    expect(result.merged.id).toBe('left')
    expect(result.clips).toHaveLength(1)
  })

  it('拒绝异轨 / 不相邻 / 异素材 / 变速不一致 / 源不连续 / 参数不一致', () => {
    expect(canMergeMediaClips(left, clip({ ...right, trackId: 'track-media-1' }), FPS_30)).toEqual({
      ok: false,
      reason: 'differentTrack'
    })
    expect(canMergeMediaClips(left, clip({ ...right, timelineStartSec: 2.5, timelineEndSec: 4.5 }), FPS_30)).toEqual({
      ok: false,
      reason: 'notAdjacent'
    })
    expect(canMergeMediaClips(left, clip({ ...right, mediaId: 'media-2' }), FPS_30)).toEqual({
      ok: false,
      reason: 'differentMedia'
    })
    expect(
      canMergeMediaClips(left, clip({ ...right, speed: { speed: 2, maintainPitch: true } }), FPS_30)
    ).toEqual({ ok: false, reason: 'speedMismatch' })
    expect(canMergeMediaClips(left, clip({ ...right, sourceInSec: 15, sourceOutSec: 17 }), FPS_30)).toEqual({
      ok: false,
      reason: 'sourceGap'
    })
    expect(
      canMergeMediaClips(
        left,
        clip({
          ...right,
          video: {
            scalePercent: 50,
            offsetXPercent: 0,
            offsetYPercent: 0,
            rotationDeg: 0,
            flipH: false,
            flipV: false,
            brightness: 0,
            exposure: 0,
            contrast: 0,
            saturation: 0,
            warmth: 0,
            vibrance: 0,
            curves: { master: [], r: [], g: [], b: [] }
          }
        }),
        FPS_30
      )
    ).toEqual({ ok: false, reason: 'paramsMismatch' })
  })

  it('不存在 / 同一条 / 不可合并时返回 null', () => {
    expect(mergeMediaClips([left, right], 'missing', 'right', FPS_30)).toBeNull()
    expect(mergeMediaClips([left, right], 'left', 'left', FPS_30)).toBeNull()
    expect(mergeMediaClips([left, clip({ ...right, mediaId: 'media-2' })], 'left', 'right', FPS_30)).toBeNull()
  })

  it('合并后数组仍按时间轴起点升序', () => {
    const earlier = clip({ id: 'earlier', timelineStartSec: -2, timelineEndSec: 0, sourceInSec: 0, sourceOutSec: 2 })
    const result = mergeMediaClips([earlier, left, right], 'left', 'right', FPS_30)!
    expect(ids(result.clips)).toEqual(['earlier', 'left'])
  })
})

describe('timelineOps 邻段查找与时长校验', () => {
  const a = clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 2 })
  const b = clip({ id: 'b', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 0, sourceOutSec: 2 })
  const c = clip({ id: 'c', timelineStartSec: 8, timelineEndSec: 10, sourceInSec: 0, sourceOutSec: 2 })

  it('同轨下一段 / 上一段按起点排序，跳过异轨与空隙之后仍能找到', () => {
    expect(nextMediaClipOnTrack([a, b, c], 'a')?.id).toBe('b')
    expect(nextMediaClipOnTrack([a, b, c], 'b')?.id).toBe('c')
    expect(nextMediaClipOnTrack([a, b, c], 'c')).toBeNull()
    expect(previousMediaClipOnTrack([a, b, c], 'c')?.id).toBe('b')
    expect(previousMediaClipOnTrack([a, b, c], 'a')).toBeNull()
  })

  it('时长校验按最短媒体片段口径', () => {
    expect(isClipDurationValid(clip({ timelineStartSec: 0, timelineEndSec: 1 }))).toBe(true)
    expect(isClipDurationValid(clip({ timelineStartSec: 0, timelineEndSec: 0.01 }))).toBe(false)
  })
})

describe('timelineOps.planFreezeFrame', () => {
  const base = clip({
    id: 'a',
    timelineStartSec: 0,
    timelineEndSec: 4,
    sourceInSec: 10,
    sourceOutSec: 14,
    transitionIn: { type: 'dissolve', durationSec: 0.5 }
  })

  it('在 2s 处插入 1s 冻结帧：左段 / 冻结段 / 右段首尾相接，后续同轨片段右移', () => {
    const after = clip({ id: 'after', timelineStartSec: 4, timelineEndSec: 6, sourceInSec: 0, sourceOutSec: 2 })
    const other = clip({ id: 'other', trackId: 'track-media-1', timelineStartSec: 4, timelineEndSec: 6, sourceInSec: 0, sourceOutSec: 2 })
    const plan = planFreezeFrame({
      clips: [base, after, other],
      clipId: 'a',
      atSec: 2,
      fps: FPS_30,
      freezeMediaId: 'media-freeze',
      durationSec: 1,
      newClipId: 'freeze',
      newRightId: 'right'
    })!
    expect(plan).not.toBeNull()
    expect(plan.cutSec).toBe(2)
    expect(plan.leftClip.id).toBe('a')
    expect(plan.leftClip.timelineStartSec).toBe(0)
    expect(plan.leftClip.timelineEndSec).toBe(2)
    expect(plan.leftClip.sourceOutSec).toBe(12)
    // 冻结段：源窗口按图像素材口径与时长同长
    expect(plan.freezeClip.mediaId).toBe('media-freeze')
    expect(plan.freezeClip.timelineStartSec).toBe(2)
    expect(plan.freezeClip.timelineEndSec).toBe(3)
    expect(plan.freezeClip.sourceOutSec).toBe(1)
    // 右段整体右移 1s，源窗口不变（源连续）
    expect(plan.rightClip.timelineStartSec).toBe(3)
    expect(plan.rightClip.timelineEndSec).toBe(5)
    expect(plan.rightClip.sourceInSec).toBe(12)
    expect(plan.rightClip.sourceOutSec).toBe(14)
    // 后续同轨片段右移 1s；异轨不动
    const movedAfter = plan.clips.find((item) => item.id === 'after')!
    expect(movedAfter.timelineStartSec).toBe(5)
    expect(movedAfter.timelineEndSec).toBe(7)
    const untouched = plan.clips.find((item) => item.id === 'other')!
    expect(untouched.timelineStartSec).toBe(4)
    // 结果按时间轴排序（other 在 4s、after 右移到 5s）
    expect(plan.clips.map((item) => item.id)).toEqual(['a', 'freeze', 'right', 'other', 'after'])
  })

  it('原片段入场转场留在左段，右段（新切点）不继承', () => {
    const plan = planFreezeFrame({
      clips: [base],
      clipId: 'a',
      atSec: 2,
      fps: FPS_30,
      freezeMediaId: 'media-freeze',
      durationSec: 1,
      newClipId: 'freeze',
      newRightId: 'right'
    })!
    expect(plan.leftClip.transitionIn).toEqual({ type: 'dissolve', durationSec: 0.5 })
    expect('transitionIn' in plan.rightClip).toBe(false)
  })

  it('变速段按倍速投影源坐标（2x：切点 2s → 源 14s）', () => {
    const fast = clip({
      id: 'fast',
      timelineStartSec: 0,
      timelineEndSec: 4,
      sourceInSec: 10,
      sourceOutSec: 18,
      speed: { speed: 2, maintainPitch: true }
    })
    const plan = planFreezeFrame({
      clips: [fast],
      clipId: 'fast',
      atSec: 2,
      fps: FPS_30,
      freezeMediaId: 'media-freeze',
      durationSec: 1,
      newClipId: 'freeze',
      newRightId: 'right'
    })!
    expect(plan.leftClip.sourceOutSec).toBe(14)
    expect(plan.rightClip.sourceInSec).toBe(14)
    expect(plan.rightClip.sourceOutSec).toBe(18)
  })

  it('切点吸附到帧边界', () => {
    const plan = planFreezeFrame({
      clips: [base],
      clipId: 'a',
      atSec: 2.017,
      fps: FPS_30,
      freezeMediaId: 'media-freeze',
      durationSec: 1,
      newClipId: 'freeze',
      newRightId: 'right'
    })!
    // 30fps：2.017 × 30 = 60.51 → 61 帧 = 2.0333s
    expect(plan.cutSec).toBeCloseTo(61 / 30, 6)
  })

  it('切点越界 / 两侧不足最短时长 / 片段不存在时返回 null', () => {
    const args = {
      clipId: 'a',
      fps: FPS_30,
      freezeMediaId: 'media-freeze',
      durationSec: 1,
      newClipId: 'freeze',
      newRightId: 'right'
    }
    expect(planFreezeFrame({ ...args, clips: [base], atSec: 0 })).toBeNull()
    expect(planFreezeFrame({ ...args, clips: [base], atSec: 4 })).toBeNull()
    expect(planFreezeFrame({ ...args, clips: [base], atSec: 0.1 })).toBeNull()
    expect(planFreezeFrame({ ...args, clips: [base], atSec: 3.95 })).toBeNull()
    expect(planFreezeFrame({ ...args, clips: [base], clipId: 'missing', atSec: 2 })).toBeNull()
  })
})
