import { applyEasing, clamp01 } from '@shared/easing'
import { resolveClipParams } from '@shared/keyframes'
import type { ResolvedTextElement } from '@shared/types'
import type { DrawContext } from './layers'
import { canvasFont, getTextMeasurer, type FontSpec } from './textMeasure'

/**
 * M7：文本元素绘制（Canvas2D，与字幕条同一个像素生产者）。
 *
 * 与字幕条的区别：
 * - 字幕条是包装的一部分，走 Yoga 布局 + 擦除动画；文本元素是**自由摆放**的叠加文字，
 *   布局只由「锚点 + 对齐 + 最大宽度」决定，动画是淡入/上浮（不做擦除）。
 * - 所有像素尺寸按 1080p 声明，这里按 `height / 1080` 缩放，360p→4K 观感一致。
 * - 文本在字幕条之下绘制：`renderFrame` 先画文本元素、再画字幕条。
 *
 * 纯绘制函数：不查预设表、不读 store；排版与测量只用 `TextMeasurer`（与字幕共用同一套字形度量）。
 */

/** 文本盒最大宽度占画面比例（留出安全边距，避免长文案贴边）。 */
const MAX_WIDTH_RATIO = 0.84

function clampTextWidth(width: number): number {
  return Math.max(1, width)
}

export interface TextElementDrawOptions {
  /** 预览专用：只画某个元素 */
  isolateId?: string | null
}

export function drawTextElements(
  ctx: DrawContext,
  elements: readonly ResolvedTextElement[],
  globalFrame: number,
  width: number,
  height: number,
  options: TextElementDrawOptions = {}
): void {
  for (const element of elements) {
    if (options.isolateId && element.id !== options.isolateId) continue
    if (globalFrame < element.startFrame || globalFrame >= element.endFrame) continue
    drawTextElement(ctx, element, globalFrame, width, height)
  }
}

function drawTextElement(
  ctx: DrawContext,
  element: ResolvedTextElement,
  globalFrame: number,
  width: number,
  height: number
): void {
  const style = element.style
  const scale = height / 1080
  const localFrame = globalFrame - element.startFrame
  const anim = element.animation

  // 入场 / 出场：淡入淡出 + 上浮（出场只淡出，不反向位移）
  const inRaw = anim.inFrames > 0 ? clamp01(localFrame / anim.inFrames) : 1
  const inEased = applyEasing(anim.easing, inRaw)
  const outStart = anim.totalFrames - anim.outFrames
  const outRaw = localFrame < outStart || anim.outFrames <= 0 ? 0 : clamp01((localFrame - outStart + 1) / anim.outFrames)
  const outEased = applyEasing(anim.easing, outRaw)
  const alpha = inEased * (1 - outEased)
  if (alpha <= 0.001) return

  const progress = anim.totalFrames > 0 ? localFrame / anim.totalFrames : 0
  const params = resolveClipParams(element.keyframes, progress)

  const font: FontSpec = {
    family: element.fontFamily,
    weight: style.weight,
    sizePx: style.sizePx * scale,
    trackingPx: style.trackingPx * scale
  }
  const lineHeightPx = font.sizePx * style.lineHeight
  const measurer = getTextMeasurer()
  const maxWidth = clampTextWidth(width * MAX_WIDTH_RATIO)
  const wrapped = measurer.wrap(element.text, font, maxWidth, style.maxLines)

  const lineWidths = wrapped.lines.map((line) =>
    [...line].reduce((sum, char) => sum + measurer.widthOf(char, font), 0)
  )
  const boxWidth = Math.min(maxWidth, Math.max(1, ...lineWidths))
  const textHeight = Math.max(lineHeightPx, wrapped.lines.length * lineHeightPx)
  const paddingX = style.plate.paddingXPx * scale
  const paddingY = style.plate.paddingYPx * scale
  const plateWidth = boxWidth + paddingX * 2
  const plateHeight = textHeight + paddingY * 2

  // 锚点 = 文本盒（不含背景板内边距）的左上角所对位置；align 只决定文本在盒内的横向对齐
  const riseOffset = anim.risePx * scale * (1 - inEased)
  const anchorX = (width * style.anchorXPct) / 100 + (width * params.offsetXPct) / 100
  const anchorY = (height * style.anchorYPct) / 100 + riseOffset + (height * params.offsetYPct) / 100
  const align = style.align
  const boxX =
    align === 'center' ? anchorX - boxWidth / 2 : align === 'right' ? anchorX - boxWidth : anchorX
  const plateX = boxX - paddingX
  const plateY = anchorY - paddingY

  ctx.save()
  ctx.globalAlpha = alpha * params.opacity
  if (params.scalePct !== 100 || params.rotationDeg !== 0) {
    const centerX = plateX + plateWidth / 2
    const centerY = plateY + plateHeight / 2
    ctx.translate(centerX, centerY)
    ctx.rotate((params.rotationDeg * Math.PI) / 180)
    const scaleFactor = params.scalePct / 100
    ctx.scale(scaleFactor, scaleFactor)
    ctx.translate(-centerX, -centerY)
  }

  if (style.plate.enabled && style.plate.opacity > 0) {
    ctx.save()
    ctx.globalAlpha = alpha * params.opacity * style.plate.opacity
    ctx.fillStyle = style.plate.color
    const radius = Math.min(style.plate.radiusPx * scale, plateHeight / 2)
    if (radius > 0.5 && typeof ctx.roundRect === 'function') {
      ctx.beginPath()
      ctx.roundRect(plateX, plateY, plateWidth, plateHeight, radius)
    } else {
      ctx.beginPath()
      ctx.rect(plateX, plateY, plateWidth, plateHeight)
    }
    ctx.fill()
    ctx.restore()
  }

  ctx.font = canvasFont(font)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  if (style.shadowBlurPx > 0 || style.shadowOffsetXPx !== 0 || style.shadowOffsetYPx !== 0) {
    ctx.shadowColor = style.shadowColor
    ctx.shadowBlur = style.shadowBlurPx * scale
    ctx.shadowOffsetX = style.shadowOffsetXPx * scale
    ctx.shadowOffsetY = style.shadowOffsetYPx * scale
  }
  ctx.fillStyle = style.color
  if (style.strokeWidthPx > 0) {
    ctx.lineWidth = style.strokeWidthPx * scale
    ctx.strokeStyle = style.strokeColor
  }

  const blockTop = anchorY + (textHeight - wrapped.lines.length * lineHeightPx) / 2
  for (let index = 0; index < wrapped.lines.length; index += 1) {
    const line = wrapped.lines[index] ?? ''
    const lineWidth = lineWidths[index] ?? 0
    const x =
      align === 'center' ? boxX + (boxWidth - lineWidth) / 2 : align === 'right' ? boxX + boxWidth - lineWidth : boxX
    const y = blockTop + lineHeightPx * index + lineHeightPx / 2
    if (typeof ctx.strokeText === 'function' && style.strokeWidthPx > 0) ctx.strokeText(line, x, y)
    ctx.fillText(line, x, y)
  }
  ctx.restore()
}
