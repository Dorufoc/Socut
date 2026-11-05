import { describe, expect, it } from 'vitest'
import { BUILTIN_FONTS, FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { buildProjectPlan } from '@shared/presetResolver'
import type { FontRecord, LayoutBox, RenderJobSpec } from '@shared/types'
import { computeClipBoxes } from '../src/renderer/src/render/layoutTree'
import { computeWatermarkGeometry } from '@shared/ffmpegArgs'
import {
  containFrameRect,
  displayToNative,
  fitContainRect,
  HIT_SLOP_PX,
  hitTestClips,
  STAGE_INSET_PX
} from '../src/renderer/src/render/hitTest'
import { motionAt } from '../src/renderer/src/render/animation'

/**
 * 预览点击选中（命中测试）。
 * 关键契约：只认**当前真正可见的像素** —— 片段区间外、擦除线右侧、以及装饰线尚未长到的部分都不能命中，
 * 否则用户会点到一块透明区域却被切换了选中项。
 */

const FONT_INDEX: FontRecord[] = BUILTIN_FONTS.map((meta) => ({
  ...meta,
  source: 'builtin',
  bytes: 1024,
  sha1: '',
  importedAt: '2026-01-01T00:00:00.000Z'
}))

interface Job {
  job: RenderJobSpec
  boxes: LayoutBox[]
  bar: LayoutBox
}

async function buildJob(): Promise<Job> {
  const project = createDefaultProject('命中测试')
  project.resolution = { width: 1920, height: 1080 }
  project.fps = FPS_30
  const clip = createClip({ startTime: 0, fps: FPS_30 })
  clip.content = { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' }
  project.clips = [clip]
  const plan = buildProjectPlan({ project, scope: { kind: 'timeline' }, fontIndex: FONT_INDEX })
  const clipPlan = plan.clips[0]!
  const boxes = await computeClipBoxes(clipPlan)
  const bar = boxes.find((box) => box.role === 'primaryBar')
  if (!bar) throw new Error('命中测试：缺少主条盒')
  const job: RenderJobSpec = {
    width: 1920,
    height: 1080,
    fps: FPS_30,
    frameFormat: 'png',
    startFrame: plan.startFrame,
    endFrame: plan.endFrame,
    clips: [
      {
        id: clipPlan.id,
        presetId: clipPlan.presetId,
        startFrame: clipPlan.startFrame,
        endFrame: clipPlan.endFrame,
        boxes,
        animation: clipPlan.animation,
        selected: true
      }
    ],
    aspectMode: plan.mode
  }
  return { job, boxes, bar }
}

describe('预览命中测试', () => {
  it('点在条块内部命中该片段；点在画布其他位置不命中', async () => {
    const { job, bar } = await buildJob()
    const clip = job.clips[0]!
    const steadyFrame = clip.startFrame + clip.animation.inFrames + 4

    expect(hitTestClips(job, steadyFrame, { x: bar.x + bar.w / 2, y: bar.y + bar.h / 2 })).toBe(clip.id)
    // 条块左外侧 / 上方 / 下方 / 右侧远处都不算
    expect(hitTestClips(job, steadyFrame, { x: bar.x - 40, y: bar.y + bar.h / 2 })).toBeNull()
    expect(hitTestClips(job, steadyFrame, { x: bar.x + bar.w / 2, y: bar.y - 200 })).toBeNull()
    expect(hitTestClips(job, steadyFrame, { x: bar.x + bar.w / 2, y: 1070 })).toBeNull()
    expect(hitTestClips(job, steadyFrame, { x: bar.x + bar.w + 300, y: bar.y + bar.h / 2 })).toBeNull()
  })

  it('片段区间外不命中（哪怕坐标正好落在条块上）', async () => {
    const { job, bar } = await buildJob()
    const clip = job.clips[0]!
    const point = { x: bar.x + bar.w / 2, y: bar.y + bar.h / 2 }
    expect(hitTestClips(job, clip.startFrame - 1, point)).toBeNull()
    expect(hitTestClips(job, clip.endFrame, point)).toBeNull()
  })

  it('入场擦除过程中：已擦出的部分能命中，尚未擦出的部分不能命中', async () => {
    const { job, bar } = await buildJob()
    const clip = job.clips[0]!
    // 取入场中段：擦除线大约到一半
    const midLocal = Math.floor(clip.animation.inFrames / 2)
    const midFrame = clip.startFrame + midLocal
    const motion = motionAt(clip.animation, midLocal)
    const wipeRightPx = bar.x + bar.w * motion.wipeTo

    expect(motion.wipeTo).toBeGreaterThan(0.1)
    expect(motion.wipeTo).toBeLessThan(0.95)

    // 擦除线左侧（已擦出）命中
    expect(hitTestClips(job, midFrame, { x: bar.x + 8, y: bar.y + bar.h / 2 })).toBe(clip.id)
    // 擦除线右侧（还没擦出来）不命中
    expect(
      hitTestClips(job, midFrame, { x: Math.round(wipeRightPx) + 30, y: bar.y + bar.h / 2 })
    ).toBeNull()
  })

  it('第 0 帧（窗口未开）整条都不可点', async () => {
    const { job, bar } = await buildJob()
    const clip = job.clips[0]!
    expect(hitTestClips(job, clip.startFrame, { x: bar.x + bar.w / 2, y: bar.y + bar.h / 2 })).toBeNull()
  })

  it('未选中的片段不参与命中（导出时被排除的片段不该被点中）', async () => {
    const { job, bar } = await buildJob()
    const clip = job.clips[0]!
    const steadyFrame = clip.startFrame + clip.animation.inFrames + 4
    const hidden: RenderJobSpec = { ...job, clips: [{ ...clip, selected: false }] }
    expect(hitTestClips(hidden, steadyFrame, { x: bar.x + bar.w / 2, y: bar.y + bar.h / 2 })).toBeNull()
  })
})

describe('显示坐标 → 原生像素', () => {
  it('按显示矩形的等比映射（与 DPR 无关）', () => {
    const rect = { left: 100, top: 50, width: 960, height: 540 }
    const point = displayToNative({ clientX: 100 + 480, clientY: 50 + 270 }, rect, { width: 1920, height: 1080 })
    expect(point).toEqual({ x: 960, y: 540 })
  })

  it('左上角与右下角落在预期边界，零尺寸矩形返回 null', () => {
    const rect = { left: 0, top: 0, width: 1920, height: 1080 }
    expect(displayToNative({ clientX: 0, clientY: 0 }, rect, { width: 1920, height: 1080 })).toEqual({ x: 0, y: 0 })
    expect(displayToNative({ clientX: 1920, clientY: 1080 }, rect, { width: 1920, height: 1080 })).toEqual({
      x: 1920,
      y: 1080
    })
    expect(displayToNative({ clientX: 1, clientY: 1 }, { ...rect, width: 0 }, { width: 1920, height: 1080 })).toBeNull()
  })
})

describe('等比装入矩形（预览里的视频 / 水印共用）', () => {
  it('容器与画面同宽高比时恰好铺满（无黑边）', () => {
    expect(fitContainRect({ width: 960, height: 540 }, { width: 1920, height: 1080 })).toEqual({
      left: 0,
      top: 0,
      width: 960,
      height: 540,
      scale: 0.5
    })
  })

  it('容器比画面宽时上下贴边、左右居中；容器比画面窄时反之', () => {
    const letterbox = fitContainRect({ width: 1000, height: 400 }, { width: 1920, height: 1080 })!
    expect(letterbox.height).toBeCloseTo(400, 6)
    expect(letterbox.top).toBeCloseTo(0, 6)
    expect(letterbox.left).toBeCloseTo((1000 - 400 * (1920 / 1080)) / 2, 6)
    const pillarbox = fitContainRect({ width: 300, height: 600 }, { width: 1920, height: 1080 })!
    expect(pillarbox.width).toBeCloseTo(300, 6)
    expect(pillarbox.left).toBeCloseTo(0, 6)
    expect(pillarbox.top).toBeCloseTo((600 - 300 * (1080 / 1920)) / 2, 6)
  })

  it('零尺寸容器或非法画面返回 null（不拿 NaN 去算样式）', () => {
    expect(fitContainRect({ width: 0, height: 540 }, { width: 1920, height: 1080 })).toBeNull()
    expect(fitContainRect({ width: 960, height: 540 }, { width: 0, height: 0 })).toBeNull()
  })

  it('预览显示位 = 导出原生位 × scale（与 computeWatermarkGeometry 同一口径）', () => {
    const fit = fitContainRect({ width: 960, height: 540 }, { width: 1920, height: 1080 })!
    const box = computeWatermarkGeometry(
      { path: 'D:/brand/logo.png', sourceWidth: 800, sourceHeight: 450 },
      { width: 1920, height: 1080 }
    )
    expect({ left: fit.left + box.x * fit.scale, top: fit.top + box.y * fit.scale }).toEqual({ left: 15, top: 15 })
    expect({ width: box.width * fit.scale, height: box.height * fit.scale }).toEqual({ width: 128, height: 72 })
  })
})

describe('画面框（预览区被拖成任意宽高比后的唯一基准）', () => {
  const NATIVE = { width: 1920, height: 1080 }

  it('比例只由目标分辨率决定：容器多宽多高都不改变画面宽高比', () => {
    for (const container of [
      { width: 1440, height: 810 },
      { width: 1600, height: 400 },
      { width: 300, height: 900 },
      { width: 977, height: 533 }
    ]) {
      const frame = containFrameRect(container, NATIVE)!
      expect(frame.width / frame.height).toBeCloseTo(NATIVE.width / NATIVE.height, 6)
      // 画面框始终装在容器内（不越界、不为负）
      expect(frame.left).toBeGreaterThanOrEqual(0)
      expect(frame.top).toBeGreaterThanOrEqual(0)
      expect(frame.left + frame.width).toBeLessThanOrEqual(container.width + 1e-6)
      expect(frame.top + frame.height).toBeLessThanOrEqual(container.height + 1e-6)
    }
  })

  it('容器恰好是「可用盒」时画面框等于内缩后的可用盒（无额外黑边）', () => {
    const container = { width: 960 + STAGE_INSET_PX * 2, height: 540 + STAGE_INSET_PX * 2 }
    expect(containFrameRect(container, NATIVE)).toEqual({
      left: STAGE_INSET_PX,
      top: STAGE_INSET_PX,
      width: 960,
      height: 540,
      scale: 0.5
    })
  })

  it('扁容器与高容器都居中装入，内缩作为最小边距而不是可用区上限', () => {
    const wide = containFrameRect({ width: 1000, height: 400 }, NATIVE)!
    expect(wide.height).toBeCloseTo(400 - STAGE_INSET_PX * 2, 6)
    expect(wide.top).toBeCloseTo(STAGE_INSET_PX, 6)
    expect(wide.left).toBeCloseTo((1000 - wide.width) / 2, 6)
    const tall = containFrameRect({ width: 300, height: 900 }, NATIVE)!
    expect(tall.width).toBeCloseTo(300 - STAGE_INSET_PX * 2, 6)
    expect(tall.left).toBeCloseTo(STAGE_INSET_PX, 6)
    expect(tall.top).toBeCloseTo((900 - tall.height) / 2, 6)
  })

  it('预览区被压到比边距还小时不出现负尺寸（画面缩到最小仍合法）', () => {
    const tiny = containFrameRect({ width: 12, height: 8 }, NATIVE)!
    expect(tiny.width).toBeGreaterThan(0)
    expect(tiny.height).toBeGreaterThan(0)
    expect(tiny.left).toBeCloseTo(STAGE_INSET_PX, 6)
    expect(containFrameRect({ width: 0, height: 540 }, NATIVE)).toBeNull()
  })

  it('水印相对画面落位只由原生像素决定：内缩只缩小画面，不改变台标在画面里的位置', () => {
    const container = { width: 1280, height: 500 }
    const frame = containFrameRect(container, NATIVE)!
    const geom = computeWatermarkGeometry(
      { path: 'D:/brand/logo.png', sourceWidth: 800, sourceHeight: 450 },
      NATIVE
    )
    // DOM 里 img 的定位口径：相对画面框原点
    const scale = frame.width / NATIVE.width
    expect(geom.x * scale).toBeCloseTo(30 * scale, 6)
    expect(geom.x * scale + geom.width * scale).toBeLessThanOrEqual(frame.width + 1e-6)
    expect(geom.y * scale + geom.height * scale).toBeLessThanOrEqual(frame.height + 1e-6)
    // 内缩只缩小画面本身：比例不变、台标相对画面的占比不变
    const noInset = containFrameRect(container, NATIVE, 0)!
    expect(frame.width / frame.height).toBeCloseTo(noInset.width / noInset.height, 6)
    expect(frame.width).toBeLessThan(noInset.width)
    expect((geom.width * scale) / frame.width).toBeCloseTo(geom.width / NATIVE.width, 6)
    expect((geom.height * scale) / frame.height).toBeCloseTo(geom.height / NATIVE.height, 6)
  })

  it('点选映射以画面框为 rect：容器宽高比不等于目标比例时也不偏', () => {
    const container = { width: 1000, height: 400 }
    const frame = containFrameRect(container, NATIVE)!
    // 画面左上角 → 原生 (0, 0)；画面中心 → 原生画面中心
    const origin = displayToNative({ clientX: frame.left, clientY: frame.top }, frame, NATIVE)!
    expect(origin.x).toBeCloseTo(0, 6)
    expect(origin.y).toBeCloseTo(0, 6)
    const center = displayToNative(
      { clientX: frame.left + frame.width / 2, clientY: frame.top + frame.height / 2 },
      frame,
      NATIVE
    )!
    expect(center.x).toBeCloseTo(NATIVE.width / 2, 6)
    expect(center.y).toBeCloseTo(NATIVE.height / 2, 6)
    // 拿容器盒子算就会把黑边算进画面：同一个点的偏差远超命中容差（本例水平 325 / 垂直 38 原生像素），
    // 用户看到的就是「字幕条在左边，却要点到右边才中」
    const containerBox = { left: 0, top: 0, width: container.width, height: container.height }
    const wrong = displayToNative({ clientX: frame.left, clientY: frame.top }, containerBox, NATIVE)!
    expect(wrong.x - origin.x).toBeGreaterThan(HIT_SLOP_PX * 10)
    expect(wrong.y - origin.y).toBeGreaterThan(HIT_SLOP_PX * 10)
  })
})
