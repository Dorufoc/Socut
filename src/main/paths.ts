import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'
import { TEMP_ROOT, USER_DATA_DIRS } from '../shared/constants'

/**
 * 路径解析（规格 §8：FFmpeg 二进制必须位于 asar 外部）。
 * - 打包后：extraResources 会把 resources/ffmpeg 与 resources/fonts 放到 process.resourcesPath 下；
 * - 开发时：直接指向仓库内 resources/，允许回退到 PATH 上的系统 FFmpeg（仅开发，且在 UI 明示）。
 */

export type BinarySource = 'bundled' | 'devSystem'

export interface FfmpegBinaries {
  ffmpeg: string
  ffprobe: string
  source: BinarySource
  available: boolean
  /** 缺失时给用户的说明 */
  hint?: string
}

const EXE = process.platform === 'win32' ? '.exe' : ''

/** asar 外的资源根（打包 → process.resourcesPath；开发 → 仓库 resources/）。 */
export function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
}

export function ffmpegDir(): string {
  return path.join(resourcesRoot(), 'ffmpeg')
}

export function builtinFontsDir(): string {
  return path.join(resourcesRoot(), 'fonts')
}

export function userFontsDir(): string {
  return path.join(app.getPath('userData'), USER_DATA_DIRS.fonts)
}

export function projectsDir(): string {
  return path.join(app.getPath('userData'), USER_DATA_DIRS.projects)
}

export function logsDir(): string {
  return path.join(app.getPath('userData'), USER_DATA_DIRS.logs)
}

/** 任务临时根目录（app.getPath('temp') 下，规格 §5.3 要求统一清理）。 */
export function tempRoot(): string {
  return path.join(app.getPath('temp'), TEMP_ROOT)
}

async function fileExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target)
    return stat.isFile()
  } catch {
    return false
  }
}

let cachedBinaries: FfmpegBinaries | null = null

/** 解析随包 FFmpeg/ffprobe；仅异步 I/O，禁止同步访问。 */
export async function resolveFfmpegBinaries(refresh = false): Promise<FfmpegBinaries> {
  if (cachedBinaries && !refresh) return cachedBinaries
  const dir = ffmpegDir()
  const ffmpeg = path.join(dir, `ffmpeg${EXE}`)
  const ffprobe = path.join(dir, `ffprobe${EXE}`)
  const [ok1, ok2] = await Promise.all([fileExists(ffmpeg), fileExists(ffprobe)])
  if (ok1 && ok2) {
    cachedBinaries = { ffmpeg, ffprobe, source: 'bundled', available: true }
    return cachedBinaries
  }
  if (!app.isPackaged) {
    // 开发环境允许使用系统 PATH 上的 FFmpeg，便于 M0 验证不阻塞
    cachedBinaries = {
      ffmpeg: `ffmpeg${EXE}`,
      ffprobe: `ffprobe${EXE}`,
      source: 'devSystem',
      available: true,
      hint: `随包 FFmpeg 未就位（${dir}），当前使用系统 PATH 的 FFmpeg。正式交付前请执行 npm run fetch:ffmpeg。`
    }
    return cachedBinaries
  }
  cachedBinaries = {
    ffmpeg,
    ffprobe,
    source: 'bundled',
    available: false,
    hint: `安装包内未找到 FFmpeg：${ffmpeg}`
  }
  return cachedBinaries
}

/** 供 UI 显示当前 FFmpeg 来源（开发用系统 FFmpeg 时必须明示）。 */
export function describeBinarySource(binaries: FfmpegBinaries): string {
  return binaries.source === 'bundled'
    ? `随包：${path.dirname(binaries.ffmpeg)}`
    : `系统 PATH（仅开发环境）：${binaries.ffmpeg}`
}

/** 输出基名：<工程名>-<出口>-<分辨率>-<帧率>（PNG 序列用它作目录名） */
export function buildOutputBaseName(input: {
  project: string
  kind: 'mov' | 'mp4' | 'png'
  width: number
  height: number
  fpsLabel: string
}): string {
  const safeProject = input.project.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40) || 'focusnews'
  return `${safeProject}-${input.kind}-${input.width}x${input.height}-${input.fpsLabel}`
}
