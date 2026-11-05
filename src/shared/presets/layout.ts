import type { ColorTokenKey, LayoutNode, LayoutPatch, SizeToken } from '../types'

/**
 * Lower Third 布局装配器（规格 §7：结构层叠 = 主条 / 副条 / 装饰线分层）。
 *
 * 结构基线（2026-11 第二次视觉重构，按用户明确要求）：
 *   ① 副标题放在**主标题纯色矩形上方**，不融合进同一个框、也不放在主标题下面；
 *   ② 副标题是**独立、更小的纯色矩形**，其左边缘与下方主标题矩形严格对齐；
 *   ③ 主条宽度随文字自适应（不再满宽），长文案换行时只向上长高；
 *   ④ 所有预设共用 8vh 底部锚点，切换预设不上下跳；
 *   ⑤ 两条矩形的宽度上限都是 root 内容宽（`BAR_MAX_WIDTH`）：长文案可以一直顶到
 *      画面右缘，右侧剩下的空白与左边距相等（用户明确要求：不再被百分比提前截断）。
 *
 * 生成的树形：
 *   root(col, absolute, left=right=布局边距, bottom=8vh)
 *     ├─ secondaryBar（副标题矩形，alignSelf=flex-start，maxWidth = root 内容宽）
 *     │    └─ subtitle(text)
 *     └─ primaryBar（主标题矩形，alignSelf=flex-start，maxWidth = root 内容宽）
 *          ├─ [titleBlock]（可选：左侧强调块/徽标，撑满整条高度）
 *          └─ title(text)
 */

/**
 * 条宽上限：root 已声明 `left = right = 布局边距`，所以它的 100% 就是
 * 「画宽 − 左右各一份边距」（1080p：1728px，右缘落在 1824px = 1920 − 96）。
 * 用百分比而不是 px 常量，是为了让 360p→4K 全档都自动跟随，不需要再配一套上限。
 */
export const BAR_MAX_WIDTH = '100%' as const

export interface TextTier {
  size: SizeToken
  maxLines: number
  tracking?: SizeToken
  lineHeight?: number
  align?: 'left' | 'center' | 'right'
}

export interface PlateStyle {
  fill: ColorTokenKey
  opacity?: number
  radius?: SizeToken
  paddingX: SizeToken
  paddingY: SizeToken
  /** 最小视觉宽度（副标题短标签用，避免縮成一个小药丸） */
  minWidth?: SizeToken
}

export interface LeftBlockStyle {
  width: SizeToken
  gap: SizeToken
  token: ColorTokenKey
  opacity?: number
}

export interface SubtitleAboveSpec {
  leftInset: SizeToken
  bottomInset: SizeToken
  /** 主条内容最大宽度（默认 BAR_MAX_WIDTH：可一直延伸到画面右边距） */
  maxWidth: SizeToken
  /** 主条最小宽度：短文案的视觉重量保底（与宽度上限无关，不再充当副标题上限） */
  minWidth: SizeToken
  /** 副标题矩形最大宽度；缺省跟随主条上限（两者都能延伸到右边距） */
  subMaxWidth?: SizeToken
  /** 副标题与主条之间的垂直间距 */
  gapY?: SizeToken
  title: TextTier
  subtitle: TextTier
  titlePlate: PlateStyle
  subtitlePlate: PlateStyle
  /** 主标题左侧的强调块/徽标；副标题文字左缘会跟随主标题文字左缘 */
  titleBlock?: LeftBlockStyle
  titleFillToken?: ColorTokenKey
  subtitleTextToken?: ColorTokenKey
}

function textNode(role: 'title' | 'subtitle', tier: TextTier, fillToken: ColorTokenKey): LayoutNode {
  return {
    kind: 'text',
    role,
    flexShrink: 1,
    text: {
      contentKey: role,
      size: tier.size,
      lineHeight: tier.lineHeight ?? (role === 'title' ? 1.16 : 1.18),
      tracking: tier.tracking ?? '0',
      fontRole: role,
      align: tier.align ?? 'left',
      maxLines: tier.maxLines,
      ellipsis: true
    },
    fill: { token: fillToken }
  }
}

function subtitleBar(spec: SubtitleAboveSpec): LayoutNode {
  return {
    kind: 'bar',
    role: 'secondaryBar',
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    // 副标题与主标题共用同一个宽度上限：长副标题也能一直铺到画面右边距
    maxWidth: spec.subMaxWidth ?? spec.maxWidth,
    ...(spec.subtitlePlate.minWidth !== undefined ? { minWidth: spec.subtitlePlate.minWidth } : {}),
    padding: {
      // 预设把左侧内边距设成「主条左块宽 + 间距」，副标题文字就会与主标题文字共左线
      left: spec.subtitlePlate.paddingX,
      right: spec.subtitlePlate.paddingX,
      top: spec.subtitlePlate.paddingY,
      bottom: spec.subtitlePlate.paddingY
    },
    radius: spec.subtitlePlate.radius ?? '0',
    opacity: spec.subtitlePlate.opacity ?? 1,
    fill: { token: spec.subtitlePlate.fill },
    children: [textNode('subtitle', spec.subtitle, spec.subtitleTextToken ?? 'secondaryText')]
  }
}

function titleBar(spec: SubtitleAboveSpec): LayoutNode {
  const title = textNode('title', spec.title, spec.titleFillToken ?? 'text')
  if (!spec.titleBlock) {
    return {
      kind: 'bar',
      role: 'primaryBar',
      flexDirection: 'column',
      alignItems: 'flex-start',
      alignSelf: 'flex-start',
      maxWidth: spec.maxWidth,
      minWidth: spec.minWidth,
      padding: {
        left: spec.titlePlate.paddingX,
        right: spec.titlePlate.paddingX,
        top: spec.titlePlate.paddingY,
        bottom: spec.titlePlate.paddingY
      },
      radius: spec.titlePlate.radius ?? '0',
      opacity: spec.titlePlate.opacity ?? 1,
      fill: { token: spec.titlePlate.fill },
      children: [title]
    }
  }
  return {
    kind: 'bar',
    role: 'primaryBar',
    flexDirection: 'row',
    alignItems: 'stretch',
    alignSelf: 'flex-start',
    maxWidth: spec.maxWidth,
    minWidth: spec.minWidth,
    padding: { left: '0', right: spec.titlePlate.paddingX, top: '0', bottom: '0' },
    radius: spec.titlePlate.radius ?? '0',
    opacity: spec.titlePlate.opacity ?? 1,
    fill: { token: spec.titlePlate.fill },
    children: [
      {
        kind: 'block',
        role: 'decoration',
        alignSelf: 'stretch',
        width: spec.titleBlock.width,
        margin: { right: spec.titleBlock.gap },
        fill: { token: spec.titleBlock.token, opacity: spec.titleBlock.opacity ?? 1 }
      },
      {
        kind: 'col',
        role: 'spacer',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        flexShrink: 1,
        padding: { top: spec.titlePlate.paddingY, bottom: spec.titlePlate.paddingY },
        children: [title]
      }
    ]
  }
}

/**
 * 副标题条在上 + 主标题条在下：两块独立纯色矩形，左边缘对齐、宽度上限相同。
 * 副标题条更矮；两块都随文字自适应，长文案一直延伸到画面右边距后才在条内换行。
 */
export function buildSubtitleAbove(spec: SubtitleAboveSpec): LayoutNode {
  return {
    kind: 'col',
    role: 'root',
    position: 'absolute',
    left: spec.leftInset,
    right: spec.leftInset,
    bottom: spec.bottomInset,
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: spec.gapY ?? '6px@1080p',
    children: [subtitleBar(spec), titleBar(spec)]
  }
}

/** 竖屏紧凑分支：字号线收缩、单行省略、条宽 92%。 */
export function makeCompactPatches(
  spec: { title: TextTier; subtitle: TextTier },
  overrides?: LayoutPatch[]
): LayoutPatch[] {
  const base: LayoutPatch[] = [
    { role: 'primaryBar', style: { maxWidth: '92%' } },
    { role: 'secondaryBar', style: { maxWidth: '92%' } },
    { role: 'title', text: { size: shrinkFontSize(spec.title.size), maxLines: 1, ellipsis: true } },
    { role: 'subtitle', text: { size: shrinkFontSize(spec.subtitle.size), maxLines: 1, ellipsis: true } }
  ]
  return overrides ? mergePatches(base, overrides) : base
}

/** 超宽屏：条宽收敛到 56%，避免横向被拉成一条横贯全屏的色带。 */
export function makeUltrawidePatches(spec: { maxWidth: SizeToken }): LayoutPatch[] {
  return [
    { role: 'primaryBar', style: { maxWidth: `min(${asTokenText(spec.maxWidth)}, 56%)` } },
    { role: 'secondaryBar', style: { maxWidth: '34%' } }
  ]
}

/** 字号令牌在紧凑分支下整体收缩（clamp 的 preferred 与 max 按 0.78 缩放）。 */
function shrinkFontSize(token: SizeToken): SizeToken {
  if (typeof token === 'number') return Math.round(token * 0.78)
  const m = /^clamp\(([^,]+),\s*([^,]+),\s*([^)]+)\)$/i.exec(token.trim())
  if (m) {
    const [, min, preferred, max] = m
    return `clamp(${scaleToken(min ?? '0', 0.9)}, ${scaleToken(preferred ?? '0', 0.78)}, ${scaleToken(max ?? '0', 0.78)})`
  }
  return scaleToken(token, 0.78)
}

function scaleToken(token: string | undefined, factor: number): string {
  const raw = (token ?? '0').trim()
  const m = /^([\d.]+)(vh|vw|px@1080p|px|%)$/i.exec(raw)
  if (!m) return raw
  const value = Number(m[1]) * factor
  return `${Math.round(value * 1000) / 1000}${m[2]}`
}

function asTokenText(token: SizeToken): string {
  return typeof token === 'number' ? `${token}px` : token
}

function mergePatches(base: LayoutPatch[], overrides: LayoutPatch[]): LayoutPatch[] {
  const byRole = new Map<LayoutPatch['role'], LayoutPatch>()
  for (const p of base) byRole.set(p.role, { ...p })
  for (const p of overrides) {
    const existing = byRole.get(p.role)
    byRole.set(
      p.role,
      existing
        ? { ...existing, ...p, style: { ...existing.style, ...p.style }, text: { ...existing.text, ...p.text } }
        : p
    )
  }
  return [...byRole.values()]
}

/** 常用内缩组合（底部 8vh 保证所有预设底边一致）。 */
export const INSET = {
  side: 'layout-title-side',
  bottom: '8vh'
} as const
