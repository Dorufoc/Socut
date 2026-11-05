import {
  COPYABLE_AUDIO_CODECS,
  HDR_COLOR_PRIMARIES,
  HDR_COLOR_TRANSFERS,
  VFR_GAP_FACTOR,
  VFR_RATIO_TOLERANCE,
  nearestFps
} from './constants'
import { classifyAspect, displayAspectRatio, isNon16_9 } from './aspect'
import { fpsToArg } from './fps'
import type {
  CompatFlags,
  Fps,
  Rational,
  VfrEvidence,
  VideoMeta,
  VideoProbeResult
} from './types'

/** ffprobe JSON → VideoMeta + 兼容性判定（规格 §6，纯函数便于夹具测试）。 */

type Json = Record<string, unknown>

function asObject(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function parseRational(value: unknown): Rational | null {
  const raw = asString(value)
  if (!raw) return null
  // ffprobe 用「30000/1001」表示帧率，用「16:9」「1:1」表示 SAR/DAR，两种分隔符都要支持
  const parts = raw.split(/[:/]/).map((part) => part.trim())
  if (parts.length > 2) return null
  const [numRaw, denRaw] = parts
  const n = Number(numRaw)
  const d = denRaw === undefined || denRaw.length === 0 ? 1 : Number(denRaw)
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null
  return { num: Math.round(n), den: Math.round(d) }
}

/** 解析 ffprobe `-show_streams -show_format -print_format json` 输出。 */
export function parseProbeJson(payload: unknown, path: string): VideoMeta | null {
  const root = asObject(payload)
  if (!root) return null
  const streams = Array.isArray(root['streams']) ? root['streams'] : []
  const video = streams.map(asObject).find((s) => s && asString(s['codec_type']) === 'video')
  if (!video) return null
  const audio = streams.map(asObject).find((s) => s && asString(s['codec_type']) === 'audio')
  const format = asObject(root['format'])

  const width = asNumber(video['width']) ?? 0
  const height = asNumber(video['height']) ?? 0
  if (width <= 0 || height <= 0) return null

  const sar = parseRational(video['sample_aspect_ratio'])
  const rFrameRate = parseRational(video['r_frame_rate']) ?? { num: 25, den: 1 }
  const avgFrameRate = parseRational(video['avg_frame_rate']) ?? rFrameRate

  const durationSec =
    asNumber(video['duration']) ?? asNumber(format?.['duration']) ?? 0
  const nbFrames = asNumber(video['nb_frames'])

  const meta: VideoMeta = {
    path,
    containerName: asString(format?.['format_name']) ?? 'unknown',
    width,
    height,
    sar,
    displayRatio: displayAspectRatio({ width, height }, sar),
    rFrameRate,
    avgFrameRate,
    pixFmt: asString(video['pix_fmt']) ?? 'unknown',
    colorPrimaries: asString(video['color_primaries']),
    colorSpace: asString(video['color_space']),
    colorTransfer: asString(video['color_transfer']),
    colorRange: asString(video['color_range']),
    videoCodec: asString(video['codec_name']) ?? 'unknown',
    audioCodec: audio ? asString(audio['codec_name']) : null,
    audioChannels: audio ? asNumber(audio['channels']) : null,
    durationSec,
    nbFrames,
    bitRateKbps: asNumber(format?.['bit_rate']) !== null ? (asNumber(format?.['bit_rate']) ?? 0) / 1000 : null
  }
  return meta
}

/**
 * 图片尺寸解析（水印导入用）：ffprobe 对 PNG/JPG 给的是同一路图片流，
 * 这里只取 width/height，不要求帧率/色彩标签等视频字段。
 * 任何一项不可用就返回 null（调用方按“探测失败”提示用户换图）。
 */
export function parseImageSize(payload: unknown): { width: number; height: number } | null {
  const root = asObject(payload)
  const streams = Array.isArray(root?.['streams']) ? (root?.['streams'] as unknown[]) : []
  for (const item of streams) {
    const stream = asObject(item)
    if (!stream) continue
    const codecType = asString(stream['codec_type'])
    // 纯图片探测只有一路流；写了 codec_type 的必须就是 video
    if (codecType !== null && codecType !== 'video') continue
    const width = asNumber(stream['width'])
    const height = asNumber(stream['height'])
    if (width === null || height === null) continue
    if (width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) continue
    return { width, height }
  }
  return null
}

/** 分析前若干 packet 的 pts_time，判定是否变帧率（规格 §6.3）。 */
export function analyzeVfrSample(
  packets: unknown,
  expectedFps: Fps
): { vfr: boolean; evidence: VfrEvidence } {
  const list = Array.isArray(packets) ? packets.map(asObject) : []
  const times: number[] = []
  for (const item of list) {
    const t = asNumber(item?.['pts_time'])
    if (t !== null) times.push(t)
  }
  // ffprobe 默认按 DTS 顺序输出 packet，含 B 帧时 pts 不单调；
  // 必须按展示顺序排序后再算间隔，否则会把正常的重排列误判为 VFR。
  times.sort((a, b) => a - b)
  const expectedGapSec = expectedFps.den / expectedFps.num
  let maxGap = 0
  let minGap = Number.POSITIVE_INFINITY
  for (let i = 1; i < times.length; i++) {
    const prev = times[i - 1] as number
    const cur = times[i] as number
    const gap = cur - prev
    if (gap > 0) {
      maxGap = Math.max(maxGap, gap)
      minGap = Math.min(minGap, gap)
    }
  }
  // 上限：最大间隔超阈值；下限：出现重复/极短间隔同样视为不规则
  const tooWide = maxGap > expectedGapSec * VFR_GAP_FACTOR
  const tooNarrow = Number.isFinite(minGap) && minGap < expectedGapSec / VFR_GAP_FACTOR
  const vfr = tooWide || tooNarrow
  return {
    vfr,
    evidence: { expectedGapSec, maxGapSec: maxGap, sampledPackets: times.length }
  }
}

/** 兼容性标志（计划 C8：非 16:9 用显示宽高比判定）。 */
export function detectCompat(meta: VideoMeta, vfrEvidence?: VfrEvidence): CompatFlags {
  const ratioDiff =
    meta.avgFrameRate.den > 0 && meta.rFrameRate.den > 0
      ? Math.abs(meta.rFrameRate.num / meta.rFrameRate.den - meta.avgFrameRate.num / meta.avgFrameRate.den) /
        Math.max(1e-6, meta.avgFrameRate.num / meta.avgFrameRate.den)
      : 0
  const rateMismatch = ratioDiff > VFR_RATIO_TOLERANCE
  const sampledVfr = vfrEvidence ? vfrEvidence.maxGapSec > vfrEvidence.expectedGapSec * VFR_GAP_FACTOR : false

  const hdr =
    (meta.colorTransfer !== null && HDR_COLOR_TRANSFERS.includes(meta.colorTransfer)) ||
    (meta.colorPrimaries !== null && HDR_COLOR_PRIMARIES.includes(meta.colorPrimaries)) ||
    (meta.colorSpace !== null && meta.colorSpace.startsWith('bt2020'))

  const mode = classifyAspect(meta.displayRatio)
  return {
    non169: isNon16_9(meta.displayRatio),
    portrait: mode === 'compact',
    ultraWide: mode === 'ultrawide',
    hdr,
    vfr: rateMismatch || sampledVfr,
    noAudio: meta.audioCodec === null,
    audioTranscodeNeeded: meta.audioCodec !== null && !COPYABLE_AUDIO_CODECS.includes(meta.audioCodec)
  }
}

/** 参考视频跟随的帧率：优先 avg_frame_rate，其次 r_frame_rate，吸附到支持档位。 */
export function suggestFps(meta: VideoMeta): Fps {
  const primary = meta.avgFrameRate.num / meta.avgFrameRate.den
  const value = Number.isFinite(primary) && primary > 0 ? primary : meta.rFrameRate.num / meta.rFrameRate.den
  return nearestFps(value)
}

export function buildProbeResult(meta: VideoMeta, packets?: unknown): VideoProbeResult {
  const fps = suggestFps(meta)
  const sample = packets === undefined ? undefined : analyzeVfrSample(packets, fps).evidence
  return {
    meta,
    flags: detectCompat(meta, sample),
    vfrEvidence: sample,
    suggestedFps: fps
  }
}

// ---------------------------------------------------------------------------
// 产物校验（规格 §5.3 / 计划 C1、C3）
// ---------------------------------------------------------------------------

export interface VerifyResult {
  width: number
  height: number
  pixFmt: string
  rFrameRate: Rational | null
  avgFrameRate: Rational | null
  nbFrames: number | null
  codecName: string
  codecTag: string
  colorRange: string | null
  colorSpace: string | null
  profileTag: string | null
}

export function parseVerifyJson(payload: unknown): VerifyResult | null {
  const root = asObject(payload)
  if (!root) return null
  const streams = Array.isArray(root['streams']) ? root['streams'] : []
  const video = streams.map(asObject).find((s) => s && asString(s['codec_type']) === 'video') ?? null
  if (!video) return null
  const tags = asObject(video['tags'])
  return {
    width: asNumber(video['width']) ?? 0,
    height: asNumber(video['height']) ?? 0,
    pixFmt: asString(video['pix_fmt']) ?? '',
    rFrameRate: parseRational(video['r_frame_rate']),
    avgFrameRate: parseRational(video['avg_frame_rate']),
    nbFrames: asNumber(video['nb_frames']),
    codecName: asString(video['codec_name']) ?? '',
    codecTag: asString(video['codec_tag_string']) ?? '',
    colorRange: asString(video['color_range']),
    colorSpace: asString(video['color_space']),
    profileTag: tags ? asString(tags['profile']) : null
  }
}

/** ProRes 4444 带 alpha：fourcc 必须为 ap4h（XQ 为 ap4x），像素格式必须带 a。 */
export function isProres4444WithAlpha(v: VerifyResult): boolean {
  const fourccOk = v.codecTag === 'ap4h' || v.codecTag === 'ap4x'
  const alphaOk = v.pixFmt.startsWith('yuva')
  const proresOk = v.codecName === 'prores'
  return fourccOk && alphaOk && proresOk
}

/** 叠加输出必须是 8-bit 4:2:0（计划 C3 回归校验）。 */
export function isDeliveryYuv420p(v: VerifyResult): boolean {
  return v.pixFmt === 'yuv420p'
}

/** 帧率跟随参考视频是否成立（规格 §10 第 4 条）。 */
export function frameRateMatches(v: VerifyResult, fps: Fps): boolean {
  const target = fpsToArg(fps)
  const actual = v.rFrameRate ? `${v.rFrameRate.num}/${v.rFrameRate.den}` : ''
  if (actual === target) return true
  // 允许非既约分数表示（如 30000/1001 与 3000000/100100）
  const a = v.rFrameRate ? v.rFrameRate.num / v.rFrameRate.den : 0
  const b = fps.num / fps.den
  return Number.isFinite(a) && a > 0 && Math.abs(a - b) < 1e-6
}
