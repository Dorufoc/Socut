import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * M8：RNNoise 神经网络降噪模型（FFmpeg `arnndn` 的 `m=` 参数）的定位与校验。
 *
 * 与 whisper 同一套离线纪律：模型不进仓库（`resources/models/rnnoise/` 已 gitignore），
 * 由 `npm run fetch:rnnoise` 取回或用户自备；**缺失时导出前直接报错**，
 * 不静默退化成 `afftdn`（否则用户选的是 AI 降噪、听到的却是频域降噪）。
 *
 * 真机结论（FFmpeg 9 / Windows）：`arnndn=m=` 的路径必须写成 `m='D\:/a/b.rnnn'`
 * （引号 + 反斜杠转义冒号），格式化在 `shared/audioQuality.filterPathArg`。
 */

export interface RnnoiseDirs {
  /** 随包模型目录：<resources>/models/rnnoise */
  bundledDir: string
  /** 用户自备模型目录：<userData>/models/rnnoise */
  userDir: string
  env?: NodeJS.ProcessEnv
}

export interface RnnoiseModelInfo {
  /** 找到的模型绝对路径；null = 没有 */
  path: string | null
  /** 检查过的候选路径（错误提示用） */
  candidates: string[]
}

const MODEL_EXT = '.rnnn'

/** 候选模型文件：env → 用户目录 → 随包目录（目录内按文件名排序，取第一个）。 */
export async function rnnoiseModelCandidates(dirs: RnnoiseDirs): Promise<string[]> {
  const candidates: string[] = []
  const add = (file: string | undefined): void => {
    if (file && file.length > 0 && !candidates.includes(file)) candidates.push(file)
  }
  add(dirs.env?.SOCUT_RNNOISE_MODEL)
  for (const dir of [dirs.userDir, dirs.bundledDir]) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries.filter((name) => name.toLowerCase().endsWith(MODEL_EXT)).sort()) {
      add(path.join(dir, entry))
    }
  }
  return candidates
}

/** 解析可用的 RNNoise 模型路径（第一个真实存在的文件）。 */
export async function resolveRnnoiseModel(dirs: RnnoiseDirs): Promise<RnnoiseModelInfo> {
  const candidates = await rnnoiseModelCandidates(dirs)
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile() && stat.size > 0) return { path: candidate, candidates }
    } catch {
      // 不存在 = 继续看下一个
    }
  }
  return { path: null, candidates }
}

/** 需要 AI 降噪的片段（媒体段原声或音频轨片段任一开启 `denoise = 'ai'`）。 */
export function needsAiDenoise(input: {
  segments?: readonly { audio?: { denoise?: string } }[]
  audioClips?: readonly { audio?: { denoise?: string } }[]
}): boolean {
  const usesAi = (clip: { audio?: { denoise?: string } }): boolean => clip.audio?.denoise === 'ai'
  return (input.segments ?? []).some(usesAi) || (input.audioClips ?? []).some(usesAi)
}

/** 缺模型时的错误文案（main 侧与测试共用，避免两处口径漂移）。 */
export const RNNOISE_MISSING_MESSAGE =
  '缺少 RNNoise 模型（arnndn）：请运行 npm run fetch:rnnoise 取回 std.rnnn，' +
  '或把 .rnnn 放到 userData/models/rnnoise/ 后用 SOCUT_RNNOISE_MODEL 指定'

/**
 * 合成前校验：有片段要 AI 降噪但没有模型 → 直接抛错（不静默退化）。
 * 错误信息里带可执行修复命令，导出面板原样展示。
 */
export function assertAiDenoiseModel(
  input: {
    segments?: readonly { audio?: { denoise?: string } }[]
    audioClips?: readonly { audio?: { denoise?: string } }[]
  },
  modelPath: string | undefined
): void {
  if (modelPath && modelPath.length > 0) return
  if (needsAiDenoise(input)) throw new Error(RNNOISE_MISSING_MESSAGE)
}
