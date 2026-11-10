import { describe, expect, it } from 'vitest'
import type { MediaClipMask, MaskStroke } from '@shared/types'
import { applyStrokesToContext, maskLineWidthPx as previewMaskLineWidthPx } from './maskCapture'
import { MASK_VISIBLE_COLOR, maskLineWidthPx, paintMaskStrokes, rasterizeMask } from './maskRaster'

/**
 * M8：导出侧遮罩光栅化。
 *
 * 口径（白底 / hide 擦透明 / restore 白 / 圆头圆角 / 单点圆点）由预览的
 * `maskCapture.applyStrokesToContext` 唯一定义；本测试锁两件事：
 * 1. `paintMaskStrokes` 与预览纯函数**逐操作等价**（导出的 PNG 不能与预览 CSS mask 分叉）；
 * 2. 真 Canvas 环境下 `rasterizeMask` 出的是目标尺寸的 PNG（jsdom 无 2D 上下文时 skipIf）。
 */

type Op = Record<string, unknown> & { op: string }

/** 记录型假 2D 上下文（jsdom 没有真 Canvas 实现；只记调用序列与属性快照）。 */
function recordingContext(): { ctx: CanvasRenderingContext2D; log: Op[] } {
  const props = {
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 0,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation
  }
  const log: Op[] = []
  const snap = (op: string, extra: Record<string, unknown> = {}): void => {
    log.push({ op, ...props, ...extra })
  }
  const ctx = {
    get fillStyle() {
      return props.fillStyle
    },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      props.fillStyle = value
    },
    get strokeStyle() {
      return props.strokeStyle
    },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
      props.strokeStyle = value
    },
    get lineWidth() {
      return props.lineWidth
    },
    set lineWidth(value: number) {
      props.lineWidth = value
    },
    get lineCap() {
      return props.lineCap
    },
    set lineCap(value: CanvasLineCap) {
      props.lineCap = value
    },
    get lineJoin() {
      return props.lineJoin
    },
    set lineJoin(value: CanvasLineJoin) {
      props.lineJoin = value
    },
    get globalCompositeOperation() {
      return props.globalCompositeOperation
    },
    set globalCompositeOperation(value: GlobalCompositeOperation) {
      props.globalCompositeOperation = value
    },
    save: () => snap('save'),
    restore: () => snap('restore'),
    fillRect: (x: number, y: number, width: number, height: number) =>
      snap('fillRect', { x, y, width, height }),
    beginPath: () => snap('beginPath'),
    moveTo: (x: number, y: number) => snap('moveTo', { x, y }),
    lineTo: (x: number, y: number) => snap('lineTo', { x, y }),
    arc: (x: number, y: number, r: number, startAngle: number, endAngle: number) =>
      snap('arc', { x, y, r, startAngle, endAngle }),
    stroke: () => snap('stroke'),
    fill: () => snap('fill')
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log }
}

const stroke = (
  mode: MaskStroke['mode'],
  radiusPct: number,
  points: MaskStroke['points']
): MaskStroke => ({ mode, radiusPct, points })

const MASK: MediaClipMask = {
  strokes: [
    stroke('hide', 10, [
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.2 },
      { x: 0.5, y: 0.8 }
    ]),
    stroke('restore', 4, [{ x: 0.5, y: 0.5 }])
  ]
}

describe('M8 导出口径：笔宽公式必须与预览同一实现', () => {
  it('re-export 的是 maskCapture 的同一个函数（不是第二份公式）', () => {
    expect(maskLineWidthPx).toBe(previewMaskLineWidthPx)
  })

  it('公式 = 2 × radiusPct/100 × 画面宽', () => {
    expect(maskLineWidthPx(10, 1000)).toBe(200)
    expect(maskLineWidthPx(5, 320)).toBe(32)
    expect(maskLineWidthPx(10, 1920)).toBe(384)
    expect(maskLineWidthPx(10, 3840)).toBe(768)
  })
})

describe('M8 导出画法：与预览纯函数逐操作等价', () => {
  it('同一组笔画：调用序列、合成模式、颜色、线宽、坐标完全一致', () => {
    const preview = recordingContext()
    const exported = recordingContext()
    applyStrokesToContext(preview.ctx, MASK.strokes, 320, 180)
    paintMaskStrokes(exported.ctx as never, MASK, 320, 180)
    expect(exported.log).toEqual(preview.log)
  })

  it('M8 反向遮罩：invert 传到光栅化（与预览 applyStrokesToContext 逐操作一致）', () => {
    const preview = recordingContext()
    const exported = recordingContext()
    const inverted: MediaClipMask = { ...MASK, invert: true }
    applyStrokesToContext(preview.ctx, inverted.strokes, 320, 180, 0, true)
    paintMaskStrokes(exported.ctx as never, inverted, 320, 180)
    expect(exported.log).toEqual(preview.log)
    expect(
      exported.log.filter((op) => op.op === 'fillRect' && op.globalCompositeOperation === 'xor')
    ).toHaveLength(1)
  })

  it('白底 = 全可见；hide 用 destination-out（RGB 黑 + alpha 0），restore 用不透明白', () => {
    const { ctx, log } = recordingContext()
    paintMaskStrokes(ctx as never, MASK, 320, 180)
    expect(log[0]).toMatchObject({ op: 'save' })
    expect(log.find((op) => op.op === 'fillRect')).toMatchObject({
      op: 'fillRect',
      fillStyle: MASK_VISIBLE_COLOR,
      globalCompositeOperation: 'source-over',
      x: 0,
      y: 0,
      width: 320,
      height: 180
    })
    const hideStroke = log.find((op) => op.op === 'stroke' && op.globalCompositeOperation === 'destination-out')
    expect(hideStroke).toMatchObject({ strokeStyle: '#000', lineWidth: 64, lineCap: 'round', lineJoin: 'round' })
    // 单点 restore 画的是圆点（arc + fill）：不透明白 / source-over / 半径 = 笔宽一半
    const point = log.find((op) => op.op === 'arc')
    expect(point).toMatchObject({
      globalCompositeOperation: 'source-over',
      fillStyle: '#fff',
      lineWidth: 25.6,
      r: 12.8
    })
    expect(log.at(-2)).toMatchObject({ op: 'fill', fillStyle: '#fff' })
    expect(log.at(-1)).toMatchObject({ op: 'restore' })
  })

  it('空笔画 / 缺失 strokes 只铺白底（不抛错）', () => {
    const empty = recordingContext()
    paintMaskStrokes(empty.ctx as never, { strokes: [] }, 64, 36)
    const missing = recordingContext()
    paintMaskStrokes(missing.ctx as never, {} as MediaClipMask, 64, 36)
    expect(empty.log).toEqual(missing.log)
    expect(empty.log.filter((op) => op.op === 'fillRect')).toHaveLength(1)
    expect(empty.log.some((op) => op.op === 'stroke' || op.op === 'fill')).toBe(false)
  })

  it('尺寸非法时按至少 1 像素画（canvas 尺寸不能是 0/NaN）', () => {
    const { ctx, log } = recordingContext()
    paintMaskStrokes(ctx as never, { strokes: [] }, 0, Number.NaN)
    expect(log.find((op) => op.op === 'fillRect')).toMatchObject({ width: 1, height: 1 })
  })
})

/** jsdom 默认没有 Canvas 2D；有真实实现的环境才跑真 PNG 断言。 */
function hasCanvas2d(): boolean {
  try {
    if (typeof document === 'undefined') return false
    return document.createElement('canvas').getContext('2d') !== null
  } catch {
    return false
  }
}

const HAS_CANVAS = hasCanvas2d()

describe('M8 导出真 PNG 输出', () => {
  it.skipIf(!HAS_CANVAS)('输出 PNG 字节，尺寸与导出画布一致', async () => {
    const bytes = await rasterizeMask(MASK, 320, 180)
    expect(bytes.subarray(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(view.getUint32(16)).toBe(320)
    expect(view.getUint32(20)).toBe(180)
  })
})
