import {
  curveTableValues,
  isDefaultMediaVideo,
  isStraightCurves,
  lightToneSaturate,
  normalizeMediaVideo
} from './mediaClipVideo'
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
function gradeFilters(video: MediaClipVideo): string[] {
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
      `curves=r='${curvePoints(video, 'r')}':g='${curvePoints(video, 'g')}':b='${curvePoints(video, 'b')}'`
    )
  }
  return filters
}

/** `"0.0000 0.0313 ..."` → `0/0.0000 0.031/0.0313 ... 1/1.0000`（曲线控制点）。 */
function curvePoints(video: MediaClipVideo, channel: 'r' | 'g' | 'b'): string {
  const values = curveTableValues(video, channel).split(' ')
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
  const video = normalizeMediaVideo(input.video)
  if (!video || isDefaultMediaVideo(video)) {
    return { statements: [], outputLabel: input.baseLabel }
  }

  const { frame, fps, transparentBackground, durationSec } = input
  const finalFormat = transparentBackground ? 'rgba' : 'yuv420p'
  const grade = gradeFilters(video)
  const geometry = geometryChanged(video)

  // 只有调色：帧仍是整幅 W×H，不需要补底与 overlay。
  if (!geometry) {
    const chain = [
      `[${input.baseLabel}]format=rgba`,
      ...grade,
      `format=${finalFormat}[${input.outputLabel}]`
    ].join(',')
    return { statements: [chain], outputLabel: input.outputLabel }
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
    `[bg][fg]overlay=x=${x}:y=${y}:format=auto:eof_action=pass:shortest=0,format=${finalFormat}[${input.outputLabel}]`
  ]
  return { statements, outputLabel: input.outputLabel }
}
