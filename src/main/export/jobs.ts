import { BrowserWindow } from 'electron'
import { CHANNELS } from '../../shared/ipcChannels'
import type { ExportKind, JobErrorInfo, JobPhase, JobProgress, JobResult } from '../../shared/types'

/** 任务状态表与进度回传（规格 §3.1：导出进度、取消、错误尾部输出）。 */

export interface JobState {
  id: string
  kind: ExportKind
  /** 发起任务的窗口 id（进度与结果只回给这个窗口） */
  windowId: number
  phase: JobPhase
  framesDone: number
  framesTotal: number
  /** 本次输出的总时长（秒），用于 out_time_us 时间口径 */
  timeTotalSec: number
  outTimeUs: number
  bytesWritten: number
  startedAt: number
  notices: string[]
  cancelRequested: boolean
  outputs: string[]
  error?: JobErrorInfo
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobState>()

  create(id: string, kind: ExportKind, windowId: number, framesTotal: number, timeTotalSec: number): JobState {
    const state: JobState = {
      id,
      kind,
      windowId,
      phase: 'queued',
      framesDone: 0,
      framesTotal,
      timeTotalSec,
      outTimeUs: 0,
      bytesWritten: 0,
      startedAt: Date.now(),
      notices: [],
      cancelRequested: false,
      outputs: []
    }
    this.jobs.set(id, state)
    return state
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id)
  }

  remove(id: string): void {
    this.jobs.delete(id)
  }

  active(): JobState[] {
    return [...this.jobs.values()].filter(
      (job) => job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled'
    )
  }
}

/** 展示进度 = min(已交付帧/总帧, out_time_us/总时长)（规格 §9 进度口径）。 */
export function computePercent(state: JobState): number {
  const byFrames = saturate(state.framesTotal > 0 ? state.framesDone / state.framesTotal : 0)
  const byTime = saturate(
    state.timeTotalSec > 0 ? state.outTimeUs / (state.timeTotalSec * 1e6) : 0
  )
  // 收尾阶段以帧口径为准：避免 FFmpeg 最后一批 out_time_us 未刷新时卡在 99%
  if (state.framesDone >= state.framesTotal && state.phase !== 'rendering') return byFrames
  return Math.min(byFrames, byTime || byFrames)
}

function saturate(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0
  return v > 1 ? 1 : v
}

export function toProgress(state: JobState): JobProgress {
  return {
    jobId: state.id,
    phase: state.phase,
    framesDone: state.framesDone,
    framesTotal: state.framesTotal,
    outTimeUs: state.outTimeUs,
    percent: computePercent(state),
    bytesWritten: state.bytesWritten,
    elapsedMs: Date.now() - state.startedAt,
    notices: [...state.notices]
  }
}

function targets(window: BrowserWindow | null): BrowserWindow[] {
  if (window && !window.isDestroyed()) return [window]
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
}

export function emitProgress(window: BrowserWindow | null, state: JobState): void {
  const payload = toProgress(state)
  for (const target of targets(window)) {
    target.webContents.send(CHANNELS.jobProgress, payload)
  }
}

export function emitResult(window: BrowserWindow | null, result: JobResult): void {
  for (const target of targets(window)) {
    target.webContents.send(CHANNELS.jobResult, result)
  }
}
