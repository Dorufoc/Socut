import {
  Align,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType
} from 'yoga-layout/load'
import { resolveSize, type UnitContext } from '@shared/units'
import type { ClipPlan } from '@shared/presetResolver'
import type { LayoutBox, LayoutNode, SizeToken } from '@shared/types'
import { isValidColor } from '@shared/colors'
import { getYoga } from './yogaRuntime'
import { getTextMeasurer, type FontSpec } from './textMeasure'

/**
 * 布局树 → Yoga 节点 → 绝对像素盒（规格 §4.3）。
 * 布局与分辨率解耦：同一 (预设, 内容, 覆盖, 字体, 宽高, 分支) 只计算一次，结果缓存。
 * 动画不参与布局（只改绘制偏移），因此导出与预览可共用同一份盒模型。
 */

type YogaNode = ReturnType<Awaited<ReturnType<typeof getYoga>>['Node']['create']>

interface CacheEntry {
  boxes: LayoutBox[]
  usedAt: number
}

const layoutCache = new Map<string, CacheEntry>()
const CACHE_LIMIT = 96

export function layoutCacheKey(plan: ClipPlan): string {
  const overrideKeys = Object.keys(plan.tokens) as Array<keyof typeof plan.tokens>
  const tokenPart = overrideKeys.map((k) => `${k}:${plan.tokens[k]}`).join(',')
  // 计划 §2 的键组成：presetId|contentHash|overrideHash|fontId|W|H|aspectMode。
  // 故意不包含片段实例 id：两个内容/预设/字体/尺寸完全相同的片段应当共用同一份盒模型
  //（多片段同屏是常见场景）；片段 id 也不影响任何像素。
  return [
    plan.presetId,
    plan.unitCtx.width,
    plan.unitCtx.height,
    plan.mode,
    plan.content.title,
    plan.content.subtitle,
    plan.fonts.title.fontId,
    plan.fonts.subtitle.fontId,
    plan.barOpacity,
    plan.animation.inFrames,
    plan.animation.outFrames,
    tokenPart
  ].join('|')
}

export function invalidateLayoutCache(): void {
  layoutCache.clear()
}

function percentString(value: number): `${number}%` {
  return `${value}%` as `${number}%`
}

function setDim(
  node: YogaNode,
  token: SizeToken | undefined,
  ctx: UnitContext,
  api: { points: (v: number) => void; percent: (v: number) => void; auto: () => void }
): void {
  const resolved = resolveSize(token, ctx)
  switch (resolved.kind) {
    case 'point':
      api.points(resolved.value)
      break
    case 'percent':
      api.percent(resolved.value)
      break
    default:
      api.auto()
      break
  }
}

const FLEX_DIRECTION: Record<string, FlexDirection> = {
  row: FlexDirection.Row,
  column: FlexDirection.Column
}

const JUSTIFY: Record<string, Justify> = {
  'flex-start': Justify.FlexStart,
  center: Justify.Center,
  'flex-end': Justify.FlexEnd,
  'space-between': Justify.SpaceBetween,
  'space-around': Justify.SpaceAround
}

const ALIGN: Record<string, Align> = {
  'flex-start': Align.FlexStart,
  center: Align.Center,
  'flex-end': Align.FlexEnd,
  stretch: Align.Stretch
}

const POSITION: Record<string, PositionType> = {
  static: PositionType.Static,
  relative: PositionType.Relative,
  absolute: PositionType.Absolute
}

function applyInsets(
  node: YogaNode,
  key: 'padding' | 'margin',
  token: SizeToken | undefined,
  edge: Edge,
  ctx: UnitContext
): void {
  const resolved = resolveSize(token, ctx)
  if (resolved.kind === 'point') {
    if (key === 'padding') node.setPadding(edge, resolved.value)
    else node.setMargin(edge, resolved.value)
  } else if (resolved.kind === 'percent') {
    if (key === 'padding') node.setPaddingPercent(edge, resolved.value)
    else node.setMarginPercent(edge, resolved.value)
  }
}

function applyInsetsGroup(
  NodeClass: YogaNode,
  plan: ClipPlan,
  node: LayoutNode
): void {
  const ctx = plan.unitCtx
  const groups = [['padding', node.padding], ['margin', node.margin]] as const
  for (const [kind, insets] of groups) {
    if (!insets) continue
    if (insets.left !== undefined) applyInsets(NodeClass, kind as 'padding' | 'margin', insets.left, Edge.Left, ctx)
    if (insets.right !== undefined) applyInsets(NodeClass, kind as 'padding' | 'margin', insets.right, Edge.Right, ctx)
    if (insets.top !== undefined) applyInsets(NodeClass, kind as 'padding' | 'margin', insets.top, Edge.Top, ctx)
    if (insets.bottom !== undefined)
      applyInsets(NodeClass, kind as 'padding' | 'margin', insets.bottom, Edge.Bottom, ctx)
  }
}

function fillOf(node: LayoutNode, plan: ClipPlan): LayoutBox['fill'] {
  if (!node.fill) return undefined
  const tokenValue = plan.tokens[node.fill.token]
  if (!isValidColor(tokenValue)) return undefined
  const nodeOpacity = node.opacity ?? 1
  const isBar = node.role === 'primaryBar' || node.role === 'secondaryBar'
  const extra = isBar ? plan.barOpacity : 1
  const baseOpacity = node.fill.opacity ?? 1
  const gradient = node.fill.gradient
  return {
    color: tokenValue,
    opacity: baseOpacity * nodeOpacity * extra,
    ...(gradient ? { gradient } : {})
  }
}

export async function computeClipBoxes(plan: ClipPlan): Promise<LayoutBox[]> {
  const key = layoutCacheKey(plan)
  const cached = layoutCache.get(key)
  if (cached) {
    cached.usedAt = Date.now()
    return cached.boxes
  }

  const Yoga = await getYoga()
  const config = Yoga.Config.create()
  // 计划 C9：布局落在整数像素网格；web 默认（border-box 等）与浏览器语义一致
  config.setPointScaleFactor(1)
  config.setUseWebDefaults(true)

  const frame = Yoga.Node.createWithConfig(config)
  frame.setWidth(plan.unitCtx.width)
  frame.setHeight(plan.unitCtx.height)
  frame.setFlexDirection(FlexDirection.Column)

  const measuredNodes: YogaNode[] = []
  const bag: SpecBag = { specs: [], cursor: 0 }
  buildNode(Yoga, frame, plan.layout, plan, measuredNodes, bag)

  frame.calculateLayout(plan.unitCtx.width, plan.unitCtx.height, Direction.LTR)

  const boxes: LayoutBox[] = []
  const root = frame.getChild(0)
  if (root) collectBoxes(root, 0, 0, plan, boxes, bag)

  // 释放顺序：先解除测量回调（避免 lib 内部 Map 残留指针），再释放节点
  for (const node of measuredNodes) {
    try {
      node.unsetMeasureFunc()
    } catch {
      // 已被 freeRecursive 释放
    }
  }
  frame.freeRecursive()
  config.free()

  trimCache()
  layoutCache.set(key, { boxes, usedAt: Date.now() })
  return boxes
}

function trimCache(): void {
  if (layoutCache.size < CACHE_LIMIT) return
  const sorted = [...layoutCache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
  const dropCount = layoutCache.size - Math.floor(CACHE_LIMIT / 2)
  for (let i = 0; i < dropCount; i++) {
    const entry = sorted[i]
    if (entry) layoutCache.delete(entry[0])
  }
}

function buildNode(
  Yoga: Awaited<ReturnType<typeof getYoga>>,
  parent: YogaNode,
  spec: LayoutNode,
  plan: ClipPlan,
  measuredNodes: YogaNode[],
  bag: SpecBag
): YogaNode {
  const node = Yoga.Node.createWithConfig(getConfig(Yoga))
  // 前序记录声明节点：collectBoxes 以完全相同的顺序消费（Yoga 节点不带业务元数据）
  bag.specs.push(spec)
  const ctx = plan.unitCtx

  if (spec.position) node.setPositionType(POSITION[spec.position] ?? PositionType.Relative)
  if (spec.left !== undefined || spec.right !== undefined || spec.top !== undefined || spec.bottom !== undefined) {
    if (spec.left !== undefined) applyPosition(node, spec.left, Edge.Left, ctx)
    if (spec.top !== undefined) applyPosition(node, spec.top, Edge.Top, ctx)
    if (spec.right !== undefined) applyPosition(node, spec.right, Edge.Right, ctx)
    if (spec.bottom !== undefined) applyPosition(node, spec.bottom, Edge.Bottom, ctx)
  }

  if (spec.width !== undefined) setDim(node, spec.width, ctx, {
    points: (v) => node.setWidth(v),
    percent: (v) => node.setWidthPercent(v),
    auto: () => node.setWidthAuto()
  })
  if (spec.height !== undefined) setDim(node, spec.height, ctx, {
    points: (v) => node.setHeight(v),
    percent: (v) => node.setHeightPercent(v),
    auto: () => node.setHeightAuto()
  })
  if (spec.minWidth !== undefined) applyMinMax(node, 'min', spec.minWidth, 'width', ctx)
  if (spec.maxWidth !== undefined) applyMinMax(node, 'max', spec.maxWidth, 'width', ctx)
  if (spec.minHeight !== undefined) applyMinMax(node, 'min', spec.minHeight, 'height', ctx)
  if (spec.maxHeight !== undefined) applyMinMax(node, 'max', spec.maxHeight, 'height', ctx)
  if (spec.aspectRatio !== undefined) node.setAspectRatio(spec.aspectRatio)

  if (spec.flexDirection) node.setFlexDirection(FLEX_DIRECTION[spec.flexDirection] ?? FlexDirection.Row)
  if (spec.justifyContent) node.setJustifyContent(JUSTIFY[spec.justifyContent] ?? Justify.FlexStart)
  if (spec.alignItems) node.setAlignItems(ALIGN[spec.alignItems] ?? Align.Stretch)
  if (spec.alignSelf) node.setAlignSelf(ALIGN[spec.alignSelf] ?? Align.Auto)
  if (spec.flexGrow !== undefined) node.setFlexGrow(spec.flexGrow)
  if (spec.flexShrink !== undefined) node.setFlexShrink(spec.flexShrink)
  if (spec.flexBasis !== undefined) {
    setDim(node, spec.flexBasis, ctx, {
      points: (v) => node.setFlexBasis(v),
      percent: (v) => node.setFlexBasisPercent(v),
      auto: () => node.setFlexBasisAuto()
    })
  }
  if (spec.gap !== undefined) {
    const resolved = resolveSize(spec.gap, ctx)
    if (resolved.kind === 'point') node.setGap(Gutter.All, resolved.value)
    else if (resolved.kind === 'percent') node.setGapPercent(Gutter.All, resolved.value)
  }

  applyInsetsGroup(node, plan, spec)

  if (spec.kind === 'text' && spec.text) {
    node.setOverflow(Overflow.Visible)
    const style = spec.text
    const role = style.fontRole
    const resolved = plan.fonts[role]
    const content = style.contentKey === 'title' ? plan.content.title : plan.content.subtitle
    const fontSpec: FontSpec = {
      family: resolved.family,
      weight: resolved.weight,
      sizePx: resolved.sizePx,
      trackingPx: resolved.trackingPx
    }
    const measurer = getTextMeasurer()
    const maxLines = style.maxLines ?? 1
    const measureFn = (
      availableWidth: number,
      widthMode: MeasureMode,
      _availableHeight: number,
      _heightMode: MeasureMode
    ): { width: number; height: number } => {
      const unconstrained = widthMode === MeasureMode.Undefined
      const measured = measurer.measure({
        text: content,
        font: fontSpec,
        lineHeight: resolved.lineHeight,
        maxWidth: unconstrained ? undefined : availableWidth,
        maxLines,
        ellipsis: style.ellipsis ?? true
      })
      return { width: measured.width, height: measured.height }
    }
    node.setMeasureFunc(measureFn)
    measuredNodes.push(node)
  }

  parent.insertChild(node, parent.getChildCount())

  for (const child of spec.children ?? []) {
    buildNode(Yoga, node, child, plan, measuredNodes, bag)
  }
  return node
}

let sharedConfig: ReturnType<Awaited<ReturnType<typeof getYoga>>['Config']['create']> | null = null

function getConfig(Yoga: Awaited<ReturnType<typeof getYoga>>) {
  if (!sharedConfig) {
    sharedConfig = Yoga.Config.create()
    sharedConfig.setPointScaleFactor(1)
    sharedConfig.setUseWebDefaults(true)
  }
  return sharedConfig
}

function applyPosition(node: YogaNode, token: SizeToken, edge: Edge, ctx: UnitContext): void {
  const resolved = resolveSize(token, ctx)
  if (resolved.kind === 'point') node.setPosition(edge, resolved.value)
  else if (resolved.kind === 'percent') node.setPositionPercent(edge, resolved.value)
  else node.setPositionAuto(edge)
}

function applyMinMax(
  node: YogaNode,
  kind: 'min' | 'max',
  token: SizeToken,
  axis: 'width' | 'height',
  ctx: UnitContext
): void {
  const resolved = resolveSize(token, ctx)
  if (resolved.kind === 'auto') return
  if (kind === 'min') {
    if (axis === 'width') {
      if (resolved.kind === 'point') node.setMinWidth(resolved.value)
      else node.setMinWidth(percentString(resolved.value))
    } else {
      if (resolved.kind === 'point') node.setMinHeight(resolved.value)
      else node.setMinHeight(percentString(resolved.value))
    }
  } else {
    if (axis === 'width') {
      if (resolved.kind === 'point') node.setMaxWidth(resolved.value)
      else node.setMaxWidth(percentString(resolved.value))
    } else {
      if (resolved.kind === 'point') node.setMaxHeight(resolved.value)
      else node.setMaxHeight(percentString(resolved.value))
    }
  }
}

function collectBoxes(
  node: YogaNode,
  parentX: number,
  parentY: number,
  plan: ClipPlan,
  out: LayoutBox[],
  bag: SpecBag
): void {
  const left = node.getComputedLeft()
  const top = node.getComputedTop()
  const width = node.getComputedWidth()
  const height = node.getComputedHeight()
  const x = parentX + left
  const y = parentY + top

  const spec = bag.specs[bag.cursor]
  bag.cursor += 1
  if (!spec) return

  const box: LayoutBox = {
    role: spec.role,
    kind: spec.kind,
    x,
    y,
    w: width,
    h: height,
    radiusPx: spec.radius !== undefined ? resolveRadius(spec.radius, plan.unitCtx) : 0,
    opacity: spec.opacity ?? 1,
    ...(spec.fadeEnd !== undefined ? { fadeEnd: spec.fadeEnd } : {})
  }
  const fill = fillOf(spec, plan)
  if (fill) box.fill = fill
  if (spec.kind === 'text' && spec.text) {
    const contentKey = spec.text.contentKey
    const resolved = plan.fonts[contentKey === 'title' ? 'title' : 'subtitle']
    const content = contentKey === 'title' ? plan.content.title : plan.content.subtitle
    box.text = {
      content,
      fontId: resolved.fontId,
      family: resolved.family,
      weight: resolved.weight,
      sizePx: resolved.sizePx,
      lineHeightPx: resolved.sizePx * resolved.lineHeight,
      trackingPx: resolved.trackingPx,
      align: spec.text.align ?? 'left',
      maxLines: spec.text.maxLines ?? 1,
      ellipsis: spec.text.ellipsis ?? true,
      color: fill?.color ?? plan.tokens[contentKey === 'title' ? 'text' : 'secondaryText'],
      ...(plan.gradients[contentKey] ? { gradient: plan.gradients[contentKey] } : {})
    }
  }
  out.push(box)

  const childCount = node.getChildCount()
  for (let i = 0; i < childCount; i++) {
    const child = node.getChild(i)
    if (child) collectBoxes(child, x, y, plan, out, bag)
  }
}

/** 一次布局计算内部的「声明节点序列」，避免并发任务共享全局游标。 */
interface SpecBag {
  specs: LayoutNode[]
  cursor: number
}

function resolveRadius(token: SizeToken, ctx: UnitContext): number {
  const resolved = resolveSize(token, ctx)
  return resolved.kind === 'point' ? resolved.value : 0
}
