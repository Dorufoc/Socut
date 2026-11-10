import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRANSITION_DURATION_SEC,
  TRANSITIONS,
  TRANSITION_FAMILIES,
  TRANSITION_FAMILY_LABELS,
  TRANSITION_MAP,
  cleanupInvalidTransitions,
  isTransitionAdjacent,
  previousMediaClipOnTrack,
  resolveTransitionDuration,
  transitionGapSec,
  planTransitionExport,
  transitionMaxDurationSec,
  transitionProgressAt,
  transitionWindow,
  transitionsByFamily
} from '@shared/transitions'
import type { TransitionExportInputSegment } from '@shared/transitions'
import { FPS_23_976, FPS_30, TRANSITION_DURATION } from '@shared/constants'
import { durationSecToFrames, frameIntervalSec, framesToDurationSec } from '@shared/fps'
import type { MediaClip, Project } from '@shared/types'

/** v10：19 种转场的元数据、相邻判定与手柄夹取（纯函数，不依赖窗口/IPC）。 */

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    id: over.id ?? 'a',
    mediaId: over.mediaId ?? 'media-1',
    trackId: over.trackId ?? 'track-media-0',
    timelineStartSec: over.timelineStartSec ?? 0,
    timelineEndSec: over.timelineEndSec ?? 2,
    sourceInSec: over.sourceInSec ?? 0,
    sourceOutSec: over.sourceOutSec ?? 2,
    ...over
  }
}

const META = { durationSec: 10 }

describe('转场元数据（58 种 xfade + blurV 别名）', () => {
  /** FFmpeg 9 `xfade` 的 58 个具名 transition（不含 custom）；目录必须一一覆盖。 */
  const FFMPEG9_XFADE = [
    'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown',
    'circlecrop', 'rectcrop', 'distance', 'fadeblack', 'fadewhite', 'radial', 'smoothleft', 'smoothright',
    'smoothup', 'smoothdown', 'circleopen', 'circleclose', 'vertopen', 'vertclose', 'horzopen', 'horzclose',
    'dissolve', 'pixelize', 'diagtl', 'diagtr', 'diagbl', 'diagbr', 'hlslice', 'hrslice', 'vuslice', 'vdslice',
    'hblur', 'fadegrays', 'wipetl', 'wipetr', 'wipebl', 'wipebr', 'squeezeh', 'squeezev', 'zoomin', 'fadefast',
    'fadeslow', 'hlwind', 'hrwind', 'vuwind', 'vdwind', 'coverleft', 'coverright', 'coverup', 'coverdown',
    'revealleft', 'revealright', 'revealup', 'revealdown'
  ]

  it('58 个 xfade 原语全覆盖；旧 19 种 id 保持映射（纵向模糊改用 hblur 近似）', () => {
    const xfades = new Set(TRANSITIONS.map((meta) => meta.xfade))
    expect(xfades.size).toBe(58)
    expect([...xfades].sort()).toEqual([...FFMPEG9_XFADE].sort())

    // 旧工程 id 全部保留，且每个都指向合法 xfade
    for (const type of [
      'dissolve', 'fadeBlack', 'fadeWhite', 'lightFlash', 'blurH', 'blurV',
      'windLeft', 'windRight', 'windUp', 'windDown',
      'pushLeft', 'pushRight', 'pushUp', 'pushDown',
      'pullLeft', 'pullRight', 'pullUp', 'pullDown', 'zoomIn'
    ] as const) {
      expect(TRANSITION_MAP[type]).toBeTruthy()
      expect(FFMPEG9_XFADE).toContain(TRANSITION_MAP[type].xfade)
      expect(TRANSITION_MAP[type].label.length).toBeGreaterThan(0)
    }
    expect(TRANSITION_MAP.blurV.xfade).toBe('hblur')
    expect(TRANSITION_MAP.dissolve.xfade).toBe('fade')
    expect(TRANSITION_MAP.pushLeft.xfade).toBe('coverleft')
  })

  it('59 条目录：类型唯一、中文名唯一、每个类型都进 TRANSITION_MAP', () => {
    expect(TRANSITIONS).toHaveLength(59)
    expect(new Set(TRANSITIONS.map((meta) => meta.type)).size).toBe(59)
    expect(new Set(TRANSITIONS.map((meta) => meta.label)).size).toBe(59)
    for (const meta of TRANSITIONS) {
      expect(TRANSITION_MAP[meta.type]).toBe(meta)
      expect(meta.xfade.length).toBeGreaterThan(0)
    }
  })

  it('按族分组：基础 7 / 模糊 2 / 风感 4 / 推入 4 / 拉出 4 / 运镜 1 / 擦除 20 / 滑动 4 / 形状 10 / 特效 3', () => {
    expect(TRANSITION_FAMILIES).toEqual([
      'basic', 'blur', 'wind', 'push', 'pull', 'camera', 'wipe', 'slide', 'shape', 'effect'
    ])
    const groups = transitionsByFamily()
    expect(groups.map((group) => [group.family, group.label, group.transitions.length])).toEqual([
      ['basic', TRANSITION_FAMILY_LABELS.basic, 7],
      ['blur', TRANSITION_FAMILY_LABELS.blur, 2],
      ['wind', TRANSITION_FAMILY_LABELS.wind, 4],
      ['push', TRANSITION_FAMILY_LABELS.push, 4],
      ['pull', TRANSITION_FAMILY_LABELS.pull, 4],
      ['camera', TRANSITION_FAMILY_LABELS.camera, 1],
      ['wipe', TRANSITION_FAMILY_LABELS.wipe, 20],
      ['slide', TRANSITION_FAMILY_LABELS.slide, 4],
      ['shape', TRANSITION_FAMILY_LABELS.shape, 10],
      ['effect', TRANSITION_FAMILY_LABELS.effect, 3]
    ])
    expect(groups.flatMap((group) => group.transitions)).toHaveLength(59)
  })

  it('默认时长 = 0.5s，范围常量来自 constants', () => {
    expect(DEFAULT_TRANSITION_DURATION_SEC).toBe(0.5)
    expect(DEFAULT_TRANSITION_DURATION_SEC).toBe(TRANSITION_DURATION.default)
  })
})

describe('同轨前段与相邻判定', () => {
  const a = clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 2 })
  const b = clip({ id: 'b', timelineStartSec: 2, timelineEndSec: 4 })
  const otherTrack = clip({ id: 'c', trackId: 'track-media-1', timelineStartSec: 0, timelineEndSec: 2 })

  it('只找同轨、按起始时间排序后的紧邻前一段；首段/跨轨返回 null', () => {
    expect(previousMediaClipOnTrack([a, b, otherTrack], b)?.id).toBe('a')
    expect(previousMediaClipOnTrack([a, b, otherTrack], a)).toBeNull()
    expect(previousMediaClipOnTrack([a, b, otherTrack], otherTrack)).toBeNull()
    // 传入乱序数组也按时间排序
    expect(previousMediaClipOnTrack([b, a], b)?.id).toBe('a')
  })

  it('空隙为后段起点减前段终点；吸附容差 = 半帧', () => {
    expect(transitionGapSec(a, b)).toBe(0)
    expect(isTransitionAdjacent(a, b, FPS_30)).toBe(true)
    const near = clip({ id: 'near', timelineStartSec: 2 + frameIntervalSec(FPS_30) / 2 - 1e-4, timelineEndSec: 4 })
    expect(isTransitionAdjacent(a, near, FPS_30)).toBe(true)
    const far = clip({ id: 'far', timelineStartSec: 2 + frameIntervalSec(FPS_30) / 2 + 1e-4, timelineEndSec: 4 })
    expect(isTransitionAdjacent(a, far, FPS_30)).toBe(false)
  })
})

describe('resolveTransitionDuration：默认值 / 夹取 / 手柄 / 倍速 / 帧吸附', () => {
  const prev = clip({ id: 'prev', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0, sourceOutSec: 2 })
  const right = (over: Partial<MediaClip> = {}): MediaClip =>
    clip({
      id: 'right',
      timelineStartSec: 2,
      timelineEndSec: 4,
      sourceInSec: 0.5,
      sourceOutSec: 2.5,
      transitionIn: { type: 'dissolve', durationSec: 0.5 },
      ...over
    })

  it('没有显式请求时取片段当前时长；没有 transitionIn 且无请求 → no-type', () => {
    const ok = resolveTransitionDuration({ prev, clip: right(), prevMeta: META, clipMeta: META, fps: FPS_30 })
    expect(ok).toMatchObject({ ok: true, durationSec: 0.5, reason: null })

    const noType = resolveTransitionDuration({
      prev,
      clip: right({ transitionIn: undefined }),
      prevMeta: META,
      clipMeta: META,
      fps: FPS_30
    })
    expect(noType).toMatchObject({ ok: false, reason: 'no-type', durationSec: 0 })
  })

  it('不得超过两侧片段时长：后段只有 0.4s 时 0.8s 被夹到 0.4s', () => {
    const short = right({ timelineEndSec: 2.4 })
    const result = resolveTransitionDuration({
      prev,
      clip: short,
      prevMeta: META,
      clipMeta: META,
      requestedSec: 0.8,
      fps: FPS_30
    })
    expect(result.ok).toBe(true)
    expect(result.durationSec).toBeCloseTo(0.4, 9)
    expect(transitionMaxDurationSec({ prev, clip: short, prevMeta: META, clipMeta: META, fps: FPS_30 })).toBeCloseTo(0.4, 9)
  })

  it('手柄不足时按「前段尾 + 后段头」夹取（源秒与时间轴秒同为 1x）', () => {
    const tightPrev = clip({ id: 'prev', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0, sourceOutSec: 9.8 })
    const tightClip = right({ sourceInSec: 0.1 })
    const result = resolveTransitionDuration({
      prev: tightPrev,
      clip: tightClip,
      prevMeta: META,
      clipMeta: META,
      requestedSec: 0.5,
      fps: FPS_30
    })
    expect(result.ok).toBe(true)
    expect(result.durationSec).toBeCloseTo(0.2, 9)
  })

  it('图像两侧都视为无限手柄', () => {
    const imagePrev = resolveTransitionDuration({
      prev,
      clip: right({ timelineEndSec: 2.6 }),
      prevMeta: { durationSec: 5, kind: 'image' },
      clipMeta: META,
      requestedSec: 0.5,
      fps: FPS_30
    })
    expect(imagePrev.ok).toBe(true)
    expect(imagePrev.durationSec).toBeCloseTo(0.5, 9)

    const imageClip = resolveTransitionDuration({
      prev,
      clip: right({ timelineEndSec: 2.4 }),
      prevMeta: META,
      clipMeta: { durationSec: 5, kind: 'image' },
      requestedSec: 0.5,
      fps: FPS_30
    })
    expect(imageClip.ok).toBe(true)
    expect(imageClip.durationSec).toBeCloseTo(0.4, 9)
  })

  it('倍速换算：前段 2x 时同样源尾部手柄只占一半时间轴', () => {
    const fastPrev = clip({
      id: 'prev',
      timelineStartSec: 0,
      timelineEndSec: 2,
      sourceInSec: 0,
      sourceOutSec: 9.8,
      speed: { speed: 2, maintainPitch: true }
    })
    const result = resolveTransitionDuration({
      prev: fastPrev,
      clip: right({ sourceInSec: 0.5 }),
      prevMeta: META,
      clipMeta: META,
      requestedSec: 0.5,
      fps: FPS_30
    })
    expect(result.ok).toBe(true)
    // 源尾 0.2s → 时间轴 0.1s → 转场最多 2×0.1 = 0.2s
    expect(result.durationSec).toBeCloseTo(0.2, 9)
  })

  it('23.976 帧率吸附：0.5s 取 12 帧', () => {
    const result = resolveTransitionDuration({
      prev,
      clip: right(),
      prevMeta: META,
      clipMeta: META,
      requestedSec: 0.5,
      fps: FPS_23_976
    })
    expect(result.ok).toBe(true)
    expect(durationSecToFrames(result.durationSec, FPS_23_976)).toBe(12)
    expect(result.durationSec).toBeCloseTo(framesToDurationSec(12, FPS_23_976), 9)
  })
})

describe('resolveTransitionDuration：禁用原因优先级', () => {
  const prev = clip({ id: 'prev', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0, sourceOutSec: 2 })
  const right = (over: Partial<MediaClip> = {}): MediaClip =>
    clip({
      id: 'right',
      timelineStartSec: 2,
      timelineEndSec: 4,
      sourceInSec: 0.5,
      sourceOutSec: 2.5,
      transitionIn: { type: 'dissolve', durationSec: 0.5 },
      ...over
    })

  it('first：没有同轨前段', () => {
    const result = resolveTransitionDuration({ prev: null, clip: right(), prevMeta: null, clipMeta: META, fps: FPS_30 })
    expect(result).toMatchObject({ ok: false, reason: 'first', durationSec: 0 })
  })

  it('gap：与前段之间有空隙（或重叠超出半帧）', () => {
    const result = resolveTransitionDuration({
      prev,
      clip: right({ timelineStartSec: 3, timelineEndSec: 5 }),
      prevMeta: META,
      clipMeta: META,
      fps: FPS_30
    })
    expect(result).toMatchObject({ ok: false, reason: 'gap' })
  })

  it('no-type：没请求时长且片段没有 transitionIn', () => {
    const result = resolveTransitionDuration({
      prev,
      clip: right({ transitionIn: undefined }),
      prevMeta: META,
      clipMeta: META,
      fps: FPS_30
    })
    expect(result).toMatchObject({ ok: false, reason: 'no-type' })
  })

  it('no-tail：前段 sourceOut 已到素材末尾', () => {
    const result = resolveTransitionDuration({
      prev: clip({ id: 'prev', timelineStartSec: 0, timelineEndSec: 2, sourceOutSec: 2 }),
      clip: right(),
      prevMeta: { durationSec: 2 },
      clipMeta: META,
      fps: FPS_30
    })
    expect(result).toMatchObject({ ok: false, reason: 'no-tail' })
  })

  it('no-head：后段 sourceIn 为 0（没有头部手柄）', () => {
    const result = resolveTransitionDuration({
      prev,
      clip: right({ sourceInSec: 0 }),
      prevMeta: META,
      clipMeta: META,
      fps: FPS_30
    })
    expect(result).toMatchObject({ ok: false, reason: 'no-head' })
  })

  it('too-short：两侧手柄都够，但前段本身不足 0.2s', () => {
    const result = resolveTransitionDuration({
      prev: clip({ id: 'prev', timelineStartSec: 0, timelineEndSec: 0.1, sourceOutSec: 0.1 }),
      clip: right({ timelineStartSec: 0.1, timelineEndSec: 2, sourceInSec: 0.5 }),
      prevMeta: META,
      clipMeta: META,
      fps: FPS_30
    })
    expect(result).toMatchObject({ ok: false, reason: 'too-short' })
  })
})

describe('转场窗口与时相', () => {
  it('居中跨切点：起点/终点各 T/2，切点处进度 0.5', () => {
    const prev = clip({ id: 'prev', timelineStartSec: 0, timelineEndSec: 2 })
    const right = clip({ id: 'right', timelineStartSec: 2, timelineEndSec: 4 })
    expect(transitionWindow(prev, right, 0.5)).toEqual({ startSec: 1.75, endSec: 2.25, cutSec: 2 })
    expect(transitionProgressAt(1.75, 2, 0.5)).toBe(0)
    expect(transitionProgressAt(2, 2, 0.5)).toBe(0.5)
    expect(transitionProgressAt(2.25, 2, 0.5)).toBe(1)
    // 窗口外夹到两端
    expect(transitionProgressAt(1, 2, 0.5)).toBe(0)
    expect(transitionProgressAt(3, 2, 0.5)).toBe(1)
  })
})

describe('planTransitionExport（导出计划：手柄 / offset / run）', () => {
  const VIDEO_META = { durationSec: 10, kind: 'video' as const }
  const input = (clips: MediaClip[], meta = VIDEO_META): TransitionExportInputSegment[] =>
    clips.map((item, index) => ({ index, clip: item, meta }))

  it('两段相邻 + 0.5s 溶解：T=0.5、头尾各 0.25、offset=0.75、总核心时长 2s', () => {
    const plan = planTransitionExport({
      fps: FPS_30,
      segments: input([
        clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }),
        clip({
          id: 'b',
          timelineStartSec: 1,
          timelineEndSec: 2,
          sourceInSec: 0.5,
          sourceOutSec: 1.5,
          transitionIn: { type: 'dissolve', durationSec: 0.5 }
        })
      ])
    })
    expect(plan.hasTransitions).toBe(true)
    expect(plan.runs).toHaveLength(1)
    const [first, second] = plan.runs[0]!.segments
    expect(first).toMatchObject({ headHandleSec: 0, tailHandleSec: 0.25, sourceInExtSec: 0, sourceOutExtSec: 1.25 })
    expect(second).toMatchObject({ headHandleSec: 0.25, tailHandleSec: 0, sourceInExtSec: 0.25, sourceOutExtSec: 1.5 })
    expect(second?.transition).toMatchObject({
      type: 'dissolve',
      xfade: 'fade',
      durationSec: 0.5,
      offsetInRunSec: 0.75
    })
    expect(plan.runs[0]!.segments.reduce((sum, segment) => sum + segment.coreDurationSec, 0)).toBe(2)
    expect(plan.runs[0]!.endSec).toBe(2)
  })

  it('三段两个转场：中间段同时吃头尾，offset 按 run 起点累加', () => {
    const plan = planTransitionExport({
      fps: FPS_30,
      segments: input([
        clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }),
        clip({
          id: 'b',
          timelineStartSec: 1,
          timelineEndSec: 2,
          sourceInSec: 0.5,
          sourceOutSec: 1.5,
          transitionIn: { type: 'dissolve', durationSec: 0.5 }
        }),
        clip({
          id: 'c',
          timelineStartSec: 2,
          timelineEndSec: 3,
          sourceInSec: 0.5,
          sourceOutSec: 1.5,
          transitionIn: { type: 'pushLeft', durationSec: 0.5 }
        })
      ])
    })
    const [a, b, c] = plan.runs[0]!.segments
    expect(a).toMatchObject({ headHandleSec: 0, tailHandleSec: 0.25, sourceOutExtSec: 1.25 })
    expect(b).toMatchObject({ headHandleSec: 0.25, tailHandleSec: 0.25, sourceInExtSec: 0.25, sourceOutExtSec: 1.75 })
    expect(c).toMatchObject({ headHandleSec: 0.25, tailHandleSec: 0, sourceInExtSec: 0.25, sourceOutExtSec: 1.5 })
    expect(b?.transition?.offsetInRunSec).toBe(0.75)
    expect(c?.transition).toMatchObject({ type: 'pushLeft', xfade: 'coverleft', offsetInRunSec: 1.75 })
    expect(plan.runs[0]!.segments.reduce((sum, segment) => sum + segment.coreDurationSec, 0)).toBe(3)
  })

  it('空隙打断 run：跨空隙的转场不生效，两段各成一条 run', () => {
    const plan = planTransitionExport({
      fps: FPS_30,
      segments: input([
        clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }),
        clip({
          id: 'b',
          timelineStartSec: 1.5,
          timelineEndSec: 2.5,
          sourceInSec: 0.5,
          sourceOutSec: 1.5,
          transitionIn: { type: 'dissolve', durationSec: 0.5 }
        })
      ])
    })
    expect(plan.runs).toHaveLength(2)
    expect(plan.runs.map((run) => run.startSec)).toEqual([0, 1.5])
    expect(plan.hasTransitions).toBe(false)
    expect(plan.runs[1]!.segments[0]).toMatchObject({ sourceInExtSec: 0.5, sourceOutExtSec: 1.5, headHandleSec: 0 })
  })

  it('图像视为无限手柄：源入点为 0 也能吃到头部手柄，且扩展链长按输出时长补齐', () => {
    const plan = planTransitionExport({
      fps: FPS_30,
      segments: [
        { index: 0, clip: clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }), meta: VIDEO_META },
        {
          index: 1,
          clip: clip({
            id: 'img',
            timelineStartSec: 1,
            timelineEndSec: 2,
            sourceInSec: 0,
            sourceOutSec: 1,
            transitionIn: { type: 'dissolve', durationSec: 0.5 }
          }),
          meta: { durationSec: 0, kind: 'image' }
        }
      ]
    })
    expect(plan.hasTransitions).toBe(true)
    expect(plan.runs[0]!.segments[1]!.transition?.durationSec).toBe(0.5)
    expect(plan.runs[0]!.segments[1]).toMatchObject({ headHandleSec: 0.25, sourceInExtSec: 0, sourceOutExtSec: 1.25 })
  })

  it('倍速换算：前段 2x 时源尾手柄只折算一半时间轴，T 被夹到 0.4', () => {
    const plan = planTransitionExport({
      fps: FPS_30,
      segments: [
        {
          index: 0,
          clip: clip({
            id: 'a',
            timelineStartSec: 0,
            timelineEndSec: 2,
            sourceInSec: 0,
            sourceOutSec: 4,
            speed: { speed: 2, maintainPitch: true }
          }),
          meta: { durationSec: 4.4, kind: 'video' }
        },
        {
          index: 1,
          clip: clip({
            id: 'b',
            timelineStartSec: 2,
            timelineEndSec: 4,
            sourceInSec: 0.5,
            sourceOutSec: 2.5,
            transitionIn: { type: 'dissolve', durationSec: 0.5 }
          }),
          meta: VIDEO_META
        }
      ]
    })
    const [a, b] = plan.runs[0]!.segments
    expect(b?.transition?.durationSec).toBeCloseTo(0.4, 9)
    expect(a).toMatchObject({ tailHandleSec: 0.2, sourceOutExtSec: 4.4 })
    expect(b).toMatchObject({ headHandleSec: 0.2, sourceInExtSec: 0.3 })
    expect(b?.transition?.offsetInRunSec).toBeCloseTo(1.8, 9)
  })

  it('23.976 帧率吸附：0.5s 请求按 12 帧写入，计划与检查器同一口径', () => {
    const plan = planTransitionExport({
      fps: FPS_23_976,
      segments: input([
        clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }),
        clip({
          id: 'b',
          timelineStartSec: 1,
          timelineEndSec: 2,
          sourceInSec: 0.5,
          sourceOutSec: 1.5,
          transitionIn: { type: 'dissolve', durationSec: 0.5 }
        })
      ])
    })
    const transition = plan.runs[0]!.segments[1]!.transition!
    expect(durationSecToFrames(transition.durationSec, FPS_23_976)).toBe(12)
    expect(transition.durationSec).toBeCloseTo(framesToDurationSec(12, FPS_23_976), 9)
  })

  it('手柄不足 / 无转场：不产生 xfade，hasTransitions=false 且源区间保持核心', () => {
    const noHead = planTransitionExport({
      fps: FPS_30,
      segments: input([
        clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }),
        clip({
          id: 'b',
          timelineStartSec: 1,
          timelineEndSec: 2,
          sourceInSec: 0,
          sourceOutSec: 1,
          transitionIn: { type: 'dissolve', durationSec: 0.5 }
        })
      ])
    })
    expect(noHead.hasTransitions).toBe(false)
    expect(noHead.runs[0]!.segments[0]!.sourceOutExtSec).toBe(1)
    expect(noHead.runs[0]!.segments[1]!.sourceInExtSec).toBe(0)

    const plain = planTransitionExport({
      fps: FPS_30,
      segments: input([
        clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }),
        clip({ id: 'b', timelineStartSec: 1, timelineEndSec: 2, sourceInSec: 0.5, sourceOutSec: 1.5 })
      ])
    })
    expect(plain.hasTransitions).toBe(false)
  })
})

describe('cleanupInvalidTransitions', () => {
  function projectWith(clips: MediaClip[]): Project {
    return {
      version: 3,
      name: '转场清理',
      resolution: { width: 1920, height: 1080 },
      fps: FPS_30,
      clips: [],
      fonts: [],
      media: [
        {
          id: 'media-1',
          path: 'C:/media/a.mp4',
          name: 'a.mp4',
          meta: {
            path: 'C:/media/a.mp4',
            containerName: 'mp4',
            width: 1920,
            height: 1080,
            sar: null,
            displayRatio: 16 / 9,
            rFrameRate: { num: 30, den: 1 },
            avgFrameRate: { num: 30, den: 1 },
            pixFmt: 'yuv420p',
            colorPrimaries: null,
            colorSpace: null,
            colorTransfer: null,
            colorRange: null,
            videoCodec: 'h264',
            audioCodec: 'aac',
            audioChannels: 2,
            durationSec: 10,
            nbFrames: null,
            bitRateKbps: null
          },
          non169Ack: true,
          hdrAck: true,
          vfrPolicy: 'none',
          compactMode: 'auto',
          thumbnailUrl: '',
          importedAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      mediaClips: clips,
      mediaTracks: [{ id: 'track-media-0', kind: 'media', name: '媒体 1', muted: false, hidden: false, locked: false }],
      audioTracks: [{ id: 'track-audio-0', kind: 'audio', name: '音频 1', muted: false, hidden: false, locked: false }],
      subtitleTrack: { id: 'track-subtitle', kind: 'subtitle', name: '字幕', muted: false, hidden: false, locked: false }
    }
  }

  it('首段 / 空隙 / 手柄不足的转场被删除；合法转场保留', () => {
    const first = clip({ id: 'first', timelineStartSec: 0, timelineEndSec: 2, transitionIn: { type: 'dissolve', durationSec: 0.5 } })
    const next = clip({ id: 'next', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 0.5, transitionIn: { type: 'dissolve', durationSec: 0.5 } })
    const cleaned = cleanupInvalidTransitions(projectWith([first, next]), FPS_30)
    expect(cleaned.mediaClips[0]?.transitionIn).toBeUndefined()
    expect(cleaned.mediaClips[1]?.transitionIn?.type).toBe('dissolve')

    const gapClip = clip({ id: 'gap', timelineStartSec: 3, timelineEndSec: 5, sourceInSec: 0.5, transitionIn: { type: 'dissolve', durationSec: 0.5 } })
    const gapCleaned = cleanupInvalidTransitions(projectWith([first, gapClip]), FPS_30)
    expect(gapCleaned.mediaClips.find((item) => item.id === 'gap')?.transitionIn).toBeUndefined()

    const noHead = clip({ id: 'nohead', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 0, transitionIn: { type: 'dissolve', durationSec: 0.5 } })
    const noHeadCleaned = cleanupInvalidTransitions(projectWith([first, noHead]), FPS_30)
    expect(noHeadCleaned.mediaClips.find((item) => item.id === 'nohead')?.transitionIn).toBeUndefined()
  })

  it('手柄变化后时长被夹小写回；无变化时保持原工程引用', () => {
    const first = clip({ id: 'first', timelineStartSec: 0, timelineEndSec: 2, sourceOutSec: 9.8 })
    const next = clip({ id: 'next', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 0.1, transitionIn: { type: 'dissolve', durationSec: 0.6 } })
    const project = projectWith([first, next])
    const cleaned = cleanupInvalidTransitions(project, FPS_30)
    expect(cleaned.mediaClips.find((item) => item.id === 'next')?.transitionIn?.durationSec).toBeCloseTo(0.2, 9)

    const valid = projectWith([
      clip({ id: 'first', timelineStartSec: 0, timelineEndSec: 2, sourceOutSec: 2 }),
      clip({ id: 'next', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 0.5, transitionIn: { type: 'dissolve', durationSec: 0.5 } })
    ])
    expect(cleanupInvalidTransitions(valid, FPS_30)).toBe(valid)
  })
})
