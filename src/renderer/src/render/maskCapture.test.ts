import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaskStroke } from '@shared/types'
import {
  applyStrokesToContext,
  maskLineWidthPx,
  maskPointDistance,
  maskPointToPixels,
  maskPreviewObjectUrl,
  normalizeMaskPoint,
  previewMaskCanvasSize,
  revokeMaskUrl
} from './maskCapture'

/**
 * M8：手绘遮罩光栅化口径（纯函数）。
 *
 * 锁死与导出侧共享的公式：lineWidth = 2·radiusPct/100·画布宽、白底、hide 擦透明（RGB 黑）、
 * restore 不透明白、圆头圆角、单点画圆点；以及归一化坐标夹取与预览 blob URL 的生命周期。
 */

type Op = Record<string, unknown> & { op: string }

/** 记录型假 2D 上下文：属性写入 + 绘制调用都记下来（jsdom 没有真 Canvas 实现）。 */
function recordingContext(canvasHeight = 500): { ctx: CanvasRenderingContext2D; log: Op[] } {
  const props = {
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 0,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    filter: 'none' as string
  }
  const log: Op[] = []
  const snap = (op: string, extra: Record<string, unknown> = {}): void => {
    log.push({ op, ...props, ...extra })
  }
  const ctx = {
    get fillStyle() {
      return props.fillStyle
    },
    set fillStyle(value: string) {
      props.fillStyle = value
    },
    get strokeStyle() {
      return props.strokeStyle
    },
    set strokeStyle(value: string) {
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
    get filter() {
      return props.filter
    },
    set filter(value: string) {
      props.filter = value
    },
    canvas: { width: 1000, height: canvasHeight },
    save: () => snap('save'),
    restore: () => snap('restore'),
    fillRect: (x: number, y: number, width: number, height: number) => snap('fillRect', { x, y, width, height }),
    beginPath: () => snap('beginPath'),
    moveTo: (x: number, y: number) => snap('moveTo', { x, y }),
    lineTo: (x: number, y: number) => snap('lineTo', { x, y }),
    arc: (x: number, y: number, r: number, startAngle: number, endAngle: number) =>
      snap('arc', { x, y, r, startAngle, endAngle }),
    stroke: () => snap('stroke'),
    fill: () => snap('fill'),
    drawImage: (...args: unknown[]) => snap('drawImage', { args })
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log }
}

function stroke(mode: MaskStroke['mode'], radiusPct: number, points: MaskStroke['points']): MaskStroke {
  return { mode, radiusPct, points }
}

const LINE = stroke('hide', 4, [
  { x: 0, y: 0.5 },
  { x: 1, y: 0.5 }
])

describe('遮罩公式（与导出光栅化同口径）', () => {
  it('lineWidth = 2·radiusPct/100·画布宽', () => {
    // 1024 宽、半径 4% → 直径 2*4/100*1024 = 81.92
    expect(maskLineWidthPx(4, 1024)).toBeCloseTo(81.92, 6)
    expect(maskLineWidthPx(0.5, 800)).toBeCloseTo(8, 6)
    expect(maskLineWidthPx(20, 1000)).toBeCloseTo(400, 6)
    expect(maskLineWidthPx(4, 0)).toBe(0)
  })

  it('归一化点 → 像素坐标；越界点夹回 0..1', () => {
    expect(maskPointToPixels({ x: 0.5, y: 0.25 }, 800, 450)).toEqual({ x: 400, y: 112.5 })
    expect(maskPointToPixels({ x: -1, y: 2 }, 800, 450)).toEqual({ x: 0, y: 450 })
    expect(maskPointToPixels({ x: Number.NaN, y: 0.5 }, 800, 450)).toEqual({ x: 0, y: 225 })
  })

  it('指针 client 坐标 → 画面归一化坐标（含边界夹取与无效矩形）', () => {
    const rect = { left: 10, top: 20, width: 800, height: 450 }
    expect(normalizeMaskPoint(410, 245, rect)).toEqual({ x: 0.5, y: 0.5 })
    expect(normalizeMaskPoint(-100, -100, rect)).toEqual({ x: 0, y: 0 })
    expect(normalizeMaskPoint(2000, 2000, rect)).toEqual({ x: 1, y: 1 })
    expect(normalizeMaskPoint(100, 100, { left: 0, top: 0, width: 0, height: 450 })).toBeNull()
  })

  it('点间距用于抽稀（欧氏距离）', () => {
    expect(maskPointDistance({ x: 0, y: 0 }, { x: 0.3, y: 0.4 })).toBeCloseTo(0.5, 6)
    expect(maskPointDistance({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })).toBe(0)
  })

  it('预览画布保持画面宽高比，长边固定', () => {
    expect(previewMaskCanvasSize(16 / 9)).toEqual({ width: 1024, height: 576 })
    expect(previewMaskCanvasSize(9 / 16)).toEqual({ width: 1024, height: 1820 })
    expect(previewCanvasSizeOf(4 / 3)).toEqual({ width: 1024, height: 768 })
    // 非法宽高比按 16:9 兜底
    expect(previewMaskCanvasSize(0)).toEqual({ width: 1024, height: 576 })
    expect(previewMaskCanvasSize(Number.NaN)).toEqual({ width: 1024, height: 576 })
    expect(previewMaskCanvasSize(16 / 9, 512)).toEqual({ width: 512, height: 288 })
  })
})

/** 同 previewMaskCanvasSize，只是让 4:3 的返回值参与断言（避免断言写法被格式化搞乱）。 */
function previewCanvasSizeOf(aspect: number): { width: number; height: number } {
  return previewMaskCanvasSize(aspect)
}

describe('applyStrokesToContext', () => {
  it('M8 羽化：filter=blur(百分比×宽) 并自绘一次；0/非法值 = 硬边不动', () => {
    const softened = recordingContext(500)
    applyStrokesToContext(softened.ctx, [LINE], 1000, 500, 5)
    const draw = softened.log.find((entry) => entry.op === 'drawImage')
    expect(draw).toBeTruthy()
    // 5% × 1000 宽 = 50px 模糊半径
    expect(draw).toMatchObject({ op: 'drawImage', filter: 'blur(50px)', globalCompositeOperation: 'source-over' })

    const hard = recordingContext(500)
    applyStrokesToContext(hard.ctx, [LINE], 1000, 500, 0)
    expect(hard.log.some((entry) => entry.op === 'drawImage')).toBe(false)

    // 越界羽化被夹到 0..20（20% × 1000 = 200px）
    const clamped = recordingContext(500)
    applyStrokesToContext(clamped.ctx, [LINE], 1000, 500, 99)
    expect(clamped.log.find((entry) => entry.op === 'drawImage')).toMatchObject({ filter: 'blur(200px)' })
  })

  it('M8 反向遮罩：羽化之后用 xor + 不透明白整张取反；不反向时没有 xor 操作', () => {
    const inverted = recordingContext(500)
    applyStrokesToContext(inverted.ctx, [LINE], 1000, 500, 6, true)
    const xors = inverted.log.filter(
      (entry) => entry.op === 'fillRect' && entry.globalCompositeOperation === 'xor'
    )
    expect(xors).toHaveLength(1)
    expect(xors[0]).toMatchObject({ fillStyle: '#fff', width: 1000, height: 500 })
    // 顺序：先画 + 羽化（drawImage），最后才取反 —— 预览与导出共用同一张 PNG 的前提
    const featherIndex = inverted.log.findIndex((entry) => entry.op === 'drawImage')
    expect(featherIndex).toBeGreaterThan(-1)
    expect(inverted.log.indexOf(xors[0]!)).toBeGreaterThan(featherIndex)

    const normal = recordingContext(500)
    applyStrokesToContext(normal.ctx, [LINE], 1000, 500, 6, false)
    expect(normal.log.some((entry) => entry.globalCompositeOperation === 'xor')).toBe(false)
  })

  it('白底 + 圆头圆角：先铺满画布，再按笔画顺序绘制', () => {
    const { ctx, log } = recordingContext()
    applyStrokesToContext(ctx, [LINE], 1000, 500)

    expect(log[0]!.op).toBe('save')
    expect(log[1]).toMatchObject({ op: 'fillRect', x: 0, y: 0, width: 1000, height: 500, fillStyle: '#fff' })
    const begin = log.find((entry) => entry.op === 'beginPath')!
    expect(begin.lineCap).toBe('round')
    expect(begin.lineJoin).toBe('round')
    expect(log[log.length - 1]!.op).toBe('restore')
  })

  it('hide：destination-out 擦掉 alpha（RGB 黑），线宽按公式', () => {
    const { ctx, log } = recordingContext()
    applyStrokesToContext(ctx, [stroke('hide', 5, [{ x: 0.2, y: 0.4 }, { x: 0.8, y: 0.6 }])], 800, 450)

    const move = log.find((entry) => entry.op === 'moveTo')!
    expect(move).toMatchObject({ x: 160, y: 180, lineWidth: 80, strokeStyle: '#000', globalCompositeOperation: 'destination-out' })
    expect(log.find((entry) => entry.op === 'lineTo')).toMatchObject({ x: 640, y: 270 })
    expect(log.find((entry) => entry.op === 'stroke')).toMatchObject({ lineWidth: 80 })
  })

  it('restore：不透明白盖回（source-over），线宽按各自半径', () => {
    const { ctx, log } = recordingContext()
    applyStrokesToContext(ctx, [stroke('restore', 2.5, [{ x: 0, y: 0 }, { x: 1, y: 1 }])], 1000, 1000)

    expect(log.find((entry) => entry.op === 'moveTo')).toMatchObject({
      strokeStyle: '#fff',
      fillStyle: '#fff',
      globalCompositeOperation: 'source-over',
      lineWidth: 50
    })
  })

  it('单点笔画画成半径 = lineWidth/2 的圆点（arc + fill，不 stroke）', () => {
    const { ctx, log } = recordingContext()
    applyStrokesToContext(ctx, [stroke('hide', 4, [{ x: 0.5, y: 0.5 }])], 1024, 576)

    const arc = log.find((entry) => entry.op === 'arc')!
    expect(arc).toMatchObject({ x: 512, y: 288, r: (2 * 4 * 1024) / 100 / 2, startAngle: 0 })
    expect(arc.endAngle).toBeCloseTo(Math.PI * 2, 6)
    expect(log.some((entry) => entry.op === 'fill')).toBe(true)
    expect(log.some((entry) => entry.op === 'stroke')).toBe(false)
  })

  it('无点/非法半径的笔画跳过；多笔画按数组顺序（后画的盖前画的）', () => {
    const { ctx, log } = recordingContext()
    applyStrokesToContext(
      ctx,
      [
        stroke('hide', 4, []),
        stroke('hide', 0, [{ x: 0.5, y: 0.5 }]),
        stroke('hide', 3, [{ x: 0.25, y: 0.25 }, { x: 0.3, y: 0.3 }]),
        stroke('restore', 3, [{ x: 0.75, y: 0.75 }, { x: 0.8, y: 0.8 }])
      ],
      1000,
      1000
    )
    const strokeOps = log.filter((entry) => entry.op === 'stroke')
    expect(strokeOps).toHaveLength(2)
    expect(strokeOps[0]).toMatchObject({ globalCompositeOperation: 'destination-out' })
    expect(strokeOps[1]).toMatchObject({ globalCompositeOperation: 'source-over', strokeStyle: '#fff' })
  })
})

describe('maskPreviewObjectUrl（blob URL 生命周期）', () => {
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  let counter = 0
  const createObjectURL = vi.fn(() => `blob:mask-${++counter}`)
  const revokeObjectURL = vi.fn()

  function stubUrl(): void {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
  }

  function restoreUrl(): void {
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
    else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
    else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
  }

  /** 假 OffscreenCanvas：真画一遍（假 ctx 只记录），convertToBlob 返回 PNG Blob。 */
  function stubOffscreenCanvas(): { sizes: Array<{ width: number; height: number }>; logs: Op[][] } {
    const sizes: Array<{ width: number; height: number }> = []
    const logs: Op[][] = []
    class FakeOffscreenCanvas {
      width: number
      height: number
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
        sizes.push({ width, height })
      }
      getContext(kind: string): CanvasRenderingContext2D | null {
        if (kind !== '2d') return null
        const recorder = recordingContext()
        logs.push(recorder.log)
        return recorder.ctx
      }
      convertToBlob(): Promise<Blob> {
        return Promise.resolve(new Blob(['mask'], { type: 'image/png' }))
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    return { sizes, logs }
  }

  afterEach(() => {
    restoreUrl()
    vi.unstubAllGlobals()
    counter = 0
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
  })

  it('画布按画面宽高比光栅化，convertToBlob → createObjectURL 返回 blob 地址', async () => {
    stubUrl()
    const { sizes, logs } = stubOffscreenCanvas()
    const mask = { strokes: [line()] }

    const url = await maskPreviewObjectUrl(mask, 16 / 9)

    expect(url).toBe('blob:mask-1')
    expect(sizes).toEqual([{ width: 1024, height: 576 }])
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    // 光栅化真的画了：白底 + hide 笔画的 destination-out
    expect(logs[0]!.some((entry) => entry.op === 'fillRect')).toBe(true)
    expect(logs[0]!.some((entry) => entry.op === 'stroke' && entry.globalCompositeOperation === 'destination-out')).toBe(
      true
    )
  })

  it('空笔画返回 null（不产生 blob URL）', async () => {
    stubUrl()
    stubOffscreenCanvas()
    await expect(maskPreviewObjectUrl({ strokes: [] }, 16 / 9)).resolves.toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('画布拿不到 2D 上下文时返回 null（预览退化为无遮罩，不影响剪辑）', async () => {
    stubUrl()
    // 模拟浏览器没有可用的 2D 上下文（jsdom 不实现 canvas；这里显式给 null 避免 jsdom 的告警噪音）
    class NoContextCanvas {
      getContext(): null {
        return null
      }
      convertToBlob(): Promise<Blob> {
        return Promise.resolve(new Blob([]))
      }
    }
    vi.stubGlobal('OffscreenCanvas', NoContextCanvas)
    await expect(maskPreviewObjectUrl({ strokes: [line()] }, 16 / 9)).resolves.toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('revokeMaskUrl：空值安全、正常时调用 revokeObjectURL', () => {
    stubUrl()
    revokeMaskUrl(null)
    revokeMaskUrl(undefined)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    revokeMaskUrl('blob:mask-1')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mask-1')
  })

  function line(): MaskStroke {
    return stroke('hide', 4, [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 }
    ])
  }
})
