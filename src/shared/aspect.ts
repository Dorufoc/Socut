import {
  COMPACT_BAR_WIDTH_PERCENT,
  COMPACT_RATIO_MAX,
  NON_169_TOLERANCE,
  ULTRAWIDE_BAR_MAX_WIDTH_PERCENT,
  ULTRAWIDE_RATIO_MIN,
  WIDE_TARGET_RATIO
} from './constants'
import type { AspectMode, Resolution } from './types'

/** SAR 修正后的显示宽高比（计划 C8：判定用显示比而非像素比）。 */
export function displayAspectRatio(resolution: Resolution, sar?: { num: number; den: number } | null): number {
  const sarRatio = sar && sar.den > 0 ? sar.num / sar.den : 1
  return ((resolution.width * sarRatio) / resolution.height) * 1
}

export function isNon16_9(ratio: number): boolean {
  return Math.abs(ratio - WIDE_TARGET_RATIO) / WIDE_TARGET_RATIO > NON_169_TOLERANCE
}

/** 预设分支选择：竖屏紧凑 / 超宽上限 / 标准（规格 §4.3）。 */
export function classifyAspect(ratio: number): AspectMode {
  if (ratio < COMPACT_RATIO_MAX) return 'compact'
  if (ratio > ULTRAWIDE_RATIO_MIN) return 'ultrawide'
  return 'standard'
}

/** 条宽（占显示宽度的百分比）随分支变化。 */
export function barWidthPercent(mode: AspectMode): number {
  switch (mode) {
    case 'compact':
      return COMPACT_BAR_WIDTH_PERCENT
    case 'ultrawide':
      return ULTRAWIDE_BAR_MAX_WIDTH_PERCENT
    default:
      return 62
  }
}

/**
 * 字号上限钳制（规格 §4.3：字号以 vh 上限钳制，避免竖屏下失控）。
 * vh / px@1080p 在竖屏下会同时放大，因此必须再加一道「按显示宽度」的硬上限。
 */
export function fontSizeCapPx(
  mode: AspectMode,
  preferredPx: number,
  width: number,
  height: number
): number {
  const byWidth = width * (mode === 'compact' ? 0.075 : 0.062)
  const byHeight = height * (mode === 'compact' ? 0.085 : 0.066)
  return Math.max(6, Math.min(preferredPx, byWidth, byHeight))
}

/** 由参考视频显示宽高比推出对齐的标准分辨率（长边吸附到标准档）。 */
export function resolutionFromRatio(ratio: number, baseHeight = 1080): Resolution {
  const width = Math.round((baseHeight * ratio) / 2) * 2
  return { width, height: baseHeight }
}

/** 依据参考视频分辨率就近选择规格档（保持宽高比时按高度档）。 */
export function pickResolutionPreset(resolution: Resolution): { width: number; height: number } {
  return { width: resolution.width, height: resolution.height }
}
