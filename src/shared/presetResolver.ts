import { BUILTIN_FONTS, DEFAULT_FONT_ID, FONT_SCALE_MAX, FONT_SCALE_MIN, MIN_CLIP_DURATION_SEC, cssFamilyFor } from './constants'
import { classifyAspect, displayAspectRatio, fontSizeCapPx } from './aspect'
import { isUsableGradient, mergeTokens } from './colors'
import {
  clipEndFrame,
  clipStartFrame,
  durationSecToFrames,
  timelineFrameCount
} from './fps'
import { getPreset } from './presets'
import { applyLayoutPatches, patchesForMode } from './presetSchema'
import { resolveToPx, type UnitContext } from './units'
import type {
  AspectMode,
  AnimationSpec,
  ClipContent,
  ColorTokens,
  FontRecord,
  FontRoleKey,
  Fps,
  GradientSpec,
  LayoutNode,
  Project,
  ResolvedAnimation,
  SubtitleClip,
  TextNodeStyle
} from './types'

/**
 * 预设解析（纯函数，无 DOM / 无 Yoga）：
 * Project + 预设 + 字体库 + 目标分辨率 → 布局计划（ClipPlan）。
 * 布局盒坐标由渲染层的 layoutTree（Yoga）补齐，本层只负责「声明式解析」。
 */

export interface ResolvedFontRole {
  fontId: string
  family: string
  weight: number
  sizePx: number
  lineHeight: number
  trackingPx: number
}

export interface ClipPlan {
  id: string
  presetId: SubtitleClip['presetId']
  startFrame: number
  endFrame: number
  layout: LayoutNode
  tokens: ColorTokens
  barOpacity: number
  gradients: Partial<Record<FontRoleKey, GradientSpec>>
  fonts: Record<FontRoleKey, ResolvedFontRole>
  animation: ResolvedAnimation
  content: ClipContent
  unitCtx: UnitContext
  mode: AspectMode
}

export interface ProjectPlan {
  width: number
  height: number
  fps: Fps
  mode: AspectMode
  /** 迭代窗口（绝对帧，含 start，不含 end） */
  startFrame: number
  endFrame: number
  /**
   * 活跃区间（计划 C7）：首个片段入点 → 末个片段出点。
   * 透明出口（导出 A）按整条时间轴输出；叠加出口（导出 B）必须只渲染这个区间，
   * 否则开头那段全透明间隙会被白白渲染并进入中间 MOV。
   */
  activeStartFrame: number
  activeEndFrame: number
  clips: ClipPlan[]
  /** 参与本次导出的片段 id（selected 用） */
  selectedClipIds: string[]
}

export interface PlanInput {
  project: Project
  /** 目标分辨率（默认取 project.resolution） */
  resolution?: { width: number; height: number }
  /** 目标帧率（默认取 project.fps） */
  fps?: Fps
  /** 宽高比分支；缺省时由目标分辨率显示比自动判定 */
  mode?: AspectMode
  scope: { kind: 'timeline' } | { kind: 'clips'; clipIds: string[] }
  /** 字体库（内置 + 用户） */
  fontIndex: FontRecord[]
  /** 强制紧凑（styleOverrides.compact 优先于自动判定） */
  forceCompact?: boolean
}

/**
 * 时间轴内容的真实末尾（秒）：字幕 / 媒体 / 音频三轨取并集包络，空工程 = 0。
 *
 * 只给 UI 用（播放头与蓝线上限、轨道长度）：它**不夹最小值**，所以「空工程」时
 * 播放头只能停在 0s，而不是旧实现里那个凭空的 5s / MIN_CLIP_DURATION_SEC。
 * 导出长度仍走 `projectDurationSec`（见下），两者语义不同，不要合并。
 */
export function timelineContentEndSec(project: Project): number {
  let endSec = 0
  for (const clip of project.clips) endSec = Math.max(endSec, clip.endTime)
  for (const clip of project.mediaClips) endSec = Math.max(endSec, clip.timelineEndSec)
  for (const clip of project.audioClips ?? []) endSec = Math.max(endSec, clip.timelineEndSec)
  return Math.max(0, endSec)
}

/** 时间轴覆盖时长（秒）：字幕轨与媒体轨取并集包络（v2）。 */
export function projectDurationSec(project: Project): number {
  const maxClipEnd = project.clips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
  const maxMediaEnd = project.mediaClips.reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
  // M7：文本元素也算进工程时长（否则只有文本元素、没有字幕条时导出区间会是 0）
  const maxTextEnd = (project.textClips ?? []).reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
  const combined = Math.max(maxClipEnd, maxMediaEnd, maxTextEnd)
  if (combined === 0) return MIN_CLIP_DURATION_SEC
  return Math.max(MIN_CLIP_DURATION_SEC, combined)
}

/** 片段 span（首个入点 → 末个出点，规格 C7）；v2 同时取两轨包络。 */
export function projectSpanSec(project: Project): { startSec: number; endSec: number } {
  let startSec = Number.POSITIVE_INFINITY
  let endSec = 0
  for (const clip of project.clips) {
    startSec = Math.min(startSec, clip.startTime)
    endSec = Math.max(endSec, clip.endTime)
  }
  for (const clip of project.mediaClips) {
    startSec = Math.min(startSec, clip.timelineStartSec)
    endSec = Math.max(endSec, clip.timelineEndSec)
  }
  if (!Number.isFinite(startSec)) return { startSec: 0, endSec: MIN_CLIP_DURATION_SEC }
  return { startSec: Math.max(0, startSec), endSec }
}

function buildFontIndex(input: FontRecord[]): Map<string, FontRecord> {
  const map = new Map<string, FontRecord>()
  for (const record of input) map.set(record.fontId, record)
  return map
}

function resolveRoleFont(
  presetFonts: Record<FontRoleKey, { builtinKey: string; weight: number; fallbackBuiltinKey: string }>,
  role: FontRoleKey,
  clipFontId: string,
  index: Map<string, FontRecord>,
  textStyle: TextNodeStyle,
  ctx: UnitContext,
  mode: AspectMode,
  fontScale = 1
): ResolvedFontRole {
  const roleSpec = presetFonts[role]
  // 预设若为角色指定了固定内置字体（如财经数据的等宽数字），不被片段字体覆盖
  const fixedBuiltin = roleSpec.builtinKey !== 'auto'
  const candidateId = fixedBuiltin ? roleSpec.builtinKey : clipFontId
  const record =
    index.get(candidateId) ??
    index.get(roleSpec.fallbackBuiltinKey) ??
    index.get(DEFAULT_FONT_ID) ??
    undefined
  const fallbackFromBuiltinList = BUILTIN_FONTS.find(
    (f) => f.fontId === (fixedBuiltin ? roleSpec.builtinKey : roleSpec.fallbackBuiltinKey)
  )
  const family = cssFamilyFor(record?.fontId ?? candidateId)
  const weight = record?.weight ?? fallbackFromBuiltinList?.weight ?? roleSpec.weight
  const preferredPx = resolveToPx(textStyle.size, ctx, ctx.width)
  // 片段级字号缩放：先乘缩放再过硬上限（否则 4K/竖屏上 200% 会把硬上限突破）
  const scaledPx = preferredPx * clampScale(fontScale)
  const sizePx = fontSizeCapPx(mode, scaledPx, ctx.width, ctx.height)
  return {
    fontId: record?.fontId ?? candidateId,
    family,
    weight,
    sizePx: Math.round(sizePx * 100) / 100,
    lineHeight: textStyle.lineHeight,
    trackingPx: Math.round(resolveToPx(textStyle.tracking ?? '0', ctx) * 100) / 100
  }
}

function resolveAnimation(anim: AnimationSpec, fps: Fps, ctx: UnitContext, totalFrames: number): ResolvedAnimation {
  const inFrames = durationSecToFrames(anim.inDuration, fps)
  const outFrames = durationSecToFrames(anim.outDuration, fps)
  return {
    inFrames: Math.min(inFrames, Math.max(1, Math.floor(totalFrames / 2)) || inFrames),
    outFrames,
    totalFrames,
    easing: anim.easing,
    textRevealFrames: anim.textRevealFrames,
    displacementXPx: Math.round(resolveToPx(anim.displacement.x, ctx, ctx.width) * 100) / 100,
    displacementYPx: Math.round(resolveToPx(anim.displacement.y, ctx, ctx.width) * 100) / 100,
    ruleLeadInFrames: anim.ruleLeadInFrames ?? 0
  }
}

function resolveMode(input: PlanInput, fps: Fps, width: number, height: number): AspectMode {
  if (input.mode) return input.mode
  void fps
  const ratio = displayAspectRatio({ width, height }, null)
  return classifyAspect(ratio)
}

export function buildProjectPlan(input: PlanInput): ProjectPlan {
  const project = input.project
  const fps = input.fps ?? project.fps
  const width = input.resolution?.width ?? project.resolution.width
  const height = input.resolution?.height ?? project.resolution.height
  const ctx: UnitContext = { width, height }
  const fontIndex = buildFontIndex(input.fontIndex)
  const baseMode = resolveMode(input, fps, width, height)

  const selectedIds =
    input.scope.kind === 'timeline' ? project.clips.map((c) => c.id) : input.scope.clipIds
  const selectedSet = new Set(selectedIds)

  const clips: ClipPlan[] = []
  for (const clip of project.clips) {
    if (!selectedSet.has(clip.id)) continue
    const preset = getPreset(clip.presetId)
    const startFrame = clipStartFrame(clip.startTime, fps)
    const endFrame = clipEndFrame(clip.endTime, fps)
    const totalFrames = Math.max(1, endFrame - startFrame)
    const mode: AspectMode = clip.styleOverrides.compact === true ? 'compact' : baseMode
    const tokens = mergeTokens(preset.tokens, clip.styleOverrides.tokens)
    const barOpacity = clamp01(clip.styleOverrides.barOpacity ?? 1)
    const layout = applyLayoutPatches(preset.layout, patchesForMode(preset, mode))

    clips.push({
      id: clip.id,
      presetId: clip.presetId,
      startFrame,
      endFrame,
      layout,
      tokens,
      barOpacity,
      gradients: {
        title: isUsableGradient(clip.styleOverrides.titleGradient) ? clip.styleOverrides.titleGradient : undefined,
        subtitle: isUsableGradient(clip.styleOverrides.subtitleGradient)
          ? clip.styleOverrides.subtitleGradient
          : undefined
      },
      fonts: {
        title: resolveRoleFont(
          preset.fonts,
          'title',
          clip.fontId,
          fontIndex,
          requireTextStyle(layout, 'title'),
          ctx,
          mode,
          clip.styleOverrides.fontScale?.title
        ),
        subtitle: resolveRoleFont(
          preset.fonts,
          'subtitle',
          clip.fontId,
          fontIndex,
          requireTextStyle(layout, 'subtitle'),
          ctx,
          mode,
          clip.styleOverrides.fontScale?.subtitle
        )
      },
      animation: resolveAnimation(clip.animation, fps, ctx, totalFrames),
      content: clip.content,
      unitCtx: ctx,
      mode
    })
  }

  let startFrame = 0
  let endFrame = timelineFrameCount(projectDurationSec(project), fps)
  if (input.scope.kind === 'clips' && clips.length > 0) {
    startFrame = clips.reduce((acc, c) => Math.min(acc, c.startFrame), Number.POSITIVE_INFINITY)
    endFrame = clips.reduce((acc, c) => Math.max(acc, c.endFrame), endFrame)
    if (!Number.isFinite(startFrame)) startFrame = 0
  }

  // 活跃区间与 scope 无关：始终取本次参与片段的真实入出点包络
  // M7：文本元素（timeline scope）也参与包络，否则只含文本元素的项目导出区间会是空
  const textClipsInScope = input.scope.kind === 'timeline' ? (project.textClips ?? []) : []
  const textStartFrames = textClipsInScope.map((clip) => clipStartFrame(clip.startTime, fps))
  const textEndFrames = textClipsInScope.map((clip) => clipEndFrame(clip.endTime, fps))
  const hasText = textClipsInScope.length > 0
  const activeStartFrame =
    clips.length === 0 && !hasText
      ? startFrame
      : Math.min(
          clips.length === 0 ? Number.POSITIVE_INFINITY : clips.reduce((acc, c) => Math.min(acc, c.startFrame), Number.POSITIVE_INFINITY),
          ...(hasText ? textStartFrames : [Number.POSITIVE_INFINITY])
        )
  const activeEndFrame =
    clips.length === 0 && !hasText
      ? endFrame
      : Math.max(
          clips.length === 0 ? 0 : clips.reduce((acc, c) => Math.max(acc, c.endFrame), 0),
          ...(hasText ? textEndFrames : [0])
        )

  return {
    width,
    height,
    fps,
    mode: baseMode,
    startFrame: Math.max(0, startFrame),
    endFrame: Math.max(startFrame + 1, endFrame),
    activeStartFrame: Math.max(0, Math.min(activeStartFrame, endFrame - 1)),
    activeEndFrame: Math.max(Math.max(0, startFrame) + 1, Math.min(activeEndFrame, endFrame)),
    clips,
    selectedClipIds: selectedIds
  }
}

/** 从（已应用补丁的）布局树里取某角色节点的字号令牌。 */
function findTextNodeByRole(node: LayoutNode, role: 'title' | 'subtitle'): LayoutNode | undefined {
  if (node.role === role && node.text) return node
  for (const child of node.children ?? []) {
    const found = findTextNodeByRole(child, role)
    if (found) return found
  }
  return undefined
}

/** 取角色对应的文本样式；预设必须声明 title/subtitle（validatePreset 已保障），否则回退保守值。 */
function requireTextStyle(layout: LayoutNode, role: 'title' | 'subtitle'): TextNodeStyle {
  const node = findTextNodeByRole(layout, role)
  return (
    node?.text ?? {
      contentKey: role,
      size: role === 'title' ? 'clamp(36px@1080p, 4.6vh, 76px@1080p)' : 'clamp(22px@1080p, 3vh, 46px@1080p)',
      lineHeight: role === 'title' ? 1.18 : 1.2,
      tracking: '0',
      fontRole: role,
      align: 'left',
      maxLines: 1,
      ellipsis: true
    }
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, v))
}
