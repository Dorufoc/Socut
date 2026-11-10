import { gradientLine, toCssColor } from '@shared/colors'
import type { LayoutBox } from '@shared/types'
import { canvasFont, getTextMeasurer, type FontSpec } from './textMeasure'

/**
 * 图层绘制（规格 §7 结构层叠：装饰线 → 背景条 → 主条 → 文字 → 副条）。
 * 所有绘制都在原生分辨率坐标系（1 单位 = 1 输出像素），与预览缩放无关（规格 §4.3）。
 *
 * 动画形态：「整体从左到右擦除」—— 一个片段只有**一条**绝对擦除线，
 * 所有矩形（条/色块/线/文字遮罩）都被同一对 x 边界裁切。
 * 每层各按自身宽度算比例会导致条内文字与条块擦除线不同步（出场时文字会“跑出”条外），
 * 因此擦除线只由片段的 root 盒决定，几何尺寸永远不变（规格 §11 纪律 6）。
 */

/** 片段的擦除线（原生分辨率绝对坐标）。入场时 leftPx 从 root 左缘向右推进。 */
export interface WipeSweep {
  leftPx: number
  rightPx: number
  /** 入场进度 0~1（= wipeTo），供文字逐字错峰使用 */
  progressIn: number
  /** 出场进度 0~1（= wipeFrom），供文字逐字渐隐使用 */
  progressOut: number
}

/**
 * 由一个片段的 root 盒与动画比例算出绝对擦除线。
 * 绘制（renderer）与命中测试（hitTest）必须用同一份口径，否则“看到的位置”和“点得到的位置”会错位。
 */
export function sweepOf(motion: ClipMotionLike, root: { x: number; w: number }): WipeSweep {
  return {
    leftPx: root.x + root.w * motion.wipeFrom,
    rightPx: root.x + root.w * motion.wipeTo,
    progressIn: motion.wipeTo,
    progressOut: motion.wipeFrom
  }
}

/** sweepOf 只用到这两个比例字段（避免本模块依赖动画模块的实现细节） */
export interface ClipMotionLike {
  wipeFrom: number
  wipeTo: number
}

export type DrawContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function setTracking(ctx: DrawContext, trackingPx: number): void {
  const withTracking = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if ('letterSpacing' in withTracking) {
    withTracking.letterSpacing = `${trackingPx}px`
  }
}

function roundedPath(
  ctx: DrawContext,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  ctx.beginPath()
  if (radius > 0.5 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, Math.min(radius, h / 2))
    return
  }
  ctx.rect(x, y, w, h)
}

/**
 * 实际可见内容的横向包络（排除纯布局容器）。
 * 擦除线、命中测试都必须用它而不是 root 盒：条宽随文字自适应后，
 * root 仍占满「画宽减边距」，用它会让窄条在入场早期就整条显露。
 */
export function contentBoundsOf(boxes: LayoutBox[]): { x: number; w: number } {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    if (box.kind === 'row' || box.kind === 'col') continue
    if (box.w <= 0 || box.h <= 0) continue
    left = Math.min(left, box.x)
    right = Math.max(right, box.x + box.w)
  }
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) {
    const root = boxes[0]
    return root ? { x: root.x, w: Math.max(1, root.w) } : { x: 0, w: 1 }
  }
  return { x: left, w: Math.max(1, right - left) }
}

/** 只画像素的盒（row/col/spacer 是纯布局容器，不参与锚点计算）。 */
const LAYOUT_ONLY_KINDS = new Set(['row', 'col', 'spacer'])

/**
 * 片段实际绘制内容的几何中心：关键帧的位移/缩放/旋转都以它为原点。
 * 用绘制盒并集（与擦除线同一口径），而不是 root 盒——条宽随文字自适应后，
 * root 是「画宽减边距」，绕它旋转会让窄条绕着一个看不见的中心甩出去。
 *
 * 绘制（renderer）与命中测试（hitTest）共用这一个锚点：命中测试要把鼠标点
 * **反变换**回这个局部坐标系，否则关键帧位移/缩放后点击位置会偏。
 */
export function contentAnchorOf(boxes: readonly LayoutBox[]): { cx: number; cy: number } | null {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    if (LAYOUT_ONLY_KINDS.has(box.kind)) continue
    if (box.w <= 0 || box.h <= 0) continue
    left = Math.min(left, box.x)
    right = Math.max(right, box.x + box.w)
    top = Math.min(top, box.y)
    bottom = Math.max(bottom, box.y + box.h)
  }
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null
  return { cx: (left + right) / 2, cy: (top + bottom) / 2 }
}

/**
 * 条块 / 色块：几何尺寸不变，用同一条擦除线裁出（左→右）。
 * 渐变基于**完整**盒几何生成，所以擦除过程中颜色不会跟着被压缩。
 */
export function drawBar(ctx: DrawContext, box: LayoutBox, sweep: WipeSweep, alphaMul = 1): void {
  if (!box.fill || box.w <= 0 || box.h <= 0) return
  const alpha = box.opacity * box.fill.opacity * alphaMul
  if (alpha <= 0.001) return
  const win = visibleSpanX(box, sweep.leftPx, sweep.rightPx)
  if (!win) return
  ctx.save()
  ctx.globalAlpha = clampAlpha(alpha)
  const x = Math.round(box.x)
  const y = Math.round(box.y)
  const w = Math.round(box.w)
  const h = Math.round(box.h)
  const gradient = box.fill.gradient
  if (gradient && gradient.enabled) {
    const line = gradientLine({ x, y, w: box.w, h: box.h }, gradient.angleDeg)
    const g = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1)
    g.addColorStop(0, toCssColor(gradient.from, 1))
    g.addColorStop(1, toCssColor(gradient.to, 1))
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = toCssColor(box.fill.color, 1)
  }
  // 只裁不缩放：擦除完全由 clip 完成，条块几何始终是布局盒（稳态帧无 clip）
  if (!win.full) {
    ctx.beginPath()
    ctx.rect(win.left, y, win.width, h)
    ctx.clip()
  }
  roundedPath(ctx, x, y, w, h, box.radiusPx)
  ctx.fill()
  ctx.restore()
}

/**
 * 装饰线：自身生长（ruleReveal，可提前入场）与擦除线叠加，用法与条块一致。
 * 端部可选渐隐（fadeEnd 比例的宽度淡出）。
 */
export function drawRule(
  ctx: DrawContext,
  box: LayoutBox,
  sweep: WipeSweep,
  ruleReveal: number,
  alphaMul = 1
): void {
  if (!box.fill || box.h <= 0) return
  const alpha = box.opacity * box.fill.opacity * alphaMul
  if (alpha <= 0.001) return
  const grownRight = box.x + box.w * clampRatio(ruleReveal)
  const win = visibleSpanX(box, sweep.leftPx, Math.min(sweep.rightPx, grownRight))
  if (!win) return
  ctx.save()
  const x = Math.round(box.x)
  const y = Math.round(box.y)
  const h = Math.max(1, Math.round(box.h))
  const color = box.fill.color
  const fadeEnd = box.fadeEnd ?? 0
  if (fadeEnd > 0) {
    // 渐隐基于整条线（而不是擦除到的那一段），擦除中不会看到渐变被挤压
    const g = ctx.createLinearGradient(x, y, x + Math.round(box.w), y)
    g.addColorStop(0, toCssColor(color, 1))
    g.addColorStop(Math.max(0.01, 1 - fadeEnd), toCssColor(color, 1))
    g.addColorStop(1, toCssColor(color, 0))
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = toCssColor(color, 1)
  }
  ctx.globalAlpha = clampAlpha(alpha)
  ctx.fillRect(win.left, y, win.width, h)
  ctx.restore()
}

/**
 * 文字：逐字渐隐渐现。
 * 每个字符按**字符索引**在自己的窗口内渐入（入场）/渐出（出场），
 * 进度与条块擦除同源（`wipeTo` / `wipeFrom`），因此不会出现“文字抢在条块前面”。
 * 交错跨度由预设 `textRevealFrames` 解释为「同时处于过渡的字符数」（字）。
 */
export function drawText(
  ctx: DrawContext,
  box: LayoutBox,
  sweep: WipeSweep,
  staggerChars: number,
  alphaMul = 1
): void {
  const text = box.text
  if (!text || text.content.length === 0 || box.w <= 0 || box.h <= 0) return
  const win = visibleSpanX(box, sweep.leftPx, sweep.rightPx)
  if (!win) return
  const alpha = box.opacity * alphaMul
  if (alpha <= 0.001) return

  const font: FontSpec = {
    family: text.family,
    weight: text.weight,
    sizePx: text.sizePx,
    trackingPx: text.trackingPx
  }
  // 与布局测量同一入口（TextMeasurer.wrap / truncate），确保折行与省略结果一致
  const measurer = getTextMeasurer()
  const lineTexts =
    text.maxLines > 1
      ? measurer.wrap(text.content, font, box.w, text.maxLines).lines
      : [
          measurer.measure({
            text: text.content,
            font,
            lineHeight: text.lineHeightPx / text.sizePx,
            maxWidth: box.w,
            maxLines: 1,
            ellipsis: text.ellipsis
          }).displayText
        ]

  const y = box.y
  const charsPerLine = lineTexts.map((line) => [...line])
  const totalChars = charsPerLine.reduce((sum, chars) => sum + chars.length, 0)
  if (totalChars === 0) return

  ctx.save()
  // 只把文字限制在条块擦除窗口内（不再用整段遮罩）；逐字 alpha 负责“渐显”
  if (!win.full) {
    ctx.beginPath()
    ctx.rect(win.left, Math.round(y), win.width, Math.round(box.h))
    ctx.clip()
  }

  ctx.font = canvasFont(font)
  setTracking(ctx, text.trackingPx)
  ctx.textBaseline = 'middle'
  // 逐字绘制：位置由累计字宽决定，所以对齐由我们自己算
  ctx.textAlign = 'left'

  if (text.gradient && text.gradient.enabled) {
    const line = gradientLine({ x: box.x, y, w: box.w, h: box.h }, text.gradient.angleDeg)
    const g = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1)
    g.addColorStop(0, toCssColor(text.gradient.from, 1))
    g.addColorStop(1, toCssColor(text.gradient.to, 1))
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = toCssColor(text.color, 1)
  }

  const lineHeight = text.lineHeightPx
  const blockTop = y + box.h / 2 - (lineTexts.length * lineHeight) / 2
  const stagger = charStagger(totalChars, staggerChars)
  let charIndex = 0

  for (let li = 0; li < charsPerLine.length; li++) {
    const chars = charsPerLine[li] ?? []
    const widths = chars.map((ch) => measurer.widthOf(ch, font))
    const lineWidth = widths.reduce((sum, w) => sum + w, 0)
    const alignX =
      text.align === 'center' ? box.x + box.w / 2 : text.align === 'right' ? box.x + box.w : box.x
    const startX = text.align === 'center' ? alignX - lineWidth / 2 : text.align === 'right' ? alignX - lineWidth : alignX
    const baseline = blockTop + lineHeight * (li + 0.5)
    let cursor = startX

    for (let ci = 0; ci < chars.length; ci++) {
      const charAlpha = stagger(charIndex, sweep)
      charIndex += 1
      const charWidth = widths[ci] ?? 0
      // 已经完整落在擦除窗口外的字符直接跳过（clip 也会裁掉，但跳过可减少无效落笔，
      // 同时让「逐字渐显不得越线」的约束在录制指令层也能被验证）
      if (cursor > win.left + win.width + 0.5 || cursor + charWidth < win.left - 0.5) {
        cursor += charWidth
        continue
      }
      if (charAlpha > 0.002) {
        ctx.globalAlpha = clampAlpha(alpha * charAlpha)
        ctx.fillText(chars[ci] ?? '', Math.round(cursor), Math.round(baseline))
      }
      cursor += charWidth
    }
  }

  ctx.restore()
}

/**
 * 逐字 alpha：字符 i 在自己的窗口内从 0 → 1（入场）、从 1 → 0（出场）。
 * 窗口宽度 = staggerChars / 总字数，并按总进度归一，保证进度=1 时所有字都是 1。
 */
function charStagger(totalChars: number, staggerChars: number): (index: number, sweep: WipeSweep) => number {
  const n = Math.max(1, totalChars)
  const window = Math.min(0.6, Math.max(0.05, Math.max(1, staggerChars) / n))
  return (index, sweep) => {
    const q = n === 1 ? 0 : (index / (n - 1)) * (1 - window)
    const inA = clampRatio((sweep.progressIn - q) / window)
    const outA = 1 - clampRatio((sweep.progressOut - q) / window)
    return inA * outA
  }
}

/**
 * 盒与擦除线的交集（整数像素）：返回该帧该盒真正应该露出的横向区间。
 * full=true 表示整盒都在线右侧（稳态帧可以省掉 clip）。
 */
export function visibleSpanX(
  box: { x: number; w: number },
  leftPx: number,
  rightPx: number
): { left: number; width: number; full: boolean } | null {
  const left = Math.round(Math.max(box.x, leftPx))
  const right = Math.round(Math.min(box.x + box.w, rightPx))
  const width = right - left
  if (width <= 0) return null
  return { left, width, full: left === Math.round(box.x) && width === Math.round(box.w) }
}

function clampAlpha(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function clampRatio(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
