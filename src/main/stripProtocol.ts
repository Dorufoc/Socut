import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { buildStripArgs } from '../shared/ffmpegArgs'
import {
  STRIP_CACHE_MAX_FILES,
  STRIP_FRAME_WIDTH_PX,
  STRIP_FRAMES_MAX,
  STRIP_FRAMES_MIN,
  stripCacheKey,
  stripFilePrefix,
  stripFileToken
} from '../shared/mediaStrip'
import type { MediaStripRequest, MediaStripResult } from '../shared/types'
import { runToEnd } from './ffrun'
import { resolveFfmpegBinaries, userStripPath, userStripsDir } from './paths'
import { log } from './log'

/**
 * 媒体片段的时间帧预览条（Thumbnail Strip，v5）。
 *
 * 分工与纪律：
 * - **主进程生成**：一次 FFmpeg 调用完成「均匀抽帧 + 横向 tile 拼接」，渲染层只拿到一张长图；
 *   逐格起进程会把导入与缩放卡成明显掉帧，所以绝不在渲染层做解码。
 * - **磁盘缓存**：`userData/strips/<mediaId>-<token>.jpg`，token = 素材 + 源区间 + 格数的哈希。
 *   同一 key 再请求直接命中缓存（不起子进程），命中与否在结果里回报给渲染层。
 * - **并发合并**：同一 token 的并发请求共享同一次生成（缩放时几十条卡片同时请求也只跑一次）。
 * - **协议最小暴露**：`focusnews-strip://<token>` 只读登记过的文件（与 thumb/media 同一口径），
 *   渲染进程无法借协议读任意本地文件。
 * - **失败即占位**：源文件不在、FFmpeg 缺失、抽帧报错一律返回 `url: null`，
 *   卡片显示「无法预览」，不打断时间轴任何交互。
 */

export const STRIP_SCHEME = 'focusnews-strip'

/** token → jpg 绝对路径。 */
const registry = new Map<string, string>()
/** 同一 token 的并发请求合并成一次生成。 */
const inflight = new Map<string, Promise<MediaStripResult>>()

/** 必须在 app ready 之前调用：标准 + 安全 + 可 fetch（<img> 需要）。 */
export function registerStripScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: STRIP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

function stripUrl(token: string): string {
  return `${STRIP_SCHEME}://${encodeURIComponent(token)}`
}

function failed(token: string, frames: number): MediaStripResult {
  return { url: null, frames, key: token, cached: false }
}

/** 请求参数校验 + 格数夹心（主进程不信任渲染层给的 frames）。 */
function normalizeRequest(request: MediaStripRequest): {
  mediaId: string
  path: string
  sourceInSec: number
  sourceOutSec: number
  frames: number
} | null {
  if (typeof request?.mediaId !== 'string' || request.mediaId.length === 0) return null
  if (typeof request.path !== 'string' || request.path.length === 0) return null
  const sourceInSec = Number(request.sourceInSec)
  const sourceOutSec = Number(request.sourceOutSec)
  if (!Number.isFinite(sourceInSec) || !Number.isFinite(sourceOutSec)) return null
  if (sourceInSec < 0 || sourceOutSec <= sourceInSec) return null
  const frames = Math.min(STRIP_FRAMES_MAX, Math.max(STRIP_FRAMES_MIN, Math.round(Number(request.frames) || 0)))
  return { mediaId: request.mediaId, path: request.path, sourceInSec, sourceOutSec, frames }
}

/** 磁盘上已有这张图（含主进程重启后 registry 为空的情况）→ 登记并复用。 */
async function reuseCached(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/**
 * 缓存淘汰：按 mtime 保留最新 STRIP_CACHE_MAX_FILES 个。
 * 不做淘汰的话，每改一次入出点都会多留一张图，userData 会无界增长。
 */
async function pruneCache(): Promise<void> {
  const dir = userStripsDir()
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  const files = names.filter((name) => name.endsWith('.jpg'))
  if (files.length <= STRIP_CACHE_MAX_FILES) return
  const stats = await Promise.all(
    files.map(async (name) => {
      const full = path.join(dir, name)
      const stat = await fs.stat(full).catch(() => null)
      return { full, name, mtimeMs: stat?.mtimeMs ?? 0 }
    })
  )
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const stale of stats.slice(STRIP_CACHE_MAX_FILES)) {
    await fs.rm(stale.full, { force: true }).catch(() => undefined)
    for (const [token, file] of [...registry]) {
      if (file === stale.full) registry.delete(token)
    }
  }
}

/**
 * 生成（或复用）一条预览条长图。
 * 返回 `url: null` 表示"这张条抽不出帧"，渲染层据此显示占位符而不是空黑洞。
 */
export async function generateStrip(request: MediaStripRequest): Promise<MediaStripResult> {
  const input = normalizeRequest(request)
  if (!input) return failed('invalid', STRIP_FRAMES_MIN)

  const key = stripCacheKey(input)
  const token = stripFileToken(key)
  const file = userStripPath(input.mediaId, token)

  // 1. 内存登记 → 磁盘缓存：命中就不起子进程
  if (registry.has(token) || (await reuseCached(file))) {
    if (!registry.has(token)) registry.set(token, file)
    return { url: stripUrl(token), frames: input.frames, key: token, cached: true }
  }

  // 2. 同一 token 正在生成：等那一次，不重复排队
  const pending = inflight.get(token)
  if (pending) return pending

  const task = runStrip(input, token, file)
  inflight.set(token, task)
  try {
    return await task
  } finally {
    inflight.delete(token)
  }
}

async function runStrip(
  input: NonNullable<ReturnType<typeof normalizeRequest>>,
  token: string,
  file: string
): Promise<MediaStripResult> {
  try {
    const stat = await fs.stat(input.path).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) return failed(token, input.frames)

    const binaries = await resolveFfmpegBinaries()
    if (!binaries.available) return failed(token, input.frames)

    await fs.mkdir(userStripsDir(), { recursive: true })
    const args = buildStripArgs({
      inputPath: input.path,
      outputPath: file,
      sourceInSec: input.sourceInSec,
      sourceOutSec: input.sourceOutSec,
      frames: input.frames,
      frameWidth: STRIP_FRAME_WIDTH_PX
    })
    const result = await runToEnd(binaries.ffmpeg, args, `strip-${token.slice(0, 12)}`, '时间帧预览条')
    if (result.code !== 0) {
      await log(
        'warn',
        `预览条抽帧失败（${path.basename(input.path)} ${input.sourceInSec.toFixed(2)}→${input.sourceOutSec.toFixed(2)}s）：` +
          `退出码 ${result.code} ${result.stderr.slice(0, 200)}`
      )
      await fs.rm(file, { force: true }).catch(() => undefined)
      return failed(token, input.frames)
    }
    const written = await fs.stat(file).catch(() => null)
    if (!written || !written.isFile() || written.size === 0) return failed(token, input.frames)

    registry.set(token, file)
    await pruneCache()
    return { url: stripUrl(token), frames: input.frames, key: token, cached: false }
  } catch (error) {
    await log('warn', `预览条生成异常（${path.basename(input.path)}）：${String(error)}`)
    return failed(token, input.frames)
  }
}

/**
 * 素材移出池时回收它的全部预览条（文件名前缀 = 安全化后的 mediaId）。
 * 与 removeThumbnail 同一纪律：不留孤儿文件。
 */
export async function removeStripsFor(mediaId: string): Promise<void> {
  const prefix = stripFilePrefix(mediaId)
  const dir = userStripsDir()
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jpg')) continue
    const full = path.join(dir, name)
    await fs.rm(full, { force: true }).catch(() => undefined)
    for (const [token, file] of [...registry]) {
      if (file === full) registry.delete(token)
    }
  }
}

/** app ready 之后调用：按 token 读出已登记的长图。 */
export function installStripProtocol(): void {
  protocol.handle(STRIP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }
    let token: string
    try {
      token = decodeURIComponent(new URL(request.url).host || '')
    } catch {
      return new Response(null, { status: 400 })
    }
    const file = registry.get(token)
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
      // 长图内容随入出点/格数变化，但每次生成都是新 token，所以可以允许浏览器复用
      'Cache-Control': 'max-age=86400, immutable'
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>
    return new Response(stream, { status: 200, headers })
  })
}
