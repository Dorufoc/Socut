import { isValidColor } from './colors'
import { DEFAULT_FONT_ID, TEXT_TRACK_ID } from './constants'
import type { TextElementAnimation, TextElementPresetId, TextElementStyle, TextElementStyleOverrides } from './types'

/**
 * M7：文本元素起始预设。
 *
 * 与「字幕条预设（8 套）」是两套不同东西：
 * - 字幕条 = 新闻包装的一部分，有严格的安全区/擦除纪律，由 `presets/` 定义；
 * - 文本元素 = 可自由摆放的叠加文字（标题、人名条、引语、数字、地点、时间戳、角标），
 *   这套表只提供**起点**，用户可逐字段覆盖（`TextElementClip.styleOverrides`）。
 *
 * 像素尺寸一律按 1080p 基准声明，渲染时按实际画高等比缩放（360p→4K 观感一致）。
 */

/** 文本元素动画默认值（淡入 + 上浮；与字幕条的左→右擦除是两套语言）。 */
export const DEFAULT_TEXT_ANIMATION: TextElementAnimation = {
  inDurationSec: 0.3,
  outDurationSec: 0.2,
  easing: 'outCubic',
  risePx: 14
}

/** 基础样式默认值（所有预设都从它出发）。 */
export const DEFAULT_TEXT_STYLE: TextElementStyle = {
  fontId: DEFAULT_FONT_ID,
  sizePx: 64,
  weight: 700,
  color: '#FFFFFF',
  trackingPx: 0,
  lineHeight: 1.25,
  maxLines: 2,
  align: 'left',
  anchorXPct: 8,
  anchorYPct: 12,
  strokeWidthPx: 0,
  strokeColor: '#000000',
  shadowBlurPx: 0,
  shadowColor: '#000000',
  shadowOffsetXPx: 0,
  shadowOffsetYPx: 0,
  plate: {
    enabled: false,
    color: '#000000',
    opacity: 0.72,
    paddingXPx: 24,
    paddingYPx: 12,
    radiusPx: 4
  }
}

export interface TextPresetDefinition {
  id: TextElementPresetId
  name: string
  /** 新建时的示例文案（用户直接改字即可） */
  sampleText: string
  style: TextElementStyleOverrides
}

/** 7 套起始预设（顺序 = 面板里的展示顺序）。 */
export const TEXT_PRESETS: readonly TextPresetDefinition[] = [
  {
    id: 'newsHeadline',
    name: '新闻标题',
    sampleText: '今日头条',
    style: { sizePx: 88, weight: 800, trackingPx: 1, anchorXPct: 8, anchorYPct: 10, maxLines: 2 }
  },
  {
    id: 'personTag',
    name: '人名条',
    sampleText: '张伟｜省发展改革委主任',
    style: {
      sizePx: 56,
      weight: 700,
      anchorXPct: 8,
      anchorYPct: 78,
      plate: { enabled: true, color: '#0A1B2E', opacity: 0.82, paddingXPx: 22, paddingYPx: 10, radiusPx: 3 }
    }
  },
  {
    id: 'quoteCard',
    name: '引语卡',
    sampleText: '“稳中求进，把实事办到群众心坎上。”',
    style: {
      sizePx: 52,
      weight: 500,
      lineHeight: 1.4,
      anchorXPct: 50,
      anchorYPct: 46,
      maxLines: 3,
      plate: { enabled: true, color: '#111418', opacity: 0.78, paddingXPx: 36, paddingYPx: 22, radiusPx: 6 }
    }
  },
  {
    id: 'numberStat',
    name: '数字读数',
    sampleText: '12.8%',
    style: { sizePx: 132, weight: 900, color: '#FFD400', trackingPx: 2, anchorXPct: 8, anchorYPct: 24, maxLines: 1 }
  },
  {
    id: 'locationTag',
    name: '地点条',
    sampleText: '浙江 · 杭州',
    style: { sizePx: 44, weight: 600, trackingPx: 1, anchorXPct: 8, anchorYPct: 88, maxLines: 1 }
  },
  {
    id: 'timestamp',
    name: '时间戳',
    sampleText: '2026-11-09  19:30',
    style: { sizePx: 34, weight: 500, color: '#E6EDF7', trackingPx: 1, anchorXPct: 92, anchorYPct: 92, align: 'right', maxLines: 1 }
  },
  {
    id: 'cornerBadge',
    name: '角标',
    sampleText: '直播中',
    style: {
      sizePx: 36,
      weight: 800,
      color: '#FFFFFF',
      anchorXPct: 88,
      anchorYPct: 6,
      align: 'right',
      maxLines: 1,
      plate: { enabled: true, color: '#C4141E', opacity: 1, paddingXPx: 18, paddingYPx: 8, radiusPx: 999 }
    }
  }
] as const

export const TEXT_PRESET_IDS = TEXT_PRESETS.map((preset) => preset.id)
export const DEFAULT_TEXT_PRESET_ID: TextElementPresetId = 'newsHeadline'

export function isTextPresetId(value: unknown): value is TextElementPresetId {
  return typeof value === 'string' && (TEXT_PRESET_IDS as readonly string[]).includes(value)
}

export function getTextPreset(id: TextElementPresetId): TextPresetDefinition {
  return TEXT_PRESETS.find((preset) => preset.id === id) ?? TEXT_PRESETS[0]!
}

/** 文本轨固定一条（与字幕轨同思路：不进轨道数组，恒有且只有一条）。 */
export const TEXT_ELEMENT_TRACK_ID = TEXT_TRACK_ID

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** 逐字段合并 + 夹取：预设 → 用户覆盖（未覆盖的保留预设值）。 */
export function resolveTextStyle(
  presetId: TextElementPresetId,
  overrides?: TextElementStyleOverrides
): TextElementStyle {
  const preset = getTextPreset(presetId)
  const { plate: overridePlate, ...restOverrides } = overrides ?? {}
  const merged: TextElementStyle = {
    ...DEFAULT_TEXT_STYLE,
    ...preset.style,
    ...restOverrides,
    plate: { ...DEFAULT_TEXT_STYLE.plate, ...(preset.style.plate ?? {}), ...(overridePlate ?? {}) }
  }
  return {
    ...merged,
    sizePx: clamp(merged.sizePx, 8, 400),
    weight: Math.round(clamp(merged.weight, 100, 900)),
    trackingPx: clamp(merged.trackingPx, -10, 50),
    lineHeight: clamp(merged.lineHeight, 0.8, 3),
    maxLines: Math.round(clamp(merged.maxLines, 1, 6)),
    anchorXPct: clamp(merged.anchorXPct, 0, 100),
    anchorYPct: clamp(merged.anchorYPct, 0, 100),
    strokeWidthPx: clamp(merged.strokeWidthPx, 0, 24),
    shadowBlurPx: clamp(merged.shadowBlurPx, 0, 64),
    shadowOffsetXPx: clamp(merged.shadowOffsetXPx, -64, 64),
    shadowOffsetYPx: clamp(merged.shadowOffsetYPx, -64, 64),
    plate: {
      ...merged.plate,
      opacity: clamp(merged.plate.opacity, 0, 1),
      paddingXPx: clamp(merged.plate.paddingXPx, 0, 96),
      paddingYPx: clamp(merged.plate.paddingYPx, 0, 96),
      radiusPx: clamp(merged.plate.radiusPx, 0, 999)
    }
  }
}

/**
 * 预设表自检（启动自检与单测共用）：字号/行数/锚点/颜色必须在合法区间。
 * 返回错误列表；空数组 = 全部通过。
 */
export function validateTextPresets(): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const preset of TEXT_PRESETS) {
    const tag = `文本预设 ${preset.id}`
    if (seen.has(preset.id)) errors.push(`${tag}：id 重复`)
    seen.add(preset.id)
    const style = resolveTextStyle(preset.id)
    if (style.sizePx <= 0) errors.push(`${tag}：字号必须为正`)
    if (style.maxLines < 1) errors.push(`${tag}：maxLines 必须 >= 1`)
    if (style.anchorXPct < 0 || style.anchorXPct > 100) errors.push(`${tag}：锚点 x 越界`)
    if (style.anchorYPct < 0 || style.anchorYPct > 100) errors.push(`${tag}：锚点 y 越界`)
    for (const [key, color] of [
      ['color', style.color],
      ['strokeColor', style.strokeColor],
      ['shadowColor', style.shadowColor],
      ['plate.color', style.plate.color]
    ] as const) {
      if (!isValidColor(color)) errors.push(`${tag}：${key} 非法颜色 ${color}`)
    }
    if (style.lineHeight < 0.8 || style.lineHeight > 3) errors.push(`${tag}：行高越界`)
    if (preset.sampleText.trim().length === 0) errors.push(`${tag}：示例文案为空`)
  }
  return errors
}
