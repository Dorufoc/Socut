import type { RenderJobSpec } from '@shared/types'
import { renderFrame, type RenderOptions } from './renderer'

/**
 * 原生分辨率舞台（规格 §4.3）。
 * 只有一份像素缓冲区：尺寸恒等于目标分辨率。预览只是把它等比缩放画到显示 Canvas，
 * 显示 Canvas 的 CSS 尺寸、devicePixelRatio、系统 125%/150% 缩放都不参与任何坐标计算（计划 C9）。
 */

export class NativeStage {
  private readonly canvas: OffscreenCanvas
  private readonly ctx: OffscreenCanvasRenderingContext2D
  width: number
  height: number
  /** 最近一次渲染使用的选项（供 UI 判断当前是否带安全区） */
  options: RenderOptions = {}

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.canvas = new OffscreenCanvas(width, height)
    // willReadFrequently：导出路径每帧都要 convertToBlob（本质是读回），
    // 不标该位时 Chromium 会走 GPU 画布 + 每帧一次 GPU→CPU 回读，实测这是帧吞吐的主要开销。
    const ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: true })
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
   */
  blitTo(display: HTMLCanvasElement, options: { showSafeArea?: boolean; transparent?: boolean } = {}): void {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
    const cssWidth = Math.max(1, Math.floor(display.clientWidth || display.width || 1))
    const cssHeight = Math.max(1, Math.floor(display.clientHeight || display.height || 1))
    const targetW = Math.floor(cssWidth * dpr)
    const targetH = Math.floor(cssHeight * dpr)
    if (display.width !== targetW || display.height !== targetH) {
      display.width = targetW
      display.height = targetH
    }
    const ctx = display.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, display.width, display.height)

    // 透明区域用棋盘格提示（只存在于预览，永不进入导出）；有参考视频时让视频透出来
    if (!options.transparent) drawCheckerboard(ctx, display.width, display.height)

    const scale = Math.min(display.width / this.width, display.height / this.height)
    const w = this.width * scale
    const h = this.height * scale
    const x = (display.width - w) / 2
    const y = (display.height - h) / 2
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.canvas, x, y, w, h)
    // 安全区辅助线已在 render() 阶段绘入原生画布（预览专用选项），这里不再叠加
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
