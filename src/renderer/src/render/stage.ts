import type { RenderJobSpec } from '@shared/types'
import { renderFrame, type RenderOptions } from './renderer'

/**
 * 原生分辨率舞台（规格 §4.3）。
 * 只有一份像素缓冲区：尺寸恒等于目标分辨率。预览只是把它等比缩放画到显示 Canvas，
 * 显示 Canvas 的 CSS 尺寸、devicePixelRatio、系统 125%/150% 缩放都不参与任何坐标计算（计划 C9）。
 */

export interface NativeStageOptions {
  /**
   * 是否会被回读（导出、封面、像素回归、评审表）。默认 true = CPU 画布，
   * 保证与导出路径逐字节一致；预览不读回，传 false 让 Chromium 走 GPU 画布。
   */
  readback?: boolean
  /** 显示层缩放质量。预览用 low 降低每帧重采样成本；默认 high 保持原行为。 */
  smoothing?: ImageSmoothingQuality
}

export interface BlitShowOptions {
  showSafeArea?: boolean
  transparent?: boolean
  /** 显式 CSS 尺寸（预览循环的缓存值）。不传时保持 clientWidth 旧语义。 */
  cssWidth?: number
  cssHeight?: number
  /** 覆盖构造时的缩放质量 */
  smoothing?: ImageSmoothingQuality
}

export class NativeStage {
  private readonly canvas: OffscreenCanvas
  private readonly ctx: OffscreenCanvasRenderingContext2D
  /** 构造时的默认缩放质量（blitTo 可逐次覆盖） */
  private readonly smoothing: ImageSmoothingQuality
  /** 显示画布的 2D 上下文只取一次：同一挂载周期内 getContext 是纯浪费 */
  private displayCtx: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null
  width: number
  height: number
  /** 最近一次渲染使用的选项（供 UI 判断当前是否带安全区） */
  options: RenderOptions = {}

  constructor(width: number, height: number, options: NativeStageOptions = {}) {
    this.width = width
    this.height = height
    this.smoothing = options.smoothing ?? 'high'
    this.canvas = new OffscreenCanvas(width, height)
    // willReadFrequently：导出路径每帧都要 convertToBlob（本质是读回），
    // 不标该位时 Chromium 会走 GPU 画布 + 每帧一次 GPU→CPU 回读，实测这是帧吞吐的主要开销。
    // 预览不回读，用 { alpha: true } 走 GPU 画布（回读语义由 readback:true 的调用方保持）。
    const ctx =
      options.readback === false
        ? this.canvas.getContext('2d', { alpha: true })
        : this.canvas.getContext('2d', { alpha: true, willReadFrequently: true })
    if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文')
    this.ctx = ctx
  }

  /**
   * 原生分辨率画布本体。逐帧评审表等取证用途需要自己控制缩放与背景，
   * 不能走 blitTo（那个路径会按 devicePixelRatio 重算目标尺寸）。
   */
  get surface(): OffscreenCanvas {
    return this.canvas
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
  }

  render(job: RenderJobSpec, frame: number, options: RenderOptions = {}): void {
    // 预览可以传 safeArea；导出路径永不传（见 frameSource）
    this.options = options
    renderFrame(this.ctx, job, frame, options)
  }

  /**
   * 等比缩放到显示 Canvas（唯一允许的重采样位置，仅用于预览）。
   * transparent=true 时不画棋盘格，让 Canvas 真正透明，露出下层参考视频。
   * cssWidth/cssHeight 不传时保持旧的 clientWidth 语义（像素一致性回归依赖这一点）。
   */
  blitTo(display: HTMLCanvasElement, options: BlitShowOptions = {}): void {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const cssWidth = Math.max(
      1,
      Math.floor(options.cssWidth ?? (display.clientWidth || display.width || 1))
    )
    const cssHeight = Math.max(
      1,
      Math.floor(options.cssHeight ?? (display.clientHeight || display.height || 1))
    )
    const targetW = Math.floor(cssWidth * dpr)
    const targetH = Math.floor(cssHeight * dpr)
    if (display.width !== targetW || display.height !== targetH) {
      display.width = targetW
      display.height = targetH
    }
    const ctx = this.contextOf(display)
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, display.width, display.height)

    // 透明区域用棋盘格提示（只存在于预览，永不进入导出）；有参考视频时让视频透出来
    if (!options.transparent) drawCheckerboardCached(ctx, display.width, display.height)

    const scale = Math.min(display.width / this.width, display.height / this.height)
    const w = this.width * scale
    const h = this.height * scale
    const x = (display.width - w) / 2
    const y = (display.height - h) / 2
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = options.smoothing ?? this.smoothing
    ctx.drawImage(this.canvas, x, y, w, h)
    // 安全区辅助线已在 render() 阶段绘入原生画布（预览专用选项），这里不再叠加
  }

  /** 同一块显示画布只 getContext 一次（尺寸变化会清空位图，但上下文对象本身不变）。 */
  private contextOf(display: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const cached = this.displayCtx
    if (cached && cached.canvas === display) return cached.ctx
    const ctx = display.getContext('2d')
    if (ctx) this.displayCtx = { canvas: display, ctx }
    return ctx
  }

  async pngBlob(): Promise<Blob> {
    return this.canvas.convertToBlob({ type: 'image/png' })
  }

  async pngBuffer(): Promise<ArrayBuffer> {
    const blob = await this.canvas.convertToBlob({ type: 'image/png' })
    return blob.arrayBuffer()
  }

  /** 原生分辨率像素回读（像素一致性回归用；与导出同一张画布）。 */
  imageData(): ImageData {
    return this.ctx.getImageData(0, 0, this.width, this.height)
  }

  /**
   * 未压缩 RGBA 帧字节（主路径）。
   * getImageData 是一次线性读回，比 PNG 的 zlib 压缩便宜得多；
   * 配合上面的 willReadFrequently（强制 CPU 画布）避免每帧 GPU→CPU 回读。
   */
  rawRgba(): ArrayBuffer {
    const ctx = this.ctx as OffscreenCanvasRenderingContext2D & {
      getImageData(sx: number, sy: number, sw: number, sh: number): ImageData
    }
    const image = ctx.getImageData(0, 0, this.width, this.height)
    // getImageData 返回的 buffer 恰好就是这个尺寸，直接交出底层 buffer（不再 slice 一次拷贝）
    return image.data.buffer as ArrayBuffer
  }
}

/** 棋盘格导出供像素一致性回归复用：预览与“导出图按同比例缩放”必须在同一背景上比。 */
export function drawCheckerboard(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const cell = Math.max(8, Math.round(Math.min(width, height) / 32))
  ctx.save()
  ctx.fillStyle = '#1b1f25'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#22272e'
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      if (((x / cell + y / cell) | 0) % 2 === 0) ctx.fillRect(x, y, cell, cell)
    }
  }
  ctx.restore()
}

/**
 * 棋盘格的缓存版本（预览 blit 用）。
 * 逐格 fillRect 在 1080P 下是几千次调用；棋盘格本身只有两种纯色且格宽是整数，
 * 用一块 2×2 格子的 tile 做 CanvasPattern 一次 fillRect，像素结果与逐格绘制完全一致
 * （原点对齐、1:1 不缩放，没有重采样/抗锯齿差异）。`drawCheckerboard` 保持原样给回归用。
 */
const CHECKER_BASE = '#1b1f25'
const CHECKER_ALT = '#22272e'
const checkerTiles = new Map<number, OffscreenCanvas | HTMLCanvasElement>()
const checkerPatterns = new WeakMap<CanvasRenderingContext2D, { cell: number; pattern: CanvasPattern }>()

function checkerTile(cell: number): OffscreenCanvas | HTMLCanvasElement | null {
  const cached = checkerTiles.get(cell)
  if (cached) return cached
  const size = cell * 2
  let canvas: OffscreenCanvas | HTMLCanvasElement
  let tileCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (typeof OffscreenCanvas !== 'undefined') {
    const offscreen = new OffscreenCanvas(size, size)
    canvas = offscreen
    tileCtx = offscreen.getContext('2d')
  } else if (typeof document !== 'undefined') {
    const domCanvas = document.createElement('canvas')
    domCanvas.width = size
    domCanvas.height = size
    canvas = domCanvas
    tileCtx = domCanvas.getContext('2d')
  } else {
    return null
  }
  if (!tileCtx) return null
  tileCtx.fillStyle = CHECKER_BASE
  tileCtx.fillRect(0, 0, size, size)
  tileCtx.fillStyle = CHECKER_ALT
  // 与逐格绘制同一判据：((x/cell + y/cell) | 0) % 2 === 0 → 偶数格是亮色
  tileCtx.fillRect(0, 0, cell, cell)
  tileCtx.fillRect(cell, cell, cell, cell)
  // 窗口尺寸变化会产生新的格子尺寸；缓存只保留最近几种，避免无界增长
  if (checkerTiles.size > 8) checkerTiles.clear()
  checkerTiles.set(cell, canvas)
  return canvas
}

function drawCheckerboardCached(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const cell = Math.max(8, Math.round(Math.min(width, height) / 32))
  const cached = checkerPatterns.get(ctx)
  let pattern = cached && cached.cell === cell ? cached.pattern : null
  if (!pattern) {
    const tile = checkerTile(cell)
    pattern = tile ? ctx.createPattern(tile, 'repeat') : null
    if (!pattern) {
      // 极少数环境拿不到 pattern（例如没有可用的 tile 画布）：退回逐格绘制，保证可见结果不变
      drawCheckerboard(ctx, width, height)
      return
    }
    checkerPatterns.set(ctx, { cell, pattern })
  }
  ctx.save()
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}
