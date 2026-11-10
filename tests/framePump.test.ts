import { describe, expect, it } from 'vitest'
import {
  FRAME_BUFFER_BUDGET_BYTES,
  MAX_INFLIGHT_FRAMES,
  frameWindowSize
} from '../src/main/export/framePump'

/**
 * 流式导出的内存纪律：在飞帧数必须由**字节预算**反算，
 * 而不是写死 3。否则 4K/8K 导出会把内存吃穿（8K RGBA 单帧就 132MB）。
 */

describe('帧窗口（内存有界）', () => {
  it('1080p RGBA：预算足够，用满并发窗口', () => {
    expect(frameWindowSize(1920 * 1080 * 4)).toBe(MAX_INFLIGHT_FRAMES)
  })

  it('4K RGBA：仍在预算内，保持满窗口', () => {
    const frameBytes = 3840 * 2160 * 4 // 约 33MB
    expect(frameBytes * MAX_INFLIGHT_FRAMES).toBeLessThanOrEqual(FRAME_BUFFER_BUDGET_BYTES)
    expect(frameWindowSize(frameBytes)).toBe(MAX_INFLIGHT_FRAMES)
  })

  it('8K RGBA：单帧超过预算，窗口收窄到 1，绝不越界占用', () => {
    const frameBytes = 7680 * 4320 * 4 // 约 133MB
    const window = frameWindowSize(frameBytes)
    expect(window).toBe(1)
    expect(window * frameBytes).toBeLessThanOrEqual(frameBytes * MAX_INFLIGHT_FRAMES)
  })

  it('未知帧大小（PNG 压缩流）回落满窗口，但不会超过渲染侧舞台池', () => {
    expect(frameWindowSize(undefined)).toBe(MAX_INFLIGHT_FRAMES)
    expect(frameWindowSize(0)).toBe(MAX_INFLIGHT_FRAMES)
  })

  it('窗口永不为 0：单帧再大也必须能推进', () => {
    expect(frameWindowSize(FRAME_BUFFER_BUDGET_BYTES * 4)).toBe(1)
  })
})
