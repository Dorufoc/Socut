import path from 'node:path'
import { BrowserWindow } from 'electron'
import { buildCfrArgs } from '../shared/ffmpegArgs'
import { createId } from '../shared/projectSchema'
import { TEXT } from '../shared/i18n'
import type { Fps, JobErrorInfo, JobResult, VideoMeta } from '../shared/types'
import { spawnJob, terminateJob } from './procRegistry'
import { ProgressParser } from './progressParser'
import { resolveFfmpegBinaries } from './paths'
import { log } from './log'
import { emitProgress, emitResult, toProgress } from './export/jobs'
import type { JobState } from './export/jobs'
import { decideAudioMode, probeVideo } from './videoImport'
import { FFmpegExitError, waitForClose } from './export/transparentMov'

/** VFR → CFR 后台转码（规格 §6.3：转换并导入为推荐路径）。 */

const registry = new Map<string, JobState>()

export interface CfrJob {
  jobId: string
  outputPath: string
}

export function cfrJobs(): JobState[] {
  return [...registry.values()]
}

export async function cancelCfr(jobId: string): Promise<void> {
  const state = registry.get(jobId)
  if (!state) return
  state.cancelRequested = true
  await terminateJob(jobId)
}

export async function convertToCfr(
  inputPath: string,
  fps: Fps,
  meta: VideoMeta,
  window: BrowserWindow | null
): Promise<CfrJob> {
  const jobId = createId('cfr')
  const dir = path.dirname(inputPath)
  const base = path.basename(inputPath, path.extname(inputPath))
  const outputPath = path.join(dir, `${base}_cfr.mp4`)
  const binaries = await resolveFfmpegBinaries()
  if (!binaries.available) {
    throw new Error(TEXT.errors.ffmpegMissing(binaries.ffmpeg))
  }

  const framesTotal = Math.max(0, Math.round(meta.durationSec * (fps.num / fps.den)))
  const state: JobState = {
    id: jobId,
    kind: 'overlayMp4',
    windowId: window?.id ?? -1,
    phase: 'preparing',
    framesDone: 0,
    framesTotal,
    timeTotalSec: meta.durationSec,
    outTimeUs: 0,
    bytesWritten: 0,
    startedAt: Date.now(),
    notices: [],
    cancelRequested: false,
    outputs: [outputPath]
  }
  registry.set(jobId, state)

  const audio = decideAudioMode(meta)
  const ticker = makeTicker(state)

  void run(jobId, state, inputPath, outputPath, fps, audio.mode, binaries.ffmpeg, ticker, window).catch(
    async (error) => {
      registry.delete(jobId)
      const info = toInfo(error)
      const result: JobResult = { jobId, ok: false, outputs: [], error: info, progress: toProgress(state) }
      emitResult(window, result)
      await log('error', `CFR 转换失败 ${jobId}：${info.message}`)
    }
  )

  return { jobId, outputPath }
}

function makeTicker(state: JobState): () => void {
  let last = 0
  return () => {
    const now = Date.now()
    if (now - last < 120) return
    last = now
    emitProgress(state.windowId >= 0 ? BrowserWindow.getAllWindows().find((w) => w.id === state.windowId) ?? null : null, state)
  }
}

async function run(
  jobId: string,
  state: JobState,
  inputPath: string,
  outputPath: string,
  fps: Fps,
  audioMode: 'copy' | 'aac',
  ffmpegPath: string,
  ticker: () => void,
  window: BrowserWindow | null
): Promise<void> {
  state.phase = 'muxing'
  ticker()
  let result = await once(jobId, state, inputPath, outputPath, fps, audioMode, ffmpegPath, ticker)

  if (audioMode === 'copy' && result.code !== 0 && !state.cancelRequested) {
    state.notices.push('音频直接复制失败，已改用 AAC 192k。')
    result = await once(jobId, state, inputPath, outputPath, fps, 'aac', ffmpegPath, ticker)
  }

  if (state.cancelRequested) {
    registry.delete(jobId)
    emitResult(window, {
      jobId,
      ok: false,
      outputs: [],
      error: { code: 'CANCELLED', message: '转换已取消', stderrTail: '', fatal: false },
      progress: toProgress(state)
    })
    return
  }
  if (result.code !== 0) {
    registry.delete(jobId)
    throw new FFmpegExitError(result.code, result.stderrTail, result.argv)
  }

  // 规格 §10 第 6 条：转换后 ffprobe 确认帧率一致
  const probe = await probeVideo(outputPath, `${jobId}-verify`, true)
  const sameRate =
    probe.meta.rFrameRate.num === probe.meta.avgFrameRate.num &&
    probe.meta.rFrameRate.den === probe.meta.avgFrameRate.den

  state.phase = 'done'
  registry.delete(jobId)
  emitResult(window, {
    jobId,
    ok: sameRate,
    outputs: [outputPath],
    outputPath,
    error: sameRate
      ? undefined
      : {
          code: 'CFR_RATE',
          message: `转换后帧率仍不一致：r=${probe.meta.rFrameRate.num}/${probe.meta.rFrameRate.den} avg=${probe.meta.avgFrameRate.num}/${probe.meta.avgFrameRate.den}`,
          stderrTail: '',
          fatal: true
        },
    progress: toProgress(state)
  })
  await log('info', `CFR 转换完成：${outputPath}`)
}

async function once(
  jobId: string,
  state: JobState,
  inputPath: string,
  outputPath: string,
  fps: Fps,
  audioMode: 'copy' | 'aac',
  ffmpegPath: string,
  ticker: () => void
): Promise<{ code: number | null; stderrTail: string; argv: string[] }> {
  const parser = new ProgressParser()
  const job = spawnJob({
    jobId,
    label: 'VFR → CFR',
    binary: ffmpegPath,
    args: buildCfrArgs(inputPath, outputPath, fps, audioMode),
    stdin: false,
    onStdoutChunk: (chunk) => {
      const snapshot = parser.feed(chunk)
      if (snapshot) {
        state.outTimeUs = snapshot.outTimeUs
        state.bytesWritten = 0
        ticker()
      }
    }
  })
  const watch = setInterval(() => {
    if (state.cancelRequested) void terminateJob(jobId)
  }, 200)
  try {
    const code = await waitForClose(job)
    return { code, stderrTail: job.stderr.tail(4096), argv: job.argv }
  } finally {
    clearInterval(watch)
  }
}

function toInfo(error: unknown): JobErrorInfo {
  const e = error as { message?: string; code?: string; stderrTail?: string; argv?: string[] }
  return {
    code: e?.code ?? 'CFR_FAILED',
    message: e?.message ?? String(error),
    stderrTail: e?.stderrTail ?? '',
    argv: e?.argv,
    fatal: true
  }
}
