import { describe, expect, it } from 'vitest'
import { BUILTIN_FONTS, FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { buildProjectPlan } from '@shared/presetResolver'
import type { FontRecord, LayoutBox, RenderJobSpec } from '@shared/types'
import { computeClipBoxes } from '../src/renderer/src/render/layoutTree'
import { displayToNative, hitTestClips } from '../src/renderer/src/render/hitTest'
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
