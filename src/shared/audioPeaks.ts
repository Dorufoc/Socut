import { mediaKindOf } from './audioClips'
import { fadeEnvelopeAt, clipAudioOf } from './mediaClipAudio'
import type { ClipAudio, MediaItem } from './types'

/**
 * 频谱条（Audio Spectrum）的采样与映射口径（v9，主/渲染/测试共用）。
 *
 * 数据从哪来：主进程一次 FFmpeg 调用把片段源区间解成**单声道 PCM**（`-f s16le pipe:1`），
 * 渲染前在这里折算成等分桶的峰值。为什么不在浏览器里解码/分析：
 * - 卡片随时可能在**未播放**状态下显示，纯 WebAudio 拿不到整段的历史幅度；
 * - 时间轴上一屏可能有十几条卡片，逐条起 WebAudio 解码器会把预览拖垮；
 * - 与预览条同一纪律：派生数据只存输入（素材 + 源区间 + 桶数），不存结果，
 *   所以换素材 / 改入出点 / 改缩放都不会读到过期像素。
 *
 * 「动态」从哪来：桶高度 = 提取到的幅度 × 当前音量 × 淡入淡出包络，
 * 所以拖动音量/渐变滑杆时柱子会立刻跟着变；播放时卡片再叠一层实时电平（见
 * `renderer/src/audio/previewLevel`），那条只作用于**正在发声的片段**。
 */

/** 目标密度：每约 7 CSS 像素一根柱子（卡片很窄，太密就糊成一片色块）。 */
export const SPECTRUM_PX_PER_BAR = 7

/** 柱子数档位：取「不超过理想值的那一档」，所以拖宽卡片只有跨档才重新采样。 */
export const SPECTRUM_BUCKET_STEPS = [16, 24, 32, 48, 64, 80, 96] as const

export const SPECTRUM_BUCKETS_MIN = SPECTRUM_BUCKET_STEPS[0] as number
export const SPECTRUM_BUCKETS_MAX = SPECTRUM_BUCKET_STEPS[SPECTRUM_BUCKET_STEPS.length - 1] as number

/** PCM 取样率档位（升序）。选「够把每根柱子铺满 ≥2 个样本」的最低档，字节量最小。 */
export const SPECTRUM_SAMPLE_RATES = [2000, 4000, 8000, 11025, 16000, 22050, 32000, 48000] as const

export const SPECTRUM_SAMPLE_RATE_MIN = SPECTRUM_SAMPLE_RATES[0] as number
export const SPECTRUM_SAMPLE_RATE_MAX = SPECTRUM_SAMPLE_RATES[SPECTRUM_SAMPLE_RATES.length - 1] as number

/**
 * 一次取样允许读进内存的最大字节数（单声道 s16le）。
 * 超了就把取样率降一档；再超就拒发请求（宁可没有频谱，也不能把主进程撑爆）。
 */
export const SPECTRUM_MAX_BYTES = 6 * 1024 * 1024

/** 峰值归一化的下限（dBFS）：低于此值一律当作 0，避免底噪被拉成满格柱子。 */
export const SPECTRUM_FLOOR_DB = -60

/** s16le 的满刻度。 */
const FULL_SCALE = 32768

/** 频谱条请求的参与量（派生数据，不入工程）。 */
export interface SpectrumRequestInput {
  mediaId: string
  /** 取样的实际文件（VFR 转 CFR / 重新定位后会变） */
  path: string
  sourceInSec: number
  sourceOutSec: number
  buckets: number
}

/**
 * 该抽多少根柱子：由卡片像素宽决定密度，再夹到档位上下限。
 * 与预览条同一手法——走档位而不是逐像素，否则一次窗口缩放会连环重取样。
 */
export function spectrumBucketCount(widthPx: number): number {
  if (!(widthPx > 0)) return SPECTRUM_BUCKETS_MIN
  const raw = Math.floor(widthPx / SPECTRUM_PX_PER_BAR)
  let chosen = SPECTRUM_BUCKETS_MIN
  for (const step of SPECTRUM_BUCKET_STEPS) {
    if (step <= raw) chosen = step
  }
  return Math.min(SPECTRUM_BUCKETS_MAX, Math.max(SPECTRUM_BUCKETS_MIN, chosen))
}

/** 源窗口长度（秒）；脏值（出点早于入点）一律当 0。 */
export function spectrumSourceDurationSec(clip: { sourceInSec: number; sourceOutSec: number }): number {
  return Math.max(0, clip.sourceOutSec - clip.sourceInSec)
}

/**
 * 选取样率：先拿「能让每根柱子分到至少 2 个样本」的最低档（成本最小），
 * 再按字节上限往下降档；连最低档都装不下就返回 0（调用方不发请求）。
 *
 * 柱子是等分时间桶的峰值，不是示波器：2kHz 单声道足够描述包络，
 * 一分钟的片段只要 24 万样本（480KB），不会把主进程撑住。
 */
export function pickSpectrumSampleRate(durationSec: number, buckets: number): number {
  if (!(durationSec > 0) || !(buckets > 0)) return SPECTRUM_SAMPLE_RATE_MIN
  const wantedSamples = buckets * 2
  const ideal = SPECTRUM_SAMPLE_RATES.find((rate) => durationSec * rate >= wantedSamples) ?? SPECTRUM_SAMPLE_RATE_MAX
  if (durationSec * ideal * 2 <= SPECTRUM_MAX_BYTES) return ideal
  for (let i = SPECTRUM_SAMPLE_RATES.length - 1; i >= 0; i -= 1) {
    const rate = SPECTRUM_SAMPLE_RATES[i]!
    if (durationSec * rate * 2 <= SPECTRUM_MAX_BYTES) return rate
  }
  return 0
}

/** 渲染层内存缓存用的键（可读，便于排查「为什么这条没频谱」）。 */
export function spectrumCacheKey(input: SpectrumRequestInput): string {
  return `${input.mediaId}|${input.path}|${input.sourceInSec.toFixed(3)}|${input.sourceOutSec.toFixed(3)}|${input.buckets}`
}

/** 回收某枚素材的全部取样结果：键前缀就是 mediaId（内存缓存不需要文件名安全化）。 */
export function spectrumCachePrefix(mediaId: string): string {
  return `${mediaId}|`
}

/**
 * PCM（单声道 s16le 字节）→ 等分桶峰值（线性 0..1）。
 *
 * 桶边界按样本数等分，尾桶可能只有几个样本——这是**显示用**的幅度包络，
 * 不做统计意义上的能量归一。字节数为奇数时丢掉最后半个样本。
 */
export function peaksFromPcm(bytes: Uint8Array, buckets: number): number[] {
  const count = Math.max(1, Math.round(buckets))
  const out = new Array<number>(count).fill(0)
  const samples = Math.floor(bytes.byteLength / 2)
  if (samples <= 0) return out
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2)
  const perBucket = samples / count
  for (let bucket = 0; bucket < count; bucket += 1) {
    const from = Math.floor(bucket * perBucket)
    const to = Math.max(from + 1, Math.min(samples, Math.ceil((bucket + 1) * perBucket)))
    let peak = 0
    for (let i = from; i < to; i += 1) {
      const value = Math.abs(view.getInt16(i * 2, true))
      if (value > peak) peak = value
    }
    out[bucket] = peak / FULL_SCALE
  }
  return out
}

/**
 * 线性峰值 → 显示电平（0..1）。
 *
 * 用 dB 而不是线性：线性下 -20dB 的播报声只有 10% 高，柱子看着像空的；
 * 以 {@link SPECTRUM_FLOOR_DB} 为底折算后，正常语音能填满大半高度，
 * 底噪仍然落在 0 附近。
 */
export function normalizeSpectrumPeaks(peaks: number[]): number[] {
  return peaks.map((peak) => {
    if (!(peak > 0)) return 0
    const db = 20 * Math.log10(Math.min(1, peak))
    if (!Number.isFinite(db)) return 0
    return Math.min(1, Math.max(0, (db - SPECTRUM_FLOOR_DB) / (0 - SPECTRUM_FLOOR_DB)))
  })
}

/** PCM → 已归一化的频谱电平（主进程与测试都走这一个入口，避免两处口径分叉）。 */
export function spectrumPeaksFromPcm(bytes: Uint8Array, buckets: number): number[] {
  return normalizeSpectrumPeaks(peaksFromPcm(bytes, buckets))
}

/**
 * 电平 → 柱高：乘上「当前音量 × 淡入淡出包络」。
 *
 * 这一步让频谱条成为音频参数的**可视化反馈**：音量拉到 200% 时柱满格、
 * 拉到 0% 时整条平掉，渐入渐出直接看出斜边——与导出滤镜同源（`clipAudioOf`）。
 * 增益 >100% 时夹在满格（柱子已经没有更高的刻度了）。
 */
export function spectrumBarHeights(
  peaks: number[],
  audio: ClipAudio | undefined,
  outputDurationSec: number
): number[] {
  const resolved = clipAudioOf(audio)
  const gain = resolved.volumePercent / 100
  const length = Math.max(0, outputDurationSec)
  const total = Math.max(1, peaks.length)
  return peaks.map((peak, index) => {
    const envelope = fadeEnvelopeAt(audio, index / total, length)
    return Math.min(1, Math.max(0, peak * gain * envelope))
  })
}

/**
 * 这一段该不该画频谱条。
 *
 * 图像素材没有音轨（导出侧也是补静音），无音轨的视频同样不画——
 * 判据用探测到的 `audioCodec`，缺省（旧工程没探到）时不画，免得给一条静音空条。
 */
export function clipShowsSpectrum(item: MediaItem | null | undefined): boolean {
  if (!item) return false
  if (mediaKindOf(item) === 'image') return false
  const codec = item.meta.audioCodec
  return typeof codec === 'string' && codec.length > 0 && codec !== 'none'
}

export type SpectrumStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface SpectrumState {
  status: SpectrumStatus
  /** 归一化电平（0..1）；未就绪时为空数组 */
  peaks: number[]
  buckets: number
}

export const SPECTRUM_IDLE_STATE: SpectrumState = { status: 'idle', peaks: [], buckets: SPECTRUM_BUCKETS_MIN }
