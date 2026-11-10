import { AUDIO_DENOISE_PROFILES, AUDIO_DUCKING_PROFILES, AUDIO_MASTERING_TARGETS } from './constants'
import type { AudioDenoiseLevel, AudioDuckingLevel, AudioMastering, AudioRole } from './types'

/**
 * v10 导出侧音频质量的三条纯口径（主进程 / 测试共用）：
 *
 * 1. 节点降噪：档位 → `afftdn` 的 `nr/nf`；
 * 2. BGM 自动压低：档位 → `sidechaincompress` 参数（attack/release 以毫秒计）；
 * 3. 成片响度：档位 → `loudnorm` 目标。
 *
 * 纪律与 `mediaClipAudio` 相同：**默认值（关闭 / undefined）返回空串或 null**，
 * 调用方拼接时不会多出逗号，也不会凭空注入滤镜。
 */

/**
 * 滤镜串里的文件路径写法（arnndn 的 `m=` 参数）。
 *
 * 真机实测（FFmpeg 9，Windows）：`m=D:\a\b.rnnn` 与 `m=D:/a/b.rnnn` 都解析失败
 * （"No option name near …"），必须 **引号 + 反斜杠转义冒号**：`m='D\:/a/b.rnnn'`。
 * 滤镜语法里 `:` 是选项分隔符、`\` 是转义符，所以在引号内也要转义冒号。
 */
export function filterPathArg(filePath: string): string {
  if (filePath.length === 0) return ''
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:')
}

/** `arnndn`（RNNoise 神经网络降噪）滤镜串；没有模型路径返回 ''。 */
export function arnndnFilter(modelPath: string | undefined): string {
  const escaped = modelPath ? filterPathArg(modelPath) : ''
  if (escaped.length === 0) return ''
  return `arnndn=m='${escaped}'`
}

export interface DenoiseFilterOptions {
  /** `denoise = 'ai'` 时必须给出（main 侧解析随包 `std.rnnn`）；缺省时 ai 档不产出滤镜 */
  arnndnModelPath?: string
}

/** 降噪档位 → 滤镜串；关闭/缺省返回 ''。`ai` 档走 `arnndn`，其余档走 `afftdn`。 */
export function denoiseFilter(level: AudioDenoiseLevel | undefined, options: DenoiseFilterOptions = {}): string {
  if (level === undefined) return ''
  if (level === 'ai') return arnndnFilter(options.arnndnModelPath)
  const profile = AUDIO_DENOISE_PROFILES[level]
  if (!profile) return ''
  return `afftdn=nr=${profile.nr}:nf=${profile.nf}`
}

/**
 * BGM 自动压低：BGM 总线（inputLabel）以口播总线（sidechainLabel）为 sidechain 做压缩。
 * 标签入参不带方括号，返回语句自带方括号。
 */
export function duckingFilter(
  level: AudioDuckingLevel,
  inputLabel: string,
  sidechainLabel: string,
  outputLabel: string
): string {
  const profile = AUDIO_DUCKING_PROFILES[level]
  if (!profile) return ''
  return (
    `[${inputLabel}][${sidechainLabel}]sidechaincompress` +
    `=threshold=${profile.threshold}:ratio=${profile.ratio}` +
    `:attack=${profile.attack}:release=${profile.release}:makeup=1` +
    `[${outputLabel}]`
  )
}

/** 响度标准化档位 → `loudnorm` 滤镜串；off/缺省返回 ''。 */
export function loudnormFilter(mastering: AudioMastering | undefined): string {
  if (mastering !== 'social' && mastering !== 'broadcast') return ''
  const target = AUDIO_MASTERING_TARGETS[mastering]
  return `loudnorm=I=${target.I}:TP=${target.TP}:LRA=${target.LRA}`
}

/** 界面读数用的档位名（纯函数，不依赖 i18n 的具体排版）。 */
export function audioMasteringLabel(mastering: AudioMastering | undefined): string {
  if (mastering === 'social') return '社交 -14 LUFS'
  if (mastering === 'broadcast') return '广播 -23 LUFS'
  return '关闭'
}

const DUCKING_RANK: Record<AudioDuckingLevel, number> = { light: 1, standard: 2, strong: 3 }

/**
 * 本次混音要用的 ducking 档位：取全部 `role = bgm` 且开启 ducking 的片段里**最强**的一档。
 * 没有此类片段时返回 undefined（调用方据此不生成压缩链）。
 */
export function duckingStrengthOf(
  clips: readonly { role?: AudioRole; ducking?: AudioDuckingLevel }[]
): AudioDuckingLevel | undefined {
  let strongest: AudioDuckingLevel | undefined
  for (const clip of clips) {
    if (clip.role !== 'bgm' || clip.ducking === undefined) continue
    if (strongest === undefined || DUCKING_RANK[clip.ducking] > DUCKING_RANK[strongest]) {
      strongest = clip.ducking
    }
  }
  return strongest
}
