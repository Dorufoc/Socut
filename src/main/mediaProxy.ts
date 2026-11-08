import path from 'node:path'
import fs from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import { buildProxyArgs } from '../shared/ffmpegArgs'
import { IMPORTABLE_VIDEO_EXTENSIONS } from '../shared/constants'
import {
  isProxyFileOf,
  proxyFileName,
  proxyJobId,
  proxySignature,
  proxyToken
} from '../shared/mediaProxy'
import type {
  JobErrorInfo,
  JobResult,
  MediaProxyRequest,
  MediaProxyResult,
  MediaProxyStatusResult
} from '../shared/types'
import { spawnJob, terminateJob } from './procRegistry'
import { ProgressParser } from './progressParser'
import { resolveFfmpegBinaries, userProxyDir } from './paths'
import { log } from './log'
import { emitProgress, emitResult, toProgress } from './export/jobs'
import type { JobState } from './export/jobs'
import { FFmpegExitError, waitForClose } from './export/transparentMov'

/**
 * v10：4K / MXF 预览代理的后台作业（与 stabPreview 同一套作业/进度/取消纪律）。
 *
 * 代理是**整片 720p H.264 转码**，时间轴与源 1:1：预览侧只需要把 `<video>` 的 src
 * 换成代理路径，源坐标换算不需要任何偏移。导出链从不读取代理。
 *
 * 缓存口径：文件名带签名令牌（源路径 + size/mtime + 代理规格）；源文件被替换或规格
 * 改动 → 令牌变化 → 旧代理自然失效（命中不了，也无需显式删除）。
 * jobId = `proxy-<mediaId>`（确定性）：同素材重复点击复用运行中的作业，进度面板只有一张卡。
 */

const registry = new Map<string, JobState>()

/** 代理是否可直接使用（存在且非空文件）。 */
async function usableFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

function isVideoPath(target: string): boolean {
  const ext = path.extname(target).replace(/^\./, '').toLowerCase()
  return (IMPORTABLE_VIDEO_EXTENSIONS as readonly string[]).includes(ext)
}

/** 图片/音频不需要代理；其余非视频素材一律拒绝（调用方应只对视频入口发起）。 */
function assertProxyable(request: MediaProxyRequest): void {
  if (typeof request.path !== 'string' || request.path.length === 0) {
    throw new Error('缺少素材路径，无法生成预览代理')
  }
  if (!isVideoPath(request.path)) {
    throw new Error(`预览代理只支持视频素材：${request.path}`)
  }
}

export async function applyMediaProxy(
  request: MediaProxyRequest,
  window: BrowserWindow | null
): Promise<MediaProxyResult> {
  assertProxyable(request)
  const jobId = proxyJobId(request.mediaId)

  let source
  try {
    source = await fs.stat(request.path)
  } catch {
    throw new Error(`源文件不存在或不可读：${request.path}`)
  }

  const signature = proxySignature({
    sourcePath: request.path,
    sourceBytes: source.size,
    sourceMtimeMs: source.mtimeMs
  })
  const token = proxyToken(signature, source.size, source.mtimeMs)
  const dir = userProxyDir()
  const videoPath = path.join(dir, proxyFileName(request.mediaId, token))

  // 1) 磁盘缓存命中：代理已就绪，不起任何进程。
  if (await usableFile(videoPath)) {
    return { status: 'cached', jobId, path: videoPath, signature }
  }
  // 2) 同素材作业已在跑：复用（重复点击不排第二份）。
  if (registry.has(jobId)) {
    return { status: 'queued', jobId, path: null, signature }
  }

  const binaries = await resolveFfmpegBinaries()
  if (!binaries.available) {
    throw new Error(`未找到可用的 FFmpeg：${binaries.ffmpeg}`)
  }

  const durationSec = Math.max(0, request.durationSec ?? 0)
  const state: JobState = {
    id: jobId,
    kind: 'overlayMp4',
    windowId: window?.id ?? -1,
    phase: 'queued',
    framesDone: 0,
    framesTotal: 1,
    timeTotalSec: durationSec,
    outTimeUs: 0,
    bytesWritten: 0,
    startedAt: Date.now(),
    notices: [],
    cancelRequested: false,
    outputs: [videoPath]
  }
  registry.set(jobId, state)
  emitProgress(window, state)

  void run(state, request, binaries.ffmpeg, videoPath, window).catch(async (error: unknown) => {
    registry.delete(jobId)
    // 取消/失败都不留半成品：产物路径就是本次唯一写入的文件。
    await fs.rm(videoPath, { force: true }).catch(() => undefined)
    const info = toInfo(error)
    state.phase = info.code === 'CANCELLED' ? 'cancelled' : 'failed'
    const result: JobResult = {
      jobId,
      ok: false,
      outputs: [],
      error: info,
      progress: toProgress(state)
    }
    emitResult(window, result)
    await log('error', `预览代理失败 ${jobId}：${info.message}`)
  })

  return { status: 'queued', jobId, path: null, signature }
}

/** 导出面板的取消入口按 jobId 前缀路由到这里（与 stab- 同一套语义）。 */
export async function cancelMediaProxy(jobId: string): Promise<void> {
  const state = registry.get(jobId)
  if (!state) return
  state.cancelRequested = true
  await terminateJob(jobId)
}

/** 素材移出池：先取消在跑作业，再按 mediaId 前缀回收全部代理版本。 */
export async function removeMediaProxy(mediaId: string): Promise<void> {
  const jobId = proxyJobId(mediaId)
  const state = registry.get(jobId)
  if (state) {
    state.cancelRequested = true
    await terminateJob(jobId)
  }
  await clearProxyForMedia(mediaId)
}

async function clearProxyForMedia(mediaId: string): Promise<void> {
  const dir = userProxyDir()
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => isProxyFileOf(mediaId, name))
      .map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => undefined))
  )
}

/**
 * 新鲜度查询：按当前源指纹重算签名并检查代理文件。
 * 源文件被替换（size/mtime 变化）→ 令牌变化 → 旧代理文件不在新路径上 → fresh=false，
 * 渲染侧据此回落原片/不可预览，而不是继续播旧代理。
 */
export async function statusMediaProxy(request: MediaProxyRequest): Promise<MediaProxyStatusResult> {
  if (typeof request.path !== 'string' || !isVideoPath(request.path)) {
    return { fresh: false, path: null, signature: '' }
  }
  let source
  try {
    source = await fs.stat(request.path)
  } catch {
    return { fresh: false, path: null, signature: '' }
  }
  const signature = proxySignature({
    sourcePath: request.path,
    sourceBytes: source.size,
    sourceMtimeMs: source.mtimeMs
  })
  const token = proxyToken(signature, source.size, source.mtimeMs)
  const candidate = path.join(userProxyDir(), proxyFileName(request.mediaId, token))
  const fresh = await usableFile(candidate)
  return { fresh, path: fresh ? candidate : null, signature }
}

async function run(
  state: JobState,
  request: MediaProxyRequest,
  ffmpegPath: string,
  videoPath: string,
  window: BrowserWindow | null
): Promise<void> {
  await fs.mkdir(path.dirname(videoPath), { recursive: true })
  const ticker = makeTicker(state, window)
  const durationUs = Math.max(1, Math.round((request.durationSec ?? 0) * 1e6))

  state.phase = 'rendering'
  ticker()

  const parser = new ProgressParser()
  const job = spawnJob({
    jobId: state.id,
    label: '预览代理 · 转码',
    binary: ffmpegPath,
    args: buildProxyArgs({
      inputPath: request.path,
      outputPath: videoPath,
      hasAudio: request.hasAudio !== false
    }),
    stdin: false,
    cwd: path.dirname(videoPath),
    onStdoutChunk: (chunk) => {
      const snapshot = parser.feed(chunk)
      if (!snapshot) return
      const ratio =
        durationUs > 0 && snapshot.outTimeUs > 0
          ? Math.min(1, snapshot.outTimeUs / durationUs)
          : 0
      state.framesDone = ratio
      state.outTimeUs = snapshot.outTimeUs
      ticker()
    }
  })
  const watch = setInterval(() => {
    if (state.cancelRequested) void terminateJob(state.id)
  }, 200)
  let code: number | null
  try {
    code = await waitForClose(job)
  } finally {
    clearInterval(watch)
  }
  if (code !== 0) throw new FFmpegExitError(code, job.stderr.tail(4096), job.argv)
  if (state.cancelRequested) throw cancelInfo()
  if (!(await usableFile(videoPath))) throw new Error(`预览代理产物为空：${videoPath}`)

  state.framesDone = 1
  state.outTimeUs = durationUs
  state.phase = 'done'
  registry.delete(state.id)
  emitResult(window, {
    jobId: state.id,
    ok: true,
    outputs: [videoPath],
    outputPath: videoPath,
    progress: toProgress(state)
  })
  await log('info', `预览代理完成：${videoPath}`)
}

function makeTicker(state: JobState, window: BrowserWindow | null): () => void {
  let last = 0
  return () => {
    const now = Date.now()
    if (now - last < 120) return
    last = now
    const target =
      state.windowId >= 0 ? BrowserWindow.getAllWindows().find((w) => w.id === state.windowId) ?? window : window
    emitProgress(target ?? null, state)
  }
}

function cancelInfo(): JobErrorInfo {
  return { code: 'CANCELLED', message: '预览代理生成已取消', stderrTail: '', fatal: false }
}

function toInfo(error: unknown): JobErrorInfo {
  const e = error as { message?: string; code?: string; stderrTail?: string; argv?: string[] }
  return {
    code: e?.code ?? 'MEDIA_PROXY_FAILED',
    message: e?.message ?? String(error),
    stderrTail: e?.stderrTail ?? '',
    argv: e?.argv,
    fatal: true
  }
}
