import { afterEach, describe, expect, it } from 'vitest'
import {
  formatPreviewPerfSummary,
  noteFrame,
  previewPerf,
  previewPerfSnapshot,
  resetPreviewPerf
} from './previewPerf'

/** Task 1：诊断计数本身必须是纯累加，且重置后能当作一个干净的观测窗口。 */

afterEach(() => {
  resetPreviewPerf()
})

describe('previewPerf', () => {
  it('reset 原地清零所有计数', () => {
    previewPerf.renders = 3
    previewPerf.skips = 7
    previewPerf.loopWraps = 1
    resetPreviewPerf()
    expect(previewPerf.renders).toBe(0)
    expect(previewPerf.skips).toBe(0)
    expect(previewPerf.loopWraps).toBe(0)
  })

  it('noteFrame 累计耗时，并按 2 倍帧间隔判长帧', () => {
    // 60Hz：2 帧 = 33.3ms
    noteFrame({ renderMs: 10, blitMs: 5, frameIntervalSec: 1 / 60 })
    expect(previewPerf.longFrames).toBe(0)
    noteFrame({ renderMs: 20, blitMs: 20, frameIntervalSec: 1 / 60 })
    expect(previewPerf.longFrames).toBe(1)
    expect(previewPerf.renderMs).toBe(30)
    expect(previewPerf.blitMs).toBe(25)
    expect(previewPerf.renders).toBe(0)
  })

  it('snapshot 给出平均值，format 输出单行可读摘要', () => {
    // 每帧都 render 并 blit 一次（与预览循环一致）
    previewPerf.renders = 2
    previewPerf.blits = 2
    noteFrame({ renderMs: 4, blitMs: 2, frameIntervalSec: 1 / 30 })
    noteFrame({ renderMs: 8, blitMs: 4, frameIntervalSec: 1 / 30 })

    const snapshot = previewPerfSnapshot()
    expect(snapshot.avgRenderMs).toBe(6)
    expect(snapshot.avgBlitMs).toBe(3)
    expect(snapshot.renders).toBe(2)

    const line = formatPreviewPerfSummary(snapshot)
    expect(line).toContain('renders=2')
    expect(line).toContain('render=6.00ms')
    expect(line).toContain('blit=3.00ms')
    expect(line.includes('\n')).toBe(false)
  })

  it('没有渲染时平均值是 0，不会出现 NaN', () => {
    const snapshot = previewPerfSnapshot()
    expect(snapshot.avgRenderMs).toBe(0)
    expect(snapshot.avgBlitMs).toBe(0)
  })

  it('安装 CDP 可读的全局读数入口，reset 生效', () => {
    expect(typeof window.__socutPreviewPerf).toBe('function')
    expect(typeof window.__socutPreviewPerfReset).toBe('function')

    previewPerf.renders = 2
    previewPerf.layerTicks = 5
    const snapshot = window.__socutPreviewPerf!()
    expect(snapshot.renders).toBe(2)
    expect(snapshot.layerTicks).toBe(5)

    window.__socutPreviewPerfReset!()
    expect(previewPerf.renders).toBe(0)
    expect(previewPerf.layerTicks).toBe(0)
  })
})
