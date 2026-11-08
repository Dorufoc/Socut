import { describe, expect, it } from 'vitest'
import { FPS_29_97, FPS_30 } from '@shared/constants'
import { frameTimeSec } from '@shared/fps'
import type { RenderJobSpec } from '@shared/types'
import { choosePreviewFrame, decidePreviewRender, type PreviewRenderState } from './previewFrame'

/**
 * 预览该出哪一帧（P4 预览轴接管）：
 * 悬停帧只改「画哪一帧」，不改「播放头在哪」——所以它必须同时报告
 * 「这次不要回写 UI 时间」，否则蓝线与时间码会被黄线拖着走。
 */

const SPEC = { fps: FPS_30, startFrame: 0, endFrame: 300 }

describe('choosePreviewFrame', () => {
  it('没有悬停帧时按内部时钟出图，并要求回写 UI 时间', () => {
    const choice = choosePreviewFrame({ elapsedSec: 4, overrideSec: null, ...SPEC })

    expect(choice.frame).toBe(120)
    expect(choice.reportDisplay).toBe(true)
  })

  it('有悬停帧时出悬停那一帧，且不回写 UI 时间（蓝线与时间码留在原地）', () => {
    const choice = choosePreviewFrame({ elapsedSec: 4, overrideSec: 9, ...SPEC })

    expect(choice.frame).toBe(270)
    expect(choice.reportDisplay).toBe(false)
  })

  it('悬停秒值向下取整到帧边界：非整帧的鼠标位置不会落在两帧之间', () => {
    const midFrame = frameTimeSec(150, FPS_30) + frameTimeSec(1, FPS_30) / 2

    expect(choosePreviewFrame({ elapsedSec: 0, overrideSec: midFrame, ...SPEC }).frame).toBe(150)
  })

  it('悬停帧夹进工程帧区间：越界不越帧，起点前不落到负帧号', () => {
    expect(choosePreviewFrame({ elapsedSec: 0, overrideSec: 999, ...SPEC }).frame).toBe(299)
    expect(choosePreviewFrame({ elapsedSec: 0, overrideSec: -5, ...SPEC }).frame).toBe(0)
  })

  it('工程起点不在 0 帧时，悬停帧仍在绝对坐标上（与导出同一套帧号）', () => {
    const choice = choosePreviewFrame({ elapsedSec: 0, overrideSec: 2, fps: FPS_30, startFrame: 900, endFrame: 1200 })

    expect(choice.frame).toBe(960)
  })

  it('非标准帧率（29.97）按自己的帧长折算，不借 30fps 的整秒', () => {
    const secondFrame = choosePreviewFrame({ elapsedSec: 0, overrideSec: 1, fps: FPS_29_97, startFrame: 0, endFrame: 300 })

    expect(secondFrame.frame).toBe(29)
  })
})

/**
 * Task 2：rAF 每帧的「重画/上屏」判据。
 * 内容输入（帧号、规格引用、安全区）变了才允许碰原生层；
 * 只影响显示的条件（CSS 尺寸、DPR、透明底）只重新 blit；全都没变就整帧跳过。
 */
describe('decidePreviewRender', () => {
  const jobA = { width: 1920, height: 1080 } as unknown as RenderJobSpec
  const jobB = { width: 1920, height: 1080 } as unknown as RenderJobSpec
  const base: PreviewRenderState = {
    frame: 10,
    spec: jobA,
    cssWidth: 800,
    cssHeight: 450,
    dpr: 1,
    safeArea: false,
    transparent: false
  }

  it('force 或首帧（last == null）必须整帧出图', () => {
    expect(decidePreviewRender(base, base, true)).toEqual({ render: true, blit: true })
    expect(decidePreviewRender(base, null, false)).toEqual({ render: true, blit: true })
    expect(decidePreviewRender(base, null, true)).toEqual({ render: true, blit: true })
  })

  it('全部相同且没有 force：既不重画也不重新上屏（暂停同帧的静默态）', () => {
    expect(decidePreviewRender(base, { ...base }, false)).toEqual({ render: false, blit: false })
  })

  it('帧号 / spec 引用 / 安全区变化：必须重画原生层并上屏', () => {
    expect(decidePreviewRender({ ...base, frame: 11 }, base, false)).toEqual({ render: true, blit: true })
    expect(decidePreviewRender({ ...base, spec: jobB }, base, false)).toEqual({ render: true, blit: true })
    expect(decidePreviewRender({ ...base, safeArea: true }, base, false)).toEqual({ render: true, blit: true })
  })

  it('只有 CSS 尺寸 / DPR / 透明底变化：只重新 blit，不重画字幕层', () => {
    expect(decidePreviewRender({ ...base, cssWidth: 801 }, base, false)).toEqual({ render: false, blit: true })
    expect(decidePreviewRender({ ...base, cssHeight: 451 }, base, false)).toEqual({ render: false, blit: true })
    expect(decidePreviewRender({ ...base, dpr: 2 }, base, false)).toEqual({ render: false, blit: true })
    expect(decidePreviewRender({ ...base, transparent: true }, base, false)).toEqual({ render: false, blit: true })
  })

  it('内容与显示同时变化：仍然按内容优先（整帧出图）', () => {
    expect(
      decidePreviewRender({ ...base, frame: 12, cssWidth: 900, transparent: true }, base, false)
    ).toEqual({ render: true, blit: true })
  })
})
