import type { MediaClipMask } from '@shared/types'
import { applyStrokesToContext, maskLineWidthPx, type MaskCanvasContext } from './maskCapture'

/**
 * M8：手绘遮罩光栅化（渲染侧导出用）。
 *
 * **口径只有一份**：真正“白底 → hide 擦透明 / restore 盖回”的画法在
 * `render/maskCapture.ts` 的 `applyStrokesToContext` 里（预览 CSS mask 与导出 PNG
 * 必须逐字节同口径）。本文件只做三件事：
 * 1. 把「画到上下文」包装成可注入的 `paintMaskStrokes`（jsdom 里可注入 fake ctx 验证）；
 * 2. 在渲染进程建一块与**导出画布等尺寸**的画布；
 * 3. 用 `convertToBlob` / `toBlob` 出 PNG 字节（**禁止 toDataURL**，check-env 会报错）。
 *
 * 与预览的差异只有尺寸：预览长边 1024（`MASK_PREVIEW_LONG_EDGE`），导出用目标分辨率；
 * 归一化坐标与尺寸无关，因此两者内容一致、只差采样精度。
 */

export { maskLineWidthPx }
export type { MaskCanvasContext }

/** 白 = 全可见（与 maskCapture 的白底一致；hide 区域被擦成 RGB 黑 + alpha 0）。 */
export const MASK_VISIBLE_COLOR = '#fff'

/** 画布尺寸收敛：至少 1 像素的整数（0/NaN 会让 canvas 建不出来）。 */
function normalizedSize(value: number): number {
  return Math.max(1, Math.round(Number.isFinite(value) ? value : 1))
}

/**
 * 把整片遮罩画到 2D 上下文：直接复用预览同一份 `applyStrokesToContext`。
 * 坐标乘以目标宽高、hide 擦 alpha、restore 不透明白、圆头圆角、单点圆点全部由它保证。
 */
export function paintMaskStrokes(
  ctx: MaskCanvasContext,
  mask: MediaClipMask,
  width: number,
  height: number
): void {
  applyStrokesToContext(
    ctx,
    mask.strokes ?? [],
    normalizedSize(width),
    normalizedSize(height),
    mask.featherPct ?? 0,
    mask.invert === true
  )
}

type MaskCanvas = OffscreenCanvas | HTMLCanvasElement

/** 建一块遮罩画布：优先 OffscreenCanvas（渲染进程），退到 DOM canvas；都没有时返回 null。 */
function createMaskCanvas(
  width: number,
  height: number
): { canvas: MaskCanvas; ctx: MaskCanvasContext } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx) return { canvas, ctx }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx) return { canvas, ctx }
  }
  return null
}

/** OffscreenCanvas 走 convertToBlob；DOM canvas 走 toBlob（都不产生 base64 中间串）。 */
function canvasToPngBlob(canvas: MaskCanvas): Promise<Blob> {
  const offscreen = canvas as OffscreenCanvas
  if (typeof offscreen.convertToBlob === 'function') {
    return offscreen.convertToBlob({ type: 'image/png' })
  }
  return new Promise<Blob>((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('遮罩 PNG 编码失败：canvas.toBlob 返回空'))
    }, 'image/png')
  })
}

/**
 * 光栅化一片手绘遮罩 → PNG 字节（与导出画布同尺寸）。
 * 失败（没有可用 Canvas / PNG 编码失败）直接抛错：导出宁可失败，也不能静默丢遮罩。
 */
export async function rasterizeMask(
  mask: MediaClipMask,
  width: number,
  height: number
): Promise<Uint8Array> {
  const w = normalizedSize(width)
  const h = normalizedSize(height)
  const made = createMaskCanvas(w, h)
  if (!made) {
    throw new Error('无法创建遮罩画布：当前环境没有可用的 2D Canvas（遮罩无法光栅化）')
  }
  paintMaskStrokes(made.ctx, mask, w, h)
  const blob = await canvasToPngBlob(made.canvas)
  return new Uint8Array(await blob.arrayBuffer())
}
