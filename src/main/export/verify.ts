import { ALPHA_DROPPED_MARKER, buildVerifyArgs } from '../../shared/ffmpegArgs'
import { frameRateMatches, isDeliveryYuv420p, isProres4444WithAlpha, parseVerifyJson } from '../../shared/probe'
import type { Fps, VideoMeta } from '../../shared/types'
import type { FfmpegBinaries } from '../paths'
import { runFfprobeJson } from '../ffrun'

/** 产物校验（规格 §5.3 / 验收 §10）：校验失败即任务失败。 */

export class VerifyError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message)
  }
}

export interface Expectation {
  width: number
  height: number
  fps: Fps
  frames: number
}

/** 计划 C1：profile 0–3 会静默丢 alpha，只打日志。必须显式检测。 */
export function assertNoAlphaDrop(stderr: string): void {
  if (stderr.includes(ALPHA_DROPPED_MARKER)) {
    throw new VerifyError('alpha 通道未编码', stderr.slice(-512))
  }
}

export async function verifyTransparentMov(
  path: string,
  expectation: Expectation,
  binaries: FfmpegBinaries,
  options: { codec?: 'prores4444' | 'qtrle' } = {}
): Promise<void> {
  const payload = await runFfprobeJson<unknown>(buildVerifyArgs(path), `verify-${Date.now()}`, binaries)
  const result = parseVerifyJson(payload)
  if (!result) throw new VerifyError('产物无法解析', 'ffprobe 未返回视频流')

  if (result.width !== expectation.width || result.height !== expectation.height) {
    throw new VerifyError(
      '分辨率不符',
      `期望 ${expectation.width}x${expectation.height}，实际 ${result.width}x${result.height}`
    )
  }
  if (expectation.frames > 0 && result.nbFrames !== null && result.nbFrames !== expectation.frames) {
    throw new VerifyError('帧数不符', `期望 ${expectation.frames}，实际 ${result.nbFrames}`)
  }
  if (!frameRateMatches(result, expectation.fps)) {
    throw new VerifyError(
      '帧率不符',
      `期望 ${expectation.fps.num}/${expectation.fps.den}，实际 ${result.rFrameRate?.num ?? '?'}/${result.rFrameRate?.den ?? '?'}`
    )
  }
  if (options.codec === 'qtrle') {
    if (result.pixFmt !== 'argb' || result.codecTag !== 'rle ') {
      throw new VerifyError('qtrle 产物不符', `pix_fmt=${result.pixFmt} tag=${result.codecTag}`)
    }
    return
  }
  if (!isProres4444WithAlpha(result)) {
    throw new VerifyError(
      'ProRes 4444 透明通道校验失败',
      `codec=${result.codecName} tag=${result.codecTag} pix_fmt=${result.pixFmt}（期望 fourcc=ap4h 且 pix_fmt=yuva444p10le）`
    )
  }
}

export interface OverlayVerifyOptions {
  /** M9：显式要求编码格式（缺省只校验像素格式，与旧行为一致） */
  videoCodec?: 'avc' | 'hevc' | 'av1'
  /** M9：10bit 产物期望 yuv420p10le */
  bitDepth?: 8 | 10
  /** M9：full range 产物期望 color_range=pc */
  colorRange?: 'limited' | 'full'
}

export async function verifyOverlayMp4(
  path: string,
  expectation: Expectation,
  refMeta: VideoMeta,
  binaries: FfmpegBinaries,
  options: OverlayVerifyOptions = {}
): Promise<void> {
  const payload = await runFfprobeJson<unknown>(buildVerifyArgs(path), `verify-${Date.now()}`, binaries)
  const result = parseVerifyJson(payload)
  if (!result) throw new VerifyError('产物无法解析', 'ffprobe 未返回视频流')
  if (options.bitDepth === 10) {
    // M9：10bit 交付（HEVC/AV1）；像素格式必须带 10
    if (result.pixFmt !== 'yuv420p10le' && result.pixFmt !== 'yuv420p10be') {
      throw new VerifyError('输出位深不符', `pix_fmt=${result.pixFmt}（期望 yuv420p10le）`)
    }
  } else if (!isDeliveryYuv420p(result)) {
    // 计划 C3：overlay 后必须回到 8-bit 4:2:0
    throw new VerifyError('输出像素格式不符', `pix_fmt=${result.pixFmt}（期望 yuv420p）`)
  }
  if (options.videoCodec) {
    const expected = options.videoCodec === 'hevc' ? 'hevc' : options.videoCodec === 'av1' ? 'av1' : 'h264'
    if (result.codecName !== expected) {
      throw new VerifyError('输出编码格式不符', `codec=${result.codecName}（期望 ${expected}）`)
    }
  }
  if (options.colorRange === 'full' && result.colorRange !== 'pc') {
    throw new VerifyError('色彩范围标签不符', `color_range=${result.colorRange ?? '未标注'}（期望 pc）`)
  }
  if (result.width !== expectation.width || result.height !== expectation.height) {
    throw new VerifyError(
      '未跟随参考视频分辨率',
      `参考 ${expectation.width}x${expectation.height}，实际 ${result.width}x${result.height}`
    )
  }
  if (!frameRateMatches(result, expectation.fps)) {
    throw new VerifyError(
      '未跟随参考视频帧率',
      `参考 ${refMeta.avgFrameRate.num}/${refMeta.avgFrameRate.den}，实际 ${result.rFrameRate?.num ?? '?'}/${result.rFrameRate?.den ?? '?'}`
    )
  }
  if (refMeta.audioCodec !== null && result.nbFrames !== null && expectation.frames > 0) {
    // 有音轨时至少要求帧数与预期一致（时长口径由上层 duration 再核对）
    if (result.nbFrames < expectation.frames * 0.98) {
      throw new VerifyError('输出帧数偏少', `期望约 ${expectation.frames}，实际 ${result.nbFrames}`)
    }
  }
}
