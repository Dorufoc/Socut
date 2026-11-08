import { useCallback, useState } from 'react'
import type { CoverExportResult } from '@shared/types'
import { runCoverExport, type CoverExportInput } from '../render/coverRunner'
import { useUiStore } from '../state/uiStore'

/** 封面导出 hook：只负责 busy 与提示文案，实际取帧/合成在 render/coverRunner。 */

export type { CoverExportInput } from '../render/coverRunner'

export function useCoverExport(): {
  exportCover: (input: CoverExportInput) => Promise<CoverExportResult>
  busy: boolean
} {
  const [busy, setBusy] = useState(false)

  const exportCover = useCallback(async (input: CoverExportInput): Promise<CoverExportResult> => {
    const setNotice = useUiStore.getState().setNotice
    setBusy(true)
    try {
      const result = await runCoverExport(input)
      setNotice(result.ok ? `封面已导出：${result.path}` : `封面导出失败：${result.error ?? '未知错误'}`)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice(`封面导出失败：${message}`)
      return { ok: false, path: '', error: message }
    } finally {
      setBusy(false)
    }
  }, [])

  return { exportCover, busy }
}
