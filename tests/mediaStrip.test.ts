import { describe, expect, it } from 'vitest'
import { FPS_23_976, FPS_30 } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import {
  STRIP_CLICK_SLOP_PX,
  STRIP_FRAMES_MAX,
  STRIP_FRAMES_MIN,
  STRIP_TARGET_PX_PER_FRAME,
  isStripTap,
  stripCacheKey,
  stripDurationSec,
  stripFallbackLabel,
  stripFilePrefix,
  stripFileToken,
  stripFrameCount,
  stripTimeAtFraction
} from '@shared/mediaStrip'

/**
 * 时间帧预览条（Thumbnail Strip）的采样与映射口径。
 *
 * 锁三件事：
 * 1. 密度随卡片像素宽走**档位**——逐像素拖宽不能连环重抽（那是性能与抖动的来源）；
 * 2. 缓存键必须包含实际文件路径——「重新定位」换源不换轨时 mediaId 与入出点都不变；
 * 3. 指针位置 → 时间的换算与拖拽同一口径吸附帧边界，点出来的位置一定能落在整帧上。
 */

describe('抽帧密度（stripFrameCount）', () => {
  it('按每约 44px 一格取档位，卡片越宽格数越多', () => {
    expect(STRIP_TARGET_PX_PER_FRAME).toBe(44)
    expect(stripFrameCount(132, 10)).toBe(3)
    expect(stripFrameCount(300, 10)).toBe(6)
    expect(stripFrameCount(1000, 10)).toBe(20)
    expect(stripFrameCount(4000, 10)).toBe(STRIP_FRAMES_MAX)
  })

  it('拖宽几像素不跨档 → 格数不变（不会每像素重抽一次）', () => {
    const before = stripFrameCount(1000, 12)
    const after = stripFrameCount(1010, 12)
    expect(after).toBe(before)
    // 跨到下一档才变
    expect(stripFrameCount(1100, 12)).toBeGreaterThan(after)
  })

  it('极窄卡片与零宽/零时长都退到最小格数，不出现 0 或 NaN', () => {
    expect(stripFrameCount(20, 5)).toBe(STRIP_FRAMES_MIN)
    expect(stripFrameCount(0, 5)).toBe(STRIP_FRAMES_MIN)
    expect(stripFrameCount(800, 0)).toBe(STRIP_FRAMES_MIN)
    expect(stripFrameCount(Number.NaN, 5)).toBe(STRIP_FRAMES_MIN)
  })

  it('区间里真实帧数不足时按可用帧数收敛（0.2s 片段不该抽 20 张重复图）', () => {
    const duration = 0.2
    const framesAvailable = Math.floor(duration * (FPS_30.num / FPS_30.den))
    expect(stripFrameCount(1000, duration, framesAvailable)).toBe(framesAvailable)
    // 下限仍然是最小格数：短到不足一帧也画得出格子
    expect(stripFrameCount(1000, 0.02, 1)).toBe(STRIP_FRAMES_MIN)
  })
})

describe('缓存键与文件名', () => {
  const base = { mediaId: 'media-a', path: 'C:/media/a.mp4', sourceInSec: 1, sourceOutSec: 6, frames: 8 }

  it('素材路径参与键：换源不换轨（重新定位）必须失效重抽', () => {
    expect(stripCacheKey({ ...base, path: 'C:/media/b.mp4' })).not.toBe(stripCacheKey(base))
    expect(stripCacheKey({ ...base, mediaId: 'media-b' })).not.toBe(stripCacheKey(base))
    expect(stripCacheKey({ ...base, sourceInSec: 1.5 })).not.toBe(stripCacheKey(base))
    expect(stripCacheKey({ ...base, sourceOutSec: 7 })).not.toBe(stripCacheKey(base))
    expect(stripCacheKey({ ...base, frames: 10 })).not.toBe(stripCacheKey(base))
    expect(stripCacheKey(base)).toBe(stripCacheKey(base))
  })

  it('令牌稳定、只含十六进制、长度固定（可直接拼文件名）', () => {
    const token = stripFileToken(stripCacheKey(base))
    expect(token).toBe(stripFileToken(stripCacheKey(base)))
    expect(token).toMatch(/^[0-9a-f]{16}$/)
    expect(stripFileToken(stripCacheKey({ ...base, frames: 10 }))).not.toBe(token)
  })

  it('mediaId 前缀只留安全字符（素材移出时按前缀整批回收）', () => {
    expect(stripFilePrefix('media-1a2b')).toBe('media-1a2b-')
    expect(stripFilePrefix('../evil')).toBe('___evil-')
    expect(stripFilePrefix('')).toBe('media-')
  })

  it('时长取绝对值下限 0，倒挂区间不会给出负数', () => {
    expect(stripDurationSec({ sourceInSec: 2, sourceOutSec: 7 })).toBe(5)
    expect(stripDurationSec({ sourceInSec: 7, sourceOutSec: 2 })).toBe(0)
  })
})

describe('指针位置 → 时间（stripTimeAtFraction）', () => {
  const clip = { sourceInSec: 2, sourceOutSec: 8, timelineStartSec: 10, fps: FPS_30 }

  it('两端与中点：源坐标与时间轴坐标同幅度，且都落在帧边界上', () => {
    const atStart = stripTimeAtFraction({ fraction: 0, ...clip })
    const atEnd = stripTimeAtFraction({ fraction: 1, ...clip })
    const atMiddle = stripTimeAtFraction({ fraction: 0.5, ...clip })

    expect(atStart.sourceSec).toBeCloseTo(2, 6)
    expect(atStart.timelineSec).toBeCloseTo(10, 6)
    expect(atEnd.sourceSec).toBeCloseTo(8, 6)
    expect(atEnd.timelineSec).toBeCloseTo(16, 6)
    expect(atMiddle.sourceSec).toBeCloseTo(5, 6)
    expect(atMiddle.timelineSec - atStart.timelineSec).toBeCloseTo(atMiddle.sourceSec - atStart.sourceSec, 6)
  })

  it('越界比例被钳到 0~1（拖出卡片不会算出区间外的时间）', () => {
    expect(stripTimeAtFraction({ fraction: -0.5, ...clip }).sourceSec).toBeCloseTo(2, 6)
    expect(stripTimeAtFraction({ fraction: 1.5, ...clip }).sourceSec).toBeCloseTo(8, 6)
  })

  it('非整帧比例吸附到当前帧率的帧边界，点出来的位置一定能落在整帧', () => {
    const at = stripTimeAtFraction({ fraction: 0.333, ...clip, fps: FPS_23_976 })
    expect(at.sourceSec).toBe(snapTimeToFrame(at.sourceSec, FPS_23_976))
    expect(at.timelineSec).toBe(snapTimeToFrame(at.timelineSec, FPS_23_976))
  })
})

describe('点击判定与占位文案', () => {
  it('位移不超过阈值才算「点一格跳转」，超过就是拖拽', () => {
    expect(STRIP_CLICK_SLOP_PX).toBe(3)
    expect(isStripTap(0)).toBe(true)
    expect(isStripTap(3)).toBe(true)
    expect(isStripTap(-3)).toBe(true)
    expect(isStripTap(4)).toBe(false)
    expect(isStripTap(Number.NaN)).toBe(false)
  })

  it('三态分开且都是短词：素材已移出 > 生成中 > 无法预览 > 待生成', () => {
    expect(stripFallbackLabel({ mediaMissing: true, status: 'failed' })).toBe('素材已移出')
    expect(stripFallbackLabel({ mediaMissing: false, status: 'loading' })).toBe('生成中…')
    expect(stripFallbackLabel({ mediaMissing: false, status: 'failed' })).toBe('无法预览')
    expect(stripFallbackLabel({ mediaMissing: false, status: 'idle' })).toBe('待生成')
  })
})
