import path from 'node:path'

/**
 * 预览协议的纯逻辑（不依赖 electron，便于单测）：
 * 扩展名白名单与 HTTP Range 解析。协议注册与文件流在 media.ts。
 */

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  // MXF（XDCAM / AVC-Intra / DNxHD）：ffprobe / ffmpeg 原生可读，导入与导出都可用；
  // Chromium 没有 MXF 解封装器，<video> 会走 onError → 预览显示「不可预览」而不是白屏。
  '.mxf': 'video/mxf'
}

/**
 * 图片扩展名：水印预览走同一条协议（主进程登记后 <img> 才可读），
 * 与视频共用白名单，避开再开一条 custom scheme。
 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

const PREVIEW_MIME_BY_EXTENSION: Record<string, string> = {
  ...VIDEO_MIME_BY_EXTENSION,
  ...IMAGE_MIME_BY_EXTENSION
}

export interface ByteRange {
  start: number
  end: number
}

/** 扩展名白名单（视频 + 图片）+ 绝对路径规范化；返回 null 表示不是可预览的文件。 */
export function normalizePreviewPath(candidate: string): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  const resolved = path.resolve(candidate)
  return path.extname(resolved).toLowerCase() in PREVIEW_MIME_BY_EXTENSION ? resolved : null
}

/** 扩展名 → Content-Type；未知扩展名交给调用方兜底。 */
export function mimeTypeOf(filePath: string): string | undefined {
  return PREVIEW_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()]
}

/**
 * 解析 `Range: bytes=...`，支持 `0-`、`0-1023`、`-512` 三种写法。
 * 返回 null 表示不是单段可满足的范围（调用方回退为整段 200 响应）。
 */
export function parseByteRange(header: string | null, size: number): ByteRange | null {
  if (!header || size <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart = '', rawEnd = ''] = match
  if (rawStart === '' && rawEnd === '') return null

  let start = rawStart === '' ? 0 : Number(rawStart)
  let end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null

  if (rawStart === '') {
    // bytes=-512：最后 512 字节
    start = Math.max(0, size - end)
    end = size - 1
  }
  if (start < 0 || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}
