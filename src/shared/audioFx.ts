import type { VoiceChangeKind, VoiceEnhanceLevel } from './types'

/**
 * M8：音频 AI/音色处理（纯函数，只产出 FFmpeg 滤镜串）。
 *
 * 三组能力：
 * 1. **人声增强**（voiceEnhance）：高通去低频轰鸣 + 3kHz 存在感提升 + 轻度压缩，
 *    按档位加强；对话素材拉开人声与背景的差距，不改变时长。
 * 2. **变声**（voiceChange）：花栗鼠 / 低沉用 **rubberband** 改音高并保持时长
 *    （asetrate+atempo 的组合会有 0.5% 级的时长漂移，rubberband 精确 1:1）；
 *    机器人用 vibrato+tremolo；电话音用带通 + 压缩。
 * 3. **降噪**沿用 `audioQuality.denoiseFilter`（afftdn），顺序在增强之前。
 *
 * 全部导出侧生效（与既有降噪同一口径：预览不做频谱处理，面板 hover 有说明）。
 * 依赖的滤镜随包 FFmpeg（gyan essentials 9.0.2）已包含：highpass / equalizer / acompressor /
 * speechnorm / rubberband / vibrato / tremolo / lowpass / volume。
 */

export const VOICE_ENHANCE_LEVELS: readonly VoiceEnhanceLevel[] = ['light', 'standard', 'strong']
export const VOICE_CHANGE_KINDS: readonly VoiceChangeKind[] = ['chipmunk', 'robot', 'phone', 'deep']

export function isVoiceEnhanceLevel(value: unknown): value is VoiceEnhanceLevel {
  return typeof value === 'string' && (VOICE_ENHANCE_LEVELS as readonly string[]).includes(value)
}

export function isVoiceChangeKind(value: unknown): value is VoiceChangeKind {
  return typeof value === 'string' && (VOICE_CHANGE_KINDS as readonly string[]).includes(value)
}

/**
 * 人声增强 → 滤镜串。数值口径：
 * - 高通 80/100/120Hz：去掉空调声、桌面震动、呼吸低频；
 * - 2.5–3.2kHz +2.5~3.5dB：中文齿音/辅音的清晰度区间（不做 8kHz 大提升，避免齿音刺耳）；
 * - acompressor：把口播的动态压平（阈值 0.08/0.05、比 2.5/3），后续响度标准化更好做。
 */
export function voiceEnhanceFilters(level: VoiceEnhanceLevel | undefined): string[] {
  if (level === undefined) return []
  if (level === 'light') {
    return ['highpass=f=80', 'equalizer=f=3200:t=q:w=1:g=2.5']
  }
  if (level === 'standard') {
    return [
      'highpass=f=100',
      'equalizer=f=2500:t=q:w=1:g=3',
      'acompressor=threshold=0.08:ratio=2.5:attack=5:release=120'
    ]
  }
  return [
    'highpass=f=120',
    'equalizer=f=2500:t=q:w=1:g=3.5',
    'equalizer=f=7000:t=q:w=1:g=2',
    'acompressor=threshold=0.05:ratio=3:attack=4:release=100',
    'speechnorm=p=0.9:e=2'
  ]
}

/**
 * 变声 → 滤镜串（**时长 1:1**，不会破坏片段与视频的对齐）。
 *
 * - chipmunk：rubberband 音高 ×1.3（尖）；
 * - deep：rubberband 音高 ×0.8（闷/低沉）；
 * - robot：vibrato（频率抖动）+ tremolo（幅度抖动），保留原音高但金属感；
 * - phone：300–3400Hz 带通 + 压缩 + 轻微衰减，模拟电话听筒。
 */
export function voiceChangeFilters(kind: VoiceChangeKind | undefined): string[] {
  if (kind === undefined) return []
  if (kind === 'chipmunk') return ['rubberband=pitch=1.3']
  if (kind === 'deep') return ['rubberband=pitch=0.8']
  if (kind === 'robot') return ['vibrato=f=10:d=0.8', 'tremolo=f=25:d=0.9']
  return ['highpass=f=300', 'lowpass=f=3400', 'acompressor=threshold=0.08:ratio=4:attack=2:release=30', 'volume=0.9']
}
