import { denoiseFilter } from './audioQuality'
import type { AudioDenoiseLevel, ClipAudio, ClipSpeed } from './types'

/**
 * 片段音频参数与变速的纯口径（v9，主/渲染/测试共用）。
 *
 * 沿用 `mediaClipVideo` / `mediaStab` 的四条纪律：
 * 1. **默认值 = 不生效**：100% / 0 / 0 / 1.0x / 保持音高；全部默认时整键不写进工程，
 *    旧工程 JSON 与旧 argv 逐字节不变。
 * 2. **一套语义三处消费**：面板滑杆、预览（`playbackRate` + 增益包络 + 频谱条形状）、
 *    导出（`atempo` / `asetrate` / `volume` / `afade` / `setpts`）都读这里的函数，
 *    单位换算只允许写在本文件。
 * 3. **脏值全部可夹心**：任何工程值都能夹回合法区间，不会有 NaN 进滤镜串。
 * 4. **变速不动源窗口**：源入出点表示「这一段要读的源内容」，倍速只改变它在
 *    时间轴上占多长（见下面的换算函数），所以画面几何/调色/防抖的语义完全不受影响。
 */

export const CLIP_AUDIO_RANGE = {
  /** 音量百分比：0..200（100 = 原始增益） */
  volume: { min: 0, max: 200 },
  /** 渐入 / 渐出时长（秒） */
  fade: { min: 0, max: 5 }
} as const

export const CLIP_SPEED_RANGE = { min: 0.25, max: 4 } as const

/** 面板步长：音量 1%、时间 0.1s、倍速 0.05x（0.05 能整除到 0.25 与 4.0 两端）。 */
export const CLIP_AUDIO_STEP = { volume: 1, fade: 0.1, speed: 0.05 } as const

/**
 * 变速不保持音高时的基准采样率。
 * 先 `aresample` 到它、再 `asetrate=基准×倍速`、最后回到基准，
 * 于是「音高变化倍数 = 倍速」与源文件本身的采样率无关（不写表达式，避免解析差异）。
 */
export const PITCH_SHIFT_BASE_RATE = 48000

/** `atempo` 单个实例的安全区间（旧版 FFmpeg 只接受 0.5..2，超出的倍速串接多个实例）。 */
const ATEMPO_LIMITS = { min: 0.5, max: 2 }

export function defaultClipAudio(): ClipAudio {
  return { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 }
}

export function defaultClipSpeed(): ClipSpeed {
  return { speed: 1, maintainPitch: true }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 滤镜串里的数值：去掉尾零，`1.5` 就写 `1.5`（FFmpeg 两种都吃，短的更好读更好测）。 */
function rate(value: number): string {
  return String(round3(value))
}

function isDenoiseLevel(value: unknown): value is AudioDenoiseLevel {
  return value === 'light' || value === 'standard' || value === 'strong'
}

/** 任意 JSON → 合法音频参数；**全部默认时返回 undefined**（调用方据此整键删除）。 */
export function normalizeClipAudio(raw: unknown): ClipAudio | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const denoise = isDenoiseLevel(record['denoise']) ? record['denoise'] : undefined
  const next: ClipAudio = {
    volumePercent: round2(clamp(num(record['volumePercent'], 100), CLIP_AUDIO_RANGE.volume.min, CLIP_AUDIO_RANGE.volume.max)),
    fadeInSec: round2(clamp(num(record['fadeInSec'], 0), CLIP_AUDIO_RANGE.fade.min, CLIP_AUDIO_RANGE.fade.max)),
    fadeOutSec: round2(clamp(num(record['fadeOutSec'], 0), CLIP_AUDIO_RANGE.fade.min, CLIP_AUDIO_RANGE.fade.max)),
    // v10：降噪只在非关闭档位落盘；缺省不写进工程
    ...(denoise ? { denoise } : {})
  }
  return isDefaultClipAudio(next) ? undefined : next
}

/** 任意 JSON → 合法变速；**等于默认（1x + 保持音高）时返回 undefined**。 */
export function normalizeClipSpeed(raw: unknown): ClipSpeed | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const next: ClipSpeed = {
    speed: round2(clamp(num(record['speed'], 1), CLIP_SPEED_RANGE.min, CLIP_SPEED_RANGE.max)),
    maintainPitch: record['maintainPitch'] !== false
  }
  return isDefaultClipSpeed(next) ? undefined : next
}

export function isDefaultClipAudio(audio: ClipAudio | undefined): boolean {
  if (!audio) return true
  return (
    Math.abs(audio.volumePercent - 100) < 1e-6 &&
    Math.abs(audio.fadeInSec) < 1e-6 &&
    Math.abs(audio.fadeOutSec) < 1e-6 &&
    // v10：降噪非默认时整键必须落盘
    audio.denoise === undefined
  )
}

export function isDefaultClipSpeed(speed: ClipSpeed | undefined): boolean {
  if (!speed) return true
  return Math.abs(speed.speed - 1) < 1e-6 && speed.maintainPitch === true
}

/** 片段上的音频参数（缺省字段补齐，供 UI 与滤镜串消费）。 */
export function clipAudioOf(audio: ClipAudio | undefined): ClipAudio {
  if (!audio) return defaultClipAudio()
  return {
    volumePercent: round2(clamp(num(audio.volumePercent, 100), CLIP_AUDIO_RANGE.volume.min, CLIP_AUDIO_RANGE.volume.max)),
    fadeInSec: round2(clamp(num(audio.fadeInSec, 0), CLIP_AUDIO_RANGE.fade.min, CLIP_AUDIO_RANGE.fade.max)),
    fadeOutSec: round2(clamp(num(audio.fadeOutSec, 0), CLIP_AUDIO_RANGE.fade.min, CLIP_AUDIO_RANGE.fade.max)),
    ...(isDenoiseLevel(audio.denoise) ? { denoise: audio.denoise } : {})
  }
}

export function clipSpeedOf(speed: ClipSpeed | undefined): ClipSpeed {
  if (!speed) return defaultClipSpeed()
  return {
    speed: round2(clamp(num(speed.speed, 1), CLIP_SPEED_RANGE.min, CLIP_SPEED_RANGE.max)),
    maintainPitch: speed.maintainPitch !== false
  }
}

// ------------------------------------------------------------------ 时间换算

/** 倍速（只有一个数值的入口，脏值直接夹回 0.25..4）。 */
export function speedValueOf(speed: ClipSpeed | undefined): number {
  return clipSpeedOf(speed).speed
}

/** 时间轴上的秒 → 源上被读走的秒（1x 时两者相等，与旧工程完全一致）。 */
export function sourceSecForTimelineSec(speed: number, timelineSec: number): number {
  const s = clipSpeedOf({ speed, maintainPitch: true }).speed
  return Math.max(0, timelineSec) * s
}

/** 源上的秒 → 它在时间轴上占据的秒。 */
export function timelineSecForSourceSec(speed: number, sourceSec: number): number {
  const s = clipSpeedOf({ speed, maintainPitch: true }).speed
  return Math.max(0, sourceSec) / s
}

/** 片段在时间轴上的长度（= 变速后的输出时长）。 */
export function clipTimelineDurationSec(clip: { timelineStartSec: number; timelineEndSec: number }): number {
  return Math.max(0, clip.timelineEndSec - clip.timelineStartSec)
}

/** 片段读走的源窗口长度。 */
export function clipSourceDurationSec(clip: { sourceInSec: number; sourceOutSec: number }): number {
  return Math.max(0, clip.sourceOutSec - clip.sourceInSec)
}

/** 时间轴某一刻对应的源坐标（预览 seek 与导出 trim 共用）。 */
export function sourceTimeAt(
  clip: { timelineStartSec: number; sourceInSec: number; speed?: ClipSpeed },
  atSec: number
): number {
  return clip.sourceInSec + sourceSecForTimelineSec(speedValueOf(clip.speed), Math.max(0, atSec - clip.timelineStartSec))
}

// ------------------------------------------------------------------ 导出滤镜链

/**
 * 倍速 → 一串 `atempo`（保持音高）。
 *
 * 单个 `atempo` 在旧版 FFmpeg 只接受 0.5..2，所以 4x 拆成两个 2、0.25x 拆成两个 0.5；
 * 1x 返回空串（不挂滤镜，argv 与不变速时逐字节一致）。
 */
export function atempoFilters(speed: number): string[] {
  const target = clipSpeedOf({ speed, maintainPitch: true }).speed
  if (Math.abs(target - 1) < 1e-6) return []
  const chain: string[] = []
  let rest = target
  while (rest > ATEMPO_LIMITS.max + 1e-9) {
    chain.push(`atempo=${ATEMPO_LIMITS.max}`)
    rest /= ATEMPO_LIMITS.max
  }
  while (rest < ATEMPO_LIMITS.min - 1e-9) {
    chain.push(`atempo=${ATEMPO_LIMITS.min}`)
    rest /= ATEMPO_LIMITS.min
  }
  if (Math.abs(rest - 1) > 1e-6) chain.push(`atempo=${rate(rest)}`)
  return chain
}

/**
 * 倍速 → 改变音高的滤镜链（`asetrate` 连动音高）。
 *
 * 先归一到基准采样率，再用「基准 × 倍速」重解释采样率（时长缩为 1/倍速、音高升为倍速），
 * 最后回到基准采样率，保证下游 `concat` / `amix` 的采样率一致。
 */
export function pitchShiftFilters(speed: number): string[] {
  const target = clipSpeedOf({ speed, maintainPitch: false }).speed
  if (Math.abs(target - 1) < 1e-6) return []
  return [
    `aresample=${PITCH_SHIFT_BASE_RATE}`,
    `asetrate=${Math.round(PITCH_SHIFT_BASE_RATE * target)}`,
    `aresample=${PITCH_SHIFT_BASE_RATE}`
  ]
}

/** 倍速 → 音频变速滤镜（按「保持音高」开关二选一）。 */
export function tempoFilters(speed: ClipSpeed | undefined): string[] {
  const resolved = clipSpeedOf(speed)
  return resolved.maintainPitch ? atempoFilters(resolved.speed) : pitchShiftFilters(resolved.speed)
}

/** 音量 → `volume` 滤镜（100% 时返回 ''，不挂滤镜）。 */
export function volumeFilter(audio: ClipAudio | undefined): string {
  const resolved = clipAudioOf(audio)
  if (Math.abs(resolved.volumePercent - 100) < 1e-6) return ''
  return `volume=${rate(resolved.volumePercent / 100)}`
}

/**
 * 渐入渐出 → `afade` 滤镜（相对**本段输出的局部时间**，即变速之后的秒数）。
 *
 * 两个渐变各自不超过半个片段（重叠的淡入淡出会互相吃掉，用户拖过界只是想要「整段淡」，
 * 夹到半段是最不失真的解释）。
 */
export function fadeFilters(audio: ClipAudio | undefined, outputDurationSec: number): string[] {
  const resolved = clipAudioOf(audio)
  const length = Math.max(0, outputDurationSec)
  const ceiling = length / 2
  const out: string[] = []
  if (resolved.fadeInSec > 1e-6 && ceiling > 1e-6) {
    out.push(`afade=t=in:st=0:d=${rate(Math.min(resolved.fadeInSec, ceiling))}`)
  }
  if (resolved.fadeOutSec > 1e-6 && ceiling > 1e-6) {
    const d = Math.min(resolved.fadeOutSec, ceiling)
    out.push(`afade=t=out:st=${rate(Math.max(0, length - d))}:d=${rate(d)}`)
  }
  return out
}

/**
 * 一段音频（媒体段原声或音频段）在 `asetpts=PTS-STARTPTS` 之后要挂的滤镜串。
 *
 * 顺序固定：**降噪 → 变速 → 音量 → 渐入 → 渐出**
 * （降噪在变速前，频域降噪面对的是源采样率/原时长；变速在前，渐变的秒数才等于用户在
 * 时间轴上读到的秒数；音量与淡变次序不影响结果，但固定一个顺序才能让预览与导出对得上）。
 * 全部默认时返回 `''`，调用方拼接时不会多出逗号。
 */
export function clipAudioFilterChain(input: {
  audio?: ClipAudio
  speed?: ClipSpeed
  outputDurationSec: number
}): string {
  const denoise = denoiseFilter(input.audio?.denoise)
  const parts = [
    ...(denoise ? [denoise] : []),
    ...tempoFilters(input.speed),
    ...(() => {
      const volume = volumeFilter(input.audio)
      return volume ? [volume] : []
    })(),
    ...fadeFilters(input.audio, input.outputDurationSec)
  ]
  return parts.join(',')
}

/**
 * 变速后的画面时间戳滤镜（`''` = 不变速）。
 *
 * 挂在 `fps=<rate>` **之后**：`fps` 决定帧序列，`vidstabtransform` 的 .trf 按帧序号索引，
 * 两者必须在同一帧序列上，所以不能提前改 PTS。
 */
export function clipVideoSpeedFilter(speed: ClipSpeed | undefined): string {
  const resolved = clipSpeedOf(speed)
  if (Math.abs(resolved.speed - 1) < 1e-6) return ''
  return `setpts=(PTS-STARTPTS)/${rate(resolved.speed)}`
}

// ------------------------------------------------------------------ 预览侧

/** 增益包络：音量 × 线性淡入淡出（与 `afade` 同一形状，同一时间基准）。 */
export function previewGainAt(
  audio: ClipAudio | undefined,
  localSec: number,
  outputDurationSec: number
): number {
  const resolved = clipAudioOf(audio)
  const gain = resolved.volumePercent / 100
  const length = Math.max(0, outputDurationSec)
  const ceiling = length / 2
  const fadeIn = Math.min(resolved.fadeInSec, ceiling)
  const fadeOut = Math.min(resolved.fadeOutSec, ceiling)
  const at = clamp(localSec, 0, length)
  let envelope = 1
  if (fadeIn > 1e-6 && at < fadeIn) envelope = at / fadeIn
  if (fadeOut > 1e-6 && at > length - fadeOut) envelope = Math.min(envelope, Math.max(0, (length - at) / fadeOut))
  return round3(gain * envelope)
}

/** 片段自身的增益包络形状（频谱条要按它把柱子压出淡入淡出的斜角）。 */
export function fadeEnvelopeAt(audio: ClipAudio | undefined, fraction: number, outputDurationSec: number): number {
  const resolved = clipAudioOf(audio)
  const at = clamp(fraction, 0, 1) * Math.max(0, outputDurationSec)
  const length = Math.max(0, outputDurationSec)
  const ceiling = length / 2
  const fadeIn = Math.min(resolved.fadeInSec, ceiling)
  const fadeOut = Math.min(resolved.fadeOutSec, ceiling)
  if (fadeIn > 1e-6 && at < fadeIn) return at / fadeIn
  if (fadeOut > 1e-6 && at > length - fadeOut) return Math.max(0, (length - at) / fadeOut)
  return 1
}

/** 片段是否动过音频（驱动面板的「已编辑」标记）。 */
export function clipAudioEdited(audio: ClipAudio | undefined, speed: ClipSpeed | undefined): boolean {
  return !isDefaultClipAudio(audio) || !isDefaultClipSpeed(speed)
}

/** `HTMLMediaElement.playbackRate` 用值（脏值/缺省都回到 1）。 */
export function previewPlaybackRate(speed: ClipSpeed | undefined): number {
  const resolved = clipSpeedOf(speed)
  return Math.abs(resolved.speed - 1) < 1e-6 ? 1 : resolved.speed
}

/** `HTMLMediaElement.preservesPitch` 用值（true = 变速保持音高）。 */
export function previewPreservesPitch(speed: ClipSpeed | undefined): boolean {
  return clipSpeedOf(speed).maintainPitch
}
