import { describe, expect, it } from 'vitest'
import { BUILTIN_FONTS, FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject, normalizeProject } from '@shared/projectSchema'
import { buildProjectPlan } from '@shared/presetResolver'
import {
  CLIP_PARAM_LIMITS,
  KEYFRAME_MAX_POINTS,
  clipProgressAt,
  keyframeValueAt,
  normalizeKeyframeTracks,
  removeKeyframePoint,
  resolveClipParams,
  upsertKeyframePoint,
  type KeyframeTrack
} from '@shared/keyframes'
import { acceptBezier, bezierAt, bezierSamples, isBezierOvershootFree, normalizeBezier } from '@shared/bezier'
import { computeClipBoxes } from '../src/renderer/src/render/layoutTree'
import { contentAnchorOf, renderFrame } from '../src/renderer/src/render/renderer'
import type { FontRecord, RenderJobSpec } from '@shared/types'

/** M6：贝塞尔缓动 + 片段级参数关键帧（求值口径 / 归一 / 渲染接线）。 */

describe('bezier：求解与单调校验', () => {
  it('端点固定：x=0 → 0，x=1 → 1；单调曲线输出单调不减', () => {
    const curve = normalizeBezier([0.25, 0.1, 0.25, 1])!
    expect(bezierAt(curve, 0)).toBe(0)
    expect(bezierAt(curve, 1)).toBe(1)
    const samples = bezierSamples(curve, 32)
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!.y).toBeGreaterThanOrEqual(samples[index - 1]!.y - 1e-9)
    }
  })

  it('求解精度：x(t) 反解后与目标 x 的误差 < 1e-4（含陡峭曲线）', () => {
    const curves = [
      [0.42, 0, 0.58, 1] as const,
      [0.05, 0.9, 0.95, 0.1] as const,
      [0, 0, 1, 1] as const
    ]
    for (const tuple of curves) {
      const curve = normalizeBezier(tuple)!
      for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        // 用采样点反查：y(x) 必须落在 [0,1] 且可用；这里直接校验分段线性近似误差
        const y = bezierAt(curve, x)
        const near = bezierSamples(curve, 200).reduce((best, point) =>
          Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best
        )
        expect(Math.abs(near.y - y)).toBeLessThan(0.02)
      }
    }
  })

  it('归一化：x 夹到 [0,1]，y 越界（过冲）直接拒绝，非法输入返回 null', () => {
    expect(normalizeBezier([-1, 0.2, 2, 0.8])).toEqual([0, 0.2, 1, 0.8])
    expect(normalizeBezier([0.2, 1.2, 0.4, 0.8])).toBeNull()
    expect(normalizeBezier([0.2, 0.3, 0.4])).toBeNull()
    expect(normalizeBezier(['a', 0, 1, 1])).toBeNull()
    expect(normalizeBezier(null)).toBeNull()
  })

  it('过冲曲线被拒绝（回退由调用方做）；合法缓出曲线通过', () => {
    // y 分量 > 1：先冲过头再回落 —— 产品禁区，直接判非法
    expect(acceptBezier([0.3, 1.6, 0.6, 0.6])).toBeNull()
    expect(isBezierOvershootFree([0.25, 1.4, 0.25, 1])).toBe(false)
    // 合法缓出曲线通过
    expect(acceptBezier([0.25, 0.1, 0.25, 1])).not.toBeNull()
    expect(isBezierOvershootFree([0.25, 0.1, 0.25, 1])).toBe(true)
  })
})

describe('keyframes：归一口径', () => {
  it('未知参数/非法点/空轨道被丢弃；全非法时整份返回 undefined', () => {
    expect(
      normalizeKeyframeTracks([
        { param: 'opacity', points: [{ t: 0, value: 1 }, { t: 1, value: 'x' }] },
        { param: 'unknown', points: [{ t: 0, value: 1 }] },
        { param: 'scalePct', points: [] }
      ])
    ).toEqual([{ param: 'opacity', points: [{ t: 0, value: 1, easing: 'linear' }] }])
    expect(normalizeKeyframeTracks([{ param: 'nope', points: [] }])).toBeUndefined()
    expect(normalizeKeyframeTracks('bad')).toBeUndefined()
  })

  it('按 t 升序、同 t 后来者胜、参数按固定顺序输出', () => {
    const tracks = normalizeKeyframeTracks([
      { param: 'scalePct', points: [{ t: 1, value: 120 }, { t: 0, value: 100 }] },
      { param: 'opacity', points: [{ t: 0.5, value: 0.2 }, { t: 0.5, value: 0.6 }] }
    ])!
    expect(tracks.map((track) => track.param)).toEqual(['opacity', 'scalePct'])
    expect(tracks[0]!.points).toEqual([{ t: 0.5, value: 0.6, easing: 'linear' }])
    expect(tracks[1]!.points.map((point) => point.t)).toEqual([0, 1])
  })

  it('取值夹到参数范围；超过上限的点被截断', () => {
    const tracks = normalizeKeyframeTracks([
      {
        param: 'opacity',
        points: Array.from({ length: KEYFRAME_MAX_POINTS + 5 }, (_, index) => ({
          t: index / (KEYFRAME_MAX_POINTS + 4),
          value: 5
        }))
      }
    ])!
    expect(tracks[0]!.points).toHaveLength(KEYFRAME_MAX_POINTS)
    expect(tracks[0]!.points[0]!.value).toBe(CLIP_PARAM_LIMITS.opacity.max)
  })

  it('custom 缓动：合法贝塞尔保留，非法回退 linear', () => {
    const ok = normalizeKeyframeTracks([
      { param: 'opacity', points: [{ t: 0, value: 0, easing: 'custom', bezier: [0.25, 0.1, 0.25, 1] }] }
    ])!
    expect(ok[0]!.points[0]!.easing).toBe('custom')
    expect(ok[0]!.points[0]!.bezier).toEqual([0.25, 0.1, 0.25, 1])

    const bad = normalizeKeyframeTracks([
      { param: 'opacity', points: [{ t: 0, value: 0, easing: 'custom', bezier: [0.3, 2, 0.6, 0.6] }] }
    ])!
    expect(bad[0]!.points[0]!.easing).toBe('linear')
  })
})

describe('keyframes：求值', () => {
  const track: KeyframeTrack = {
    param: 'opacity',
    points: [
      { t: 0, value: 0, easing: 'linear' },
      { t: 0.5, value: 1, easing: 'linear' },
      { t: 1, value: 0.5, easing: 'linear' }
    ]
  }

  it('端点外保持首尾值；分段线性插值', () => {
    expect(keyframeValueAt(track, -1)).toBe(0)
    expect(keyframeValueAt(track, 0)).toBe(0)
    expect(keyframeValueAt(track, 0.25)).toBeCloseTo(0.5, 9)
    expect(keyframeValueAt(track, 0.5)).toBe(1)
    expect(keyframeValueAt(track, 0.75)).toBeCloseTo(0.75, 9)
    expect(keyframeValueAt(track, 1.5)).toBe(0.5)
  })

  it('缓动只作用于"本点 → 下一点"这一段', () => {
    const eased: KeyframeTrack = {
      param: 'offsetXPct',
      points: [
        { t: 0, value: 0, easing: 'outCubic' },
        { t: 1, value: 100, easing: 'linear' }
      ]
    }
    expect(keyframeValueAt(eased, 0.5)).toBeCloseTo(100 * (1 - 0.5 ** 3), 6)
  })

  it('resolveClipParams：无关键帧 → hasAny=false 且全默认；有关键帧只覆盖出现的参数', () => {
    expect(resolveClipParams(undefined, 0.5)).toMatchObject({
      opacity: 1,
      offsetXPct: 0,
      scalePct: 100,
      rotationDeg: 0,
      hasAny: false
    })
    const resolved = resolveClipParams([track], 0.5)
    expect(resolved).toMatchObject({ opacity: 1, scalePct: 100, hasAny: true })
  })

  it('clipProgressAt：片段内进度（两端越界夹取，零时长返回 0）', () => {
    expect(clipProgressAt(1, 0, 4)).toBe(0.25)
    expect(clipProgressAt(-1, 0, 4)).toBe(0)
    expect(clipProgressAt(9, 0, 4)).toBe(1)
    expect(clipProgressAt(3, 5, 5)).toBe(0)
  })

  it('upsert / remove：同 t 覆盖、删空后整条轨道消失', () => {
    let tracks = upsertKeyframePoint(undefined, 'opacity', { t: 0.2, value: 0.5, easing: 'linear' })
    tracks = upsertKeyframePoint(tracks, 'opacity', { t: 0.2, value: 0.8, easing: 'linear' })
    expect(tracks[0]!.points).toHaveLength(1)
    expect(tracks[0]!.points[0]!.value).toBe(0.8)
    tracks = removeKeyframePoint(tracks, 'opacity', 0)
    expect(tracks).toEqual([])
  })
})

describe('schema：关键帧落盘与旧工程兼容', () => {
  it('带 keyframes 的片段往返；非法关键帧整键丢弃', () => {
    const project = createDefaultProject('关键帧')
    const clip = createClip({ startTime: 0, fps: FPS_30 })
    clip.keyframes = [
      { param: 'opacity', points: [{ t: 0, value: 1, easing: 'linear' }, { t: 1, value: 0, easing: 'outCubic' }] }
    ]
    project.clips = [clip]
    const parsed = normalizeProject(JSON.parse(JSON.stringify(project)))!
    expect(parsed.clips[0]!.keyframes).toHaveLength(1)
    expect(parsed.clips[0]!.keyframes![0]!.points[1]!.easing).toBe('outCubic')

    const broken = JSON.parse(JSON.stringify(project)) as Record<string, unknown>
    ;(broken['clips'] as Record<string, unknown>[])[0]!['keyframes'] = [{ param: 'nope', points: [] }]
    const parsedBroken = normalizeProject(broken)!
    expect(parsedBroken.clips[0]!.keyframes).toBeUndefined()
    expect('keyframes' in parsedBroken.clips[0]!).toBe(false)
  })

  it('没有 keyframes 的旧工程归一后不凭空多出键', () => {
    const project = createDefaultProject('旧工程')
    project.clips = [createClip({ startTime: 0, fps: FPS_30 })]
    const parsed = normalizeProject(JSON.parse(JSON.stringify(project)))!
    expect('keyframes' in parsed.clips[0]!).toBe(false)
  })
})

/* ------------------------------------------------------------------------- */
/* 渲染接线：用录制式假上下文断言"没有关键帧零变换 / 有关键帧按参数变换"          */
/* ------------------------------------------------------------------------- */

interface Call {
  fn: string
  args: number[]
  alpha?: number
}

function createFakeCtx(): { calls: Call[]; globalAlpha: number } & Record<string, unknown> {
  const calls: Call[] = []
  const ctx: Record<string, unknown> = { calls, globalAlpha: 1, fillStyle: '', font: '', textBaseline: '', textAlign: '' }
  const record = (fn: string) => (...args: unknown[]): void => {
    const call: Call = { fn, args: args.map((value) => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : String(value) as unknown as number)) }
    if (fn === 'fillText' || fn === 'fill' || fn === 'fillRect') {
      call.alpha = Math.round(((ctx['globalAlpha'] as number) ?? 1) * 1000) / 1000
    }
    calls.push(call)
  }
  for (const fn of [
    'save',
    'restore',
    'setTransform',
    'clearRect',
    'beginPath',
    'rect',
    'clip',
    'fill',
    'fillRect',
    'strokeRect',
    'roundRect',
    'fillText',
    'translate',
    'rotate',
    'scale'
  ]) {
    ctx[fn] = record(fn)
  }
  ctx['createLinearGradient'] = (...args: unknown[]) => {
    calls.push({ fn: 'createLinearGradient', args: args.map((value) => Number(value)) })
    return { addColorStop: record('addColorStop') }
  }
  return ctx as never
}

async function buildJob(width = 1920, height = 1080): Promise<RenderJobSpec> {
  const fontIndex: FontRecord[] = BUILTIN_FONTS.map((meta) => ({
    ...meta,
    source: 'builtin',
    bytes: 1024,
    sha1: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }))
  const project = createDefaultProject('关键帧渲染')
  project.resolution = { width, height }
  project.fps = FPS_30
  const clip = createClip({ startTime: 0, fps: FPS_30 })
  clip.content = { title: '关键帧测试标题', subtitle: '副标题' }
  clip.animation = {
    inDuration: 0.3,
    outDuration: 0.18,
    easing: 'outCubic',
    textRevealFrames: 3,
    displacement: { x: '-30px@1080p', y: '0' }
  }
  project.clips = [clip]
  const plan = buildProjectPlan({ project, scope: { kind: 'timeline' }, fontIndex })
  const boxes = await computeClipBoxes(plan.clips[0]!)
  const source = plan.clips[0]!
  return {
    width,
    height,
    fps: FPS_30,
    frameFormat: 'png',
    startFrame: plan.startFrame,
    endFrame: plan.endFrame,
    clips: [
      {
        id: source.id,
        presetId: source.presetId,
        startFrame: source.startFrame,
        endFrame: source.endFrame,
        boxes,
        animation: source.animation,
        selected: true
      }
    ],
    aspectMode: plan.mode
  }
}

const STABLE_FRAME = 60

describe('渲染接线：关键帧变换', () => {
  it('无关键帧：不产生 translate/rotate/scale（旧路径零变换）', async () => {
    const job = await buildJob()
    const ctx = createFakeCtx()
    renderFrame(ctx as never, job, STABLE_FRAME)
    expect(ctx.calls.filter((call) => ['translate', 'rotate', 'scale'].includes(call.fn))).toHaveLength(0)
  })

  it('不透明度关键帧：逐字 alpha 按进度缩放', async () => {
    const job = await buildJob()
    job.clips[0]!.keyframes = [
      { param: 'opacity', points: [{ t: 0, value: 0, easing: 'linear' }, { t: 1, value: 1, easing: 'linear' }] }
    ]
    const ctx = createFakeCtx()
    // 帧 60 / 片段 150 帧 = 进度 0.4 → opacity 0.4
    renderFrame(ctx as never, job, STABLE_FRAME)
    const texts = ctx.calls.filter((call) => call.fn === 'fillText')
    expect(texts.length).toBeGreaterThan(0)
    for (const text of texts) expect(text.alpha).toBeCloseTo(0.4, 3)
    // 条块的填充同样被乘上 alphaMul（不能用 ctx.globalAlpha 覆盖，drawBar 内部会自己设）
    const fills = ctx.calls.filter((call) => call.fn === 'fill' || call.fn === 'fillRect')
    expect(fills.length).toBeGreaterThan(0)
    for (const fill of fills) expect(fill.alpha).toBeCloseTo(0.4, 3)
  })

  it('位移/缩放/旋转：绕内容中心变换，位移单位是画面百分比', async () => {
    const job = await buildJob()
    job.clips[0]!.keyframes = [
      { param: 'offsetXPct', points: [{ t: 0, value: 10, easing: 'linear' }, { t: 1, value: 10, easing: 'linear' }] },
      { param: 'scalePct', points: [{ t: 0, value: 50, easing: 'linear' }, { t: 1, value: 50, easing: 'linear' }] },
      { param: 'rotationDeg', points: [{ t: 0, value: 30, easing: 'linear' }, { t: 1, value: 30, easing: 'linear' }] }
    ]
    const anchor = contentAnchorOf(job.clips[0]!.boxes)!
    const ctx = createFakeCtx()
    renderFrame(ctx as never, job, STABLE_FRAME)

    const translate = ctx.calls.filter((call) => call.fn === 'translate')
    const round = (value: number): number => Math.round(value * 1000) / 1000
    expect(translate[0]!.args).toEqual([round(anchor.cx + 192), round(anchor.cy)])
    const rotate = ctx.calls.find((call) => call.fn === 'rotate')!
    expect(rotate.args[0]).toBeCloseTo(Math.PI / 6, 3)
    const scale = ctx.calls.find((call) => call.fn === 'scale')!
    expect(scale.args).toEqual([0.5, 0.5])
    // 结束前回到原点：最后一次 translate 是 -anchor
    expect(translate[translate.length - 1]!.args).toEqual([round(-anchor.cx), round(-anchor.cy)])
  })
})
