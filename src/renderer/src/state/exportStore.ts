import { create } from 'zustand'
import type { JobProgress, JobResult } from '@shared/types'

/** 导出任务状态（进度、取消、错误尾部输出，规格 §3.1）。 */

export interface ExportState {
  jobs: Record<string, JobProgress>
  /** 排队顺序（UI 展示用） */
  order: string[]
  lastResult: JobResult | null
  /** 上一次导出的发起参数（失败后的「重试入口」依赖它重建规格，计划 M4-2） */
  lastInput: unknown | null
  /** 任一任务处于非终态 */
  busy: boolean
  upsertProgress: (progress: JobProgress) => void
  setResult: (result: JobResult) => void
  setLastInput: (input: unknown | null) => void
  clearFinished: () => void
}

const TERMINAL: JobProgress['phase'][] = ['done', 'failed', 'cancelled']

export const useExportStore = create<ExportState>((set) => ({
  jobs: {},
  order: [],
  lastResult: null,
  lastInput: null,
  busy: false,

  setLastInput: (input) => set({ lastInput: input }),

  upsertProgress: (progress) =>
    set((state) => {
      const jobs = { ...state.jobs, [progress.jobId]: progress }
      const order = state.order.includes(progress.jobId) ? state.order : [...state.order, progress.jobId]
      return { jobs, order, busy: order.some((id) => !TERMINAL.includes(jobs[id]?.phase ?? 'queued')) }
    }),

  setResult: (result) =>
    set((state) => {
      const existing = state.jobs[result.jobId]
      const jobs = {
        ...state.jobs,
        [result.jobId]: {
          ...(existing ?? {
            jobId: result.jobId,
            phase: result.ok ? ('done' as const) : ('failed' as const),
            framesDone: result.progress.framesDone,
            framesTotal: result.progress.framesTotal,
            outTimeUs: result.progress.outTimeUs,
            bytesWritten: result.progress.bytesWritten,
            elapsedMs: result.progress.elapsedMs,
            notices: []
          }),
          phase: result.ok ? ('done' as const) : result.error?.code === 'CANCELLED' ? ('cancelled' as const) : ('failed' as const),
          percent: result.ok ? 1 : result.progress.percent,
          notices: [...(existing?.notices ?? []), ...result.progress.notices]
        }
      }
      return {
        jobs,
        lastResult: result,
        busy: Object.values(jobs).some((job) => !TERMINAL.includes(job.phase))
      }
    }),

  clearFinished: () =>
    set((state) => {
      const jobs: Record<string, JobProgress> = {}
      const order: string[] = []
      for (const id of state.order) {
        const job = state.jobs[id]
        if (!job) continue
        if (TERMINAL.includes(job.phase)) continue
        jobs[id] = job
        order.push(id)
      }
      return { jobs, order, busy: order.length > 0 }
    })
}))
