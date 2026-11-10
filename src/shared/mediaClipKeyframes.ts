import { CLIP_PARAM_LIMITS, keyframeValueAt, type KeyframeTrack } from './keyframes'
import type { MediaClipVideo } from './types'

/**
 * M6-E：媒体段（视频/图片）的关键帧。
 *
 * 与字幕条/文本元素的关键帧**同一套数据模型**（`KeyframeTrack[]`，`t` = 片段内进度 0..1），
 * 区别只在"参数如何落到画面上"：
 * - 字幕条/文本元素由 Canvas 逐帧绘制（`renderer.ts`），直接拿 `resolveClipParams`；
 * - 媒体段是 DOM `<video>`（预览）或 FFmpeg 解码流（导出），所以这里给出**两个同源口径**：
 *   1. `mediaFrameParamsAt` / `mediaKeyframeCssAt`：给预览的 CSS transform/opacity；
 *   2. `mediaParamExpr`：给 FFmpeg 的 `t`（秒）表达式（`scale=...:eval=frame` / `overlay x/y` / alpha mask）。
 *
 * 参数语义：**轨道存在 = 绝对覆盖静态 `video` 字段**（不是叠加）。没有轨道的参数仍用静态值，
 * 所以"只想让缩放动起来、位置保持静态设置"这种用法是成立的。
 */

/** 媒体段可关键帧化的参数（与 `MediaClipVideo` 的静态字段同名对应）。 */
export const MEDIA_KEYFRAME_PARAMS = ['opacity', 'offsetXPct', 'offsetYPct', 'scalePct', 'rotationDeg'] as const
export type MediaKeyframeParam = (typeof MEDIA_KEYFRAME_PARAMS)[number]

/** 媒体段没有静态"不透明度"字段：无轨道时恒为 1（不生效）。 */
export const MEDIA_STATIC_OPACITY = 1

export interface MediaFrameParams {
  opacity: number
  offsetXPct: number
  offsetYPct: number
  scalePct: number
  rotationDeg: number
  /** 是否真的挂了关键帧（没有则渲染/导出走旧静态路径，逐字节不变） */
  hasKeyframes: boolean
}

/** 片段内进度 → 该帧的有效参数（轨道覆盖静态值）。 */
export function mediaFrameParamsAt(
  video: MediaClipVideo | undefined,
  keyframes: readonly KeyframeTrack[] | undefined,
  progress: number
): MediaFrameParams {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
  const params: MediaFrameParams = {
    opacity: MEDIA_STATIC_OPACITY,
    offsetXPct: video?.offsetXPercent ?? 0,
    offsetYPct: video?.offsetYPercent ?? 0,
    scalePct: video?.scalePercent ?? 100,
    rotationDeg: video?.rotationDeg ?? 0,
    hasKeyframes: false
  }
  if (!keyframes || keyframes.length === 0) return params
  for (const track of keyframes) {
    if (track.points.length === 0) continue
    if (!(MEDIA_KEYFRAME_PARAMS as readonly string[]).includes(track.param)) continue
    params.hasKeyframes = true
    switch (track.param) {
      case 'opacity':
        params.opacity = keyframeValueAt(track, p)
        break
      case 'offsetXPct':
        params.offsetXPct = keyframeValueAt(track, p)
        break
      case 'offsetYPct':
        params.offsetYPct = keyframeValueAt(track, p)
        break
      case 'scalePct':
        params.scalePct = keyframeValueAt(track, p)
        break
      case 'rotationDeg':
        params.rotationDeg = keyframeValueAt(track, p)
        break
    }
  }
  return params
}

/** 浮点数压缩写法（CSS 与滤镜串共用；避免 `1.0000000000000002` 这种噪声）。 */
function num(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '0'
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

/**
 * 预览用：CSS `transform` 与 `opacity`。
 *
 * 顺序与静态 `mediaVideoTransform` **完全一致**（translate → rotate → scale → flip），
 * 否则"只加一个缩放关键帧"也会让画面位置轻微跳一下。
 */
export function mediaKeyframeCssAt(
  video: MediaClipVideo | undefined,
  keyframes: readonly KeyframeTrack[] | undefined,
  progress: number
): { transform: string; opacity: number; hasKeyframes: boolean } {
  const params = mediaFrameParamsAt(video, keyframes, progress)
  if (!params.hasKeyframes) {
    return {
      transform: 'none',
      opacity: MEDIA_STATIC_OPACITY,
      hasKeyframes: false
    }
  }
  const parts: string[] = []
  if (Math.abs(params.offsetXPct) > 1e-6 || Math.abs(params.offsetYPct) > 1e-6) {
    parts.push(`translate(${num(params.offsetXPct)}%, ${num(params.offsetYPct)}%)`)
  }
  if (Math.abs(params.rotationDeg) > 1e-6) parts.push(`rotate(${num(params.rotationDeg)}deg)`)
  if (Math.abs(params.scalePct - 100) > 1e-6) parts.push(`scale(${num(params.scalePct / 100)})`)
  if (video?.flipH) parts.push('scaleX(-1)')
  if (video?.flipV) parts.push('scaleY(-1)')
  return {
    transform: parts.length === 0 ? 'none' : parts.join(' '),
    opacity: Math.min(1, Math.max(0, params.opacity)),
    hasKeyframes: true
  }
}

/** 导出用：采样点数上限（表达式体积与精度折中；48 段对 0.5s 的快速运动也够平顺）。 */
export const MEDIA_KEYFRAME_EXPR_SAMPLES = 48

/**
 * 把一条参数轨道变成 FFmpeg 表达式（变量 `t` = 滤镜内秒数）。
 *
 * 做法：按 `[0, durationSec]` 均匀采样 `samples+1` 个点（`keyframeValueAt` 内部已应用缓动/贝塞尔），
 * 再拼成嵌套 `if(lt(t, t₁), 线性段, 余下)`；值相同的相邻段会被合并，避免表达式膨胀。
 * 无轨道 / 空轨道 → null（调用方保持旧静态路径）。
 */
export function mediaParamExpr(
  track: KeyframeTrack | undefined,
  durationSec: number,
  samples: number = MEDIA_KEYFRAME_EXPR_SAMPLES,
  /** FFmpeg 表达式里的时间变量名：多数滤镜是 `t`，`geq` 是 `T`（真机踩过） */
  timeVar = 't'
): string | null {
  if (!track || track.points.length === 0) return null
  const duration = Math.max(1e-6, Number.isFinite(durationSec) ? durationSec : 0)
  const count = Math.max(2, Math.min(96, Math.round(samples)))
  // 采样：进度 p ∈ [0,1] → 时间 t = p * duration
  const points: Array<{ t: number; value: number }> = []
  for (let index = 0; index <= count; index += 1) {
    const p = index / count
    points.push({ t: p * duration, value: keyframeValueAt(track, p) })
  }
  // 相邻等值合并（保留首尾），减少表达式层数
  const compact: typeof points = [points[0]!]
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = compact[compact.length - 1]!
    const current = points[index]!
    const next = points[index + 1]!
    const flat = Math.abs(current.value - previous.value) < 1e-6 && Math.abs(next.value - current.value) < 1e-6
    if (!flat) compact.push(current)
  }
  compact.push(points[points.length - 1]!)

  const literal = (value: number): string => num(value, 6)
  if (compact.length === 1) return literal(compact[0]!.value)
  if (compact.every((point) => Math.abs(point.value - compact[0]!.value) < 1e-9)) {
    return literal(compact[0]!.value)
  }
  // 从后往前拼：最外层是第一个区间
  let expr = literal(compact[compact.length - 1]!.value)
  for (let index = compact.length - 2; index >= 0; index -= 1) {
    const from = compact[index]!
    const to = compact[index + 1]!
    const span = to.t - from.t
    const segment =
      span <= 1e-9
        ? literal(to.value)
        : `${literal(from.value)}+(${literal(to.value - from.value)})*(${timeVar}-${literal(from.t)})/${literal(span)}`
    expr = `if(lt(${timeVar},${literal(to.t)}),${segment},${expr})`
  }
  return expr
}

/** 轨道集合里是否有对媒体段有效的关键帧（决定导出走表达式路径）。 */
export function mediaKeyframesActive(keyframes: readonly KeyframeTrack[] | undefined): boolean {
  if (!keyframes || keyframes.length === 0) return false
  return keyframes.some(
    (track) => track.points.length > 0 && (MEDIA_KEYFRAME_PARAMS as readonly string[]).includes(track.param)
  )
}

/** 取某参数轨道（找不到 = undefined）。 */
export function mediaTrackOf(
  keyframes: readonly KeyframeTrack[] | undefined,
  param: MediaKeyframeParam
): KeyframeTrack | undefined {
  return keyframes?.find((track) => track.param === param)
}

/** 采样区间内某参数的最大/最小值（导出时算旋转包围盒、校验夹取用）。 */
export function mediaParamRange(
  keyframes: readonly KeyframeTrack[] | undefined,
  param: MediaKeyframeParam,
  samples = MEDIA_KEYFRAME_EXPR_SAMPLES
): { min: number; max: number } | null {
  const track = mediaTrackOf(keyframes, param)
  if (!track) return null
  const limits = CLIP_PARAM_LIMITS[param]
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let index = 0; index <= samples; index += 1) {
    const value = keyframeValueAt(track, index / samples)
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: limits.defaultValue, max: limits.defaultValue }
  return { min, max }
}
