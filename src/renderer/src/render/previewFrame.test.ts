import { describe, expect, it } from 'vitest'
import { FPS_29_97, FPS_30 } from '@shared/constants'
import { frameTimeSec } from '@shared/fps'
import { choosePreviewFrame } from './previewFrame'

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
