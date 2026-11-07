import type { CoverCaptureRect } from '@shared/api'

/**
 * 把当前预览画面截成工程封面。
 *
 * **必须在 `setView('launcher')` 之前调用**：切到启动页后 `.stage__frame` 已经卸载，
 * 量不到矩形就只能放弃。这里只负责量框与转交主进程，真正的像素截取由主进程完成。
 */
export async function captureCurrentCover(entryId: string | null): Promise<string | null> {
  if (!entryId) return null
  const api = typeof window === 'undefined' ? undefined : window.focusnews?.project
  if (!api || typeof api.captureCover !== 'function') return null

  try {
    const frame = document.querySelector('.stage__frame')
    if (!frame) return null
    const rect = frame.getBoundingClientRect()
    // 太小说明布局还没稳定（或预览被折叠），截出来只会是糊图，不如保留旧封面
    if (rect.width < 32 || rect.height < 32) return null

    await waitOneFrame()

    const payload: CoverCaptureRect = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }
    return await api.captureCover(entryId, payload)
  } catch {
    // 封面是锦上添花：失败不影响打开/返回启动页
    return null
  }
}

function waitOneFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })
}
