import path from 'node:path'
import fs from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import { buildStabDetectArgs, buildStabPreviewArgs } from '../shared/ffmpegArgs'
import {
  stabPreviewFileName,
  stabPreviewSignature,
  stabPreviewToken
} from '../shared/mediaStab'
import { TEXT } from '../shared/i18n'
import type { JobErrorInfo, JobResult, StabPreviewRequest, StabPreviewResult } from '../shared/types'
import { spawnJob, terminateJob } from './procRegistry'
import { ProgressParser } from './progressParser'
import { resolveFfmpegBinaries, userStabPreviewDir } from './paths'
import { log } from './log'
import { emitProgress, emitResult, toProgress } from './export/jobs'
import type { JobState } from './export/jobs'
import { FFmpegExitError, waitForClose } from './export/transparentMov'

/**
 * v8.1：防抖预览代理的后台作业（规格 §6.3 家族：与 cfrTranscode 同一套作业/进度/取消纪律）。
 *
 * 用户点 Inspector 的「应用防抖预览」后：
 * 1. pass 1 运动检测（detect）：源区间 → .trf 运动数据（ userData/stab-preview 下持久缓存，帧序与导出合成同源）；
 * 2. pass 2 代理转码（transform）：.trf + 源区间 → 稳定化 mp4 代理（+ 该区间原声）；
 * 3. 产物路径经 jobResult.outputs[0] 回传，渲染侧把 PreviewStage 的 <video> 换成代理。
 *
 * 缓存口径：文件名带签名令牌（区间/帧率/档位 + 源 size/mtime 指纹），
 * 源文件被替换或参数改动 → 令牌变化 → 旧代理自然失效，不起进程也命中不了。
 * jobId = `stab-<clipId>`（确定性）：同片段重复点击复用运行中的作业，进度面板只有一张卡。
 */

const registry = new Map<string, JobState>()

/** 全任务进度（0..1）：两阶段各占一半；framesDone 与 outTimeUs 都由它反推，保持两条口径一致。 */
function applyStageProgress(state: JobState, stage: 0 | 1, ratio: number, durationUs: number): void {
  const overall = (stage + Math.min(1, Math.max(0, ratio))) / 2
  state.framesDone = overall * 2
  state.outTimeUs = Math.round(overall * durationUs)
}

/** 稳定化代理是否可直接使用（存在且非空文件）。 */
async function usableFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target)
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

export async function applyStabPreview(
  request: StabPreviewRequest,
  window: BrowserWindow | null
): Promise<StabPreviewResult> {
  const jobId = `stab-${request.clipId.replace(/[^\w-]/g, '_').slice(0, 64) || 'clip'}`
  if (!request.stab.enabled) {
    throw new Error(TEXT.stab.applyDisabled)
  }
  const durationSec = request.sourceOutSec - request.sourceInSec
  if (!(durationSec > 0)) {
    throw new Error(TEXT.stab.applyBadRange)
  }

  let source
  try {
    source = await fs.stat(request.sourcePath)
  } catch {
    throw new Error(TEXT.stab.sourceMissing(request.sourcePath))
  }

  const signature = stabPreviewSignature({
    sourcePath: request.sourcePath,
    sourceInSec: request.sourceInSec,
    sourceOutSec: request.sourceOutSec,
    fps: request.fps,
    stab: request.stab
  })
  const token = stabPreviewToken(signature, source.size, source.mtimeMs)
  const names = stabPreviewFileName(request.clipId, token)
  const dir = userStabPreviewDir()
  const videoPath = path.join(dir, names.video)

  // 1) 磁盘缓存命中：代理已就绪，不起任何进程。
  if (await usableFile(videoPath)) {
    return { status: 'cached', jobId, path: videoPath, signature }
  }
  // 2) 同片段作业已在跑：复用（重复点击不排第二份）。
  if (registry.has(jobId)) {
    return { status: 'queued', jobId, path: null, signature }
  }

  const binaries = await resolveFfmpegBinaries()
  if (!binaries.available) {
    throw new Error(TEXT.errors.ffmpegMissing(binaries.ffmpeg))
  }

  const state: JobState = {
    id: jobId,
    kind: 'overlayMp4',
    windowId: window?.id ?? -1,
    phase: 'queued',
    framesDone: 0,
    framesTotal: 2,
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

  void run(state, request, binaries.ffmpeg, dir, names.trf, videoPath, window).catch(
    async (error: unknown) => {
      registry.delete(jobId)
      await fs.rm(videoPath, { force: true }).catch(() => undefined)
      const info = toInfo(error)
      state.phase = info.code === 'CANCELLED' ? 'cancelled' : 'failed'
      const result: JobResult = { jobId, ok: false, outputs: [], error: info, progress: toProgress(state) }
      emitResult(window, result)
      await log('error', `防抖预览代理失败 ${jobId}：${info.message}`)
    }
  )

  return { status: 'queued', jobId, path: null, signature }
}

export async function cancelStabPreview(jobId: string): Promise<void> {
  const state = registry.get(jobId)
  if (!state) return
  state.cancelRequested = true
  await terminateJob(`${jobId}-detect`)
  await terminateJob(jobId)
}

/** 片段从时间轴移除时回收它的全部代理与运动数据（按 clipId 安全化前缀匹配）。 */
export async function removeStabPreviewForClip(clipId: string): Promise<void> {
  const safeClip = clipId.replace(/[^\w-]/g, '_').slice(0, 64) || 'clip'
  const dir = userStabPreviewDir()
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(`stab-${safeClip}-`) && (name.endsWith('.mp4') || name.endsWith('.trf')))
      .map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => undefined))
  )
}

async function run(
  state: JobState,
  request: StabPreviewRequest,
  ffmpegPath: string,
  dir: string,
  trfName: string,
  videoPath: string,
  window: BrowserWindow | null
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  const ticker = makeTicker(state, window)
  const durationUs = Math.max(1, Math.round((request.sourceOutSec - request.sourceInSec) * 1e6))

  state.phase = 'preparing'
  ticker()

  // pass 1：运动检测（上一轮留下的完整 .trf 直接复用，跳过整段分析）。
  if (!(await usableFile(path.join(dir, trfName)))) {
    const detect = await once({
      procId: `${state.id}-detect`,
      label: '防抖预览 · 运动检测',
      state,
      args: buildStabDetectArgs({
        inputPath: request.sourcePath,
        sourceInSec: request.sourceInSec,
        sourceOutSec: request.sourceOutSec,
        fps: request.fps,
        stab: request.stab,
        resultFile: trfName
      }),
      ffmpegPath,
      cwd: dir,
      stage: 0,
      durationUs,
      ticker
    })
    if (detect.code !== 0) throw new FFmpegExitError(detect.code, detect.stderrTail, detect.argv)
    if (state.cancelRequested) throw cancelInfo()
    if (!(await usableFile(path.join(dir, trfName)))) {
      throw new Error(TEXT.stab.detectFailed)
    }
  }
  applyStageProgress(state, 1, 0, durationUs)
  ticker()

  // pass 2：稳定化代理转码（主 jobId 登记进程，取消直达）。
  state.phase = 'rendering'
  const render = await once({
    procId: state.id,
    label: '防抖预览 · 代理转码',
    state,
    args: buildStabPreviewArgs({
      inputPath: request.sourcePath,
      sourceInSec: request.sourceInSec,
      sourceOutSec: request.sourceOutSec,
      fps: request.fps,
      stab: request.stab,
      stabFile: trfName,
      hasAudio: request.hasAudio,
      outputPath: videoPath
    }),
    ffmpegPath,
    cwd: dir,
    stage: 1,
    durationUs,
    ticker
  })
  if (render.code !== 0) throw new FFmpegExitError(render.code, render.stderrTail, render.argv)
  if (state.cancelRequested) throw cancelInfo()
  if (!(await usableFile(videoPath))) throw new Error(TEXT.stab.proxyEmpty(videoPath))

  state.framesDone = 2
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
  await log('info', `防抖预览代理完成：${videoPath}`)
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

interface OnceInput {
  procId: string
  label: string
  state: JobState
  args: string[]
  ffmpegPath: string
  cwd: string
  stage: 0 | 1
  durationUs: number
  ticker: () => void
}

/** 跑一个 ffmpeg 进程：进度解析 → 阶段内帧折算 → 200ms 取消监视（detect 用子 id，取消要另打一发）。 */
async function once(input: OnceInput): Promise<{ code: number | null; stderrTail: string; argv: string[] }> {
  const parser = new ProgressParser()
  const job = spawnJob({
    jobId: input.procId,
    label: input.label,
    binary: input.ffmpegPath,
    args: input.args,
    stdin: false,
    cwd: input.cwd,
    onStdoutChunk: (chunk) => {
      const snapshot = parser.feed(chunk)
      if (!snapshot) return
      applyStageProgress(input.state, input.stage, snapshot.outTimeUs / input.durationUs, input.durationUs)
      input.ticker()
    }
  })
  const watch = setInterval(() => {
    if (input.state.cancelRequested) void terminateJob(input.procId)
  }, 200)
  try {
    const code = await waitForClose(job)
    return { code, stderrTail: job.stderr.tail(4096), argv: job.argv }
  } finally {
    clearInterval(watch)
  }
}

function cancelInfo(): JobErrorInfo {
  return { code: 'CANCELLED', message: TEXT.stab.previewCancelled, stderrTail: '', fatal: false }
}

function toInfo(error: unknown): JobErrorInfo {
  const e = error as { message?: string; code?: string; stderrTail?: string; argv?: string[] }
  return {
    code: e?.code ?? 'STAB_PREVIEW_FAILED',
    message: e?.message ?? String(error),
    stderrTail: e?.stderrTail ?? '',
    argv: e?.argv,
    fatal: true
  }
}
