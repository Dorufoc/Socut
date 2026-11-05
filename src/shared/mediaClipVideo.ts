import type { CurveStops, MediaClipVideo } from './types'

/**
 * 媒体片段画面变换与调色的纯口径（主/渲染/测试共用）。
 *
 * 三条纪律：
 * 1. **默认值 = 不生效**：100% / 0 / false / 0 / 直线曲线；全部默认时整键不写进工程。
 * 2. **一套语义两处消费**：预览用 CSS transform + 滤镜（含 SVG 曲线表），
 *    导出层将来用同名的 FFmpeg 滤镜链，参数含义必须一一对得上，
 *    所以「百分比 / 角度 / -100..100」这些单位的换算只允许写在这里。
 * 3. **数值全部可夹心**：任何脏工程值都能被夹回合法区间，不会有 NaN 进样式表。
 */

export const MEDIA_VIDEO_RANGE = {
  /** 缩放百分比 */
  scale: { min: 10, max: 400 },
  /** 平移百分比（相对画面宽/高） */
  offset: { min: -100, max: 100 },
  rotation: { min: 0, max: 360 },
  /** 调色滑块统一 -100..100 */
  grade: { min: -100, max: 100 }
} as const

/** 曲线 LUT 的采样点数（tableValues 至少 2 个；17 点足够平滑且够短） */
export const CURVE_LUT_STEPS = 16

/** 曲线的「直线」基准：不改变像素。 */
export const STRAIGHT_CURVE: CurveStops = [0, 0.5, 1]

export function defaultMediaVideo(): MediaClipVideo {
  return {
    scalePercent: 100,
    offsetXPercent: 0,
    offsetYPercent: 0,
    rotationDeg: 0,
    flipH: false,
    flipV: false,
    brightness: 0,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    warmth: 0,
    vibrance: 0,
    curves: { r: [...STRAIGHT_CURVE], g: [...STRAIGHT_CURVE], b: [...STRAIGHT_CURVE] }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min === 0 ? 0 : min
  return Math.min(max, Math.max(min, value))
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function normalizeStops(raw: unknown): CurveStops {
  if (!Array.isArray(raw) || raw.length < 3) return [...STRAIGHT_CURVE]
  return [clamp(num(raw[0], 0), 0, 1), clamp(num(raw[1], 0.5), 0, 1), clamp(num(raw[2], 1), 0, 1)]
}

/** 任意 JSON → 合法参数；**全部默认时返回 undefined**（调用方据此整键删除）。 */
export function normalizeMediaVideo(raw: unknown): MediaClipVideo | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const curvesRaw = typeof record['curves'] === 'object' && record['curves'] !== null ? (record['curves'] as Record<string, unknown>) : {}
  const next: MediaClipVideo = {
    scalePercent: round1(clamp(num(record['scalePercent'], 100), MEDIA_VIDEO_RANGE.scale.min, MEDIA_VIDEO_RANGE.scale.max)),
    offsetXPercent: round1(clamp(num(record['offsetXPercent'], 0), MEDIA_VIDEO_RANGE.offset.min, MEDIA_VIDEO_RANGE.offset.max)),
    offsetYPercent: round1(clamp(num(record['offsetYPercent'], 0), MEDIA_VIDEO_RANGE.offset.min, MEDIA_VIDEO_RANGE.offset.max)),
    rotationDeg: round1(clamp(num(record['rotationDeg'], 0), MEDIA_VIDEO_RANGE.rotation.min, MEDIA_VIDEO_RANGE.rotation.max)),
    flipH: record['flipH'] === true,
    flipV: record['flipV'] === true,
    brightness: round1(clamp(num(record['brightness'], 0), MEDIA_VIDEO_RANGE.grade.min, MEDIA_VIDEO_RANGE.grade.max)),
    exposure: round1(clamp(num(record['exposure'], 0), MEDIA_VIDEO_RANGE.grade.min, MEDIA_VIDEO_RANGE.grade.max)),
    contrast: round1(clamp(num(record['contrast'], 0), MEDIA_VIDEO_RANGE.grade.min, MEDIA_VIDEO_RANGE.grade.max)),
    saturation: round1(clamp(num(record['saturation'], 0), MEDIA_VIDEO_RANGE.grade.min, MEDIA_VIDEO_RANGE.grade.max)),
    warmth: round1(clamp(num(record['warmth'], 0), MEDIA_VIDEO_RANGE.grade.min, MEDIA_VIDEO_RANGE.grade.max)),
    vibrance: round1(clamp(num(record['vibrance'], 0), MEDIA_VIDEO_RANGE.grade.min, MEDIA_VIDEO_RANGE.grade.max)),
    curves: {
      r: normalizeStops(curvesRaw['r']),
      g: normalizeStops(curvesRaw['g']),
      b: normalizeStops(curvesRaw['b'])
    }
  }
  return isDefaultMediaVideo(next) ? undefined : next
}

function sameStops(a: CurveStops, b: CurveStops): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6
}

/** 是否全部等于默认值（= 这条片段没有任何画面编辑）。 */
export function isDefaultMediaVideo(video: MediaClipVideo | undefined): boolean {
  if (!video) return true
  const base = defaultMediaVideo()
  return (
    Math.abs(video.scalePercent - base.scalePercent) < 1e-6 &&
    Math.abs(video.offsetXPercent) < 1e-6 &&
    Math.abs(video.offsetYPercent) < 1e-6 &&
    Math.abs(video.rotationDeg) < 1e-6 &&
    !video.flipH &&
    !video.flipV &&
    Math.abs(video.brightness) < 1e-6 &&
    Math.abs(video.exposure) < 1e-6 &&
    Math.abs(video.contrast) < 1e-6 &&
    Math.abs(video.saturation) < 1e-6 &&
    Math.abs(video.warmth) < 1e-6 &&
    Math.abs(video.vibrance) < 1e-6 &&
    sameStops(video.curves.r, base.curves.r) &&
    sameStops(video.curves.g, base.curves.g) &&
    sameStops(video.curves.b, base.curves.b)
  )
}

/**
 * 预览里的几何变换（CSS transform）。
 * 顺序：平移 → 旋转 → 缩放 → 镜像，与将来 FFmpeg 的 `translate→rotate→scale→hflip/vflip`
 * 保持同一顺序，避免“调参顺序不同导致落点不同”。
 */
export function mediaVideoTransform(video: MediaClipVideo | undefined): string {
  if (!video) return 'none'
  const parts: string[] = []
  if (Math.abs(video.offsetXPercent) > 1e-6 || Math.abs(video.offsetYPercent) > 1e-6) {
    parts.push(`translate(${video.offsetXPercent}%, ${video.offsetYPercent}%)`)
  }
  if (Math.abs(video.rotationDeg) > 1e-6) parts.push(`rotate(${video.rotationDeg}deg)`)
  if (Math.abs(video.scalePercent - 100) > 1e-6) parts.push(`scale(${video.scalePercent / 100})`)
  if (video.flipH) parts.push('scaleX(-1)')
  if (video.flipV) parts.push('scaleY(-1)')
  return parts.length === 0 ? 'none' : parts.join(' ')
}

/** 曝光与冷暖都是「按通道倍增」：归一到 0.25 量级的增益，肉眼可见但不失控。 */
function channelGain(video: MediaClipVideo, channel: 'r' | 'g' | 'b'): number {
  const exposure = Math.pow(2, video.exposure / 100)
  const warmth = video.warmth / 100
  if (channel === 'r') return exposure * (1 + warmth * 0.25)
  if (channel === 'b') return exposure * (1 - warmth * 0.25)
  return exposure
}

/** 曲线是否真的弯了（直线时不必挂 SVG 滤镜，省一次合成）。 */
export function needsCurveTable(video: MediaClipVideo): boolean {
  return (
    !sameStops(video.curves.r, STRAIGHT_CURVE) ||
    !sameStops(video.curves.g, STRAIGHT_CURVE) ||
    !sameStops(video.curves.b, STRAIGHT_CURVE)
  )
}

/** 该片段是否需要 SVG 曲线滤镜（曲线弯了，或曝光/冷暖这类按通道倍增的参数非 0）。 */
export function needsChannelTable(video: MediaClipVideo): boolean {
  return needsCurveTable(video) || Math.abs(video.exposure) > 1e-6 || Math.abs(video.warmth) > 1e-6
}

/**
 * 曲线采样（折线插值，不含通道增益）：给 SVG 预览画折线用。
 * 三个控制点把 [0,1] 分成两段，x 固定为 0 / 0.5 / 1。
 */
export function curveSamples(stops: CurveStops, steps = CURVE_LUT_STEPS): number[] {
  const values: number[] = []
  for (let i = 0; i <= steps; i += 1) {
    const x = i / steps
    const y = x <= 0.5 ? stops[0] + (stops[1] - stops[0]) * (x / 0.5) : stops[1] + (stops[2] - stops[1]) * ((x - 0.5) / 0.5)
    values.push(y)
  }
  return values
}

/**
 * 三通道曲线 → `feFuncX tableValues`（逗号分隔 0..1 的采样值）。
 * 在采样值上再乘通道增益（曝光 / 冷暖），最后夹到 0..1。
 */
export function curveTableValues(video: MediaClipVideo, channel: 'r' | 'g' | 'b', steps = CURVE_LUT_STEPS): string {
  const gain = channelGain(video, channel)
  return curveSamples(video.curves[channel], steps)
    .map((y) => Math.min(1, Math.max(0, y * gain)).toFixed(4))
    .join(' ')
}

/** 该片段需要的 SVG 滤镜 id（与 PreviewStage 里 <filter> 的定义同源）。 */
export const MEDIA_GRADE_FILTER_ID = 'focusnews-media-grade'

/**
 * 预览里的调色（CSS filter）。
 * 亮度/对比度/饱和度/光感走 CSS 函数；曝光/冷暖/曲线走 SVG 曲线表（见 `curveTableValues`）。
 */
export function mediaVideoFilter(video: MediaClipVideo | undefined): string {
  if (!video) return 'none'
  const parts: string[] = []
  if (Math.abs(video.brightness) > 1e-6) parts.push(`brightness(${(1 + video.brightness / 100).toFixed(3)})`)
  if (Math.abs(video.contrast) > 1e-6) parts.push(`contrast(${(1 + video.contrast / 100).toFixed(3)})`)
  const saturation = 1 + video.saturation / 100 + video.vibrance / 200
  if (Math.abs(video.saturation) > 1e-6 || Math.abs(video.vibrance) > 1e-6) parts.push(`saturate(${saturation.toFixed(3)})`)
  if (needsChannelTable(video)) parts.push(`url(#${MEDIA_GRADE_FILTER_ID})`)
  return parts.length === 0 ? 'none' : parts.join(' ')
}
