import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { mimeTypeOf, normalizePreviewPath, parseByteRange, type ByteRange } from './mediaRange'

/**
 * 参考视频预览协议（focusnews-media://）。
 *
 * 用途：把本机视频以带 Range 支持的流交给渲染进程的 <video>，让预览里能看到
 * 「字幕条叠在参考视频上」的合成效果（此前预览只有棋盘格，看不出叠加结果）。
 * 水印图片也走这一条协议（<img> 不需要 Range，只需要同一套「登记过才可读」的纪律）。
 *
 * 安全边界：只有主进程显式登记过（video:previewUrl 校验文件存在 + 受支持的扩展名）的
 * 绝对路径可读；渲染进程无法借这个协议读取任意文件。
 */

export const MEDIA_SCHEME = 'focusnews-media'
const MEDIA_HOST = 'preview'

/** 已放行的绝对路径（由 video:previewUrl 登记）。 */
const allowlist = new Set<string>()

/**
 * 必须在 app ready 之前调用：把 scheme 标记为「标准 + 安全 + 可流式」，
 * 否则 <video> 既可能被当作不安全来源，也拿不到 Range 流式播放能力。
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** 校验文件存在并登记，返回可直接给 <video src> / <img src> 用的 URL。 */
export async function createPreviewUrl(candidate: string): Promise<string | null> {
  const resolved = normalizePreviewPath(candidate)
  if (!resolved) return null
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile() || stat.size === 0) return null
  } catch {
    return null
  }
  allowlist.add(resolved)
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/?path=${encodeURIComponent(resolved)}`
}

function bodyOf(filePath: string, range?: ByteRange): ReadableStream<Uint8Array> {
  const stream = range ? createReadStream(filePath, { start: range.start, end: range.end }) : createReadStream(filePath)
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
}

/** app ready 之后调用：注册流式响应（视频拖动进度条需要 206 + Content-Range）。 */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }

    let target: string
    try {
      target = path.resolve(new URL(request.url).searchParams.get('path') ?? '')
    } catch {
      return new Response(null, { status: 400 })
    }
    if (!allowlist.has(target)) return new Response(null, { status: 403 })

    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      return new Response(null, { status: 404 })
    }
    if (!stat.isFile() || stat.size === 0) return new Response(null, { status: 404 })

    const mime = mimeTypeOf(target) ?? 'application/octet-stream'
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }

    const range = parseByteRange(request.headers.get('Range'), stat.size)
    if (!range) {
      headers['Content-Length'] = String(stat.size)
      return new Response(request.method === 'HEAD' ? null : bodyOf(target), { status: 200, headers })
    }

    headers['Content-Length'] = String(range.end - range.start + 1)
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    return new Response(request.method === 'HEAD' ? null : bodyOf(target, range), { status: 206, headers })
  })
}
