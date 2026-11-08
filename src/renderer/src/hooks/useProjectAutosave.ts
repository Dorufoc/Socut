import { useEffect, useRef } from 'react'
import { AUTOSAVE_DEBOUNCE_MS } from '@shared/constants'
import { useProjectStore } from '../state/projectStore'

/**
 * 当前工程自动保存（规格 §4.6）：revision 变化 → 短 debounce → 主进程原子写。
 * debounce 只负责把拖拽/滑杆这类连续改值合并成一次写入；一次操作完成（revision 停止变化）
 * 后很快就落盘，关窗/切走页签时再强制刷一次，保证「每完成一次操作都持久化」。
 */

export function useProjectAutosave(): { lastError: string | null } {
  const revision = useProjectStore((state) => state.revision)
  const errorRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 最近一次已落盘的 revision：同一revision不重复写（左栏 Tab 快照等低频补写除外，它们自己会推 revision） */
  const savedRevRef = useRef(0)

  useEffect(() => {
    if (revision === 0) return
    if (timerRef.current) clearTimeout(timerRef.current)
    const write = (): void => {
      if (savedRevRef.current === revision) return
      // entryId 在真正写入时现取：debounce 窗口内另存为/打开切换了身份，也不会写错归属。
      void window.socut.project
        .autosaveWrite(useProjectStore.getState().project, useProjectStore.getState().currentEntryId)
        .then(() => {
          savedRevRef.current = revision
          errorRef.current = null
        })
        .catch((error: unknown) => {
          errorRef.current = String(error)
          void window.socut.app.writeLog('error', `自动保存失败：${String(error)}`)
        })
    }
    timerRef.current = setTimeout(write, AUTOSAVE_DEBOUNCE_MS)
    const flush = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      // beforeunload / visibilitychange 里同步发出 IPC：主进程退出清理会等在途写入落盘
      write()
    }
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [revision])

  return { lastError: errorRef.current }
}
