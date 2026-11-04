import path from 'node:path'

/**
 * 参考视频预览的纯逻辑（不依赖 electron，便于单测）：
 * 扩展名白名单与 HTTP Range 解析。协议注册与文件流在 media.ts。
 */

const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
}

export interface ByteRange {
  start: number
  end: number
}

/** 扩展名白名单 + 绝对路径规范化；返回 null 表示不是可预览的视频。 */
export function normalizePreviewPath(candidate: string): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null
  const resolved = path.resolve(candidate)
  return path.extname(resolved).toLowerCase() in VIDEO_MIME_BY_EXTENSION ? resolved : null
}

/** 扩展名 → Content-Type；未知扩展名交给调用方兜底。 */
export function mimeTypeOf(filePath: string): string | undefined {
  return VIDEO_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()]
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
