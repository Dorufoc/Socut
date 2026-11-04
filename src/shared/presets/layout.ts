import type { ColorTokenKey, LayoutNode, LayoutPatch, SizeToken } from '../types'

/**
 * Lower Third 布局装配器（规格 §7：结构层叠 = 主条 / 副条 / 装饰线分层）。
 *
 * 设计基线（2026-11 视觉重构）：
 * - 条**不再固定满宽**：宽度随文字自适应，只受 maxWidth 上限约束；极短文案用 minWidth
 *   保底视觉重量。满宽色带会让 3 个字的人名占 10% 宽度、右侧 87% 空白，观感像演示稿。
 * - 标题在上、副标题在下（阅读顺序），副标题不再“贴”在主条上沿。
 * - 条高由「文字行高 + 上下内边距」驱动，长文案换行时整块等比长高，不会顶到条边。
 * - 所有预设共用同一个底部锚点（8vh），切换预设不上下跳。
 *
 * 生成的树形（列方向，底部左锚定）：
 *   root(absolute, left=right=布局边距, bottom=8vh)
 *     ├─ decoration（可选：上方细线 / 下方细线）
 *     └─ primaryBar（自适应宽，行/列两种内部结构）─ 标题 [ + 副标题 ]
 *          └─ secondaryBar（仅分层版式）─ 副标题
 */

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
}

export interface LeftBlockStyle {
  width: SizeToken
  gap: SizeToken
  token: ColorTokenKey
  opacity?: number
}

export interface RuleStyle {
  placement: 'above' | 'below'
  width: SizeToken
  height?: SizeToken
  gap?: SizeToken
  token: ColorTokenKey
  opacity?: number
  fadeEnd?: number
}

export interface BaseSpec {
  leftInset: SizeToken
  bottomInset: SizeToken
  /** 内容最大宽度（自适应宽度的上限） */
  maxWidth: SizeToken
  /** 极短文案的最小视觉宽度 */
  minWidth?: SizeToken
  title: TextTier
  subtitle: TextTier
  titleFillToken?: ColorTokenKey
  subtitleFillToken?: ColorTokenKey
  /** 同一块内标题与副标题的间距 */
  innerGap?: SizeToken
  rule?: RuleStyle
}

function textNode(role: 'title' | 'subtitle', tier: TextTier, fillToken: ColorTokenKey): LayoutNode {
  return {
    kind: 'text',
    role,
    flexShrink: 1,
    text: {
      contentKey: role,
      size: tier.size,
      lineHeight: tier.lineHeight ?? (role === 'title' ? 1.16 : 1.24),
      tracking: tier.tracking ?? '0',
      fontRole: role,
      align: tier.align ?? 'left',
      maxLines: tier.maxLines,
      ellipsis: true
    },
    fill: { token: fillToken }
  }
}

function ruleNode(rule: RuleStyle): LayoutNode {
  return {
    kind: 'rule',
    role: 'decoration',
    width: rule.width,
    height: rule.height ?? '4px@1080p',
    margin: rule.placement === 'above' ? { bottom: rule.gap ?? '10px@1080p' } : { top: rule.gap ?? '10px@1080p' },
    fill: { token: rule.token, opacity: rule.opacity ?? 1 },
    ...(rule.fadeEnd !== undefined ? { fadeEnd: rule.fadeEnd } : {})
  }
}

interface PlateNodeInput {
  spec: BaseSpec
  plate: PlateStyle
  leftBlock?: LeftBlockStyle
  children: LayoutNode[]
  direction: 'row' | 'column'
}

/** 一个自适应宽度的条块；row 时左侧可挂强调色块，column 时直接堆文字。 */
function plateNode({ spec, plate, leftBlock, children, direction }: PlateNodeInput): LayoutNode {
  const row = direction === 'row' && leftBlock !== undefined
  return {
    kind: 'bar',
    role: 'primaryBar',
    flexDirection: direction,
    alignItems: row ? 'stretch' : 'flex-start',
    alignSelf: 'flex-start',
    maxWidth: spec.maxWidth,
    ...(spec.minWidth !== undefined ? { minWidth: spec.minWidth } : {}),
    padding: row
      ? { left: '0', right: plate.paddingX, top: '0', bottom: '0' }
      : {
          left: plate.paddingX,
          right: plate.paddingX,
          top: plate.paddingY,
          bottom: plate.paddingY
        },
    radius: plate.radius ?? '0',
    fill: { token: plate.fill, opacity: plate.opacity ?? 1 },
    children:
      row && leftBlock
        ? [
            {
              kind: 'block',
              role: 'decoration',
              alignSelf: 'stretch',
              width: leftBlock.width,
              margin: { right: leftBlock.gap },
              fill: { token: leftBlock.token, opacity: leftBlock.opacity ?? 1 }
            },
            {
              kind: 'col',
              role: 'spacer',
              flexDirection: 'column',
              alignItems: 'flex-start',
              justifyContent: 'center',
              flexShrink: 1,
              gap: spec.innerGap ?? '4px@1080p',
              padding: { top: plate.paddingY, bottom: plate.paddingY, right: '0' },
              children
            }
          ]
        : children
  }
}

function makeRoot(children: LayoutNode[], spec: BaseSpec): LayoutNode {
  return {
    kind: 'col',
    role: 'root',
    position: 'absolute',
    left: spec.leftInset,
    right: spec.leftInset,
    bottom: spec.bottomInset,
    flexDirection: 'column',
    alignItems: 'flex-start',
    children
  }
}

export interface SinglePlateSpec extends BaseSpec {
  plate: PlateStyle
  leftBlock?: LeftBlockStyle
}

/**
 * 单板：标题 + 副标题在同一个自适应宽度的色块里（最常见、最稳的 lower third）。
 * 左强调块撑满整块高度，文字左缘始终对齐。
 */
export function buildSinglePlate(spec: SinglePlateSpec): LayoutNode {
  const textChildren = [textNode('title', spec.title, spec.titleFillToken ?? 'text')]
  if (spec.subtitle.maxLines > 0) {
    textChildren.push(textNode('subtitle', spec.subtitle, spec.subtitleFillToken ?? 'secondaryText'))
  }
  const children: LayoutNode[] = []
  if (spec.rule?.placement === 'above') children.push(ruleNode(spec.rule))
  children.push(
    plateNode({
      spec,
      plate: spec.plate,
      leftBlock: spec.leftBlock,
      children: textChildren,
      direction: spec.leftBlock ? 'row' : 'column'
    })
  )
  if (spec.rule?.placement === 'below') children.push(ruleNode(spec.rule))
  return makeRoot(children, spec)
}

export interface SplitPlateSpec extends BaseSpec {
  titlePlate: PlateStyle
  subPlate: PlateStyle
  leftBlock?: LeftBlockStyle
  /** 副条相对主条的右移量（层叠感），默认 0 */
  stackOffsetX?: SizeToken
  /** 主条与副条的垂直间距，默认 6px@1080p */
  gapY?: SizeToken
  /** 副条单独的最大宽度（必须不超过主条的 minWidth，避免副条比主条宽） */
  subMaxWidth: SizeToken
}

/**
 * 分层板：主条只放标题，副条在**下方**独立成块（副标题不再压在主条上沿）。
 * 副条 maxWidth 由预设钳制到主条 minWidth 以内，保证层级不倒置。
 */
export function buildSplitPlates(spec: SplitPlateSpec): LayoutNode {
  const children: LayoutNode[] = []
  if (spec.rule?.placement === 'above') children.push(ruleNode(spec.rule))
  children.push(
    plateNode({
      spec,
      plate: spec.titlePlate,
      leftBlock: spec.leftBlock,
      children: [textNode('title', spec.title, spec.titleFillToken ?? 'text')],
      direction: spec.leftBlock ? 'row' : 'column'
    })
  )
  if (spec.subtitle.maxLines > 0) {
    children.push({
      kind: 'bar',
      role: 'secondaryBar',
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      maxWidth: spec.subMaxWidth,
      margin: { top: spec.gapY ?? '6px@1080p', left: spec.stackOffsetX ?? '0' },
      padding: {
        left: spec.subPlate.paddingX,
        right: spec.subPlate.paddingX,
        top: spec.subPlate.paddingY,
        bottom: spec.subPlate.paddingY
      },
      radius: spec.subPlate.radius ?? '0',
      opacity: spec.subPlate.opacity ?? 1,
      fill: { token: spec.subPlate.fill },
      children: [textNode('subtitle', spec.subtitle, spec.subtitleFillToken ?? 'secondaryText')]
    })
  }
  if (spec.rule?.placement === 'below') children.push(ruleNode(spec.rule))
  return makeRoot(children, spec)
}

export interface SideBySideSpec extends BaseSpec {
  plate: PlateStyle
  leftBlock?: LeftBlockStyle
  /** 主标题与右侧字段的间距 */
  fieldGap: SizeToken
}

/**
 * 双栏板：标题在左、数字/指标在右同一行（财经读数专用）。
 * 副标题固定单行、不换行，靠右对齐；标题承担换行。
 */
export function buildSideBySidePlate(spec: SideBySideSpec): LayoutNode {
  const children: LayoutNode[] = []
  if (spec.rule?.placement === 'above') children.push(ruleNode(spec.rule))

  const barChildren: LayoutNode[] = []
  if (spec.leftBlock) {
    barChildren.push({
      kind: 'block',
      role: 'decoration',
      alignSelf: 'stretch',
      width: spec.leftBlock.width,
      margin: { right: spec.leftBlock.gap },
      fill: { token: spec.leftBlock.token, opacity: spec.leftBlock.opacity ?? 1 }
    })
  }
  // 标题留在一块可换行的列里；右侧读数固定单行、垂直居中
  barChildren.push({
    kind: 'col',
    role: 'spacer',
    flexDirection: 'column',
    justifyContent: 'center',
    flexGrow: 1,
    flexShrink: 1,
    padding: { top: spec.plate.paddingY, bottom: spec.plate.paddingY },
    children: [textNode('title', spec.title, spec.titleFillToken ?? 'text')]
  })
  barChildren.push({
    ...textNode('subtitle', { ...spec.subtitle, align: 'right', maxLines: 1 }, spec.subtitleFillToken ?? 'accent'),
    alignSelf: 'center',
    flexShrink: 0,
    margin: { left: spec.fieldGap }
  })

  children.push({
    kind: 'bar',
    role: 'primaryBar',
    flexDirection: 'row',
    alignItems: 'stretch',
    alignSelf: 'flex-start',
    maxWidth: spec.maxWidth,
    ...(spec.minWidth !== undefined ? { minWidth: spec.minWidth } : {}),
    padding: {
      left: spec.leftBlock ? '0' : spec.plate.paddingX,
      right: spec.plate.paddingX,
      top: '0',
      bottom: '0'
    },
    radius: spec.plate.radius ?? '0',
    fill: { token: spec.plate.fill, opacity: spec.plate.opacity ?? 1 },
    children: barChildren
  })

  if (spec.rule?.placement === 'below') children.push(ruleNode(spec.rule))
  return makeRoot(children, spec)
}

export interface BadgePlateSpec extends BaseSpec {
  plate: PlateStyle
  badge: { width: SizeToken; token: ColorTokenKey; opacity?: number }
}

/**
 * 徽标板：左侧大色块（突发/栏目识别） + 右侧标题副标题。
 * 色块撑满整块高度，形成比“细竖条”更强的视觉锚点。
 */
export function buildBadgePlate(spec: BadgePlateSpec): LayoutNode {
  const children: LayoutNode[] = []
  if (spec.rule?.placement === 'above') children.push(ruleNode(spec.rule))
  children.push({
    kind: 'bar',
    role: 'primaryBar',
    flexDirection: 'row',
    alignItems: 'stretch',
    alignSelf: 'flex-start',
    maxWidth: spec.maxWidth,
    ...(spec.minWidth !== undefined ? { minWidth: spec.minWidth } : {}),
    radius: spec.plate.radius ?? '0',
    fill: { token: spec.plate.fill, opacity: spec.plate.opacity ?? 1 },
    children: [
      {
        kind: 'block',
        role: 'decoration',
        alignSelf: 'stretch',
        width: spec.badge.width,
        fill: { token: spec.badge.token, opacity: spec.badge.opacity ?? 1 }
      },
      {
        kind: 'col',
        role: 'spacer',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        flexShrink: 1,
        gap: spec.innerGap ?? '4px@1080p',
        padding: {
          left: spec.plate.paddingX,
          right: spec.plate.paddingX,
          top: spec.plate.paddingY,
          bottom: spec.plate.paddingY
        },
        children: [
          textNode('title', spec.title, spec.titleFillToken ?? 'text'),
          textNode('subtitle', spec.subtitle, spec.subtitleFillToken ?? 'secondaryText')
        ]
      }
    ]
  })
  if (spec.rule?.placement === 'below') children.push(ruleNode(spec.rule))
  return makeRoot(children, spec)
}

export interface ScrimSpec extends BaseSpec {
  plate: PlateStyle
  accent: LeftBlockStyle
}

/**
 * 轻量版：半透明底 + 细竖线，几乎不遮挡画面；适合纪录片/深度报道。
 * 文字仍全部在同一个自适应宽度的安全区内，保证亮画面上也读得清。
 */
export function buildScrimLines(spec: ScrimSpec): LayoutNode {
  const children: LayoutNode[] = []
  if (spec.rule?.placement === 'above') children.push(ruleNode(spec.rule))
  children.push(
    plateNode({
      spec,
      plate: { ...spec.plate, opacity: spec.plate.opacity ?? 0.55 },
      leftBlock: spec.accent,
      direction: 'row',
      children: [
        textNode('title', spec.title, spec.titleFillToken ?? 'text'),
        textNode('subtitle', spec.subtitle, spec.subtitleFillToken ?? 'secondaryText')
      ]
    })
  )
  if (spec.rule?.placement === 'below') children.push(ruleNode(spec.rule))
  return makeRoot(children, spec)
}

/** 竖屏紧凑分支：字号线收缩、单行省略、条宽 92%。 */
export function makeCompactPatches(
  spec: { title: TextTier; subtitle: TextTier },
  overrides?: LayoutPatch[]
): LayoutPatch[] {
  const base: LayoutPatch[] = [
    { role: 'primaryBar', style: { maxWidth: '92%' } },
    { role: 'title', text: { size: shrinkFontSize(spec.title.size), maxLines: 1, ellipsis: true } },
    { role: 'subtitle', text: { size: shrinkFontSize(spec.subtitle.size), maxLines: 1, ellipsis: true } },
    // 副条（仅分层版式存在）同样收窄；不 patch decoration，避免把左侧色块拉成 22% 宽
    { role: 'secondaryBar', style: { maxWidth: '92%' } }
  ]
  return overrides ? mergePatches(base, overrides) : base
}

/** 超宽屏：条宽收敛到 56%，避免横向被拉成一条横贯全屏的色带。 */
export function makeUltrawidePatches(spec: { maxWidth: SizeToken }): LayoutPatch[] {
  return [
    { role: 'primaryBar', style: { maxWidth: `min(${asTokenText(spec.maxWidth)}, 56%)` } },
    { role: 'secondaryBar', style: { maxWidth: '40%' } }
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
