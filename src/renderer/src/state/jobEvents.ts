import type { JobProgress, JobResult } from '@shared/types'
import { useExportStore } from './exportStore'
import { useStabPreviewStore } from './stabPreviewStore'
import { useProxyStore } from './proxyStore'

/**
 * 主进程事件分发（进度 / 结果）。
 * 结果既写入 exportStore 供 UI 展示，也唤醒等待者（如 VFR→CFR 转码完成）。
 */

const waiters = new Map<string, (result: JobResult) => void>()

export function bindJobEvents(): () => void {
  const offProgress = window.socut.job.onProgress((progress: JobProgress) => {
    useExportStore.getState().upsertProgress(progress)
  })
  const offResult = window.socut.job.onResult((result: JobResult) => {
    useExportStore.getState().setResult(result)
    // v8.1：防抖预览代理作业（stab- 前缀）完成后额外记账代理路径，PreviewStage 据此换源
    useStabPreviewStore.getState().handleJobResult(result)
    // v10：4K / MXF 预览代理作业（proxy- 前缀）完成后记账整片代理路径
    useProxyStore.getState().handleJobResult(result)
    const resolve = waiters.get(result.jobId)
    if (resolve) {
      waiters.delete(result.jobId)
      resolve(result)
    }
  })
  return () => {
    offProgress()
    offResult()
  }
}

export function waitForResult(jobId: string, timeoutMs = 0): Promise<JobResult> {
  return new Promise<JobResult>((resolve, reject) => {
    waiters.set(jobId, resolve)
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (waiters.has(jobId)) {
          waiters.delete(jobId)
          reject(new Error('等待任务结果超时'))
        }
      }, timeoutMs)
    }
  })
}

export function forgetWaiter(jobId: string): void {
  waiters.delete(jobId)
}
