import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildFreezeFrameArgs } from '../shared/ffmpegArgs'
import type { FreezeFrameRequest, FreezeFrameResult } from '../shared/types'
import { runToEnd } from './ffrun'
import { log } from './log'
import { resolveFfmpegBinaries, userFreezePath } from './paths'

/**
 * M5 冻结帧抽帧（主进程）。
 *
 * 与缩略图（`thumbProtocol.generateThumbnail`）同一套纪律：
 * - 只做异步 I/O，禁止同步访问（规格 §11：FFmpeg 仅异步 spawn）；
 * - 源文件不在 / FFmpeg 缺失 / 抽帧报错一律返回 `path: null`，由渲染层提示，
 *   不抛出异常打断「插入冻结帧」这个用户动作；
 * - 产物落在 `userData/freezes/<素材>-<毫秒>.png`（运行时派生文件，不进工程 JSON，
 *   工程只引用该 PNG 路径，作为一个普通 image 素材）。
 *
 * 与缩略图的关键区别：这里要的是「与时间轴对齐的那一帧」，必须先解码再 seek，
 * 因此 `-ss` 在 `-i` 之后（见 `buildFreezeFrameArgs`），且不做任何缩放。
 */

const EMPTY: FreezeFrameResult = { path: null, width: 0, height: 0 }

function isFreezeRequest(value: unknown): value is FreezeFrameRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['path'] === 'string' &&
    record['path'].length > 0 &&
    typeof record['key'] === 'string' &&
    typeof record['atSec'] === 'number' &&
    Number.isFinite(record['atSec'])
  )
}

/** 抽一帧落盘；失败返回 `{ path: null }`（调用方负责提示，不在此抛错）。 */
export async function extractFreezeFrame(request: unknown): Promise<FreezeFrameResult> {
  if (!isFreezeRequest(request)) return EMPTY
  const atSec = Math.max(0, request.atSec)
  try {
    const stat = await fs.stat(request.path)
    if (!stat.isFile() || stat.size === 0) return EMPTY
  } catch {
    return EMPTY
  }

  const binaries = await resolveFfmpegBinaries()
  if (!binaries.available) {
    await log('warn', '冻结帧抽帧跳过：FFmpeg 不可用')
    return EMPTY
  }

  const file = userFreezePath(request.key, atSec)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const args = buildFreezeFrameArgs(request.path, file, atSec)
    const result = await runToEnd(binaries.ffmpeg, args, `freeze-${request.key}`, '冻结帧抽帧')
    if (result.code !== 0) {
      await log('warn', `冻结帧抽帧失败（${path.basename(request.path)}）：退出码 ${result.code} ${result.stderr.slice(0, 200)}`)
      return EMPTY
    }
    const written = await fs.stat(file).catch(() => null)
    if (!written || !written.isFile() || written.size === 0) return EMPTY
  } catch (error) {
    await log('warn', `冻结帧抽帧异常（${path.basename(request.path)}）：${String(error)}`)
    return EMPTY
  }

  return {
    path: file,
    width: typeof request.width === 'number' ? request.width : 0,
    height: typeof request.height === 'number' ? request.height : 0
  }
}

/** 素材移出池时回收它抽过的全部冻结帧（按 key 前缀整批删）。 */
export async function removeFreezeFrames(key: string): Promise<void> {
  const safe = key.replace(/[^\w-]/g, '_').slice(0, 64)
  if (!safe) return
  const dir = path.dirname(userFreezePath(key, 0))
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(`${safe}-`) && name.endsWith('.png'))
      .map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => undefined))
  )
}
