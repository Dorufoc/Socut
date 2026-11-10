import type { MaskStroke, MediaClipMask } from '@shared/types'

/**
 * M8：手绘遮罩的**光栅化口径**（预览与导出共用同一份纯函数）。
 *
 * 坐标：笔画点是画面归一化的 0..1（x 相对画面宽、y 相对画面高）。
 * 笔刷：`radiusPct` 是「画面宽度的百分比」；线宽（直径）换算为
 *
 *     lineWidth = 2 * radiusPct / 100 * canvasWidth
 *
 * ——预览（CSS mask 图片）与导出（mask PNG + alphamerge）必须逐字节同口径，
 * 所以这条公式只写在这里，导出侧 `maskRaster` 也必须以本函数为准。
 *
 * 颜色/透明度：白底 = 全部可见；hide 用 `destination-out` 把该区域擦成**透明**
 * （RGB 归零 → 看起来是黑），restore 用不透明白重新盖回。于是同一张 PNG 同时满足：
 * - CSS `mask-mode: alpha`（透明处被遮掉）——预览直接用它；
 * - FFmpeg `alphamerge` 需要的是 alpha 通道（透明处被抠掉）——导出直接用它。
 * 只画黑/白两个不透明色的话，alpha 通道恒为 1，两条路都失效（所以这里刻意擦 alpha）。
 */

/** 预览光栅化的长边像素（导出侧用输出分辨率；归一化坐标与尺寸无关）。 */
export const MASK_PREVIEW_LONG_EDGE = 1024

/** 支持 2D 上下文的两种 canvas（DOM canvas / OffscreenCanvas）。 */
export type MaskCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** 笔刷直径（px）：`2 * radiusPct / 100 * width`（与导出光栅化同一公式）。 */
export function maskLineWidthPx(radiusPct: number, widthPx: number): number {
  return (2 * radiusPct * widthPx) / 100
}

/** 归一化点 → 画布像素坐标；越界点夹回 0..1（与 schema 的夹取口径一致）。 */
export function maskPointToPixels(
  point: { x: number; y: number },
  widthPx: number,
  heightPx: number
): { x: number; y: number } {
  const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0)
  return { x: clamp01(point.x) * widthPx, y: clamp01(point.y) * heightPx }
}

/**
 * 指针 client 坐标 → 画面归一化坐标（0..1，越界夹取）。
 * `rect` 是画面框（`.stage__frame`）的 BoundingClientRect；宽高无效时返回 null。
 */
export function normalizeMaskPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number }
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height)
  }
}

/** 归一化点之间的欧氏距离（x 已按画面宽、y 按高计算；用于抽稀防爆点）。 */
export function maskPointDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * 把笔画画到 2D 上下文（白底 → 按顺序抹掉/擦回）。
 *
 * 调用方负责提供画布尺寸；`width` 同时决定线宽（见文件头的公式）。
 * 单点笔画画成半径 = lineWidth/2 的圆点（笔刷落笔即一个点）。
 */
export function applyStrokesToContext(
  ctx: MaskCanvasContext,
  strokes: ReadonlyArray<MaskStroke>,
  width: number,
  height: number,
  /** M8：羽化强度（画面宽度的百分比 0..20）；0/缺省 = 硬边（旧行为） */
  featherPct = 0,
  /** M8：反向遮罩（黑白互换）；false/缺省 = 旧行为 */
  invert = false
): void {
  ctx.save()
  // 白底 = 全部可见（alpha 1）
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    const points = stroke.points
    if (points.length === 0) continue
    const lineWidth = maskLineWidthPx(stroke.radiusPct, width)
    if (!(lineWidth > 0)) continue
    // hide：擦掉 alpha（RGB 归零 = 黑）；restore：不透明白盖回
    ctx.globalCompositeOperation = stroke.mode === 'hide' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = stroke.mode === 'hide' ? '#000' : '#fff'
    ctx.fillStyle = stroke.mode === 'hide' ? '#000' : '#fff'
    ctx.lineWidth = lineWidth
    if (points.length === 1) {
      const point = maskPointToPixels(points[0]!, width, height)
      ctx.beginPath()
      ctx.arc(point.x, point.y, lineWidth / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    const first = maskPointToPixels(points[0]!, width, height)
    ctx.beginPath()
    ctx.moveTo(first.x, first.y)
    for (let index = 1; index < points.length; index += 1) {
      const point = maskPointToPixels(points[index]!, width, height)
      ctx.lineTo(point.x, point.y)
    }
    ctx.stroke()
  }
  ctx.restore()
  // 羽化：整张图自绘一次（带 blur 滤镜）把硬边糊开。
  // 预览 CSS mask 与导出 alphamerge 用的是同一张 PNG，所以柔边程度天然一致。
  applyMaskFeather(ctx, featherPct, width)
  // 取反放在羽化之后：反相与模糊可交换（1 - blur(x) = blur(1 - x)），
  // 但写在这里保证两张图（预览/导出）走完全相同的步骤顺序。
  if (invert) applyMaskInvert(ctx, width, height)
}

/**
 * M8：反向遮罩。用 `xor` 与不透明白合成：
 * 结果 alpha = 1 - 原 alpha（hide 区域变可见、白底区域变隐藏），
 * 且 RGB = 255 × 新 alpha（白/黑与新 alpha 同步），因此 CSS `mask-mode: alpha`
 * 与 FFmpeg `format=gray`（取亮度）两条路依然一致。
 */
export function applyMaskInvert(ctx: MaskCanvasContext, width: number, height: number): void {
  ctx.save()
  ctx.globalCompositeOperation = 'xor'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/**
 * M8：羽化（柔边）。`featherPct` 是画面宽度的百分比 → 像素模糊半径，
 * 用 `ctx.filter = blur(Npx)` 把当前画布自绘一次（Chromium/Electron 支持 canvas 自绘）。
 * 0/非法值不动（硬边 = 旧行为，零回归）。
 */
export function applyMaskFeather(ctx: MaskCanvasContext, featherPct: number, width: number): void {
  const percent = Number.isFinite(featherPct) ? Math.min(20, Math.max(0, featherPct)) : 0
  if (!(percent > 0)) return
  const blurPx = (percent / 100) * Math.max(1, width)
  if (!(blurPx > 0)) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.filter = `blur(${Math.round(blurPx * 100) / 100}px)`
  ctx.drawImage(ctx.canvas as CanvasImageSource, 0, 0, width, ctx.canvas.height)
  ctx.restore()
}

/**
 * 预览画布尺寸：保持画面宽高比，长边固定（导出用目标分辨率，这里只为 CSS mask 出图）。
 * 宽高比非法时按 16:9 兜底。
 */
export function previewMaskCanvasSize(aspectRatio: number, longEdge = MASK_PREVIEW_LONG_EDGE): { width: number; height: number } {
  const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9
  const width = Math.max(2, Math.round(longEdge))
  const height = Math.max(2, Math.round(width / aspect))
  return { width, height }
}

/** DOM canvas 的 toBlob 回退（Electron 里优先 OffscreenCanvas，避免占 DOM）。 */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png')
  })
}

type MaskRasterResult = { blob: Blob } | null

async function rasterizeMask(
  mask: MediaClipMask,
  size: { width: number; height: number }
): Promise<MaskRasterResult> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size.width, size.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    applyStrokesToContext(ctx, mask.strokes, size.width, size.height, mask.featherPct ?? 0, mask.invert === true)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return { blob }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    applyStrokesToContext(ctx, mask.strokes, size.width, size.height, mask.featherPct ?? 0, mask.invert === true)
    const blob = await canvasToBlob(canvas)
    return blob ? { blob } : null
  }
  return null
}

/**
 * 生成预览用的遮罩 blob URL（`mask-image: url(blob:…)`）。
 *
 * check:env 禁用 `toDataURL`（base64 翻倍内存），所以走 `convertToBlob` / `toBlob`
 * 再 `URL.createObjectURL`；调用方负责在遮罩变化/卸载时 `revokeMaskUrl`。
 * 浏览器不支持画布时返回 null（预览退化为不加遮罩，不影响剪辑）。
 */
export async function maskPreviewObjectUrl(
  mask: MediaClipMask,
  aspectRatio: number,
  longEdge = MASK_PREVIEW_LONG_EDGE
): Promise<string | null> {
  if (mask.strokes.length === 0) return null
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  const size = previewMaskCanvasSize(aspectRatio, longEdge)
  const raster = await rasterizeMask(mask, size).catch(() => null)
  if (!raster) return null
  try {
    return URL.createObjectURL(raster.blob)
  } catch {
    return null
  }
}

/** 释放遮罩 blob URL（空值安全；重复释放不抛错）。 */
export function revokeMaskUrl(url: string | null | undefined): void {
  if (!url) return
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // 已被释放 / 环境不支持：忽略
  }
}
