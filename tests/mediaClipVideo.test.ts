import { describe, expect, it } from 'vitest'
import {
  CURVE_LUT_STEPS,
  CURVE_MAX_POINTS,
  MEDIA_GRADE_FILTER_ID,
  MEDIA_VIDEO_RANGE,
  curveLookup,
  curveSamples,
  curveTableValues,
  defaultMediaVideo,
  isDefaultMediaVideo,
  isStraightCurve,
  lightToneLift,
  lightToneSaturate,
  mediaVideoCenter,
  mediaVideoCorners,
  mediaVideoFilter,
  mediaVideoRotateHandle,
  mediaVideoTransform,
  needsChannelTable,
  needsCurveTable,
  normalizeCurve,
  normalizeMediaVideo,
  rotationFromPointers,
  scaleFromPointer,
  snapOffset,
  straightCurve
} from '@shared/mediaClipVideo'
import type { CurvePoint, MediaClipVideo } from '@shared/types'

/**
 * 媒体片段画面变换/调色的纯口径（v6）。
 *
 * 锁五件事：
 * 1. **默认值 = 不生效**：全默认时整键不写进工程，脏值一律夹回合法区间；
 * 2. 几何变换的**组合顺序**固定（平移→旋转→缩放→镜像），导出滤镜链要按同一顺序写；
 * 3. 曲线是自由打点：脏数据能归一成有序、端点齐全的折线，恒等映射能被识别；
 * 4. 「光感」= 中调加权提亮 + 高光保护 + 很小的饱和补偿，端点永不移动；
 * 5. 交互层（拖角/拖画面/拖旋转）用的几何函数与面板字段是同一套单位。
 */

const video = (over: Partial<MediaClipVideo> = {}): MediaClipVideo => ({ ...defaultMediaVideo(), ...over })
const frame = { width: 800, height: 450 }

describe('默认值与夹心', () => {
  it('默认参数就是「什么都没改」', () => {
    const base = defaultMediaVideo()
    expect(base.scalePercent).toBe(100)
    expect(base.curves.master).toEqual(straightCurve())
    expect(isDefaultMediaVideo(base)).toBe(true)
    expect(isDefaultMediaVideo(undefined)).toBe(true)
  })

  it('全默认 / 脏值 都归一为 undefined（不往工程里写零值）', () => {
    expect(normalizeMediaVideo(undefined)).toBeUndefined()
    expect(normalizeMediaVideo('nope')).toBeUndefined()
    expect(normalizeMediaVideo({})).toBeUndefined()
    expect(normalizeMediaVideo({ scalePercent: 100, rotationDeg: 0, flipH: false })).toBeUndefined()
    expect(normalizeMediaVideo({ curves: { master: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } })).toBeUndefined()
  })

  it('越界与 NaN 夹回合法区间，脏工程不会把 NaN 塞进样式表', () => {
    const normalized = normalizeMediaVideo({
      scalePercent: 900,
      offsetXPercent: -300,
      rotationDeg: 400,
      brightness: Number.NaN,
      saturation: 999
    })!
    expect(normalized.scalePercent).toBe(MEDIA_VIDEO_RANGE.scale.max)
    expect(normalized.offsetXPercent).toBe(MEDIA_VIDEO_RANGE.offset.min)
    expect(normalized.rotationDeg).toBe(MEDIA_VIDEO_RANGE.rotation.max)
    expect(normalized.brightness).toBe(0)
    expect(normalized.saturation).toBe(MEDIA_VIDEO_RANGE.grade.max)
  })
})

describe('自由曲线归一', () => {
  it('旧的三点写法 [0, 0.5, 1] 能升级成点集', () => {
    const points = normalizeCurve([0, 0.75, 1])
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.75 },
      { x: 1, y: 1 }
    ])
  })

  it('乱序 / 越界 / 重复 / 缺端点 都能修成合法折线', () => {
    const points = normalizeCurve([
      { x: 0.8, y: 1.4 },
      { x: 0.2, y: -0.3 },
      { x: 0.2, y: 0.6 }
    ])
    expect(points[0]).toEqual({ x: 0, y: 0 }) // 端点补齐（用首点 y）
    expect(points[points.length - 1]).toEqual({ x: 1, y: 1 }) // 末点越界被夹到 1
    expect(points.map((p) => p.x)).toEqual([0, 0.2, 0.8, 1]) // 有序、同 x 去重
    expect(points[1]!.y).toBe(0) // -0.3 被夹到 0
  })

  it('非法输入退回直线；控制点数有上限', () => {
    expect(normalizeCurve(undefined)).toEqual(straightCurve())
    expect(normalizeCurve([])).toEqual(straightCurve())
    const many: CurvePoint[] = Array.from({ length: 40 }, (_, index) => ({ x: index / 40, y: index / 40 }))
    expect(normalizeCurve(many).length).toBeLessThanOrEqual(CURVE_MAX_POINTS)
  })

  it('恒等映射能被识别（两个端点、斜率 1）', () => {
    expect(isStraightCurve(straightCurve())).toBe(true)
    expect(isStraightCurve([{ x: 0, y: 0 }, { x: 1, y: 0.8 }])).toBe(false)
    expect(isStraightCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }])).toBe(false)
  })
})

describe('曲线查表', () => {
  it('折线插值：控制点之间线性，端点外夹住', () => {
    const points = normalizeCurve([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 1 }
    ])
    expect(curveLookup(points, 0)).toBeCloseTo(0, 6)
    expect(curveLookup(points, 0.25)).toBeCloseTo(0.4, 6)
    expect(curveLookup(points, 0.5)).toBeCloseTo(0.8, 6)
    expect(curveLookup(points, 0.75)).toBeCloseTo(0.9, 6)
    expect(curveLookup(points, -1)).toBeCloseTo(0, 6)
    expect(curveLookup(points, 2)).toBeCloseTo(1, 6)
  })

  it('采样条数 = 步数 + 1，值都在 0..1', () => {
    const samples = curveSamples(straightCurve(), 4)
    expect(samples).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('tableValues：亮度曲线先应用，单通道曲线后应用', () => {
    // 亮度曲线：中间压到 0.25；R 通道：整体再乘 0.5（用直线的一半斜率近似）
    const lifted = video({
      curves: {
        master: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.25 },
          { x: 1, y: 0.5 }
        ],
        r: straightCurve(),
        g: straightCurve(),
        b: straightCurve()
      }
    })
    const table = curveTableValues(lifted, 'r', 4).split(' ').map(Number)
    expect(table).toHaveLength(5)
    // x=0.5 → master 0.25 → R 直线 0.25 → 无增益
    expect(table[2]).toBeCloseTo(0.25, 4)
    expect(table[4]).toBeCloseTo(0.5, 4)
  })

  it('曝光按通道倍增、结果夹在 1 以内', () => {
    const table = curveTableValues(video({ exposure: 100 }), 'g', 4).split(' ').map(Number)
    expect(table[2]).toBeCloseTo(1, 4) // 0.5 × 2 → 截断到 1
    expect(table[0]).toBe(0)
  })
})

describe('几何变换（CSS transform 口径）', () => {
  it('全默认 → none；组合顺序固定：平移 → 旋转 → 缩放 → 镜像', () => {
    expect(mediaVideoTransform(undefined)).toBe('none')
    expect(mediaVideoTransform(defaultMediaVideo())).toBe('none')
    const css = mediaVideoTransform(
      video({ offsetXPercent: 10, offsetYPercent: -5, rotationDeg: 90, scalePercent: 150, flipH: true })
    )
    expect(css).toBe('translate(10%, -5%) rotate(90deg) scale(1.5) scaleX(-1)')
  })
})

describe('调色滤镜', () => {
  it('亮度/对比度/饱和度各自映射', () => {
    expect(mediaVideoFilter(video({ brightness: 20, contrast: -50 }))).toBe('brightness(1.200) contrast(0.500)')
  })

  it('曲线弯了才挂 SVG 曲线表；曝光 / 冷暖 / 光感非 0 也要挂', () => {
    expect(needsCurveTable(defaultMediaVideo())).toBe(false)
    const bent = video({
      curves: { master: straightCurve(), r: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }], g: straightCurve(), b: straightCurve() }
    })
    expect(needsCurveTable(bent)).toBe(true)
    expect(mediaVideoFilter(bent)).toBe(`url(#${MEDIA_GRADE_FILTER_ID})`)

    expect(needsChannelTable(video({ exposure: 10 }))).toBe(true)
    expect(needsChannelTable(video({ warmth: -20 }))).toBe(true)
    expect(needsChannelTable(video({ vibrance: 30 }))).toBe(true)
    expect(mediaVideoFilter(video({ brightness: 10 }))).toBe('brightness(1.100)')
  })
})

describe('光感（vibrance）', () => {
  it('端点固定：黑白场永不被抬或压（HDR 感但不冲顶）', () => {
    expect(lightToneLift(0, 100)).toBeCloseTo(0, 6)
    expect(lightToneLift(1, 100)).toBeCloseTo(1, 6)
    expect(lightToneLift(0, -100)).toBeCloseTo(0, 6)
    expect(lightToneLift(1, -100)).toBeCloseTo(1, 6)
  })

  it('正值抬中调、且中调幅度明显大于高光（高光受保护）', () => {
    const mid = lightToneLift(0.5, 100)
    const high = lightToneLift(0.85, 100)
    expect(mid).toBeGreaterThan(0.5)
    expect(mid - 0.5).toBeGreaterThan(high - 0.85)
    // 幅度控制在“看得见但不夸张”的范围（约 +22%）
    expect(mid).toBeLessThan(0.8)
  })

  it('负值压中调，两端不动', () => {
    expect(lightToneLift(0.5, -100)).toBeLessThan(0.5)
    expect(lightToneLift(0.5, 0)).toBeCloseTo(0.5, 6)
  })

  it('饱和补偿远小于饱和度滑杆（有肤色保护的含义）', () => {
    expect(lightToneSaturate(0)).toBe(1)
    expect(lightToneSaturate(100)).toBeCloseTo(1.08, 6)
    expect(lightToneSaturate(100)).toBeLessThan(1 + 100 / 100)
  })

  it('滤镜里是「饱和度 × 光感补偿」，不是把光感当饱和度用', () => {
    expect(mediaVideoFilter(video({ vibrance: 50 }))).toMatch(/^saturate\(1\.040\) /)
  })
})

describe('交互几何（预览拖拽与面板同源）', () => {
  it('中心 = 帧中心 + 位移百分比', () => {
    expect(mediaVideoCenter(undefined, frame)).toEqual({ x: 400, y: 225 })
    expect(mediaVideoCenter(video({ offsetXPercent: 10, offsetYPercent: -50 }), frame)).toEqual({ x: 480, y: 0 })
  })

  it('四角跟随缩放与旋转（顺时针 90°：左上角跑到右上）', () => {
    const corners = mediaVideoCorners(video({ scalePercent: 50 }), frame)
    expect(corners[0]).toEqual({ x: 200, y: 112.5 })
    expect(corners[2]).toEqual({ x: 600, y: 337.5 })

    const rotated = mediaVideoCorners(video({ rotationDeg: 90 }), frame)
    // 800×450 绕中心顺时针转 90°：(-400,-225) → (225,-400)
    expect(rotated[0]!.x).toBeCloseTo(400 + 225, 6)
    expect(rotated[0]!.y).toBeCloseTo(225 - 400, 6)
  })

  it('旋转手柄在画面上边中点外侧，且永远落在可见帧内（frame 是 overflow:hidden）', () => {
    // 100% 缩放时画面顶边贴帧顶：理想位置会跑到 y=-28，被夹到帧内
    const handle = mediaVideoRotateHandle(video({}), frame, 28)
    expect(handle.x).toBeCloseTo(400, 6)
    expect(handle.y).toBeGreaterThan(0)
    expect(handle.y).toBeLessThan(225)

    // 顺时针转 90° → 手柄跟着跑到右侧，但仍夹在帧内
    const rotated = mediaVideoRotateHandle(video({ rotationDeg: 90 }), frame, 28)
    expect(rotated.x).toBeGreaterThan(400)
    expect(rotated.x).toBeLessThanOrEqual(frame.width)
    expect(rotated.y).toBeGreaterThanOrEqual(0)
  })

  it('拖角缩放以中心为基准：指针到中心的距离翻倍 → 缩放翻倍', () => {
    const start = mediaVideoCorners(video({}), frame)[2]! // 右下角
    const center = mediaVideoCenter(video({}), frame)
    const pointer = { x: center.x + (start.x - center.x) * 2, y: center.y + (start.y - center.y) * 2 }
    expect(scaleFromPointer(video({}), frame, start, pointer)).toBe(200)
    // 反向拖到中心 → 夹到下限
    expect(scaleFromPointer(video({}), frame, start, center)).toBe(MEDIA_VIDEO_RANGE.scale.min)
  })

  it('拖旋转手柄：顺时针扫 90° → 角度 +90，负数归一到 0..360', () => {
    const center = mediaVideoCenter(video({}), frame)
    const start = { x: center.x, y: center.y - 200 } // 正上方 = -90°
    const right = { x: center.x + 200, y: center.y } // 正右 = 0°
    expect(rotationFromPointers(video({}), frame, start, right)).toBe(90)
    expect(rotationFromPointers(video({ rotationDeg: 300 }), frame, start, right)).toBe(30)
    // 从上拖到下 = 扫过 180°
    expect(rotationFromPointers(video({}), frame, start, { x: center.x, y: center.y + 200 })).toBe(180)
  })

  it('平移吸附：居中 / 边对齐 / 不吸附', () => {
    expect(snapOffset(0.4, 100)).toEqual({ value: 0, guide: 'center' })
    // 缩放 150% → 边对齐位置 = (150-100)/100*50 = +25%
    expect(snapOffset(24.6, 150)).toEqual({ value: 25, guide: 'edge' })
    expect(snapOffset(-24.6, 150)).toEqual({ value: -25, guide: 'edge' })
    expect(snapOffset(12, 150)).toEqual({ value: 12, guide: null })
  })
})

describe('LUT 尺寸', () => {
  it('tableValues 长度 = 步数 + 1（默认 33 点）', () => {
    const table = curveTableValues(video({ contrast: 10 }), 'b')
    expect(table.split(' ')).toHaveLength(CURVE_LUT_STEPS + 1)
  })
})
