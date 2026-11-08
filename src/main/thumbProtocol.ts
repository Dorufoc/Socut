import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { buildThumbnailArgs } from '../shared/ffmpegArgs'
import { runToEnd } from './ffrun'
import { resolveFfmpegBinaries, userThumbPath } from './paths'
import { log } from './log'

/**
 * 素材卡片缩略图（v2 素材库）。
 *
 * 协议：socut-thumb://<mediaId> —— host 就是素材 id，渲染进程拿到的地址
 * 只有经主进程抽帧成功并登记过的素材才可读（同 socut-media 的最小暴露纪律）。
 *
 * 落盘：userData/thumbs/<mediaId>.jpg，由 MediaItem.thumbnailUrl 持久化引用；
 * 跨机器打开工程时文件不存在，渲染侧会重新生成（阶段 8 完整性看护负责清理失效引用）。
 */

export const THUMB_SCHEME = 'socut-thumb'
/** 素材卡片的显示宽度（目标分辨率无关，纯 UI 尺寸）。 */
export const THUMB_WIDTH_PX = 320

/** 已放行的 mediaId → jpg 绝对路径。 */
const registry = new Map<string, string>()

/** 必须在 app ready 之前调用：与预览协议同样的「标准 + 安全」权限，图片不需要 Range。 */
export function registerThumbScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: THUMB_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

/** 登记已存在的缩略图文件并返回协议地址（不校验文件，登记入口见 generateThumbnail）。 */
export function thumbUrlFor(mediaId: string): string | null {
  const file = registry.get(mediaId)
  if (!file) return null
  return `${THUMB_SCHEME}://${encodeURIComponent(mediaId)}`
}

/** 渲染侧凭 MediaItem.thumbnailUrl 直接加载；主进程重启后按持久化路径重新登记。 */
export async function ensureThumbRegistered(mediaId: string, url: string): Promise<string | null> {
  if (!mediaId) return null
  // url 必须与 mediaId 一致，避免拿着别人的地址换登记
  if (url !== `${THUMB_SCHEME}://${encodeURIComponent(mediaId)}`) return null
  if (registry.has(mediaId)) return thumbUrlFor(mediaId)
  const file = userThumbPath(mediaId)
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size === 0) return null
  } catch {
    return null
  }
  registry.set(mediaId, file)
  return `${THUMB_SCHEME}://${encodeURIComponent(mediaId)}`
}

/**
 * 用 ffmpeg 抽一帧 jpg。成功返回协议地址；FFmpeg 缺失、源文件不在、
 * 抽帧失败一律返回 null（素材库显示占位符，不打断导入流程）。
 */
export async function generateThumbnail(mediaId: string, videoPath: string, atSec = 1): Promise<string | null> {
  if (!mediaId || typeof videoPath !== 'string' || videoPath.length === 0) return null
  try {
    const stat = await fs.stat(videoPath)
    if (!stat.isFile() || stat.size === 0) return null
  } catch {
    return null
  }
  const binaries = await resolveFfmpegBinaries()
  if (!binaries.available) return null
  const file = userThumbPath(mediaId)
  const args = buildThumbnailArgs(videoPath, file, atSec, THUMB_WIDTH_PX)
  try {
    const result = await runToEnd(binaries.ffmpeg, args, `thumb-${mediaId}`, '缩略图抽帧')
    if (result.code !== 0) {
      await log('warn', `缩略图抽帧失败（${path.basename(videoPath)}）：退出码 ${result.code} ${result.stderr.slice(0, 200)}`)
      return null
    }
    const written = await fs.stat(file).catch(() => null)
    if (!written || !written.isFile() || written.size === 0) return null
  } catch (error) {
    await log('warn', `缩略图抽帧异常（${path.basename(videoPath)}）：${String(error)}`)
    return null
  }
  registry.set(mediaId, file)
  return `${THUMB_SCHEME}://${encodeURIComponent(mediaId)}`
}

/** 素材移除时回收缩略图文件与登记，避免 userData/thumbs 无限增长。 */
export async function removeThumbnail(mediaId: string): Promise<void> {
  registry.delete(mediaId)
  await fs.rm(userThumbPath(mediaId), { force: true }).catch(() => undefined)
}

/** app ready 之后调用：按 mediaId 读出已登记的 jpg。 */
export function installThumbProtocol(): void {
  protocol.handle(THUMB_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }
    let mediaId: string
    try {
      mediaId = decodeURIComponent(new URL(request.url).host || '')
    } catch {
      return new Response(null, { status: 400 })
    }
    const file = registry.get(mediaId)
    if (!file) return new Response(null, { status: 403 })
    let stat: { size: number }
    try {
      stat = await fs.stat(file)
    } catch {
      return new Response(null, { status: 404 })
    }
    if (stat.size === 0) return new Response(null, { status: 404 })
    const headers: Record<string, string> = {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store'
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, { status: 200, headers })
  })
}
