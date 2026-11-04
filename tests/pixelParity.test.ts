import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { buildProjectPlan } from '@shared/presetResolver'
import { BUILTIN_FONTS, FPS_30 } from '@shared/constants'
import { computeClipBoxes } from '../src/renderer/src/render/layoutTree'
import { renderFrame } from '../src/renderer/src/render/renderer'
import { motionAt } from '../src/renderer/src/render/animation'
import type { FontRecord, RenderJobSpec } from '@shared/types'

/**
 * 预览/导出一致性（计划 M1-7）。
 * 用录制式假上下文证明：绘制指令只由 job（原生分辨率坐标）与帧序号决定；
 * 并静态锁死「显示层度量不得进入像素生产者」（规格 §11 纪律 6）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface Call {
  fn: string
  args: (number | string)[]
  /** 仅 fillText 记录：绘制时的 globalAlpha（逐字渐显要断言各字不同） */
  alpha?: number
}

/**
 * 路径类指令的两种用途：
 * - fillPath：路径后面紧跟 fill() → 真正落地的几何（条块/色块）；
 * - clipPath：路径后面紧跟 clip() → 擦除窗口（条块与文字共用同一擦除机制）。
 * 擦除样式的整个断言都建在这个区分上：几何不变、只变裁剪。
 */
function fillPaths(calls: Call[]): Call[] {
  return calls
    .map((call, index) => ({ call, next: calls[index + 1] }))
    .filter((pair) => (pair.call.fn === 'rect' || pair.call.fn === 'roundRect') && pair.next?.fn === 'fill')
    .map((pair) => pair.call)
}

function clipPaths(calls: Call[]): Call[] {
  return calls
    .map((call, index) => ({ call, next: calls[index + 1] }))
    .filter((pair) => pair.call.fn === 'rect' && pair.next?.fn === 'clip')
    .map((pair) => pair.call)
}

interface FakeCtx {
  calls: Call[]
  globalAlpha: number
  fillStyle: string
  font: string
  textBaseline: string
  textAlign: string
}

function createFakeCtx(): FakeCtx {
  const calls: Call[] = []
  const ctx = {
    calls,
    globalAlpha: 1,
    fillStyle: '',
    font: '',
    textBaseline: '',
    textAlign: '',
    save: record('save'),
    restore: record('restore'),
    setTransform: record('setTransform'),
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    rect: record('rect'),
    clip: record('clip'),
    fill: record('fill'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    roundRect: record('roundRect'),
    fillText: record('fillText'),
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ fn: 'createLinearGradient', args: args.map((a) => Number(a)) })
      return { addColorStop: record('addColorStop') }
    }
  } as unknown as FakeCtx & Record<string, unknown>
  return ctx

  function record(fn: string) {
    return (...args: unknown[]): void => {
      const call: Call = {
        fn,
        args: args.map((a) => (typeof a === 'number' ? Math.round(a * 1000) / 1000 : String(a)))
      }
      if (fn === 'fillText') call.alpha = Math.round((ctx.globalAlpha as number) * 1000) / 1000
      calls.push(call)
    }
  }
}

async function buildJob(width = 1920, height = 1080): Promise<RenderJobSpec> {
  const fontIndex: FontRecord[] = BUILTIN_FONTS.map((meta) => ({
    ...meta,
    source: 'builtin',
    bytes: 1024,
    sha1: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }))
  const project = createDefaultProject('一致性')
  project.resolution = { width, height }
  project.fps = FPS_30
  const clip = createClip({ startTime: 0, fps: FPS_30 })
  clip.content = { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' }
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
  return {
    width,
    height,
    fps: FPS_30,
    frameFormat: 'png',
    startFrame: plan.startFrame,
    endFrame: plan.endFrame,
    clips: [
      {
        id: plan.clips[0]!.id,
        presetId: plan.clips[0]!.presetId,
        startFrame: plan.clips[0]!.startFrame,
        endFrame: plan.clips[0]!.endFrame,
        boxes,
        animation: plan.clips[0]!.animation,
        selected: true
      }
    ],
    aspectMode: plan.mode
  }
}

describe('像素生产者一致性（M1-7）', () => {
  it('同一帧两次绘制指令完全相同（确定性 → 导出与预览必然同图）', async () => {
    const job = await buildJob()
    const a = createFakeCtx()
    const b = createFakeCtx()
    renderFrame(a as never, job, 12)
    renderFrame(b as never, job, 12)
    expect(a.calls).toEqual(b.calls)
    expect(a.calls.length).toBeGreaterThan(4)
  })

  it('背景保持透明：首条指令是 clearRect(0,0,宽,高)，且不存在铺满整幅的不透明填充', async () => {
    const job = await buildJob()
    const ctx = createFakeCtx()
    renderFrame(ctx as never, job, 15)
    const first = ctx.calls.find((call) => call.fn === 'clearRect')
    expect(first?.args).toEqual([0, 0, 1920, 1080])
    for (const call of ctx.calls) {
      if (call.fn !== 'fillRect' && call.fn !== 'fill') continue
      const w = call.fn === 'fillRect' ? Number(call.args[2]) : 0
      const h = call.fn === 'fillRect' ? Number(call.args[3]) : 0
      // 不允许任何一次填充恰好覆盖整个画布（那会让 MOV 背景不再透明）
      expect(w === 1920 && h === 1080, JSON.stringify(call)).toBe(false)
    }
    // 预览专用安全区默认关闭（导出路径永不传 safeArea）
    const strokes = ctx.calls.filter((call) => call.fn === 'strokeRect')
    expect(strokes).toHaveLength(0)
  })

  it('擦除样式：只变裁剪窗口，条块几何逐帧不变（规格 §11 纪律 6）', async () => {
    const job = await buildJob()
    const inFrames = job.clips[0]!.animation.inFrames
    const settled = createFakeCtx()
    const afterIn = createFakeCtx()
    renderFrame(settled as never, job, inFrames)
    renderFrame(afterIn as never, job, inFrames + 4)
    // 入场播完 = 擦除窗口覆盖整盒，不再落任何 clip；与稳态帧逐指令相同
    expect(clipPaths(settled.calls)).toHaveLength(0)
    expect(settled.calls).toEqual(afterIn.calls)

    const early = createFakeCtx()
    renderFrame(early as never, job, 2)
    // 几何（x/y/w/h）逐帧完全一致：擦除只发生在裁剪层，不改布局
    expect(fillPaths(early.calls)).toEqual(fillPaths(settled.calls))

    // 入场早期：每个落地矩形都在自己的左边缘被擦除线切断（宽 < 整盒）；
    // 文字是**逐字渐显**，此时允许已经有字出现，但必须全部落在擦除线以内
    const barPaths = fillPaths(settled.calls)
    const earlyClips = clipPaths(early.calls)
    expect(earlyClips.length).toBeGreaterThan(0)
    // 不变量：任何擦除裁剪都不得超出条块本身的占位（文字盒比条窄，所以左缘会大于条左缘）
    const frameLeft = Math.min(...barPaths.map((path) => Number(path.args[0])))
    const frameRight = Math.max(...barPaths.map((path) => Number(path.args[0]) + Number(path.args[2])))
    for (const clip of earlyClips) {
      const left = Number(clip.args[0])
      const right = left + Number(clip.args[2])
      expect(left, `擦除裁剪 x=${left} 越过了条块左缘`).toBeGreaterThanOrEqual(frameLeft - 1)
      expect(right, `擦除裁剪 x=${left}..${right} 越过了条块右缘`).toBeLessThanOrEqual(frameRight + 1)
    }
    const earlyText = early.calls.filter((call) => call.fn === 'fillText')
    expect(earlyText.length, '入场早期应当已经逐字渐显').toBeGreaterThan(0)
    const earlyWipeRight = Math.max(...earlyClips.map((call) => Number(call.args[0]) + Number(call.args[2])))
    for (const call of earlyText) {
      // fillText 的 args = [字符, x, y]：x 在 args[1]
      expect(Number(call.args[1]), '逐字渐显的字不得出现在擦除线之外').toBeLessThanOrEqual(earlyWipeRight + 1)
    }
    // 逐字错峰：同一帧里各字符的 alpha 不应完全相同（否则就是整段淡入而非逐字）
    const alphas = new Set(earlyText.map((call) => call.alpha))
    expect(alphas.size).toBeGreaterThan(1)

    // 第 0 帧窗口未开 → 一帧全透明；之后擦除线只向右推进（右边界单调不减）
    const zero = createFakeCtx()
    renderFrame(zero as never, job, 0)
    expect(clipPaths(zero.calls)).toHaveLength(0)
    expect(zero.calls.filter((call) => call.fn === 'fillText' || call.fn === 'fill')).toHaveLength(0)
    let previousRight = 0
    for (let frame = 1; frame < inFrames; frame++) {
      const ctx = createFakeCtx()
      renderFrame(ctx as never, job, frame)
      const clips = clipPaths(ctx.calls)
      expect(clips.length, `第 ${frame} 帧应当已经擦出`).toBeGreaterThan(0)
      const maxRight = Math.max(...clips.map((call) => Number(call.args[0]) + Number(call.args[2])))
      expect(maxRight, `第 ${frame} 帧擦除线回退`).toBeGreaterThanOrEqual(previousRight)
      previousRight = maxRight
    }
  })

  it('片段区间外完全不出像素（多片段间隙保持全透明）', async () => {
    const job = await buildJob()
    const ctx = createFakeCtx()
    renderFrame(ctx as never, job, job.clips[0]!.endFrame + 3)
    expect(ctx.calls.filter((call) => call.fn !== 'setTransform' && call.fn !== 'clearRect')).toHaveLength(0)
  })

  it('跨分辨率同一逻辑帧的指令结构一致（布局与分辨率解耦）', async () => {
    const hd = await buildJob(1920, 1080)
    const sd = await buildJob(640, 360)
    const hdCtx = createFakeCtx()
    const sdCtx = createFakeCtx()
    renderFrame(hdCtx as never, hd, 12)
    renderFrame(sdCtx as never, sd, 12)
    expect(hdCtx.calls.map((c) => c.fn)).toEqual(sdCtx.calls.map((c) => c.fn))
    const hdBars = hdCtx.calls.filter((c) => c.fn === 'roundRect')
    const sdBars = sdCtx.calls.filter((c) => c.fn === 'roundRect')
    expect(hdBars.length).toBe(sdBars.length)
    for (let i = 0; i < hdBars.length; i++) {
      const ratio = Number(hdBars[i]!.args[2]) / Number(sdBars[i]!.args[2])
      expect(ratio, `第 ${i} 个盒宽比 ${ratio}`).toBeCloseTo(3, 0) // 1920/640 = 3
    }
  })

  it('纪律静态检查：像素生产者不读取任何显示层度量（DPR / 布局尺寸）', async () => {
    const files = ['render/renderer.ts', 'render/layers.ts', 'render/animation.ts', 'render/layoutTree.ts']
    for (const file of files) {
      const source = await fs.readFile(path.join(ROOT, 'src/renderer/src', file), 'utf8')
      for (const banned of ['devicePixelRatio', 'clientWidth', 'clientHeight', 'innerWidth', 'offsetWidth', 'getBoundingClientRect']) {
        expect(source.includes(banned), `${file} 不得引用 ${banned}`).toBe(false)
      }
    }
    // 只有 stage.ts（显示层）允许感知 DPR
    const stage = await fs.readFile(path.join(ROOT, 'src/renderer/src/render/stage.ts'), 'utf8')
    expect(stage.includes('devicePixelRatio')).toBe(true)
  })

  it('motionAt 的擦除窗口与绘制指令一致（入场第 0 帧完全不可见，末帧完成推出）', async () => {
    const job = await buildJob()
    const anim = job.clips[0]!.animation
    expect(motionAt(anim, 0).wipeTo).toBeLessThan(0.2)
    expect(motionAt(anim, anim.inFrames).wipeTo).toBeCloseTo(1, 3)
    expect(motionAt(anim, anim.inFrames).wipeFrom).toBeCloseTo(0, 3)
    // 出场：左边界向右推进到 1（整条被擦掉），而不是整体淡出
    const last = motionAt(anim, anim.totalFrames - 1)
    expect(last.wipeFrom).toBeCloseTo(1, 3)
    expect(last.wipeTo - last.wipeFrom).toBeLessThan(0.02)
    expect(last.alpha).toBe(1)
  })
})
