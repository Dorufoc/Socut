import { useEffect, useRef } from 'react'
import { AUTOSAVE_DEBOUNCE_MS } from '@shared/constants'
import { useProjectStore } from '../state/projectStore'

/** 当前工程自动保存（规格 §4.6）：revision 变化 → debounce → 主进程原子写。 */

export function useProjectAutosave(): { lastError: string | null } {
  const revision = useProjectStore((state) => state.revision)
  const errorRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (revision === 0) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const project = useProjectStore.getState().project
      void window.focusnews.project
        .autosaveWrite(project)
        .then(() => {
          errorRef.current = null
        })
        .catch((error: unknown) => {
          errorRef.current = String(error)
          void window.focusnews.app.writeLog('error', `自动保存失败：${String(error)}`)
        })
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [revision])

  // 关窗前补一次同步语义的写入（渲染进程无法阻塞，交给主进程在退出时落盘）
  useEffect(() => {
    const handler = (): void => {
      const project = useProjectStore.getState().project
      void window.focusnews.project.autosaveWrite(project)
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  return { lastError: errorRef.current }
}
