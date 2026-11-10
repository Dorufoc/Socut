import { describe, expect, it } from 'vitest'
import type { MediaClip } from '@shared/types'
import {
  PREVIEW_HOLD_SEC,
  PREVIEW_LOOKAHEAD_SEC,
  PREVIEW_MAX_CANDIDATES,
  PREVIEW_PREROLL_SEC,
  PREVIEW_ROLL_IN_SEC,
  hasSeamSuccessor,
  isClipActiveAt,
  latestEndedClip,
  previewClipStartSourceTime,
  previewPrerollPlan,
  previewSourceTimeAt,
  previewTransitionSourceTime,
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
    trackId: 'track-media-0',
    ...patch
  }
}

/** 媒体轨 id → 绘制序号（0 = 最底层），与 `mediaTrackOrder` 同口径。 */
function trackOrder(...ids: string[]): Map<string, number> {
  return new Map(ids.map((id, index) => [id, index]))
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
  const oneTrack = trackOrder('track-media-0')

  it('当前图层全部保留，按轨道升序（底层先画、上层后画）', () => {
    const tracks = [
      clip('top', 0, 10, { trackId: 'track-media-2' }),
      clip('bottom', 0, 10, { trackId: 'track-media-0' }),
      clip('middle', 0, 10, { trackId: 'track-media-1' })
    ]

    expect(
      selectPreviewCandidates(tracks, 5, trackOrder('track-media-0', 'track-media-1', 'track-media-2')).map(
        (c) => c.id
      )
    ).toEqual(['bottom', 'middle', 'top'])
  })

  it('不同轨道同时重叠的段全部保留：底层在前、上层最后', () => {
    const order = trackOrder('track-media-0', 'track-media-1')
    const bottom = clip('bottom', 0, 10, { trackId: 'track-media-0' })
    const top = clip('top', 2, 8, { trackId: 'track-media-1' })

    expect(selectPreviewCandidates([top, bottom], 5, order).map((c) => c.id)).toEqual(['bottom', 'top'])
  })

  it('当前段排在最前，刚结束的段紧随其后', () => {
    const tracks = [clip('old', 0, 2), clip('newer', 2, 4), clip('next', 4, 6)]

    expect(selectPreviewCandidates(tracks, 4.2, oneTrack).map((c) => c.id)).toEqual(['next', 'newer'])
  })

  it('超过 hold 窗口的段不再保留', () => {
    const tracks = [clip('old', 0, 2)]

    expect(selectPreviewCandidates(tracks, 2 + PREVIEW_HOLD_SEC + 0.01, oneTrack)).toEqual([])
  })

  it('前瞻窗口内的下一段提前挂载，窗口外的暂不挂', () => {
    const inside = clip('inside', 3, 5)
    const outside = clip('outside', 3 + PREVIEW_LOOKAHEAD_SEC + 0.01, 8)

    expect(selectPreviewCandidates([inside, outside], 1, oneTrack).map((c) => c.id)).toEqual(['inside'])
    // 1 + 2 = 3，正好在窗口边界；再早 0.5s 就不该挂
    expect(selectPreviewCandidates([inside, outside], 0.5, oneTrack)).toEqual([])
    expect(selectPreviewCandidates([outside], 1, oneTrack)).toEqual([])
  })

  it('候选总数受限，但当前图层永远全部保留', () => {
    const active = Array.from({ length: PREVIEW_MAX_CANDIDATES + 2 }, (_, i) =>
      clip(`active-${i}`, 0, 10, { trackId: `track-media-${i + 1}` })
    )
    const upcoming = clip('upcoming', 10.5, 12)

    const selected = selectPreviewCandidates(
      [...active, upcoming],
      5,
      trackOrder('track-media-0', ...active.map((c) => c.trackId))
    )
    expect(selected).toHaveLength(PREVIEW_MAX_CANDIDATES + 2)
    expect(selected.some((c) => c.id === 'upcoming')).toBe(false)
  })

  it('切点处当前段在前、上一段作为兜底保留，且不会重复', () => {
    const tracks = [clip('a', 0, 2), clip('b', 2, 4)]

    expect(selectPreviewCandidates(tracks, 2, oneTrack).map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('多轨 + 多 hold 时，即将开始的段不会被兜底段挤出候选池', () => {
    const order = trackOrder('track-media-0', 'track-media-1')
    const tracks = [
      clip('bottom', 4, 10, { trackId: 'track-media-0' }),
      clip('top', 4, 10, { trackId: 'track-media-1' }),
      clip('hold-late', 3.9, 4.1),
      clip('hold-early', 3.8, 4.0),
      clip('next', 4.5, 6)
    ]

    // 上限 4：两个活动层 + upcoming 之后只剩 1 个名额，保留结束更近的 hold
    expect(selectPreviewCandidates(tracks, 4.2, order).map((c) => c.id)).toEqual([
      'bottom',
      'top',
      'next',
      'hold-late'
    ])
  })

  it('候选上限只裁剪 held：更早结束的段先被丢弃', () => {
    const order = trackOrder('track-media-0', 'track-media-1')
    const tracks = [
      clip('bottom', 4, 10, { trackId: 'track-media-0' }),
      clip('top', 4, 10, { trackId: 'track-media-1' }),
      clip('hold-a', 3.9, 4.1),
      clip('hold-b', 3.85, 4.05),
      clip('hold-c', 3.8, 4.0)
    ]

    expect(selectPreviewCandidates(tracks, 4.2, order).map((c) => c.id)).toEqual([
      'bottom',
      'top',
      'hold-a',
      'hold-b'
    ])
  })

  it('回绕前瞻：d + s <= 前瞻窗口才纳入，窗口外不挂', () => {
    const loop = 10
    const head = clip('head', 0.5, 1.5)
    // 距回绕 1.5s：1.5 + 0.5 = 2.0 正好在前瞻窗口边界
    expect(
      selectPreviewCandidates([head], 8.5, oneTrack, undefined, { loopDurationSec: loop }).map((c) => c.id)
    ).toEqual(['head'])
    // 再早 0.1s（d = 1.6）就超出窗口
    expect(selectPreviewCandidates([head], 8.4, oneTrack, undefined, { loopDurationSec: loop })).toEqual([])

    const zero = clip('zero', 0, 1)
    expect(
      selectPreviewCandidates([zero], 8, oneTrack, undefined, { loopDurationSec: loop }).map((c) => c.id)
    ).toEqual(['zero'])
    expect(selectPreviewCandidates([zero], 7.99, oneTrack, undefined, { loopDurationSec: loop })).toEqual([])
  })

  it('回绕候选排在本轮末尾即将开始的段之后（按有效起点升序）', () => {
    const loop = 10
    const tracks = [clip('tail', 9.2, 9.6), clip('head-a', 0.5, 1), clip('head-b', 0.8, 1.2)]

    expect(
      selectPreviewCandidates(tracks, 8.9, oneTrack, undefined, { loopDurationSec: loop }).map((c) => c.id)
    ).toEqual(['tail', 'head-a', 'head-b'])
  })

  it('转场窗口两侧强制保留：左侧超过 hold 仍为右侧的转场候选', () => {
    const prev = clip('prev', 0, 2, { sourceInSec: 0, sourceOutSec: 2 })
    // 右侧 sourceIn 1s → 最大转场 1.5s，窗口到 2.75s
    const right = clip('right', 2, 4.5, {
      sourceInSec: 1,
      sourceOutSec: 3.5,
      transitionIn: { type: 'dissolve', durationSec: 1.5 }
    })

    // 2.7s：左侧已结束 0.7s，超出普通 hold 0.5s，单独选候选不会保留它
    expect(selectPreviewCandidates([prev, right], 2.7, oneTrack).map((c) => c.id)).toEqual(['right'])
    expect(
      selectPreviewCandidates([prev, right], 2.7, oneTrack, { leftId: 'prev', rightId: 'right' }).map(
        (c) => c.id
      )
    ).toEqual(['right', 'prev'])
  })

  it('转场两侧在切点前也一定同时挂载（右侧即使不在前瞻窗口）', () => {
    const prev = clip('prev', 0, 2, { sourceInSec: 0, sourceOutSec: 2 })
    const right = clip('right', 2, 4.5, {
      sourceInSec: 1,
      sourceOutSec: 3.5,
      transitionIn: { type: 'dissolve', durationSec: 1.5 }
    })

    // 1.3s：右侧起点 2s 在前瞻窗口内；显式转场对必须同时保留
    const selected = selectPreviewCandidates([prev, right], 1.3, oneTrack, [
      { leftId: 'prev', rightId: 'right' }
    ])
    expect(selected.map((c) => c.id)).toEqual(['prev', 'right'])
    expect(selected).toHaveLength(2)
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

describe('previewTransitionSourceTime（转场手柄）', () => {
  it('片段起点前允许负本地时间（后段头部手柄），只钳最终源秒 >= 0', () => {
    const c = clip('a', 10, 20, { sourceInSec: 5, sourceOutSec: 15 })

    expect(previewTransitionSourceTime(c, 10)).toBe(5)
    expect(previewTransitionSourceTime(c, 9.8)).toBeCloseTo(4.8, 9)
    expect(previewTransitionSourceTime(c, 12)).toBe(7)
    // 源秒不会小于 0：起点前的可用手柄已被 resolveTransitionDuration 限制在 sourceIn 内
    expect(previewTransitionSourceTime(clip('early', 10, 20, { sourceInSec: 0.1 }), 9)).toBe(0)
  })

  it('倍速同样作用在手柄上（源秒 = 入点 + 负本地时间 × speed）', () => {
    const c = clip('a', 10, 20, {
      sourceInSec: 5,
      sourceOutSec: 15,
      speed: { speed: 2, maintainPitch: true }
    })

    expect(previewTransitionSourceTime(c, 10)).toBe(5)
    expect(previewTransitionSourceTime(c, 9.8)).toBeCloseTo(4.6, 9)
  })
})

describe('latestEndedClip / hasSeamSuccessor（最后一帧兜底的边界）', () => {
  const a = clip('a', 0, 2)
  const b = clip('b', 2, 4)

  it('latestEndedClip 只认最近结束的一段（更早的段不能重新冒出来）', () => {
    expect(latestEndedClip([a, b], 1.5)).toBeNull()
    expect(latestEndedClip([a, b], 2.05)?.id).toBe('a')
    expect(latestEndedClip([a, b], 4.05)?.id).toBe('b')
  })

  it('hasSeamSuccessor 只认终点处紧贴的下一段：段后空隙 / 轨道末端都不算', () => {
    expect(hasSeamSuccessor(a, [a, b])).toBe(true)
    expect(hasSeamSuccessor(b, [a, b])).toBe(false)
    expect(hasSeamSuccessor(a, [a, clip('gap', 2.5, 4)])).toBe(false)
  })
})

describe('previewPrerollPlan', () => {
  it('进入预卷窗口后从入点前 remaining×speed 起播，切点正好落在入点', () => {
    const c = clip('a', 10, 20, { sourceInSec: 5 })

    expect(previewPrerollPlan(c, 10 - PREVIEW_PREROLL_SEC, false)).toEqual({
      target: 5 - PREVIEW_PREROLL_SEC,
      // 起播窗口之前只暂停摆位：位置固定在「切点前 ROLL_IN 秒」对应的源坐标
      park: 5 - PREVIEW_ROLL_IN_SEC,
      warmup: false
    })
  })

  it('起播窗口内 park 不再前移（暂停摆位只认起播那一刻的位置）', () => {
    const c = clip('a', 10, 20, { sourceInSec: 5 })

    expect(previewPrerollPlan(c, 10 - 0.15, false)).toEqual({
      target: 5 - 0.15,
      park: 5 - PREVIEW_ROLL_IN_SEC,
      warmup: false
    })
  })

  it('窗口外不预卷', () => {
    const c = clip('a', 10, 20, { sourceInSec: 5 })

    expect(previewPrerollPlan(c, 10 - PREVIEW_PREROLL_SEC - 0.01, false)).toBeNull()
    expect(previewPrerollPlan(c, 10, false)).toBeNull()
  })

  it('源入点太靠前时不倒退预卷；给了热身窗口才原地起播（warmup）', () => {
    const c = clip('a', 10, 20, { sourceInSec: 0.02 })

    expect(previewPrerollPlan(c, 10 - PREVIEW_PREROLL_SEC, false)).toBeNull()
    // 切点前 2 帧：原地起播，target 钳到 0，且明确标记 warmup（不能再往回纠偏）
    expect(previewPrerollPlan(c, 10 - 0.05, false, 0.1)).toEqual({
      target: 0,
      park: 0,
      warmup: true
    })
  })
})
