import { acceptBezier, bezierAt, type BezierTuple } from './bezier'
import { applyEasing } from './easing'
import type { EasingKey } from './types'

/**
 * M6：片段级参数关键帧（纯函数模型）。
 *
 * 用途：让一条字幕条/图形元素在片段内**按时间**改参数（不透明度、位移、缩放、旋转），
 * 而不只是播放预设的入场/出场擦除。数据挂在片段的 `keyframes` 上，不写进预设。
 *
 * 三条纪律：
 * 1. **时间归一**：关键点的 `t ∈ [0,1]` 是"片段内进度"（0 = 入点，1 = 出点），
 *    跨帧率不会漂移；求值时由调用方把播放头换算成进度。
 * 2. **默认 = 不生效**：没有 `keyframes` 键时行为与旧版逐像素一致；
 *    有键时也只覆盖出现在轨道里的参数，其余参数取参数默认值。
 * 3. **禁过冲**：具名缓动走 `easing.ts` 的 7 种无过冲曲线；自定义缓动必须过
 *    `acceptBezier`（x/y 夹取 + 单调校验），非法曲线回退线性。
 *
 * 求值只依赖 `t`，预览（Canvas 逐帧）与导出（同一 renderFrame）天然同源。
 */

/** 字幕条/图形元素可关键帧化的参数（媒体段的同名参数在 M7 接入渲染）。 */
export const CLIP_PARAM_IDS = ['opacity', 'offsetXPct', 'offsetYPct', 'scalePct', 'rotationDeg'] as const
export type ClipParamId = (typeof CLIP_PARAM_IDS)[number]

export interface ClipParamLimit {
  min: number
  max: number
  /** 没有关键帧时的默认值（= 不生效） */
  defaultValue: number
  /** UI 滑杆步长 */
  step: number
}

/** 参数取值范围与默认值（schema 归一、UI 夹取、求值兜底共用同一份）。 */
export const CLIP_PARAM_LIMITS: Record<ClipParamId, ClipParamLimit> = {
  opacity: { min: 0, max: 1, defaultValue: 1, step: 0.01 },
  offsetXPct: { min: -100, max: 100, defaultValue: 0, step: 1 },
  offsetYPct: { min: -100, max: 100, defaultValue: 0, step: 1 },
  scalePct: { min: 10, max: 400, defaultValue: 100, step: 1 },
  rotationDeg: { min: -180, max: 180, defaultValue: 0, step: 1 }
}

export function isClipParamId(value: unknown): value is ClipParamId {
  return typeof value === 'string' && (CLIP_PARAM_IDS as readonly string[]).includes(value)
}

/** 具名缓动或自定义贝塞尔。 */
export type KeyframeEasing = EasingKey | 'custom'

export interface KeyframePoint {
  /** 片段内进度 0..1 */
  t: number
  value: number
  /** 本点 → 下一点这一段的缓动（最后一点不参与插值，但仍保留以便改点后不回退） */
  easing: KeyframeEasing
  /** easing = 'custom' 时必填；已通过单调/过冲校验 */
  bezier?: BezierTuple
}

export interface KeyframeTrack {
  param: ClipParamId
  points: KeyframePoint[]
}

/** 单参数最多关键点数（保护性上限：UI 曲线编辑器不做虚拟化） */
export const KEYFRAME_MAX_POINTS = 32

const EASING_KEYS: readonly EasingKey[] = ['linear', 'outQuad', 'outCubic', 'outQuart', 'outQuint', 'outExpo', 'smootherstep']

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 归一化一个关键点；非法（非数字 / 非对象）返回 null。 */
function normalizePoint(raw: unknown, param: ClipParamId): KeyframePoint | null {
  if (!isRecord(raw)) return null
  const tRaw = raw['t']
  const valueRaw = raw['value']
  if (typeof tRaw !== 'number' || !Number.isFinite(tRaw)) return null
  if (typeof valueRaw !== 'number' || !Number.isFinite(valueRaw)) return null
  const limits = CLIP_PARAM_LIMITS[param]
  const t = round(clamp(tRaw, 0, 1), 6)
  const value = round(clamp(valueRaw, limits.min, limits.max), 4)
  const easingRaw = raw['easing']
  let easing: KeyframeEasing = 'linear'
  let bezier: BezierTuple | undefined
  if (easingRaw === 'custom') {
    bezier = acceptBezier(raw['bezier']) ?? undefined
    easing = bezier ? 'custom' : 'linear'
  } else if (typeof easingRaw === 'string' && (EASING_KEYS as readonly string[]).includes(easingRaw)) {
    easing = easingRaw as EasingKey
  }
  return { t, value, easing, ...(bezier ? { bezier } : {}) }
}

/**
 * 归一化整份关键帧数据（schema 读盘、store 写入、CLI 入参共用）：
 * - 未知 param 丢弃；空轨道丢弃；点按 t 升序、同 t 后来者胜；
 * - 超出 `KEYFRAME_MAX_POINTS` 的点截断（保留前 N 个，UI 会提示）；
 * - 全部非法时返回 undefined（工程 JSON 里整键不出现）。
 */
export function normalizeKeyframeTracks(raw: unknown): KeyframeTrack[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const byParam = new Map<ClipParamId, KeyframePoint[]>()
  for (const item of raw) {
    if (!isRecord(item)) continue
    const param = item['param']
    if (!isClipParamId(param)) continue
    const pointsRaw = Array.isArray(item['points']) ? item['points'] : []
    const points: KeyframePoint[] = []
    for (const pointRaw of pointsRaw) {
      const point = normalizePoint(pointRaw, param)
      if (point) points.push(point)
    }
    if (points.length === 0) continue
    // 同 t：保留最后一次写入（用户拖回同一帧时后写的才是意图）
    const byT = new Map<number, KeyframePoint>()
    for (const point of points) byT.set(point.t, point)
    const sorted = [...byT.values()].sort((a, b) => a.t - b.t).slice(0, KEYFRAME_MAX_POINTS)
    byParam.set(param, sorted)
  }
  if (byParam.size === 0) return undefined
  // 参数顺序固定（与 CLIP_PARAM_IDS 一致），保证工程 JSON 稳定
  return CLIP_PARAM_IDS.filter((param) => byParam.has(param)).map((param) => ({
    param,
    points: byParam.get(param)!
  }))
}

/** 单条轨道在进度 t 的取值（轨道外端点保持首尾值；空轨道取默认值）。 */
export function keyframeValueAt(track: KeyframeTrack, t: number): number {
  const limits = CLIP_PARAM_LIMITS[track.param]
  const points = track.points
  if (points.length === 0) return limits.defaultValue
  if (t <= points[0]!.t) return points[0]!.value
  const last = points[points.length - 1]!
  if (t >= last.t) return last.value
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!
    const to = points[index + 1]!
    if (t < from.t || t >= to.t) continue
    const span = to.t - from.t
    const local = span <= 1e-9 ? 1 : (t - from.t) / span
    const eased =
      from.easing === 'custom' && from.bezier
        ? bezierAt(from.bezier, local)
        : applyEasing(from.easing === 'custom' ? 'linear' : from.easing, local)
    return from.value + (to.value - from.value) * eased
  }
  return last.value
}

/** 一条片段在进度 t 的最终参数（未出现的参数取默认值 = 不生效）。 */
export interface ResolvedClipParams {
  opacity: number
  offsetXPct: number
  offsetYPct: number
  scalePct: number
  rotationDeg: number
  /** 是否真的有关键帧（渲染层据此决定要不要套变换，默认路径零开销） */
  hasAny: boolean
}

export function resolveClipParams(
  tracks: readonly KeyframeTrack[] | undefined,
  t: number
): ResolvedClipParams {
  const params: ResolvedClipParams = {
    opacity: CLIP_PARAM_LIMITS.opacity.defaultValue,
    offsetXPct: CLIP_PARAM_LIMITS.offsetXPct.defaultValue,
    offsetYPct: CLIP_PARAM_LIMITS.offsetYPct.defaultValue,
    scalePct: CLIP_PARAM_LIMITS.scalePct.defaultValue,
    rotationDeg: CLIP_PARAM_LIMITS.rotationDeg.defaultValue,
    hasAny: false
  }
  if (!tracks || tracks.length === 0) return params
  const progress = clamp(t, 0, 1)
  for (const track of tracks) {
    if (track.points.length === 0) continue
    params[track.param] = keyframeValueAt(track, progress)
    params.hasAny = true
  }
  return params
}

/** 片段内进度：0 = 入点、1 = 出点（时长退化时返回 0）。 */
export function clipProgressAt(seconds: number, startSec: number, endSec: number): number {
  const span = endSec - startSec
  if (!(span > 1e-9)) return 0
  return clamp((seconds - startSec) / span, 0, 1)
}

/** 是否有关键帧（UI 角标 / 渲染快路径判断）。 */
export function hasKeyframes(clip: { keyframes?: KeyframeTrack[] }): boolean {
  return Array.isArray(clip.keyframes) && clip.keyframes.length > 0
}

/**
 * 在轨道里插入/替换一个关键点（UI 的"打点"与 CLI 共用）：
 * 返回整份关键帧数组（不需要调用的参数原样保留）。
 */
export function upsertKeyframePoint(
  tracks: readonly KeyframeTrack[] | undefined,
  param: ClipParamId,
  point: KeyframePoint
): KeyframeTrack[] {
  const normalizedPoint = normalizePoint(point, param)
  const base = tracks ? [...tracks] : []
  if (!normalizedPoint) return normalizeKeyframeTracks(base) ?? []
  const existing = base.find((track) => track.param === param)
  const points = existing ? [...existing.points] : []
  const index = points.findIndex((item) => Math.abs(item.t - normalizedPoint.t) < 1e-6)
  if (index >= 0) points[index] = normalizedPoint
  else points.push(normalizedPoint)
  const next = existing
    ? base.map((track) => (track.param === param ? { ...track, points } : track))
    : [...base, { param, points }]
  return normalizeKeyframeTracks(next) ?? []
}

/** 删除某参数轨道上的第 index 个关键点；轨道空了就整条消失。 */
export function removeKeyframePoint(
  tracks: readonly KeyframeTrack[] | undefined,
  param: ClipParamId,
  index: number
): KeyframeTrack[] {
  if (!tracks) return []
  const next = tracks
    .map((track) => {
      if (track.param !== param) return track
      if (index < 0 || index >= track.points.length) return track
      return { ...track, points: track.points.filter((_, pointIndex) => pointIndex !== index) }
    })
    .filter((track) => track.points.length > 0)
  return normalizeKeyframeTracks(next) ?? []
}
