import { describe, expect, it } from 'vitest'
import type { MediaClip } from '@shared/types'
import {
  PREVIEW_HOLD_SEC,
  PREVIEW_LOOKAHEAD_SEC,
  PREVIEW_MAX_CANDIDATES,
  PREVIEW_PREROLL_SEC,
  isClipActiveAt,
  previewClipStartSourceTime,
  previewPrerollTarget,
  previewSourceTimeAt,
  selectPreviewCandidates
} from './previewCandidates'

/**
 * 候选池的边界条件：切点前后到底该挂哪些 `<video>`。
 * 这些判据直接决定「切段黑不黑」，所以全部用纯函数钉住，不依赖 DOM。
 */

function clip(id: string, start: number, end: number, patch: Partial<MediaClip> = {}): MediaClip {
  return {
    id,
    mediaId: `media-${id}`,
    timelineStartSec: start,
    timelineEndSec: end,
    sourceInSec: 0,
    sourceOutSec: end - start,
    ...patch
  }
}

describe('isClipActiveAt', () => {
  it('半开区间：起点算、终点不算', () => {
    const c = clip('a', 1, 2)
    expect(isClipActiveAt(c, 1)).toBe(true)
    expect(isClipActiveAt(c, 1.999)).toBe(true)
    expect(isClipActiveAt(c, 2)).toBe(false)
    expect(isClipActiveAt(c, 0.999)).toBe(false)
  })
})

describe('selectPreviewCandidates', () => {
  it('当前图层全部保留，按层号升序（底层先画、上层后画）', () => {
    const tracks = [
      clip('top', 0, 10, { layer: 2 }),
      clip('bottom', 0, 10, { layer: 0 }),
      clip('middle', 0, 10, { layer: 1 })
    ]

    expect(selectPreviewCandidates(tracks, 5).map((c) => c.id)).toEqual(['bottom', 'middle', 'top'])
  })

  it('当前段排在最前，刚结束的段紧随其后', () => {
    const tracks = [clip('old', 0, 2), clip('newer', 2, 4), clip('next', 4, 6)]

    expect(selectPreviewCandidates(tracks, 4.2).map((c) => c.id)).toEqual(['next', 'newer'])
  })

  it('超过 hold 窗口的段不再保留', () => {
    const tracks = [clip('old', 0, 2)]

    expect(selectPreviewCandidates(tracks, 2 + PREVIEW_HOLD_SEC + 0.01)).toEqual([])
  })

  it('前瞻窗口内的下一段提前挂载，窗口外的暂不挂', () => {
    const inside = clip('inside', 3, 5)
    const outside = clip('outside', 3 + PREVIEW_LOOKAHEAD_SEC + 0.01, 8)

    expect(selectPreviewCandidates([inside, outside], 1).map((c) => c.id)).toEqual(['inside'])
    // 1 + 2 = 3，正好在窗口边界；再早 0.5s 就不该挂
    expect(selectPreviewCandidates([inside, outside], 0.5)).toEqual([])
    expect(selectPreviewCandidates([outside], 1)).toEqual([])
  })

  it('候选总数受限，但当前图层永远全部保留', () => {
    const active = Array.from({ length: PREVIEW_MAX_CANDIDATES + 2 }, (_, i) =>
      clip(`active-${i}`, 0, 10, { layer: i })
    )
    const upcoming = clip('upcoming', 10.5, 12)

    const selected = selectPreviewCandidates([...active, upcoming], 5)
    expect(selected).toHaveLength(PREVIEW_MAX_CANDIDATES + 2)
    expect(selected.some((c) => c.id === 'upcoming')).toBe(false)
  })

  it('切点处当前段在前、上一段作为兜底保留，且不会重复', () => {
    const tracks = [clip('a', 0, 2), clip('b', 2, 4)]

    expect(selectPreviewCandidates(tracks, 2).map((c) => c.id)).toEqual(['b', 'a'])
  })
})

describe('previewSourceTimeAt', () => {
  it('按倍速把时间轴秒投影到源秒', () => {
    const c = clip('a', 10, 20, { sourceInSec: 100, speed: { speed: 2, maintainPitch: true } })

    expect(previewSourceTimeAt(c, 12, false)).toBe(104)
  })

  it('播防抖代理时换成代理坐标（代理内容 = 源区间 1:1）', () => {
    const c = clip('a', 10, 20, {
      sourceInSec: 100,
      sourceOutSec: 110,
      stab: { enabled: true, level: 'standard', tripod: false }
    })

    expect(previewSourceTimeAt(c, 13, true)).toBe(3)
    expect(previewClipStartSourceTime(c, true)).toBe(0)
    expect(previewClipStartSourceTime(c, false)).toBe(100)
  })
})

describe('previewPrerollTarget', () => {
  it('进入预卷窗口后从入点前 remaining×speed 起播，切点正好落在入点', () => {
    const c = clip('a', 10, 20, { sourceInSec: 5 })

    expect(previewPrerollTarget(c, 10 - PREVIEW_PREROLL_SEC, false)).toBeCloseTo(5 - PREVIEW_PREROLL_SEC, 6)
  })

  it('窗口外不预卷', () => {
    const c = clip('a', 10, 20, { sourceInSec: 5 })

    expect(previewPrerollTarget(c, 10 - PREVIEW_PREROLL_SEC - 0.01, false)).toBeNull()
    expect(previewPrerollTarget(c, 10, false)).toBeNull()
  })

  it('源入点太靠前时不预卷（从 0 起播到切点仍会超前）', () => {
    const c = clip('a', 10, 20, { sourceInSec: 0.1 })

    expect(previewPrerollTarget(c, 10 - PREVIEW_PREROLL_SEC, false)).toBeNull()
  })
})
