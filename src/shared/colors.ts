import type { ColorTokenKey, ColorTokens, GradientSpec } from './types'

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

/** 支持 #RGB / #RGBA / #RRGGBB / #RRGGBBAA / rgb() / rgba()。非法返回 null。 */
export function parseColor(input: string): Rgba | null {
  const raw = input.trim()
  if (raw.startsWith('#')) {
    const hex = raw.slice(1)
    const isHex = /^[0-9a-fA-F]+$/.test(hex)
    if (!isHex) return null
    if (hex.length === 3 || hex.length === 4) {
      const expand = (i: number): number => {
        const ch = hex.charAt(i)
        return parseInt(ch + ch, 16)
      }
      const r = expand(0)
      const g = expand(1)
      const b = expand(2)
      const a = hex.length === 4 ? expand(3) / 255 : 1
      if ([r, g, b].some((v) => Number.isNaN(v))) return null
      return { r, g, b, a }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      return { r, g, b, a }
    }
    return null
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(raw)
  if (m) {
    const parts = (m[1] ?? '').split(/[,/\s]+/).filter(Boolean).map((p) => p.replace('%', ''))
    const nums = parts.map(Number)
    if (nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(n))) return null
    const r = clampByte(nums[0] ?? 0)
    const g = clampByte(nums[1] ?? 0)
    const b = clampByte(nums[2] ?? 0)
    const aRaw = nums[3]
    const a = aRaw === undefined || !Number.isFinite(aRaw) ? 1 : Math.min(1, Math.max(0, aRaw))
    return { r, g, b, a }
  }
  return null
}

export function isValidColor(input: string): boolean {
  return parseColor(input) !== null
}

export function rgbaToCss(c: Rgba, opacityMultiplier = 1): string {
  const a = Math.min(1, Math.max(0, c.a * opacityMultiplier))
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${round3(a)})`
}

/** 颜色字符串 + 额外不透明度 → CSS 色值（解析失败回退透明）。 */
export function toCssColor(color: string, opacityMultiplier = 1): string {
  const parsed = parseColor(color)
  if (!parsed) return 'rgba(0, 0, 0, 0)'
  return rgbaToCss(parsed, opacityMultiplier)
}

export function colorToHex(c: Rgba): string {
  const h = (v: number): string => clampByte(v).toString(16).padStart(2, '0')
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`
  return c.a >= 0.999 ? base : `${base}${h(c.a * 255)}`
}

/** 端点颜色沿角度在盒内插值（用于取文字渐变中间色等）。 */
export function mixColor(a: Rgba, b: Rgba, t: number): Rgba {
  const k = Math.min(1, Math.max(0, t))
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k
  }
}

export interface GradientLine {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * 角度 → 盒内渐变线段（纯计算，可单测）。
 * 0° 自左向右，90° 自上向下，顺时针递增。
 */
export function gradientLine(
  box: { x: number; y: number; w: number; h: number },
  angleDeg: number
): GradientLine {
  const rad = (angleDeg * Math.PI) / 180
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = Math.cos(rad)
  const dy = Math.sin(rad)
  // 线段半长：使端点落在盒边界上
  const halfW = box.w / 2
  const halfH = box.h / 2
  const scale = Math.min(
    Math.abs(dx) < 1e-6 ? Number.POSITIVE_INFINITY : halfW / Math.abs(dx),
    Math.abs(dy) < 1e-6 ? Number.POSITIVE_INFINITY : halfH / Math.abs(dy)
  )
  const len = Number.isFinite(scale) ? scale : Math.hypot(halfW, halfH)
  return { x0: cx - dx * len, y0: cy - dy * len, x1: cx + dx * len, y1: cy + dy * len }
}

/** 渐变可用性校验（validatePreset / styleOverrides 使用）。 */
export function isUsableGradient(g?: GradientSpec): g is GradientSpec {
  return !!g && g.enabled && isValidColor(g.from) && isValidColor(g.to)
}

export const COLOR_TOKEN_KEYS: ColorTokenKey[] = [
  'primary',
  'accent',
  'text',
  'secondaryText',
  'barBackground'
]

/** 令牌层合并：用户覆盖作用于令牌层（规格 §7）。 */
export function mergeTokens(base: ColorTokens, overrides?: Partial<ColorTokens>): ColorTokens {
  if (!overrides) return base
  const next: ColorTokens = { ...base }
  for (const key of COLOR_TOKEN_KEYS) {
    const v = overrides[key]
    if (typeof v === 'string' && isValidColor(v)) next[key] = v
  }
  return next
}

/** 颜色亮度（0~1），用于自动决定文字对比色。 */
export function luminance(c: Rgba): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
}

export function isDark(color: string): boolean {
  const c = parseColor(color)
  if (!c) return false
  return luminance(c) < 0.5
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
