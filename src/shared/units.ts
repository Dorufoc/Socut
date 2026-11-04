import { ACTION_SAFE_RATIO, LAYOUT_INSET_SCALE, TITLE_SAFE_RATIO } from './constants'
import type { SizeToken } from './types'

/**
 * 尺寸令牌解析（规格 §4.3）。
 * 支持的写法：
 *   128                      → 绝对像素
 *   "auto"                   → 由布局决定
 *   "36vw"                   → 视口宽度百分比
 *   "6.2vh"                  → 视口高度百分比
 *   "72%"                    → 父容器百分比（透传给 Yoga 的 Percent 单位）
 *   "96px@1080p"             → 以 1080p 为基准，按目标高度等比换算
 *   "48px"                   → 固定像素（仅用于描边/线宽这类不随分辨率放大的量）
 *   "safe-side"              → 动作安全区左右内缩量
 *   "safe-bottom"            → 动作安全区底部内缩量
 *   "safe-title-side"        → 标题安全区左右内缩量
 *   "safe-title-bottom"      → 标题安全区底部内缩量
 *   "layout-side"            → **布局**左右边距 = 动作安全区内缩 × LAYOUT_INSET_SCALE
 *   "layout-title-bottom"    → 布局底部边距 = 标题安全区内缩 × LAYOUT_INSET_SCALE
 *   "clamp(28px@1080p, 4.4vh, 72px@1080p)" → 钳制
 *   "min(1400px@1080p, 70%)" / "max(...)"  → 取小 / 取大（% 以参考宽度解析）
 */

export interface UnitContext {
  /** 目标分辨率宽 */
  width: number
  /** 目标分辨率高 */
  height: number
}

export type ResolvedSize =
  | { kind: 'point'; value: number }
  | { kind: 'percent'; value: number }
  | { kind: 'auto' }

const AUTO: ResolvedSize = { kind: 'auto' }

function safeInset(axis: 'x' | 'y', area: 'action' | 'title', ctx: UnitContext): number {
  const ratio = area === 'action' ? ACTION_SAFE_RATIO : TITLE_SAFE_RATIO
  const dim = axis === 'x' ? ctx.width : ctx.height
  return ((1 - ratio) / 2) * dim
}

/** 拆分逗号，忽略括号内部。 */
function splitArgs(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim().length > 0) out.push(current.trim())
  return out
}

function parseNumber(token: string): number | null {
  const v = Number(token)
  return Number.isFinite(v) ? v : null
}

/** 把百分比按参考维度折算为像素（仅用于最终需要绝对像素的场合，如字号）。 */
export function percentToPx(percent: number, reference: number): number {
  return (percent / 100) * reference
}

export function resolveSize(token: SizeToken | undefined, ctx: UnitContext): ResolvedSize {
  if (token === undefined) return AUTO
  if (typeof token === 'number') {
    if (!Number.isFinite(token)) return AUTO
    return { kind: 'point', value: token }
  }
  const raw = token.trim()
  if (raw.length === 0 || raw === 'auto') return AUTO

  // clamp(min, preferred, max)
  const fnMatch = /^(clamp|min|max)\((.*)\)$/i.exec(raw)
  if (fnMatch) {
    const fn = (fnMatch[1] ?? 'clamp').toLowerCase()
    const args = splitArgs(fnMatch[2] ?? '')
    const px = args.map((a) => resolveToPx(a, ctx, ctx.width))
    if (px.some((v) => !Number.isFinite(v))) return AUTO
    if (fn === 'min') return { kind: 'point', value: Math.min(...px) }
    if (fn === 'max') return { kind: 'point', value: Math.max(...px) }
    // 写法不完整时降级为可用值，不让整个预设崩掉
    if (px.length === 1) return { kind: 'point', value: px[0] ?? 0 }
    const [min, preferred, max] = [px[0] ?? 0, px[1] ?? 0, px[2] ?? px[1] ?? 0]
    return { kind: 'point', value: Math.min(Math.max(preferred, min), max) }
  }

  // 布局边距（字号块摆放用）：安全区内缩 × LAYOUT_INSET_SCALE，与 safe-* 分开
  if (raw.startsWith('layout')) {
    const isTitle = raw.includes('title')
    const axis: 'x' | 'y' = raw.includes('side') || raw.includes('left') || raw.includes('right') ? 'x' : 'y'
    return { kind: 'point', value: safeInset(axis, isTitle ? 'title' : 'action', ctx) * LAYOUT_INSET_SCALE }
  }

  // 安全区
  if (raw.startsWith('safe')) {
    const isTitle = raw.includes('title')
    const axis: 'x' | 'y' = raw.includes('side') || raw.includes('left') || raw.includes('right') ? 'x' : 'y'
    return { kind: 'point', value: safeInset(axis, isTitle ? 'title' : 'action', ctx) }
  }

  // vw / vh / px@1080p / px / %
  const vw = /^(-?[\d.]+)vw$/i.exec(raw)
  if (vw) return { kind: 'point', value: ((Number(vw[1]) || 0) / 100) * ctx.width }
  const vh = /^(-?[\d.]+)vh$/i.exec(raw)
  if (vh) return { kind: 'point', value: ((Number(vh[1]) || 0) / 100) * ctx.height }
  const at1080 = /^(-?[\d.]+)px@1080p$/i.exec(raw)
  if (at1080) return { kind: 'point', value: (Number(at1080[1]) || 0) * (ctx.height / 1080) }
  const fixedPx = /^(-?[\d.]+)px$/i.exec(raw)
  if (fixedPx) return { kind: 'point', value: Number(fixedPx[1]) || 0 }
  const percent = /^(-?[\d.]+)%$/.exec(raw)
  if (percent) return { kind: 'percent', value: Number(percent[1]) || 0 }

  const plain = parseNumber(raw)
  if (plain !== null) return { kind: 'point', value: plain }
  return AUTO
}

/** 直接要像素的场景（字号、线宽、圆角等）。百分比按 reference 折算。 */
export function resolveToPx(token: SizeToken | undefined, ctx: UnitContext, reference?: number): number {
  const resolved = resolveSize(token, ctx)
  const ref = reference ?? ctx.width
  switch (resolved.kind) {
    case 'point':
      return resolved.value
    case 'percent':
      return percentToPx(resolved.value, ref)
    default:
      return 0
  }
}

/** 供 Yoga 使用：百分比透传，其余折算为点。 */
export function toYogaValue(token: SizeToken | undefined, ctx: UnitContext): ResolvedSize {
  return resolveSize(token, ctx)
}

/** 人类可读的令牌解释（UI 里标注实际像素，规格 §2.1 的 2K 标注同口径）。 */
export function describeToken(token: SizeToken, ctx: UnitContext): string {
  const px = resolveToPx(token, ctx)
  const rounded = Math.round(px * 100) / 100
  return typeof token === 'string' ? `${token} → ${rounded}px` : `${rounded}px`
}
