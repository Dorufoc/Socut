import { afterEach, describe, expect, it } from 'vitest'
import { TextMeasurer, type FontSpec } from './textMeasure'

/**
 * widthOf 的单字缓存（Task 2.5）。
 * 绘制侧逐字调用它；不缓存就是每帧 N 次 measureText。
 * jsdom 没有 OffscreenCanvas，TextMeasurer 会退到 DOM canvas——这里把 2D 上下文换成
 * 记录调用次数的假实现，直接证明「缓存命中后底层不再测量」。
 */

const FONT: FontSpec = { family: 'TestFace', weight: 400, sizePx: 20, trackingPx: 0 }

describe('TextMeasurer.widthOf 缓存', () => {
  const originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')

  afterEach(() => {
    if (originalGetContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', originalGetContext)
    }
  })

  it('同一字符重复调用结果一致，且缓存命中后 measureText 调用次数不增长', () => {
    let calls = 0
    const fakeCtx = {
      font: '',
      measureText: (text: string): { width: number } => {
        calls += 1
        return { width: text.length * 10 }
      }
    }
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => fakeCtx
    })

    const measurer = new TextMeasurer()

    expect(measurer.widthOf('字', FONT)).toBe(10)
    expect(calls).toBe(1)
    // 命中缓存：结果相同，且底层没有再测量一次
    expect(measurer.widthOf('字', FONT)).toBe(10)
    expect(calls).toBe(1)

    // 不同输入（字重不同）各占一个缓存项，不会互相污染
    expect(measurer.widthOf('字', { ...FONT, weight: 700 })).toBe(10)
    expect(calls).toBe(2)
    // 换字符同样是一次新测量
    expect(measurer.widthOf('测', FONT)).toBe(10)
    expect(calls).toBe(3)
    expect(measurer.widthOf('测', FONT)).toBe(10)
    expect(calls).toBe(3)
  })

  it('clearCache 之后重新测量（字体加载后可丢弃旧字形度量）', () => {
    let calls = 0
    const fakeCtx = {
      font: '',
      measureText: (text: string): { width: number } => {
        calls += 1
        return { width: text.length * 10 }
      }
    }
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => fakeCtx
    })

    const measurer = new TextMeasurer()
    expect(measurer.widthOf('字', FONT)).toBe(10)
    expect(calls).toBe(1)
    measurer.clearCache()
    expect(measurer.widthOf('字', FONT)).toBe(10)
    expect(calls).toBe(2)
  })
})
