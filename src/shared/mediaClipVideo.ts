import { effectPreviewFilter, normalizeActiveEffects } from './effectPackages'
import type { CurvePoint, MediaClipCurves, MediaClipVideo } from './types'

/**
 * 媒体片段画面变换与调色的纯口径（主/渲染/测试共用）。
 *
 * 四条纪律：
 * 1. **默认值 = 不生效**：100% / 0 / false / 0 / 直线曲线；全部默认时整键不写进工程。
 * 2. **一套语义两处消费**：预览用 CSS transform + 滤镜（含 SVG 曲线表），
 *    导出层将来用同名的 FFmpeg 滤镜链，参数含义必须一一对得上，
 *    所以「百分比 / 角度 / -100..100」这些单位的换算只允许写在这里。
 * 3. **数值全部可夹心**：任何脏工程值都能夹回合法区间，不会有 NaN 进样式表。
 * 4. **交互与面板同源**：拖拽预览里的手柄算出的新值，和面板滑杆写的是同一套字段与单位
 *    （见文件末尾的几何区），避免“拖完面板数字对不上”。
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

/** 曲线 LUT 采样数（值越多越平滑；33 点既够细又不会把滤镜串撑大） */
export const CURVE_LUT_STEPS = 32

/** 单条曲线最多控制点数（防止误点把 tableValues 撑爆） */
export const CURVE_MAX_POINTS = 16

/** 拖拽时吸附判定的容差（百分比 / 角度） */
export const SNAP_TOLERANCE_PERCENT = 1.5

/** 一条恒等映射的直线（两端点） */
export function straightCurve(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 }
  ]
}

export function defaultCurves(): MediaClipCurves {
  return { master: straightCurve(), r: straightCurve(), g: straightCurve(), b: straightCurve() }
}

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
    curves: defaultCurves()
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min === 0 ? 0 : min
  return Math.min(max, Math.max(min, value))
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 任意脏数据 → 合法曲线。
 *
 * 兼容两代写法：
 * - v6 初期：`[y0, y1, y2]` 三个数 = x 固定在 0 / 0.5 / 1 的三点；
 * - 现在：`{ x, y }[]`，x 可在 0..1 任意位置（自由打点）。
 *
 * 归一规则：夹到 0..1 → 按 x 排序 → 同 x 去重 → 保证首尾各有点（x=0 / x=1）→ 截断到上限。
 */
export function normalizeCurve(raw: unknown): CurvePoint[] {
  const points: CurvePoint[] = []
  if (Array.isArray(raw)) {
    if (raw.length > 0 && typeof raw[0] === 'number') {
      // 旧写法：三个 y 值
      const xs = [0, 0.5, 1]
      raw.slice(0, 3).forEach((value, index) => {
        points.push({ x: xs[index] ?? index / 2, y: clamp(num(value, xs[index] ?? 0), 0, 1) })
      })
    } else {
      for (const item of raw) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        points.push({
          x: round3(clamp(num(record['x'], 0), 0, 1)),
          y: round3(clamp(num(record['y'], 0), 0, 1))
        })
      }
    }
  }

  if (points.length < 2) return straightCurve()

  points.sort((a, b) => a.x - b.x)
  // 同 x 只留第一个（避免垂直线段导致查表除零）
  const deduped: CurvePoint[] = []
  for (const point of points) {
    if (deduped.length > 0 && Math.abs(deduped[deduped.length - 1]!.x - point.x) < 1e-3) continue
    deduped.push(point)
  }

  if (deduped[0]!.x > 0) deduped.unshift({ x: 0, y: deduped[0]!.y })
  if (deduped[deduped.length - 1]!.x < 1) deduped.push({ x: 1, y: deduped[deduped.length - 1]!.y })
  return deduped.slice(0, CURVE_MAX_POINTS)
}

/** 任意 JSON → 合法参数；**全部默认时返回 undefined**（调用方据此整键删除）。 */
export function normalizeMediaVideo(raw: unknown): MediaClipVideo | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const curvesRaw = typeof record['curves'] === 'object' && record['curves'] !== null ? (record['curves'] as Record<string, unknown>) : {}
  const effects = normalizeActiveEffects(record['effects'])
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
      master: normalizeCurve(curvesRaw['master']),
      r: normalizeCurve(curvesRaw['r']),
      g: normalizeCurve(curvesRaw['g']),
      b: normalizeCurve(curvesRaw['b'])
    },
    ...(effects ? { effects } : {})
  }
  return isDefaultMediaVideo(next) ? undefined : next
}

/** 是否是一条直线（恒等映射）。 */
export function isStraightCurve(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false
  const [first, last] = points as [CurvePoint, CurvePoint]
  return (
    Math.abs(first.x) < 1e-6 &&
    Math.abs(last.x - 1) < 1e-6 &&
    Math.abs(first.y) < 1e-6 &&
    Math.abs(last.y - 1) < 1e-6
  )
}

export function isStraightCurves(curves: MediaClipCurves): boolean {
  return isStraightCurve(curves.master) && isStraightCurve(curves.r) && isStraightCurve(curves.g) && isStraightCurve(curves.b)
}

/** 是否全部等于默认值（= 这条片段没有任何画面编辑）。 */
export function isDefaultMediaVideo(video: MediaClipVideo | undefined): boolean {
  if (!video) return true
  return (
    Math.abs(video.scalePercent - 100) < 1e-6 &&
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
    (video.effects?.length ?? 0) === 0 &&
    isStraightCurves(video.curves)
  )
}

// ------------------------------------------------------------------ 几何变换

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

/** 预览画面框的像素尺寸（与 PreviewStage 里的 .stage__frame 同一坐标系）。 */
export interface StageSize {
  width: number
  height: number
}

export interface StagePoint {
  x: number
  y: number
}

/** 变换后画面的中心点（像素）。原始画面中心 = 帧中心，所以位移只是把它推走。 */
export function mediaVideoCenter(video: MediaClipVideo | undefined, frame: StageSize): StagePoint {
  const offsetX = video?.offsetXPercent ?? 0
  const offsetY = video?.offsetYPercent ?? 0
  return {
    x: frame.width / 2 + (offsetX / 100) * frame.width,
    y: frame.height / 2 + (offsetY / 100) * frame.height
  }
}

/** 变换后画面的半宽 / 半高（像素）。 */
export function mediaVideoHalfExtent(video: MediaClipVideo | undefined, frame: StageSize): StagePoint {
  const scale = (video?.scalePercent ?? 100) / 100
  return { x: (frame.width * scale) / 2, y: (frame.height * scale) / 2 }
}

function rotatePoint(point: StagePoint, radians: number): StagePoint {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos }
}

/** 画面四角（左上 / 右上 / 右下 / 左下，已含旋转）。拖拽缩放的四个圆点就落在这里。 */
export function mediaVideoCorners(video: MediaClipVideo | undefined, frame: StageSize): StagePoint[] {
  const center = mediaVideoCenter(video, frame)
  const half = mediaVideoHalfExtent(video, frame)
  const radians = ((video?.rotationDeg ?? 0) * Math.PI) / 180
  const offsets: StagePoint[] = [
    { x: -half.x, y: -half.y },
    { x: half.x, y: -half.y },
    { x: half.x, y: half.y },
    { x: -half.x, y: half.y }
  ]
  return offsets.map((offset) => {
    const rotated = rotatePoint(offset, radians)
    return { x: center.x + rotated.x, y: center.y + rotated.y }
  })
}

/**
 * 旋转手柄的位置：上边中点沿「外法线」方向外推 gapPx，并**夹在可见帧内**
 * （`.stage__frame` 是 overflow:hidden，100% 缩放时画面顶边就贴着帧顶，
 * 纯往外推会让手柄被裁掉 —→ 所以理想位置越界时贴到帧内边缘）。
 */
export function mediaVideoRotateHandle(video: MediaClipVideo | undefined, frame: StageSize, gapPx = 28): StagePoint {
  const center = mediaVideoCenter(video, frame)
  const half = mediaVideoHalfExtent(video, frame)
  const radians = ((video?.rotationDeg ?? 0) * Math.PI) / 180
  const outward = rotatePoint({ x: 0, y: -half.y - gapPx }, radians)
  const inset = gapPx * 0.6
  const clampAxis = (value: number, max: number): number => Math.min(Math.max(value, inset), Math.max(inset, max - inset))
  return {
    x: clampAxis(center.x + outward.x, frame.width),
    y: clampAxis(center.y + outward.y, frame.height)
  }
}

function distance(a: StagePoint, b: StagePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * 拖某个角缩放：以**画面中心**为基准，按「指针到中心距离」的比例缩放。
 * 这样拖角时中心不动，画面围绕中心长大/缩小（与面板百分比同一字段）。
 */
export function scaleFromPointer(
  video: MediaClipVideo | undefined,
  frame: StageSize,
  startPointer: StagePoint,
  pointer: StagePoint
): number {
  const center = mediaVideoCenter(video, frame)
  const startDistance = distance(startPointer, center)
  if (startDistance < 1e-3) return video?.scalePercent ?? 100
  const next = ((video?.scalePercent ?? 100) * distance(pointer, center)) / startDistance
  return round1(clamp(next, MEDIA_VIDEO_RANGE.scale.min, MEDIA_VIDEO_RANGE.scale.max))
}

/** 拖旋转手柄：按「指针绕中心扫过的角度差」叠加到当前角度上，结果归一到 0..360。 */
export function rotationFromPointers(
  video: MediaClipVideo | undefined,
  frame: StageSize,
  startPointer: StagePoint,
  pointer: StagePoint
): number {
  const center = mediaVideoCenter(video, frame)
  const startAngle = Math.atan2(startPointer.y - center.y, startPointer.x - center.x)
  const angle = Math.atan2(pointer.y - center.y, pointer.x - center.x)
  let degrees = (video?.rotationDeg ?? 0) + ((angle - startAngle) * 180) / Math.PI
  degrees %= 360
  if (degrees < 0) degrees += 360
  return round1(degrees)
}

export interface SnapResult {
  /** 吸附后的位移百分比 */
  value: number
  /** 命中的辅助线：居中 / 边对齐 / 无 */
  guide: 'center' | 'edge' | null
}

/**
 * 平移吸附：命中「画面中心 ↔ 帧中心」或「画面边 ↔ 帧边」时把位移吸到整值，并返回该画哪条辅助线。
 *
 * 边对齐的判据：画面左缘 = 帧左缘 → offset = (scale − 1) × 50（缩放小于 100% 时同样成立，
 * 只是画面完全落在帧内）。三个候选值任取最近且落在容差内的一个。
 */
export function snapOffset(offsetPercent: number, scalePercent: number, tolerance = SNAP_TOLERANCE_PERCENT): SnapResult {
  const edge = round1(((scalePercent - 100) / 100) * 50)
  const candidates: { value: number; guide: 'center' | 'edge' }[] = [{ value: 0, guide: 'center' }]
  // 100% 缩放时「边对齐」与「居中」是同一个位置，只留居中（否则会报成 -0 / edge）
  if (Math.abs(edge) > 1e-6) {
    candidates.push({ value: edge, guide: 'edge' }, { value: -edge, guide: 'edge' })
  }
  let best: SnapResult = { value: offsetPercent, guide: null }
  let bestDistance = tolerance
  for (const candidate of candidates) {
    const delta = Math.abs(candidate.value - offsetPercent)
    // 严格小于：容差边缘不吸附，且最近的（居中优先）胜出
    if (delta < bestDistance) {
      bestDistance = delta
      best = { value: candidate.value === 0 ? 0 : candidate.value, guide: candidate.guide }
    }
  }
  return best
}

// ------------------------------------------------------------------ 调色

/** 曝光与冷暖都是「按通道倍增」：归一到 0.25 量级的增益，肉眼可见但不失控。 */
function channelGain(video: MediaClipVideo, channel: 'r' | 'g' | 'b'): number {
  const exposure = Math.pow(2, video.exposure / 100)
  const warmth = video.warmth / 100
  if (channel === 'r') return exposure * (1 + warmth * 0.25)
  if (channel === 'b') return exposure * (1 - warmth * 0.25)
  return exposure
}

/** 分段线性查表：曲线控制点之间的插值（与 FFmpeg `curves` 的折线口径一致）。 */
export function curveLookup(points: CurvePoint[], x: number): number {
  const clampedX = Math.min(1, Math.max(0, x))
  for (let i = 1; i < points.length; i += 1) {
    const left = points[i - 1]!
    const right = points[i]!
    if (clampedX <= right.x) {
      const span = right.x - left.x
      if (span < 1e-9) return right.y
      return left.y + ((right.y - left.y) * (clampedX - left.x)) / span
    }
  }
  return points[points.length - 1]?.y ?? clampedX
}

/** 曲线采样（不含通道增益）：给曲线编辑器的 SVG 折线用。 */
export function curveSamples(points: CurvePoint[], steps = CURVE_LUT_STEPS): number[] {
  const values: number[] = []
  for (let i = 0; i <= steps; i += 1) values.push(curveLookup(points, i / steps))
  return values
}

/**
 * 「光感」的中调权重：4x(1−x) 在中调最大、两端为 0（端点永不移动 → 黑场/白场不会被裁切），
 * 再乘 (1 − 0.30x) 压低上半段 → 高光受保护，得到 Premiere/剪映里那种“通透但不冲顶”的观感。
 */
export function lightToneWeight(x: number): number {
  const clamped = Math.min(1, Math.max(0, x))
  return 4 * clamped * (1 - clamped) * (1 - 0.3 * clamped)
}

/**
 * 光感对**亮度**的映射：正值抬中调、负值压中调，端点固定。
 * amount 100 → 中调最多 +0.22（约 +22% 亮度），不是简单的整体增亮。
 */
export function lightToneLift(x: number, amount: number): number {
  const clamped = Math.min(1, Math.max(0, x))
  const strength = (amount / 100) * (amount >= 0 ? 0.22 : 0.2)
  return Math.min(1, Math.max(0, clamped + strength * lightToneWeight(clamped)))
}

/**
 * 光感的**饱和补偿**：幅度只有饱和度滑杆的约 1/12（`0.08` 对 `1`），
 * 只补回提亮后被冲淡的色彩，不会像饱和度那样把肤色一起推爆。
 */
export function lightToneSaturate(amount: number): number {
  return 1 + (amount / 100) * 0.08
}

/** 曲线是否真的弯了（直线时不必挂 SVG 滤镜，省一次合成）。 */
export function needsCurveTable(video: MediaClipVideo): boolean {
  return !isStraightCurves(video.curves)
}

/** 该片段是否需要 SVG 通道表（曲线弯了，或曝光/冷暖/光感这类需要逐通道查表的参数非 0）。 */
export function needsChannelTable(video: MediaClipVideo): boolean {
  return (
    needsCurveTable(video) ||
    Math.abs(video.exposure) > 1e-6 ||
    Math.abs(video.warmth) > 1e-6 ||
    Math.abs(video.vibrance) > 1e-6
  )
}

/**
 * 单通道最终的查找表：**亮度曲线 → 单通道曲线 → 光感提亮 → 通道增益**，最后夹到 0..1。
 * 顺序固定，导出侧要按同一顺序写 FFmpeg 滤镜链。
 */
export function curveTableValues(video: MediaClipVideo, channel: 'r' | 'g' | 'b', steps = CURVE_LUT_STEPS): string {
  const gain = channelGain(video, channel)
  const values: string[] = []
  for (let i = 0; i <= steps; i += 1) {
    const x = i / steps
    const afterMaster = curveLookup(video.curves.master, x)
    const afterChannel = curveLookup(video.curves[channel], afterMaster)
    const afterLight = video.vibrance === 0 ? afterChannel : lightToneLift(afterChannel, video.vibrance)
    values.push(Math.min(1, Math.max(0, afterLight * gain)).toFixed(4))
  }
  return values.join(' ')
}

/** 该片段需要的 SVG 滤镜 id（与 PreviewStage 里 <filter> 的定义同源）。 */
export const MEDIA_GRADE_FILTER_ID = 'socut-media-grade'

/**
 * 预览里的调色（CSS filter）。
 * 亮度/对比度/饱和度/光感补偿走 CSS 函数；曝光/冷暖/曲线/光感提亮走 SVG 曲线表。
 */
export function mediaVideoFilter(
  video: MediaClipVideo | undefined,
  channelTableId = MEDIA_GRADE_FILTER_ID
): string {
  if (!video) return 'none'
  const parts: string[] = []
  if (Math.abs(video.brightness) > 1e-6) parts.push(`brightness(${(1 + video.brightness / 100).toFixed(3)})`)
  if (Math.abs(video.contrast) > 1e-6) parts.push(`contrast(${(1 + video.contrast / 100).toFixed(3)})`)
  const saturation = 1 + video.saturation / 100
  const withLight = video.vibrance === 0 ? saturation : saturation * lightToneSaturate(video.vibrance)
  if (Math.abs(video.saturation) > 1e-6 || Math.abs(video.vibrance) > 1e-6) parts.push(`saturate(${withLight.toFixed(3)})`)
  // 多候选预览时每段各有自己的曲线表，id 由调用方给；默认仍用全局 id（旧调用不变）
  if (needsChannelTable(video)) parts.push(`url(#${channelTableId})`)
  // M7-E：特效包的 CSS 近似（黑白/暖光/暗角等可近似项；其余靠导出）
  const effectFilter = effectPreviewFilter(video.effects)
  if (effectFilter) parts.push(effectFilter)
  return parts.length === 0 ? 'none' : parts.join(' ')
}
