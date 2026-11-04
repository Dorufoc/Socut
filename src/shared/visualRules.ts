import { parseColor } from './colors'

/**
 * 视觉检查用的纯规则（不依赖 Canvas / Electron，便于单测）。
 * 只回答“可计算的那部分视觉问题”：字符与底色的对比度、条块与文字的占比。
 */

export const VISUAL_THRESHOLDS = {
  /** 标题文字至少占主条宽度的比例（低于此值说明右侧大片空板） */
  minTextWidthRatio: 0.5,
  /** 主条右侧空白占条宽的上限 */
  maxRightVoidRatio: 0.5,
  /** 条高 /（标题字号 × 行数）的合理区间：衡量上下留白，不与行数混淆 */
  minBarFontRatio: 1.2,
  maxBarFontRatio: 3,
  /** 副标题字号 / 主标题字号 */
  minSubFontRatio: 0.38,
  maxSubFontRatio: 0.56,
  /** 标题与条块上/下沿的最小呼吸空间（px @1080p） */
  minPlatePaddingPx: 8,
  /** 主条底边距画底的最小比例 */
  minBottomRatio: 0.07,
  /** 主条左边距画宽的最小比例 */
  minLeftRatio: 0.03,
  /** 标题与底色的最小对比度（WCAG AA 大字） */
  minTitleContrast: 4.5,
  /** 副标题与底色的最小对比度 */
  minSubtitleContrast: 3,
  /** 长文案最大行数 */
  maxTitleLines: 2
} as const

function channelLuminance(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 相对亮度；颜色解析失败时返回 null（不参与断言）。 */
export function relativeLuminance(color: string): number | null {
  const parsed = parseColor(color)
  if (!parsed) return null
  return (
    0.2126 * channelLuminance(parsed.r) +
    0.7152 * channelLuminance(parsed.g) +
    0.0722 * channelLuminance(parsed.b)
  )
}

/** WCAG 对比度（1~21）；任一颜色不可解析时返回 null。 */
export function contrastRatio(foreground: string, background: string): number | null {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  if (a === null || b === null) return null
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

/** 文字区占条宽的比例（条宽为 0 时返回 0，不产生 NaN）。 */
export function textWidthRatio(textWidth: number, barWidth: number): number {
  return barWidth > 0 ? Math.min(1, Math.max(0, textWidth / barWidth)) : 0
}

/** 条块右侧空白比例（文字右缘到条右缘）。 */
export function rightVoidRatio(textRight: number, barRight: number, barWidth: number): number {
  if (barWidth <= 0) return 0
  return Math.min(1, Math.max(0, (barRight - textRight) / barWidth))
}

/** 逐条阈值检查；返回人可读的失败原因列表。 */
export interface VisualSampleMetrics {
  /** 文字内容占比（0~1） */
  textRatio: number
  /** 条块右侧空白占比（0~1） */
  rightVoid: number
  /** 条高 /（标题字号 × 行数） */
  barFontRatio: number
  /** 副标题字号 / 主标题字号 */
  subFontRatio: number
  /** 标题距条块上沿（像素） */
  padTop: number
  /** 副标题距条块下沿（像素）；无副标题时为标题下沿 */
  padBottom: number
  /** 条块底边距画底比例 */
  bottomRatio: number
  /** 条块左边距画宽比例 */
  leftRatio: number
  /** 标题与底色对比度（无法计算时 null） */
  titleContrast: number | null
  /** 副标题与底色对比度 */
  subtitleContrast: number | null
  /** 标题实际行数 */
  titleLines: number
}

export function checkVisualSample(metrics: VisualSampleMetrics): string[] {
  const failures: string[] = []
  const t = VISUAL_THRESHOLDS
  if (metrics.textRatio < t.minTextWidthRatio) {
    failures.push(`文字只占条宽 ${(metrics.textRatio * 100).toFixed(0)}%（应 ≥ ${t.minTextWidthRatio * 100}%）`)
  }
  if (metrics.rightVoid > t.maxRightVoidRatio) {
    failures.push(`条块右侧空白 ${(metrics.rightVoid * 100).toFixed(0)}%（应 ≤ ${t.maxRightVoidRatio * 100}%）`)
  }
  if (metrics.barFontRatio < t.minBarFontRatio || metrics.barFontRatio > t.maxBarFontRatio) {
    failures.push(`条高/字号 = ${metrics.barFontRatio.toFixed(2)}（应在 ${t.minBarFontRatio}–${t.maxBarFontRatio}）`)
  }
  if (metrics.subFontRatio > 0 && (metrics.subFontRatio < t.minSubFontRatio || metrics.subFontRatio > t.maxSubFontRatio)) {
    failures.push(`副标题字号比例 ${metrics.subFontRatio.toFixed(2)}（应在 ${t.minSubFontRatio}–${t.maxSubFontRatio}）`)
  }
  if (metrics.padTop < t.minPlatePaddingPx) failures.push(`标题距条顶 ${metrics.padTop.toFixed(0)}px（应 ≥ ${t.minPlatePaddingPx}px）`)
  if (metrics.padBottom < t.minPlatePaddingPx) {
    failures.push(`文字距条底 ${metrics.padBottom.toFixed(0)}px（应 ≥ ${t.minPlatePaddingPx}px）`)
  }
  if (metrics.bottomRatio < t.minBottomRatio) {
    failures.push(`底边距 ${(metrics.bottomRatio * 100).toFixed(1)}%（应 ≥ ${t.minBottomRatio * 100}%）`)
  }
  if (metrics.leftRatio < t.minLeftRatio) {
    failures.push(`左边距 ${(metrics.leftRatio * 100).toFixed(1)}%（应 ≥ ${t.minLeftRatio * 100}%）`)
  }
  if (metrics.titleContrast !== null && metrics.titleContrast < t.minTitleContrast) {
    failures.push(`标题对比度 ${metrics.titleContrast.toFixed(2)}:1（应 ≥ ${t.minTitleContrast}:1）`)
  }
  if (metrics.subtitleContrast !== null && metrics.subtitleContrast < t.minSubtitleContrast) {
    failures.push(`副标题对比度 ${metrics.subtitleContrast.toFixed(2)}:1（应 ≥ ${t.minSubtitleContrast}:1）`)
  }
  if (metrics.titleLines > t.maxTitleLines) {
    failures.push(`标题 ${metrics.titleLines} 行（应 ≤ ${t.maxTitleLines} 行）`)
  }
  return failures
}
