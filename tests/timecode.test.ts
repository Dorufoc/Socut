import { describe, expect, it } from 'vitest'
import { FPS_23_976, FPS_29_97, FPS_30, FPS_59_94 } from '@shared/constants'
import { frameTimeSec } from '@shared/fps'
import {
  formatDuration,
  frameToTimecode,
  secondsToTimecode,
  snappedTimeToTimecode,
  timecodeToSeconds
} from '@shared/timecode'

/**
 * 时间码（计划测试计划：`fps`/`timecode` 分数换算与吸附）。
 * 口径是非丢帧（NDF）时间码：帧号按 round(num/den) 计基数（23.976/29.97 → 24/30），
 * 因此 23.976 下第 24 帧就是 `00:00:01:00`，不会为了贴住挂钟时间而跳号。
 */

describe('秒 → 时间码', () => {
  it('整秒与半秒（30fps）', () => {
    expect(secondsToTimecode(0, FPS_30)).toBe('00:00:00:00')
    expect(secondsToTimecode(1, FPS_30)).toBe('00:00:01:00')
    expect(secondsToTimecode(0.5, FPS_30)).toBe('00:00:00:15')
    expect(secondsToTimecode(3661.5, FPS_30)).toBe('01:01:01:15')
  })

  it('分数帧率按 round(num/den) 取帧基数：23.976 的第 24 帧 = 1 秒', () => {
    expect(frameTimeSec(24, FPS_23_976)).toBeCloseTo(1.001, 6)
    expect(secondsToTimecode(frameTimeSec(24, FPS_23_976), FPS_23_976)).toBe('00:00:01:00')
    // 29.97 的 30 帧同样是 1 秒档
    expect(secondsToTimecode(frameTimeSec(30, FPS_29_97), FPS_29_97)).toBe('00:00:01:00')
    // 59.94 的帧基数 = 60
    expect(secondsToTimecode(frameTimeSec(60, FPS_59_94), FPS_59_94)).toBe('00:00:01:00')
  })

  it('负秒被夹到 0；withFrames=false 只给 HH:MM:SS', () => {
    expect(secondsToTimecode(-3, FPS_30)).toBe('00:00:00:00')
    expect(secondsToTimecode(1.5, FPS_30, false)).toBe('00:00:01')
  })

  it('帧序号 → 时间码与「先换算秒再格式化」完全一致', () => {
    for (const fps of [FPS_30, FPS_23_976, FPS_29_97]) {
      for (const frame of [0, 1, 23, 24, 90, 300]) {
        expect(frameToTimecode(frame, fps)).toBe(secondsToTimecode(frameTimeSec(frame, fps), fps))
      }
    }
    expect(frameToTimecode(90, FPS_30)).toBe('00:00:03:00')
  })
})

describe('时间码 → 秒（往返）', () => {
  it('解析后在 1 帧内回到原帧号（含全部分数帧率）', () => {
    for (const fps of [FPS_30, FPS_23_976, FPS_29_97, FPS_59_94]) {
      for (const frame of [0, 7, 29, 60, 137]) {
        const tc = frameToTimecode(frame, fps)
        const sec = timecodeToSeconds(tc, fps)
        expect(sec).not.toBeNull()
        // 回到同一帧（允许半帧浮点误差）
        const halfFrame = fps.den / fps.num / 2
        expect(Math.abs(sec! - frameTimeSec(frame, fps))).toBeLessThan(halfFrame + 1e-9)
      }
    }
  })

  it('非法输入返回 null，而不是悄悄当成 0 秒', () => {
    expect(timecodeToSeconds('abc', FPS_30)).toBeNull()
    expect(timecodeToSeconds('00:01', FPS_30)).toBeNull()
    expect(timecodeToSeconds('00:00:-1', FPS_30)).toBeNull()
    expect(timecodeToSeconds('', FPS_30)).toBeNull()
  })
})

describe('吸附后的时间码（UI 展示 = 存储值）', () => {
  it('1.02s @30fps 吸附到第 31 帧后展示 01:01', () => {
    expect(snappedTimeToTimecode(1.02, FPS_30)).toBe('00:00:01:01')
  })

  it('已经落在帧边界上的时间不再漂移', () => {
    for (const frame of [0, 30, 60, 150]) {
      const sec = frameTimeSec(frame, FPS_30)
      expect(snappedTimeToTimecode(sec, FPS_30)).toBe(frameToTimecode(frame, FPS_30))
    }
  })
})

describe('紧凑时长显示', () => {
  it('不足一分钟保留两位小数，非法/非正数为 0.00s', () => {
    expect(formatDuration(12.34)).toBe('12.34s')
    expect(formatDuration(0)).toBe('0.00s')
    expect(formatDuration(-5)).toBe('0.00s')
    expect(formatDuration(Number.NaN)).toBe('0.00s')
  })

  it('超过一分钟按整秒四舍五入，且不会出现 1:60', () => {
    expect(formatDuration(62.5)).toBe('1:03')
    // 60 秒是一分钟分支的起点；59.6 仍在秒分支（这一侧不做四舍五入）
    expect(formatDuration(60.4)).toBe('1:00')
    expect(formatDuration(59.6)).toBe('59.60s')
    expect(formatDuration(125.4)).toBe('2:05')
    expect(formatDuration(3600)).toBe('60:00')
  })
})
