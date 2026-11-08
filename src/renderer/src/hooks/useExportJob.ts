import { useCallback } from 'react'
import {
  runExport,
  type StartExportInput
} from '../render/exportRunner'
import { useExportStore } from '../state/exportStore'

/**
 * 导出任务发起（应用内入口）。
 *
 * 真正的规格构建/门禁/预估在 `render/exportRunner.ts`，与 CLI 共用；
 * 这里只保留 hooks 的便利语义：记录上一次参数、重试、取消。
 */

export { GateError, overlayCanvasFor, type StartExportInput, type StartExportResult } from '../render/exportRunner'

export function useExportJob(): {
  start: (input: StartExportInput) => Promise<string>
  retryLast: () => Promise<string | null>
  cancel: (jobId: string) => Promise<void>
} {
  const start = useCallback(async (input: StartExportInput): Promise<string> => {
    const result = await runExport(input)
    return result.jobId
  }, [])

  const startWith = useCallback(
    async (input: StartExportInput): Promise<string> => {
      // 记下发起参数，失败时面板可一键重试（计划 M4-2）
      useExportStore.getState().setLastInput(input)
      return start(input)
    },
    [start]
  )

  /** 重跑上一次导出（重建规格与新 jobId，不重放旧 jobId） */
  const retryLast = useCallback(async (): Promise<string | null> => {
    const last = useExportStore.getState().lastInput as StartExportInput | null
    if (!last) return null
    return start(last)
  }, [start])

  const cancel = useCallback(async (jobId: string): Promise<void> => {
    await window.socut.export.cancel(jobId)
  }, [])

  return { start: startWith, retryLast, cancel }
}
