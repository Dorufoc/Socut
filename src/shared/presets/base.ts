import { ULTRAWIDE_BAR_MAX_WIDTH_PERCENT } from '../constants'
import type { ColorTokenKey, LayoutNode, LayoutPatch, SizeToken } from '../types'

/**
 * Lower Third 布局装配器（规格 §7：结构层叠 = 主条 / 副条 / 装饰线分层）。
 *
 * 生成的树形（列方向，底部左锚定）：
 *   root(absolute, left=安全区, bottom=安全区)
 *     ├─ decoration（装饰线，可选：上方细线 / 左侧色块）
 *     ├─ primaryBar(row) ─ [accentBlock?] + title(text)
 *     └─ secondaryBar(row, 负 margin 形成层叠) ─ subtitle(text)
 *
 * 绘制顺序即数组顺序，渲染层按此顺序落笔。
 */

export type RulePlacement = 'above' | 'below' | 'leftBlock' | 'none'

export interface StackSpec {
  /** 距左侧安全区内缩（右侧用同一个令牌，保证左右边距相等） */
  leftInset: SizeToken
  /** 底部内缩（通常为 safe-title-bottom / safe-bottom） */
  bottomInset: SizeToken
  /** 副条宽度上限：默认取主条的 0.82 */
  subBarWidth?: SizeToken
  titleBarHeight: SizeToken
  subtitleBarHeight: SizeToken
  titleFontSize: SizeToken
  subtitleFontSize: SizeToken
  paddingX: SizeToken
  /** 副条相对主条的水平错位（层叠感来源） */
  stackOffsetX: SizeToken
  /** 副条与主条的垂直重叠量（px@1080p 数值，正数表示上移形成层叠） */
  overlapY: number
  titleBarFill: ColorTokenKey
  subtitleBarFill: ColorTokenKey
  subtitleBarOpacity: number
  titleFillToken: ColorTokenKey
  subtitleFillToken: ColorTokenKey
  /** 装饰线 */
  rule: {
    placement: RulePlacement
    height?: SizeToken
    width?: SizeToken
    gap?: SizeToken
    token: ColorTokenKey
    opacity?: number
    fadeEnd?: number
  }
  /** 条块圆角（广播级默认 0） */
  radius?: SizeToken
  /** 主标题字距 */
  titleTracking?: SizeToken
  /** 主标题是否居中 */
  titleAlign?: 'left' | 'center'
  /** 主标题最大行数（默认 3） */
  titleMaxLines?: number
  /** 副标题最大行数（默认 2） */
  subtitleMaxLines?: number
}

function textNode(node: LayoutNode): LayoutNode {
  return node
}

export function buildStackLayout(spec: StackSpec): LayoutNode {
  const children: LayoutNode[] = []

  const ruleHeight = spec.rule.height ?? '4px'
  const ruleWidth = spec.rule.width ?? '18%'

  if (spec.rule.placement === 'above') {
    children.push({
      kind: 'rule',
      role: 'decoration',
      width: ruleWidth,
      height: ruleHeight,
      margin: { bottom: spec.rule.gap ?? '8px@1080p' },
      fill: { token: spec.rule.token, opacity: spec.rule.opacity ?? 1 },
      fadeEnd: spec.rule.fadeEnd
    })
  }

  const titleBarChildren: LayoutNode[] = []
  if (spec.rule.placement === 'leftBlock') {
    titleBarChildren.push({
      kind: 'block',
      role: 'decoration',
      // 条高改为内容驱动（minHeight），色块用 stretch 自适配高度；
      // 写 height:'100%' 在 auto 高度父级下会退化成 0
      alignSelf: 'stretch',
      width: spec.rule.height ?? '10px@1080p',
      margin: { right: spec.rule.gap ?? '0' },
      fill: { token: spec.rule.token, opacity: spec.rule.opacity ?? 1 }
    })
  }
  titleBarChildren.push({
    kind: 'text',
    role: 'title',
    flexGrow: 1,
    flexShrink: 1,
    text: {
      contentKey: 'title',
      size: spec.titleFontSize,
      lineHeight: 1.18,
      tracking: spec.titleTracking ?? '0.5px@1080p',
      fontRole: 'title',
      align: spec.titleAlign ?? 'left',
      maxLines: spec.titleMaxLines ?? 3,
      ellipsis: true
    },
    fill: { token: spec.titleFillToken }
  })

  children.push({
    kind: 'bar',
    role: 'secondaryBar',
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: spec.subBarWidth ?? '72%',
    minHeight: spec.subtitleBarHeight,
    // 副条在上（先入树 = 视觉在上），水平错位保留层叠感；
    // 与主条的垂直重叠由主条的负 margin 实现（主条后画，压在副条下沿之上）。
    margin: { left: spec.stackOffsetX },
    padding: { left: spec.paddingX, right: spec.paddingX },
    radius: spec.radius ?? '0',
    opacity: spec.subtitleBarOpacity,
    fill: { token: spec.subtitleBarFill },
    children: [
      textNode({
        kind: 'text',
        role: 'subtitle',
        flexGrow: 1,
        flexShrink: 1,
        text: {
          contentKey: 'subtitle',
          size: spec.subtitleFontSize,
          lineHeight: 1.2,
          tracking: '0.2px@1080p',
          fontRole: 'subtitle',
          align: 'left',
          maxLines: spec.subtitleMaxLines ?? 2,
          ellipsis: true
        },
        fill: { token: spec.subtitleFillToken }
      })
    ]
  })

  children.push({
    kind: 'bar',
    role: 'primaryBar',
    flexDirection: 'row',
    alignItems: 'center',
    // 标题区域宽度 = root 宽度（= 画宽 - 左右等边距），只设下限高度，不设宽度上限：
    // 任何 maxWidth 都会让右侧边距大于左侧，破坏“左右相等”。
    width: '100%',
    minHeight: spec.titleBarHeight,
    // 主条在副条下方：上边负 margin 让两段叠一点（主条后画，视觉上压住副条下沿）
    ...(spec.overlapY > 0 ? { margin: { top: `-${spec.overlapY}px@1080p` } } : {}),
    padding: { left: spec.paddingX, right: spec.paddingX },
    radius: spec.radius ?? '0',
    fill: { token: spec.titleBarFill },
    children: titleBarChildren
  })

  if (spec.rule.placement === 'below') {
    children.push({
      kind: 'rule',
      role: 'decoration',
      width: ruleWidth,
      height: ruleHeight,
      margin: { top: spec.rule.gap ?? '8px@1080p' },
      alignSelf: 'flex-end',
      fill: { token: spec.rule.token, opacity: spec.rule.opacity ?? 1 },
      fadeEnd: spec.rule.fadeEnd
    })
  }

  const root: LayoutNode = {
    kind: 'col',
    role: 'root',
    position: 'absolute',
    left: spec.leftInset,
    // 右侧用**同一个**内缩令牌：root 宽度 = 画宽 - 2×边距。
    // 主条再用 width:100% 填满它，就得到「标题区域长度 = 预览宽度减左右等边距」，
    // 而且左右边距天然相等（不依赖 maxWidth 猜一个宽度）。
    right: spec.leftInset,
    bottom: spec.bottomInset,
    flexDirection: 'column',
    alignItems: 'flex-start',
    children
  }
  return root
}

/** 从 StackSpec 派生竖屏紧凑分支补丁（规格 §4.3：条宽 ~88%、字号偏小、副标题单行省略）。 */
export function makeCompactPatches(spec: StackSpec, overrides?: LayoutPatch[]): LayoutPatch[] {
  const base: LayoutPatch[] = [
    // 主条宽度已由「root 左右等边距 + width:100%」决定，此处不再压宽度上限
    // （任何 maxWidth 都会把右侧边距撑大，左右就不再相等）。
    { role: 'secondaryBar', style: { maxWidth: '94%' } },
    { role: 'title', text: { size: shrinkFontSize(spec.titleFontSize), maxLines: 1, ellipsis: true } },
    { role: 'subtitle', text: { size: shrinkFontSize(spec.subtitleFontSize), maxLines: 1, ellipsis: true } },
    { role: 'decoration', style: { width: '26%' } }
  ]
  return overrides ? mergePatches(base, overrides) : base
}

/**
 * 超宽屏：主条已是「满宽减等边距」，不再压宽度（压了就会左右不等）；
 * 副条仍是 hug + 宽度上限，超宽下把它收到 70% 以内，避免横向拉扯。
 */
export function makeUltrawidePatches(spec: StackSpec): LayoutPatch[] {
  return [
    { role: 'secondaryBar', style: { maxWidth: `min(${asTokenText(spec.subBarWidth ?? '72%')}, ${ULTRAWIDE_BAR_MAX_WIDTH_PERCENT}%)` } }
  ]
}

/** 字号令牌在紧凑分支下整体收缩（把 clamp 的 preferred 与 max 按 0.78 缩放）。 */
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

/** 便捷构造：常用内缩组合。
 * 用 `layout-*`（= 安全区 × LAYOUT_INSET_SCALE）而不是 `safe-*`：
 * 安全区用于辅助线与硬约束，字幕条实际摆放按产品要求贴得更近（当前为一半）。
 */
export const INSET = {
  titleLeft: 'layout-title-side',
  titleBottom: 'layout-title-bottom',
  actionLeft: 'layout-side',
  actionBottom: 'layout-bottom'
} as const
