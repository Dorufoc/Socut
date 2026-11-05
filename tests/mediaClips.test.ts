import { describe, expect, it } from 'vitest'
import { MIN_CLIP_DURATION_SEC, MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { FPS_30 } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import {
  alignAfterOverlap,
  canSplitMediaClipAt,
  compactMediaClips,
  findActiveMediaClip,
  mediaClipsOverlap,
  mediaSpanFrames,
  resolveVisibleMediaClips,
  sortMediaClips,
  sourceTimeOf,
  splitMediaClipAt
} from '@shared/mediaClips'
import type { MediaClip } from '@shared/types'

/** 媒体轨纯函数：拆分、重叠对齐、时间↔源坐标换算与帧区间包络。 */

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    // 其余可选键（layer / video / stab / audio / speed）原样透传
    ...over,
    id: over.id ?? 'mclip-a',
    mediaId: over.mediaId ?? 'media-1',
    timelineStartSec: over.timelineStartSec ?? 0,
    timelineEndSec: over.timelineEndSec ?? 4,
    sourceInSec: over.sourceInSec ?? 1,
    sourceOutSec: over.sourceOutSec ?? 5
  }
}

const newId = (): string => `mclip-${Math.random().toString(36).slice(2, 8)}`

describe('mediaClips.splitMediaClipAt', () => {
  it('在段内切一刀：左右两段的 timeline 与 source 区间首尾相接、总时长不变', () => {
    const base = clip({ timelineStartSec: 0, timelineEndSec: 4, sourceInSec: 10, sourceOutSec: 14 })
    const result = splitMediaClipAt(base, 2, FPS_30, newId)
    expect(result).not.toBeNull()
    const { left, right } = result!
    expect(left.timelineEndSec).toBe(2)
    expect(right.timelineStartSec).toBe(2)
    expect(left.sourceOutSec).toBe(12)
    expect(right.sourceInSec).toBe(12)
    expect(right.sourceOutSec).toBe(14)
    expect(right.id).not.toBe(base.id)
    // 时长守恒
    expect(left.timelineEndSec - left.timelineStartSec + (right.timelineEndSec - right.timelineStartSec)).toBeCloseTo(
      base.timelineEndSec - base.timelineStartSec,
      6
    )
  })

  it('切点落在段外 / 剩余不足最短时长时返回 null', () => {
    const base = clip({ timelineStartSec: 1, timelineEndSec: 2 })
    expect(splitMediaClipAt(base, 0.5, FPS_30, newId)).toBeNull()
    expect(splitMediaClipAt(base, 3, FPS_30, newId)).toBeNull()
    expect(splitMediaClipAt(base, 1 + MIN_MEDIA_CLIP_SEC / 2, FPS_30, newId)).toBeNull()
    expect(splitMediaClipAt(base, 2 - MIN_MEDIA_CLIP_SEC / 2, FPS_30, newId)).toBeNull()
  })

  it('切点自动吸附到当前帧率的帧边界', () => {
    const base = clip({ timelineStartSec: 0, timelineEndSec: 4 })
    const result = splitMediaClipAt(base, 1.017, FPS_30, newId)!
    expect(result.left.timelineEndSec).toBe(snapTimeToFrame(1.017, FPS_30))
  })
})

describe('mediaClips.overlap 与 alignAfterOverlap', () => {
  it('仅在真正重叠时判 true；边界相接不算重叠', () => {
    const a = clip({ timelineStartSec: 0, timelineEndSec: 2 })
    const b = clip({ id: 'b', timelineStartSec: 2, timelineEndSec: 4 })
    const c = clip({ id: 'c', timelineStartSec: 1, timelineEndSec: 3 })
    expect(mediaClipsOverlap(a, b)).toBe(false)
    expect(mediaClipsOverlap(a, c)).toBe(true)
  })

  it('锚段之后的重叠片段整体右移到锚段末尾；未重叠的不动', () => {
    const anchor = clip({ id: 'anchor', timelineStartSec: 0, timelineEndSec: 3 })
    const overlapping = clip({ id: 'over', timelineStartSec: 2, timelineEndSec: 6 })
    const clean = clip({ id: 'clean', timelineStartSec: 8, timelineEndSec: 10 })
    const tracks = [anchor, overlapping, clean]
    const aligned = alignAfterOverlap(tracks, anchor, FPS_30)
    expect(aligned.find((c) => c.id === 'over')!.timelineStartSec).toBe(3)
    expect(aligned.find((c) => c.id === 'over')!.timelineEndSec).toBe(7)
    // 时长不变、源入出点保持不变
    expect(aligned.find((c) => c.id === 'over')!.sourceInSec).toBe(overlapping.sourceInSec)
    expect(aligned.find((c) => c.id === 'clean')!.timelineStartSec).toBe(8)
    expect(aligned.find((c) => c.id === 'anchor')!.timelineStartSec).toBe(0)
  })
})

describe('mediaClips 时间↔源换算', () => {
  it('findActiveMediaClip 用半开区间，边界不冲突', () => {
    const a = clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 2 })
    const b = clip({ id: 'b', timelineStartSec: 2, timelineEndSec: 4 })
    expect(findActiveMediaClip([a, b], 1.5)?.id).toBe('a')
    expect(findActiveMediaClip([a, b], 2)?.id).toBe('b')
    expect(findActiveMediaClip([a, b], 4)).toBeNull()
    expect(findActiveMediaClip([], 1)).toBeNull()
  })

  it('sourceTimeOf：时间轴秒 + sourceInSec 偏移 = 源文件秒', () => {
    const base = clip({ timelineStartSec: 0, timelineEndSec: 4, sourceInSec: 10, sourceOutSec: 14 })
    const result = sourceTimeOf([base], 1.5)!
    expect(result.clip.id).toBe(base.id)
    expect(result.sourceSec).toBeCloseTo(11.5, 6)
  })
})

describe('mediaClips 帧区间包络', () => {
  it('空数组返回 [0, 0]；多段重叠时取并集', () => {
    expect(mediaSpanFrames([], FPS_30)).toEqual({ startFrame: 0, endFrame: 0 })
    const a = clip({ timelineStartSec: 0, timelineEndSec: 2 })
    const b = clip({ id: 'b', timelineStartSec: 1, timelineEndSec: 4 })
    expect(mediaSpanFrames([a, b], FPS_30)).toEqual({ startFrame: 0, endFrame: 120 })
  })

  it('sortMediaClips：按 timelineStartSec 升序，不改入参', () => {
    const a = clip({ id: 'a', timelineStartSec: 5 })
    const b = clip({ id: 'b', timelineStartSec: 1 })
    const sorted = sortMediaClips([a, b])
    expect(sorted.map((c) => c.id)).toEqual(['b', 'a'])
    expect(a.timelineStartSec).toBe(5)
  })
})

describe('mediaClips 边界常量', () => {
  it('MIN_MEDIA_CLIP_SEC 与 MIN_CLIP_DURATION_SEC 保持一致，两轨最小时长同口径', () => {
    expect(MIN_MEDIA_CLIP_SEC).toBe(MIN_CLIP_DURATION_SEC)
  })
})

describe('mediaClips.canSplitMediaClipAt（UI 按钮态谓词）', () => {
  it('与 splitMediaClipAt 同口径：段内可拆、空隙/贴边不可拆', () => {
    const tracks = [clip({ id: 'a', timelineStartSec: 1, timelineEndSec: 5 })]
    expect(canSplitMediaClipAt(tracks, 3, FPS_30)).toBe(true)
    // 切点贴边（两半不足最短）与落在段外：谓词与拆分函数给出一致结果
    expect(canSplitMediaClipAt(tracks, 1 + MIN_MEDIA_CLIP_SEC / 2, FPS_30)).toBe(false)
    expect(canSplitMediaClipAt(tracks, 5 - MIN_MEDIA_CLIP_SEC / 2, FPS_30)).toBe(false)
    expect(canSplitMediaClipAt(tracks, 8, FPS_30)).toBe(false)
    expect(canSplitMediaClipAt([], 3, FPS_30)).toBe(false)
    // 谓词结论与实际拆分结果一致
    expect(splitMediaClipAt(tracks[0]!, 3, FPS_30, newId)).not.toBeNull()
    expect(splitMediaClipAt(tracks[0]!, 1 + MIN_MEDIA_CLIP_SEC / 2, FPS_30, newId)).toBeNull()
  })
})

/**
 * v9：变速段的时间轴↔源坐标换算。
 *
 * 口径：**源窗口不变、时间轴伸缩**（与预览 `playbackRate` / 导出 `setpts` 同一语义），
 * 所以任何往源上投影的地方都要乘倍速，1x 时必须退回旧写法。
 */
describe('mediaClips 变速段的时间换算（v9）', () => {
  it('拆分：切点往源上投影要乘倍速，两半源窗口相接', () => {
    const base = clip({
      timelineStartSec: 0,
      timelineEndSec: 4,
      sourceInSec: 10,
      sourceOutSec: 18,
      speed: { speed: 2, maintainPitch: true }
    })
    const { left, right } = splitMediaClipAt(base, 2, FPS_30, newId)!
    expect(left.sourceOutSec).toBe(14)
    expect(right.sourceInSec).toBe(14)
    expect(right.sourceOutSec).toBe(18)
    // 两半各自仍满足恒等式：时间轴 2s @ 2x = 源 4s
    expect(left.sourceOutSec - left.sourceInSec).toBeCloseTo((left.timelineEndSec - left.timelineStartSec) * 2, 6)
    expect(right.sourceOutSec - right.sourceInSec).toBeCloseTo((right.timelineEndSec - right.timelineStartSec) * 2, 6)
  })

  it('sourceTimeOf：播放头走到段中 = 吃了一半源窗口（不是时间轴偏移）', () => {
    const base = clip({ timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 10, sourceOutSec: 14, speed: { speed: 2, maintainPitch: true } })
    expect(sourceTimeOf([base], 1.5)!.sourceSec).toBeCloseTo(13, 6)
    // 1x 时仍是旧口径
    expect(sourceTimeOf([clip({ timelineStartSec: 0, timelineEndSec: 4, sourceInSec: 10, sourceOutSec: 14 })], 1.5)!.sourceSec).toBeCloseTo(11.5, 6)
  })

  it('层号取上层：被遮蔽后的源窗口按倍速投影', () => {
    const top = clip({ id: 'top', timelineStartSec: 0, timelineEndSec: 4, sourceInSec: 0, sourceOutSec: 8, layer: 1, speed: { speed: 2, maintainPitch: true } })
    const bottom = clip({ id: 'bottom', mediaId: 'media-2', timelineStartSec: 2, timelineEndSec: 6, sourceInSec: 20, sourceOutSec: 28, speed: { speed: 2, maintainPitch: true } })
    const visible = resolveVisibleMediaClips([top, bottom])
    expect(visible.map((c) => [c.id, c.timelineStartSec, c.timelineEndSec])).toEqual([
      ['top', 0, 4],
      ['bottom', 4, 6]
    ])
    // 下层被遮掉前 2s：源入点往后吃 2s × 2 = 4s
    expect(visible[1]!.sourceInSec).toBeCloseTo(24, 6)
    expect(visible[1]!.sourceOutSec).toBeCloseTo(28, 6)
  })

  it('主轨对齐：只改时间轴落点，源窗口跟着倍速重算', () => {
    const a = clip({ id: 'a', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 0, sourceOutSec: 4, speed: { speed: 2, maintainPitch: true } })
    const compacted = compactMediaClips([a], FPS_30)
    expect(compacted[0]!.timelineStartSec).toBe(0)
    expect(compacted[0]!.timelineEndSec).toBe(2)
    // 时间轴 2s @ 2x → 仍读 4s 源
    expect(compacted[0]!.sourceOutSec).toBeCloseTo(4, 6)
  })
})
