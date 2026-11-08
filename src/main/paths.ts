import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'
import { TEMP_ROOT, USER_DATA_DIRS } from '../shared/constants'
import { RECENT_ENTRY_ID_PATTERN } from '../shared/recentProjects'

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

/** 启动页工程封面目录（userData/covers）。 */
export function userCoversDir(): string {
  return path.join(app.getPath('userData'), USER_DATA_DIRS.covers)
}

/**
 * 启动页封面路径（userData/covers/<entryId>.png）。
 * entryId 只接受最近工程索引里合法的两种形态（'autosave' 或 p+16 位十六进制），
 * 其余一律抛错——封面协议与写盘都只走这一条路径，不给目录穿越留口子。
 */
export function userCoverPath(entryId: string): string {
  if (!RECENT_ENTRY_ID_PATTERN.test(entryId)) {
    throw new Error(`非法封面 id：${entryId}`)
  }
  return path.join(userCoversDir(), `${entryId}.png`)
}

/** v2：素材卡片缩略图落盘路径（userData/thumbs/<mediaId>.jpg）。mediaId 只允许安全字符，防目录穿越。 */
export function userThumbPath(mediaId: string): string {
  const safe = mediaId.replace(/[^\w-]/g, '_').slice(0, 96) || 'thumb'
  return path.join(app.getPath('userData'), USER_DATA_DIRS.thumbs, `${safe}.jpg`)
}

/** v5：时间帧预览条缓存目录（userData/strips）。 */
export function userStripsDir(): string {
  return path.join(app.getPath('userData'), USER_DATA_DIRS.strips)
}

/** v8.1：防抖预览代理缓存目录（userData/stab-preview：代理 mp4 与 .trf 运动数据同放）。 */
export function userStabPreviewDir(): string {
  return path.join(app.getPath('userData'), USER_DATA_DIRS.stabPreview)
}

/** v10：4K / MXF 预览代理缓存目录（userData/proxies：整片 720p H.264）。 */
export function userProxyDir(): string {
  return path.join(app.getPath('userData'), USER_DATA_DIRS.proxies)
}

/**
 * v5：某次预览条请求的长图路径。
 * 文件名 = 安全化的 mediaId 前缀 + 缓存令牌：前者让「素材移出池」能按前缀回收它的全部预览条，
 * 后者保证同素材不同区间/不同格数互不覆盖。两段都只留安全字符，不接受外部拼路径。
 */
export function userStripPath(mediaId: string, token: string): string {
  const safe = mediaId.replace(/[^\w-]/g, '_').slice(0, 64) || 'media'
  const safeToken = token.replace(/[^\w-]/g, '').slice(0, 32) || 'strip'
  return path.join(userStripsDir(), `${safe}-${safeToken}.jpg`)
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
