import { describe, expect, it } from 'vitest'
import {
  clipFrameCount,
  crossFpsMaxDeviationSec,
  durationSecToFrames,
  frameTimeSec,
  parseFps,
  snapTimeToFrame,
  timeToFrameAtOrAfter,
  timeToFrameFloor,
  timeToFrameNearest
} from '@shared/fps'
import { FPS_23_976, FPS_29_97, FPS_30, FPS_59_94, fpsToString } from '@shared/constants'

/** 规格 §4.4 / §11：时间轴存秒、帧率存分数、全程整数运算，禁止浮点累加。 */

describe('分数帧率换算', () => {
  it('23.976 的第 n 帧时刻 = n*1001/24000', () => {
    expect(frameTimeSec(1, FPS_23_976)).toBeCloseTo(1001 / 24000, 12)
    expect(frameTimeSec(24, FPS_23_976)).toBeCloseTo(1.001, 12)
    expect(frameTimeSec(1000, FPS_23_976)).toBeCloseTo((1000 * 1001) / 24000, 12)
  })

  it('帧号反算保持精确（吸附后写回不漂移）', () => {
    for (const fps of [FPS_23_976, FPS_29_97, FPS_30, FPS_59_94]) {
      for (let frame = 0; frame < 900; frame += 7) {
        const sec = frameTimeSec(frame, fps)
        expect(timeToFrameAtOrAfter(sec, fps)).toBe(frame)
        expect(timeToFrameFloor(sec, fps)).toBe(frame)
        expect(timeToFrameNearest(sec, fps)).toBe(frame)
      }
    }
  })

  it('非边界时刻向上取整到后一帧、向下取整到前一帧', () => {
    const mid = frameTimeSec(10, FPS_30) + 1 / 60
    expect(timeToFrameFloor(mid, FPS_30)).toBe(10)
    expect(timeToFrameAtOrAfter(mid, FPS_30)).toBe(11)
  })

  it('浮点噪声（1e-12 级）不会让帧号跳变', () => {
    const sec = frameTimeSec(300, FPS_29_97)
    const noisy = sec + 1e-12
    expect(timeToFrameAtOrAfter(noisy, FPS_29_97)).toBe(300)
    expect(timeToFrameAtOrAfter(sec - 1e-12, FPS_29_97)).toBe(300)
  })

  it('入出点跨帧率复现：偏差小于 1 帧（验收第 4 条）', () => {
    const times = [0, 0.5, 1.001, 3.333, 12.5, 59.94]
    const deviation = crossFpsMaxDeviationSec(times, FPS_30, FPS_23_976)
    const oneFrame = 1 / fpsToNum(FPS_23_976)
    expect(deviation).toBeLessThan(oneFrame)
  })

  it('时长秒 → 帧数（至少 1 帧）', () => {
    expect(durationSecToFrames(0.3, FPS_30)).toBe(9)
    expect(durationSecToFrames(0.2, FPS_30)).toBe(6)
    expect(durationSecToFrames(0.001, FPS_30)).toBe(1)
  })

  it('片段占用帧数 = 出点帧 - 入点帧', () => {
    const start = snapTimeToFrame(1.234, FPS_29_97)
    const end = snapTimeToFrame(4.567, FPS_29_97)
    expect(clipFrameCount(start, end, FPS_29_97)).toBe(
      timeToFrameAtOrAfter(end, FPS_29_97) - timeToFrameAtOrAfter(start, FPS_29_97)
    )
  })

  it('parseFps 支持分数、浮点标签与非法输入', () => {
    expect(parseFps('30000/1001')).toEqual({ num: 30000, den: 1001 })
    expect(parseFps('29.97')).toEqual({ num: 30000, den: 1001 })
    expect(parseFps('30')).toEqual({ num: 30, den: 1 })
    expect(parseFps('0/0')).toBeNull()
    expect(parseFps('')).toBeNull()
    expect(fpsToString(FPS_59_94)).toBe('60000/1001')
  })
})

function fpsToNum(fps: { num: number; den: number }): number {
  return fps.num / fps.den
}
