import { describe, expect, it } from 'vitest'
import { BUILTIN_FONTS, FPS_30 } from '@shared/constants'
import { createDefaultProject, createTextElementClip, normalizeProject } from '@shared/projectSchema'
import {
  DEFAULT_TEXT_ANIMATION,
  TEXT_PRESETS,
  getTextPreset,
  resolveTextStyle,
  validateTextPresets
} from '@shared/textPresets'
import type { FontRecord, TextElementClip } from '@shared/types'
import { buildRenderJob } from '../src/renderer/src/render/jobBuilder'
import { renderFrame } from '../src/renderer/src/render/renderer'

/** M7：文本元素预设 / schema 归一 / 渲染接线。 */

const fontIndex: FontRecord[] = BUILTIN_FONTS.map((meta) => ({
  ...meta,
  source: 'builtin',
  bytes: 1024,
  sha1: '',
  importedAt: '2026-01-01T00:00:00.000Z'
}))

describe('textPresets：7 套起始预设', () => {
  it('预设表自检全绿（颜色/锚点/字号/行数/示例文案）', () => {
    expect(validateTextPresets()).toEqual([])
    expect(TEXT_PRESETS).toHaveLength(7)
  })

  it('resolveTextStyle：预设 + 覆盖合并，数值夹取', () => {
    const style = resolveTextStyle('personTag', {
      color: '#FFD400',
      sizePx: 999,
      anchorXPct: -20,
      plate: { enabled: true, opacity: 3 }
    })
    expect(style.color).toBe('#FFD400')
    expect(style.sizePx).toBe(400)
    expect(style.anchorXPct).toBe(0)
    expect(style.plate.enabled).toBe(true)
    expect(style.plate.opacity).toBe(1)
    // 未覆盖的字段保留预设值（人名条默认字重 700）
    expect(style.weight).toBe(700)
  })

  it('resolveTextStyle：plate 局部覆盖不会丢预设的底色/圆角', () => {
    const style = resolveTextStyle('cornerBadge', { plate: { opacity: 0.5 } })
    const preset = getTextPreset('cornerBadge')
    expect(style.plate.color).toBe(preset.style.plate?.color)
    expect(style.plate.opacity).toBe(0.5)
  })

  it('未知预设 id 回退到默认预设（不抛错）', () => {
    const style = resolveTextStyle('nope' as never)
    expect(style.sizePx).toBeGreaterThan(0)
  })
})

describe('schema：文本元素归一', () => {
  function rawProject(textClips: unknown[]): Record<string, unknown> {
    const project = createDefaultProject('文本元素')
    return { ...JSON.parse(JSON.stringify(project)), textClips }
  }

  it('合法条目保留；空白文案 / 非对象 / 缺字段的条目被丢弃', () => {
    const parsed = normalizeProject(
      rawProject([
        {
          id: 't1',
          text: '今日头条',
          presetId: 'newsHeadline',
          startTime: 1,
          endTime: 3,
          styleOverrides: { sizePx: 999, color: '不是颜色', align: 'center' },
          animation: { inDurationSec: 9, outDurationSec: 9, easing: 'bounce', risePx: -5 }
        },
        { id: 't2', text: '   ' },
        'bad',
        { id: 't3', text: '无预设', presetId: 'unknown' }
      ])
    )!
    expect(parsed.textClips).toHaveLength(2)
    // 归一后按入点排序：t3（缺省 0s）在前，t1（1s）在后
    const first = parsed.textClips!.find((clip) => clip.id === 't1')!
    expect(first.styleOverrides.sizePx).toBe(400)
    expect(first.styleOverrides.color).toBeUndefined()
    expect(first.styleOverrides.align).toBe('center')
    // 动画：时长夹到上限 2s、未知缓动回退默认、上浮量夹到 0
    expect(first.animation.inDurationSec).toBe(2)
    expect(first.animation.easing).toBe(DEFAULT_TEXT_ANIMATION.easing)
    expect(first.animation.risePx).toBe(0)
    // 未知预设回退默认
    expect(parsed.textClips![1]!.presetId).toBe(TEXT_PRESETS[0]!.id)
  })

  it('默认工程没有 textClips 键（旧工程 JSON 形状不变）', () => {
    const project = createDefaultProject('普通工程')
    const parsed = normalizeProject(JSON.parse(JSON.stringify(project)))!
    expect(parsed.textClips).toBeUndefined()
  })

  it('createTextElementClip：默认 5s、默认预设示例文案、轨道固定', () => {
    const clip = createTextElementClip({ startTime: 2, fps: FPS_30 })
    expect(clip.startTime).toBe(2)
    expect(clip.endTime).toBe(7)
    expect(clip.trackId).toBe('track-text')
    expect(clip.text).toBe(getTextPreset(clip.presetId).sampleText)
  })

  it('只有文本元素、没有字幕条时，渲染 job 的区间仍然覆盖文本元素（导出不会空）', async () => {
    const project = createDefaultProject('纯文本')
    project.fps = FPS_30
    project.textClips = [
      {
        id: 'text-1',
        text: '今日头条',
        presetId: 'newsHeadline',
        styleOverrides: {},
        startTime: 1,
        endTime: 3,
        trackId: 'track-text',
        animation: { ...DEFAULT_TEXT_ANIMATION }
      } satisfies TextElementClip
    ]
    const job = await buildRenderJob({ project, fontIndex, scope: { kind: 'timeline' } })
    expect(job.textClips).toHaveLength(1)
    expect(job.textClips![0]!.startFrame).toBe(30)
    expect(job.textClips![0]!.endFrame).toBe(90)
    // 活动区间包含文本元素（否则 restrictToActiveSpan 的导出会切掉它）
    expect(job.endFrame).toBeGreaterThanOrEqual(90)
  })
})

/* ------------------------------------------------------------------------- */
/* 渲染：用录制式假上下文断言文本元素真的落笔                                  */
/* ------------------------------------------------------------------------- */

interface Call {
  fn: string
  args: string[]
  alpha?: number
}

function createFakeCtx(): { calls: Call[]; globalAlpha: number } & Record<string, unknown> {
  const calls: Call[] = []
  const ctx: Record<string, unknown> = { calls, globalAlpha: 1, fillStyle: '', font: '', textBaseline: '', textAlign: '' }
  const record = (fn: string) => (...args: unknown[]): void => {
    const call: Call = { fn, args: args.map((value) => (typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value))) }
    if (fn === 'fillText' || fn === 'fill') call.alpha = Math.round(((ctx['globalAlpha'] as number) ?? 1) * 1000) / 1000
    calls.push(call)
  }
  for (const fn of ['save', 'restore', 'setTransform', 'clearRect', 'beginPath', 'rect', 'roundRect', 'clip', 'fill', 'fillRect', 'fillText', 'strokeText', 'translate', 'rotate', 'scale']) {
    ctx[fn] = record(fn)
  }
  return ctx as never
}

async function textJob(presetId: TextElementClip['presetId']): Promise<{ job: Awaited<ReturnType<typeof buildRenderJob>>; clip: TextElementClip }> {
  const project = createDefaultProject('文本渲染')
  project.fps = FPS_30
  const clip = createTextElementClip({ startTime: 0, fps: FPS_30, presetId, text: '今日头条' })
  clip.endTime = 5
  project.textClips = [clip]
  const job = await buildRenderJob({ project, fontIndex, scope: { kind: 'timeline' } })
  return { job, clip }
}

describe('渲染：文本元素落笔', () => {
  it('稳态帧画出文案，字号按 1080p 基准（画高 1080 时不缩放）', async () => {
    const { job } = await textJob('newsHeadline')
    const ctx = createFakeCtx()
    renderFrame(ctx as never, job, 60)
    const texts = ctx.calls.filter((call) => call.fn === 'fillText')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts[0]!.args[0]).toBe('今日头条')
    expect(ctx.calls.some((call) => call.fn === 'fill')).toBe(false) // 新闻标题预设没有背景板
  })

  it('入场首帧接近透明、稳态帧不透明；出场末段淡出', async () => {
    const { job } = await textJob('newsHeadline')
    const entry = createFakeCtx()
    renderFrame(entry as never, job, 0)
    const entryText = entry.calls.find((call) => call.fn === 'fillText')
    expect(entryText?.alpha ?? 0).toBeLessThan(0.2)

    const stable = createFakeCtx()
    renderFrame(stable as never, job, 60)
    expect(stable.calls.find((call) => call.fn === 'fillText')?.alpha).toBe(1)

    // 出场：outCubic 在最后 6 帧内淡出（149 帧时 alpha 已为 0，完全不再落笔）
    const exit = createFakeCtx()
    renderFrame(exit as never, job, 148)
    const lastDrawn = exit.calls.find((call) => call.fn === 'fillText')
    expect(lastDrawn?.alpha ?? 0).toBeLessThan(0.05)
    const gone = createFakeCtx()
    renderFrame(gone as never, job, 149)
    expect(gone.calls.some((call) => call.fn === 'fillText')).toBe(false)
  })

  it('带背景板的预设会先画板（fill 一次）再画字', async () => {
    const { job } = await textJob('cornerBadge')
    const ctx = createFakeCtx()
    renderFrame(ctx as never, job, 60)
    const fillIndex = ctx.calls.findIndex((call) => call.fn === 'fill')
    const textIndex = ctx.calls.findIndex((call) => call.fn === 'fillText')
    expect(fillIndex).toBeGreaterThanOrEqual(0)
    expect(textIndex).toBeGreaterThan(fillIndex)
  })

  it('时间窗外完全不画（不产生 fillText）', async () => {
    const { job } = await textJob('newsHeadline')
    const ctx = createFakeCtx()
    renderFrame(ctx as never, job, job.textClips![0]!.endFrame + 5)
    expect(ctx.calls.some((call) => call.fn === 'fillText')).toBe(false)
  })
})
