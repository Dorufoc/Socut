import {
  curveTableValues,
  CURVE_LUT_STEPS,
  isDefaultMediaVideo,
  isStraightCurves,
  lightToneSaturate,
  normalizeMediaVideo
} from './mediaClipVideo'
import { buildEffectFilters } from './effectPackages'
import { defaultMediaVideo } from './mediaClipVideo'
import {
  mediaGradeKeyframesActive,
  mediaKeyframesActive,
  mediaParamExpr,
  mediaTrackOf,
  mediaVideoAt,
  MEDIA_KEYFRAME_EXPR_SAMPLES
} from './mediaClipKeyframes'
import { keyframeValueAt, type KeyframeTrack } from './keyframes'
import { keyFilters, normalizeMediaClipKey } from './keying'
import type { MediaClipKey } from './keying'
import { fpsToArg } from './fps'
import type { Fps, MediaClipVideo } from './types'

/**
 * 片段画面变换与调色 → FFmpeg 滤镜语句（v10 · 导出所见即所得）。
 *
 * 与 `mediaClipVideo.ts` 的预览公式一一对应：
 * - 几何：镜像 → 缩放 → 旋转（透明/黑色补边）→ 与黑/透明底 overlay（位移可负）；
 * - 调色：亮度（colorchannelmixer，CSS brightness 同口径）→ 对比度/饱和度（eq）
 *   → 主/通道曲线 + 光感 + 曝光/冷暖通道增益（curves，采样自同一 `curveTableValues`）。
 *
 * 纪律：
 * 1. 默认值不注入任何滤镜（零回归）；
 * 2. 单位换算只在本文件与 `mediaClipVideo.ts`，不在这里另造一套；
 * 3. 本模块**不得** import `ffmpegArgs`（后者会 import 本模块），
 *    只从 `fps` 取帧率写法、在本文件内保留一个与 `formatSec` 同口径的秒格式化。
 */

export interface MediaClipVideoFxInput {
  /** 已归一为 W×H 的帧标签（rgba 或 yuv420p 均可） */
  baseLabel: string
  outputLabel: string
  video?: MediaClipVideo
  frame: { width: number; height: number }
  fps: Fps
  /** 本段在时间轴上的输出长度（变速之后） */
  durationSec: number
  /** 多轨图层 = true（透明底）；单轨基座 = false（黑底） */
  transparentBackground: boolean
  /** M8：抠像（缺省 = 不抠像；仅导出侧生效） */
  key?: MediaClipKey
  /** M6-E：媒体段关键帧（缺省 = 静态几何，与旧版逐字节一致） */
  keyframes?: KeyframeTrack[]
}

export interface MediaClipVideoFxPlan {
  /** 完整的滤镜语句（无首尾分号） */
  statements: string[]
  outputLabel: string
}

/** 秒 → 滤镜数值（与 ffmpegArgs.formatSec 同口径；本模块不能反向 import）。 */
function formatSec(sec: number): string {
  return (Math.round(sec * 1e6) / 1e6).toFixed(6)
}

/** 数字 → 紧凑写法：四舍五入到指定位数，去掉尾零与负零。 */
function num(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return '0'
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  if (Object.is(rounded, -0)) return '0'
  return String(rounded)
}

/** 旋转后包围盒的偶数尺寸（编码器要求偶数宽高）。 */
function even(value: number): number {
  const rounded = Math.round(value / 2) * 2
  return Math.max(2, Number.isFinite(rounded) ? rounded : 2)
}

function geometryChanged(video: MediaClipVideo): boolean {
  return (
    Math.abs(video.scalePercent - 100) > 1e-6 ||
    Math.abs(video.offsetXPercent) > 1e-6 ||
    Math.abs(video.offsetYPercent) > 1e-6 ||
    Math.abs(video.rotationDeg) > 1e-6 ||
    video.flipH ||
    video.flipV
  )
}

/** 调色滤镜串（不含首尾逗号）；顺序：亮度 → 对比度/饱和度 → 曲线。 */
function gradeFilters(video: MediaClipVideo, lutSteps: number = CURVE_LUT_STEPS): string[] {
  const filters: string[] = []
  if (Math.abs(video.brightness) > 1e-6) {
    const gain = 1 + video.brightness / 100
    filters.push(`colorchannelmixer=rr=${num(gain)}:gg=${num(gain)}:bb=${num(gain)}:aa=1`)
  }

  const contrastChanged = Math.abs(video.contrast) > 1e-6
  const saturationChanged = Math.abs(video.saturation) > 1e-6 || Math.abs(video.vibrance) > 1e-6
  if (contrastChanged || saturationChanged) {
    const contrast = 1 + video.contrast / 100
    const saturation = (1 + video.saturation / 100) * lightToneSaturate(video.vibrance)
    filters.push(`eq=contrast=${num(contrast)}:saturation=${num(saturation)}`)
  }

  const needsCurves =
    !isStraightCurves(video.curves) ||
    Math.abs(video.exposure) > 1e-6 ||
    Math.abs(video.warmth) > 1e-6 ||
    Math.abs(video.vibrance) > 1e-6
  if (needsCurves) {
    filters.push(
      `curves=r='${curvePoints(video, 'r', lutSteps)}':g='${curvePoints(video, 'g', lutSteps)}':b='${curvePoints(
        video,
        'b',
        lutSteps
      )}'`
    )
  }
  return filters
}

/** 调色关键帧的逐帧分段数：几何/亮度类（很小）可以切细；带曲线表（很占体积）切粗。 */
const GRADE_KEYFRAME_STEPS = 24
const GRADE_KEYFRAME_CURVE_STEPS = 12
/** 分段路径的曲线采样数：控制 filter_complex 体积（静态路径仍用完整 32 段）。 */
const GRADE_KEYFRAME_LUT_STEPS = 16

/**
 * 调色关键帧 → 一串「时间窗静态滤镜」：
 * 把整段按 `[t₀,t₁)` 切片，每个时间窗内用**窗口中点求值**的静态调色串，靠 `enable` 只在该窗生效。
 *
 * 为什么不用 `eq` 表达式：亮度/曝光/冷暖/光感的 CSS 语义是**乘性通道增益/曲线查表**，
 * FFmpeg 的 `eq` 只能做加性亮度与对比度/饱和度，`colorchannelmixer`/`curves` 又不接受表达式；
 * 所以逐帧数值只能落到「分段静态参数 + 时间窗」上（分段常量近似，并非逐帧精确）。
 */
function steppedGradeFilters(
  video: MediaClipVideo,
  keyframes: readonly KeyframeTrack[] | undefined,
  durationSec: number
): string[] {
  const duration = Math.max(1e-6, Number.isFinite(durationSec) ? durationSec : 0)
  // 曲线表（曝光/冷暖/光感/弯曲曲线）体积大，切粗一点；纯亮度/对比度/饱和度切细保证平顺
  const needsCurves =
    !isStraightCurves(video.curves) ||
    Math.abs(video.exposure) > 1e-6 ||
    Math.abs(video.warmth) > 1e-6 ||
    Math.abs(video.vibrance) > 1e-6 ||
    (keyframes ?? []).some(
      (track) =>
        track.points.length > 0 && ['exposure', 'warmth', 'vibrance'].includes(track.param)
    )
  const steps = needsCurves ? GRADE_KEYFRAME_CURVE_STEPS : GRADE_KEYFRAME_STEPS
  const lutSteps = needsCurves ? GRADE_KEYFRAME_LUT_STEPS : CURVE_LUT_STEPS
  const filters: string[] = []
  for (let index = 0; index < steps; index += 1) {
    const start = (index / steps) * duration
    const end = ((index + 1) / steps) * duration
    // 中点取值：窗口内保持常量的近似值（端点由首/末窗各覆盖一次，不会漏帧）
    const frameVideo = mediaVideoAt(video, keyframes, (index + 0.5) / steps) ?? video
    // 首窗不设下界（t 可能因上游 setpts 从非 0 开始）；末窗不设上界（覆盖到尾帧）
    const enable =
      index === 0
        ? `lt(t,${num(end, 6)})`
        : index === steps - 1
          ? `gte(t,${num(start, 6)})`
          : `gte(t,${num(start, 6)})*lt(t,${num(end, 6)})`
    for (const filter of gradeFilters(frameVideo, lutSteps)) {
      filters.push(`${filter}:enable='${enable}'`)
    }
  }
  return filters
}

/** `"0.0000 0.0313 ..."` → `0/0.0000 0.031/0.0313 ... 1/1.0000`（曲线控制点）。 */
function curvePoints(video: MediaClipVideo, channel: 'r' | 'g' | 'b', lutSteps: number = CURVE_LUT_STEPS): string {
  const values = curveTableValues(video, channel, lutSteps).split(' ')
  return values
    .map((y, index) => {
      const x = index / (values.length - 1)
      const xLabel = x === 0 || x === 1 ? num(x, 0) : num(x, 3)
      return `${xLabel}/${y}`
    })
    .join(' ')
}

/**
 * 生成片段画面变换/调色的滤镜语句。
 * 默认值（`undefined` 或全部等于默认）→ 空语句，输出标签原样返回（零回归）。
 */
export function buildMediaClipVideoFx(input: MediaClipVideoFxInput): MediaClipVideoFxPlan {
  const normalizedVideo = normalizeMediaVideo(input.video)
  // M8：键控（全默认 → undefined → 不注入任何滤镜）
  const key = normalizeMediaClipKey(input.key)
  // M6-E：媒体段关键帧（全默认 + 无关键帧时才允许"零语句"早退）
  const keyframes = input.keyframes
  const useKeyframes = mediaKeyframesActive(keyframes)
  if ((!normalizedVideo || isDefaultMediaVideo(normalizedVideo)) && !key && !useKeyframes) {
    return { statements: [], outputLabel: input.baseLabel }
  }
  const video = normalizedVideo ?? defaultMediaVideo()
  const keying = keyFilters(key)

  const { frame, fps, transparentBackground, durationSec } = input
  const finalFormat = transparentBackground ? 'rgba' : 'yuv420p'
  // 调色关键帧：逐帧数值 → 时间窗静态滤镜；否则保持原来的单串静态滤镜（逐字节不变）
  const grade = mediaGradeKeyframesActive(keyframes)
    ? steppedGradeFilters(video, keyframes, durationSec)
    : gradeFilters(video)
  const geometry = geometryChanged(video)
  // M7-E：特效包滤镜挂在调色之后（vignette/颗粒等作用在最终画面上）；
  // 无特效时 effects=[]，下面的语句与旧版逐字节一致。
  const effects = buildEffectFilters(video.effects)

  // 只有调色：帧仍是整幅 W×H，不需要补底与 overlay。
  if (!geometry && !useKeyframes) {
    const chain = [
      `[${input.baseLabel}]format=rgba`,
      ...grade,
      ...effects,
      // M8：抠像放在调色/特效之后（用户调的是最终颜色），无 keying 时不多一个逗号
      ...keying,
      `format=${finalFormat}[${input.outputLabel}]`
    ].join(',')
    return { statements: [chain], outputLabel: input.outputLabel }
  }

  // M6-E：关键帧 → 表达式路径（scale/rotate/overlay 的数值换成 t 表达式，不透明度用 alpha 掩膜）。
  // 无关键帧时**不进入**这里：静态路径的字符串必须逐字节不变（有 argv 快照测试锁定）。
  if (useKeyframes) {
    return buildKeyframeAfx(input, video, { grade, effects, keying, finalFormat })
  }

  const scale = video.scalePercent / 100
  const radians = (video.rotationDeg * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  // 包围盒用「归一后的帧尺寸 × 缩放」，不能用 iw/ih（base 已被画布归一）。
  const rotatedWidth = even(frame.width * scale * cos + frame.height * scale * sin)
  const rotatedHeight = even(frame.width * scale * sin + frame.height * scale * cos)

  const fgParts: string[] = ['format=rgba']
  if (video.flipH) fgParts.push('hflip')
  if (video.flipV) fgParts.push('vflip')
  if (Math.abs(video.scalePercent - 100) > 1e-6) {
    const factor = num(scale)
    fgParts.push(`scale=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2:flags=bicubic`)
  }
  if (Math.abs(video.rotationDeg) > 1e-6) {
    fgParts.push(
      `rotate=${num(radians)}:ow=${rotatedWidth}:oh=${rotatedHeight}:c=${transparentBackground ? 'black@0.0' : 'black'}`
    )
  }
  fgParts.push(...grade)

  const size = `${frame.width}x${frame.height}`
  const x = num((frame.width - rotatedWidth) / 2 + (video.offsetXPercent / 100) * frame.width, 3)
  const y = num((frame.height - rotatedHeight) / 2 + (video.offsetYPercent / 100) * frame.height, 3)
  const statements = [
    `[${input.baseLabel}]${fgParts.join(',')}[fg]`,
    `color=c=black${transparentBackground ? '@0.0' : ''}:s=${size}:r=${fpsToArg(fps)}:d=${formatSec(
      Math.max(0.01, durationSec)
    )}[bg]`,
    // 特效在 overlay 之后作用于整幅画面（与预览的近似顺序一致）；M8 抠像再往后
    `[bg][fg]overlay=x=${x}:y=${y}:format=auto:eof_action=pass:shortest=0` +
      `${effects.length > 0 ? `,${effects.join(',')}` : ''}` +
      `${keying.length > 0 ? `,${keying.join(',')}` : ''},format=${finalFormat}[${input.outputLabel}]`
  ]
  return { statements, outputLabel: input.outputLabel }
}

/** 关键帧路径要复用的几条滤镜（已由调用方算好，避免重复归一化）。 */
interface KeyframePassThrough {
  grade: string[]
  effects: string[]
  keying: string[]
  finalFormat: 'rgba' | 'yuv420p'
}

/**
 * M6-E：媒体段关键帧的表达式滤镜图（真机验证过的组合）。
 *
 * 口径（与预览 `mediaKeyframeCssAt` 同源）：
 * - 缩放 `scale=...:eval=frame`（表达式除以 100 = 倍率）；
 * - 旋转 `rotate=angle='(...)*PI/180':ow/oh=<整段最大包围盒>:eval=frame`（固定输出尺寸，
 *   旋转后的空边透明/黑，再由 overlay 居中）；
 * - 位移 `overlay=x='(W-w)/2+(Ox(t)/100)*W'`（`w` 跟随当前帧缩放后的宽度）；
 * - 不透明度：8×8 白底 → `geq(a=clip(255*O(T)))` → `alphaextract` → 放大 → `alphamerge`
 *   （掩膜空间均匀，8×8 足够；避免 1080p 逐像素 geq 的性能坑）。
 *
 * 注意 `geq` 的时间变量是 **`T`**（大写），overlay/scale/rotate 是 `t`——真机踩过。
 */
function buildKeyframeAfx(
  input: MediaClipVideoFxInput,
  video: MediaClipVideo,
  pass: KeyframePassThrough
): MediaClipVideoFxPlan {
  const { frame, fps, transparentBackground } = input
  const duration = Math.max(0.01, input.durationSec)
  const durationArg = formatSec(duration)
  const rate = fpsToArg(fps)
  const scaleExpr = mediaParamExpr(mediaTrackOf(input.keyframes, 'scalePct'), duration)
  const rotateExpr = mediaParamExpr(mediaTrackOf(input.keyframes, 'rotationDeg'), duration)
  const offsetXExpr = mediaParamExpr(mediaTrackOf(input.keyframes, 'offsetXPct'), duration)
  const offsetYExpr = mediaParamExpr(mediaTrackOf(input.keyframes, 'offsetYPct'), duration)
  const opacityExpr = mediaParamExpr(mediaTrackOf(input.keyframes, 'opacity'), duration, MEDIA_KEYFRAME_EXPR_SAMPLES, 'T')

  // 旋转包围盒必须在构建期定成固定尺寸：整段采样取最大外接框（表达式本身无法在构建期取极值）。
  const scaleTrack = mediaTrackOf(input.keyframes, 'scalePct')
  const rotateTrack = mediaTrackOf(input.keyframes, 'rotationDeg')
  let boxWidth = 0
  let boxHeight = 0
  for (let index = 0; index <= MEDIA_KEYFRAME_EXPR_SAMPLES; index += 1) {
    const progress = index / MEDIA_KEYFRAME_EXPR_SAMPLES
    const scale = (scaleTrack ? keyframeValueAt(scaleTrack, progress) : video.scalePercent) / 100
    const degrees = rotateTrack ? keyframeValueAt(rotateTrack, progress) : video.rotationDeg
    const radians = (degrees * Math.PI) / 180
    const cos = Math.abs(Math.cos(radians))
    const sin = Math.abs(Math.sin(radians))
    boxWidth = Math.max(boxWidth, frame.width * scale * cos + frame.height * scale * sin)
    boxHeight = Math.max(boxHeight, frame.width * scale * sin + frame.height * scale * cos)
  }
  const rotatedWidth = even(Math.max(2, boxWidth))
  const rotatedHeight = even(Math.max(2, boxHeight))

  const fgParts: string[] = ['format=rgba']
  if (video.flipH) fgParts.push('hflip')
  if (video.flipV) fgParts.push('vflip')
  if (scaleExpr) {
    fgParts.push(
      `scale=w='trunc(iw*(${scaleExpr})/100/2)*2':h='trunc(ih*(${scaleExpr})/100/2)*2':eval=frame:flags=bicubic`
    )
  } else if (Math.abs(video.scalePercent - 100) > 1e-6) {
    const factor = num(video.scalePercent / 100)
    fgParts.push(`scale=trunc(iw*${factor}/2)*2:trunc(ih*${factor}/2)*2:flags=bicubic`)
  }
  const rotateColor = transparentBackground ? 'black@0.0' : 'black'
  if (rotateExpr) {
    // 真机：本机 FFmpeg 9 的 rotate **没有 eval 选项**（传 eval=frame 会 "Option not found"）。
    // `angle` 带 T 标记（运行期可变），表达式按帧求值即可，不需要额外开关。
    fgParts.push(`rotate=angle='(${rotateExpr})*PI/180':ow=${rotatedWidth}:oh=${rotatedHeight}:c=${rotateColor}`)
  } else if (Math.abs(video.rotationDeg) > 1e-6) {
    fgParts.push(
      `rotate=${num((video.rotationDeg * Math.PI) / 180)}:ow=${rotatedWidth}:oh=${rotatedHeight}:c=${rotateColor}`
    )
  }
  fgParts.push(...pass.grade)

  const statements: string[] = []
  const size = `${frame.width}x${frame.height}`
  if (opacityExpr) {
    // fg 先落到临时标签，再与 alpha 掩膜合并
    statements.push(`[${input.baseLabel}]${fgParts.join(',')}[fgc]`)
    statements.push(
      `color=c=white:s=8x8:r=${rate}:d=${durationArg},format=rgba,` +
        `geq=r='255':g='255':b='255':a='clip(255*(${opacityExpr}),0,255)',` +
        `format=rgba,alphaextract,format=gray,scale=${rotatedWidth}:${rotatedHeight}:flags=neighbor[am]`
    )
    statements.push(`[fgc][am]alphamerge,format=rgba[fg]`)
  } else {
    statements.push(`[${input.baseLabel}]${fgParts.join(',')}[fg]`)
  }

  const x = offsetXExpr
    ? `'(W-w)/2+((${offsetXExpr})/100)*W'`
    : num((frame.width - rotatedWidth) / 2 + (video.offsetXPercent / 100) * frame.width, 3)
  const y = offsetYExpr
    ? `'(H-h)/2+((${offsetYExpr})/100)*H'`
    : num((frame.height - rotatedHeight) / 2 + (video.offsetYPercent / 100) * frame.height, 3)

  statements.push(`color=c=black${transparentBackground ? '@0.0' : ''}:s=${size}:r=${rate}:d=${durationArg}[bg]`)
  statements.push(
    `[bg][fg]overlay=x=${x}:y=${y}:format=auto:eof_action=pass:shortest=0` +
      `${pass.effects.length > 0 ? `,${pass.effects.join(',')}` : ''}` +
      `${pass.keying.length > 0 ? `,${pass.keying.join(',')}` : ''},format=${pass.finalFormat}[${input.outputLabel}]`
  )
  return { statements, outputLabel: input.outputLabel }
}
