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

/** v7：音频提取白名单（<audio> 与 WebAudio 都要能读，否则波形/试听不可用） */
const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus'
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
  ...AUDIO_MIME_BY_EXTENSION,
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
 * 文件版本标识：size + 秒级取整的 mtime，既稳定又能放进 URL。
 * 用秒级而不是毫秒，是为了和 HTTP 的 Last-Modified（精确到秒）对齐，
 * 避免同一文件在 URL 里出现两个「版本」而让 ETag/304 判断互相矛盾。
 */
export function previewFileVersion(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}-${Math.floor(stat.mtimeMs)}`
}

/**
 * 版本化协议地址。`v` 只用于区分缓存对象（文件被替换后 URL 就变），
 * 不参与鉴权；能不能读仍只看主进程的 allowlist。
 */
export function previewUrlFor(filePath: string, version: string): string {
  return `focusnews-media://preview/?path=${encodeURIComponent(path.resolve(filePath))}&v=${encodeURIComponent(version)}`
}

/**
 * 可缓存读取的响应头（Content-Type 由调用方按扩展名补）。
 * URL 自带版本 + immutable，Chromium 才能把解析后的媒体缓冲留下来，
 * 循环重播 / 切点切换时直接复用，不再重新读盘和重新缓冲。
 */
export function previewResponseHeaders(input: {
  size: number
  mtimeMs: number
  version: string
}): Record<string, string> {
  return {
    'Accept-Ranges': 'bytes',
    ETag: `"${input.version}"`,
    'Last-Modified': new Date(input.mtimeMs).toUTCString(),
    'Cache-Control': 'private, max-age=31536000, immutable'
  }
}

/**
 * 条件请求是否可回 304（命中缓存）。只做「新鲜度」判断，不负责读文件。
 * If-None-Match 优先；没带时再看 If-Modified-Since（按秒比较且允许相等）。
 * 日期解析失败一律当不匹配——服务端不能因为一个坏头就抛错。
 */
export function isPreviewNotModified(input: {
  ifNoneMatch: string | null
  ifModifiedSince: string | null
  version: string
  mtimeMs: number
}): boolean {
  const ifNoneMatch = input.ifNoneMatch?.trim()
  if (ifNoneMatch) {
    const etag = `"${input.version}"`
    // 兼容多值列表与 `*`：Chromium 偶尔会把多个 ETag 逗号拼接再发回来
    for (const candidate of ifNoneMatch.split(',')) {
      const value = candidate.trim()
      if (value === '*' || value === etag) return true
    }
  }

  const ifModifiedSince = input.ifModifiedSince?.trim()
  if (ifModifiedSince) {
    const since = Date.parse(ifModifiedSince)
    if (!Number.isNaN(since) && Math.floor(input.mtimeMs / 1000) <= Math.floor(since / 1000)) return true
  }
  return false
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
