import { describe, expect, it } from 'vitest'
import {
  CURVE_LUT_STEPS,
  MEDIA_GRADE_FILTER_ID,
  MEDIA_VIDEO_RANGE,
  STRAIGHT_CURVE,
  curveSamples,
  curveTableValues,
  defaultMediaVideo,
  isDefaultMediaVideo,
  mediaVideoFilter,
  mediaVideoTransform,
  needsChannelTable,
  needsCurveTable,
  normalizeMediaVideo
} from '@shared/mediaClipVideo'
import type { MediaClipVideo } from '@shared/types'

/**
 * 媒体片段画面变换/调色的纯口径（v6）。
 *
 * 锁三件事：
 * 1. **默认值 = 不生效**：全默认时整键不写进工程，脏值一律夹回合法区间；
 * 2. 几何变换的**组合顺序**固定（平移→旋转→缩放→镜像），将来导出滤镜链要按同一顺序写；
 * 3. 曲线是「三通道查找表」：直线时不出现在滤镜里，弯了就给 `feComponentTransfer` 用。
 */

const video = (over: Partial<MediaClipVideo> = {}): MediaClipVideo => ({ ...defaultMediaVideo(), ...over })

describe('默认值与夹心', () => {
  it('默认参数就是「什么都没改」', () => {
    const base = defaultMediaVideo()
    expect(base.scalePercent).toBe(100)
    expect(base.rotationDeg).toBe(0)
    expect(base.flipH).toBe(false)
    expect(base.curves.r).toEqual(STRAIGHT_CURVE)
    expect(isDefaultMediaVideo(base)).toBe(true)
    expect(isDefaultMediaVideo(undefined)).toBe(true)
  })

  it('全默认 / 全是脏值 都归一为 undefined（不往工程里写零值）', () => {
    expect(normalizeMediaVideo(undefined)).toBeUndefined()
    expect(normalizeMediaVideo('nope')).toBeUndefined()
    expect(normalizeMediaVideo({})).toBeUndefined()
    // 把默认值显式写一遍也算「没改」
    expect(normalizeMediaVideo({ scalePercent: 100, offsetXPercent: 0, rotationDeg: 0, flipH: false })).toBeUndefined()
    // 曲线写成直线也一样
    expect(normalizeMediaVideo({ curves: { r: [0, 0.5, 1], g: [0, 0.5, 1], b: [0, 0.5, 1] } })).toBeUndefined()
  })

  it('越界与 NaN 夹回合法区间，脏工程不会把 NaN 塞进样式表', () => {
    const normalized = normalizeMediaVideo({
      scalePercent: 900,
      offsetXPercent: -300,
      rotationDeg: 400,
      brightness: Number.NaN,
      saturation: 999,
      curves: { r: [2, -1, 3] }
    })!
    expect(normalized.scalePercent).toBe(MEDIA_VIDEO_RANGE.scale.max)
    expect(normalized.offsetXPercent).toBe(MEDIA_VIDEO_RANGE.offset.min)
    expect(normalized.rotationDeg).toBe(MEDIA_VIDEO_RANGE.rotation.max)
    expect(normalized.brightness).toBe(0)
    expect(normalized.saturation).toBe(MEDIA_VIDEO_RANGE.grade.max)
    expect(normalized.curves.r).toEqual([1, 0, 1])
  })

  it('改一项就整条保留（其余字段回到默认，不残留脏值）', () => {
    const normalized = normalizeMediaVideo({ flipH: true, scalePercent: 150 })!
    expect(normalized.flipH).toBe(true)
    expect(normalized.scalePercent).toBe(150)
    expect(normalized.contrast).toBe(0)
    expect(normalized.curves.g).toEqual(STRAIGHT_CURVE)
  })
})

describe('几何变换（CSS transform 口径）', () => {
  it('全默认 → none（不产生多余样式）', () => {
    expect(mediaVideoTransform(undefined)).toBe('none')
    expect(mediaVideoTransform(defaultMediaVideo())).toBe('none')
  })

  it('组合顺序固定：平移 → 旋转 → 缩放 → 镜像', () => {
    const css = mediaVideoTransform(
      video({ offsetXPercent: 10, offsetYPercent: -5, rotationDeg: 90, scalePercent: 150, flipH: true })
    )
    expect(css).toBe('translate(10%, -5%) rotate(90deg) scale(1.5) scaleX(-1)')
  })

  it('单项改动也只输出该项', () => {
    expect(mediaVideoTransform(video({ flipV: true }))).toBe('scaleY(-1)')
    expect(mediaVideoTransform(video({ rotationDeg: 360 }))).toBe('rotate(360deg)')
    expect(mediaVideoTransform(video({ scalePercent: 50 }))).toBe('scale(0.5)')
  })
})

describe('调色（CSS filter + SVG 曲线表）', () => {
  it('全默认 → none', () => {
    expect(mediaVideoFilter(undefined)).toBe('none')
    expect(mediaVideoFilter(defaultMediaVideo())).toBe('none')
  })

  it('亮度/对比度/饱和度各自映射，光感叠加到饱和度上', () => {
    expect(mediaVideoFilter(video({ brightness: 20, contrast: -50 }))).toBe('brightness(1.200) contrast(0.500)')
    const withVibrance = mediaVideoFilter(video({ vibrance: 40 }))
    expect(withVibrance).toBe('saturate(1.200)')
  })

  it('曲线弯了才挂 SVG 曲线表；直线但曝光/冷暖非 0 也要挂（按通道倍增）', () => {
    expect(needsCurveTable(defaultMediaVideo())).toBe(false)
    const bent = video({ curves: { r: [0.1, 0.5, 1], g: STRAIGHT_CURVE, b: STRAIGHT_CURVE } })
    expect(needsCurveTable(bent)).toBe(true)
    expect(mediaVideoFilter(bent)).toBe(`url(#${MEDIA_GRADE_FILTER_ID})`)

    expect(needsChannelTable(video({ exposure: 10 }))).toBe(true)
    expect(needsChannelTable(video({ warmth: -20 }))).toBe(true)
    // 只剩 CSS 函数的那几项时不需要 SVG 滤镜
    expect(mediaVideoFilter(video({ brightness: 10, saturation: 20 }))).toBe('brightness(1.100) saturate(1.200)')
  })

  it('曲线采样是 0..1 的折线：直线 → 等比，控制点抬升 → 对应段抬高', () => {
    const straight = curveSamples(STRAIGHT_CURVE, 4)
    expect(straight).toEqual([0, 0.25, 0.5, 0.75, 1])
    const lifted = curveSamples([0, 0.75, 1], 4)
    expect(lifted[2]).toBeCloseTo(0.75, 6)
    expect(lifted[2]).toBeGreaterThan(straight[2]!)
  })

  it('tableValues：条数 = 采样步数 + 1，且都夹在 0..1', () => {
    const values = curveTableValues(video({ exposure: 100, curves: { r: [0.4, 0.9, 1], g: STRAIGHT_CURVE, b: STRAIGHT_CURVE } }), 'r')
    const parts = values.split(' ')
    expect(parts).toHaveLength(CURVE_LUT_STEPS + 1)
    for (const part of parts) {
      const value = Number(part)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    // 曝光 +100 = 增益 ×2，红色通道整体被抬亮（再被 1 截断）
    expect(values).toContain('1.0000')
  })
})
