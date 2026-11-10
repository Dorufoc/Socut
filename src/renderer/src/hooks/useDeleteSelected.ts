import { useEffect } from 'react'
import { isEditableTarget } from './useTransportKeys'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * Delete / 退格键删除「当前选中的那一段」。
 *
 * v11 起选中态多了「转场」：`removeSelected` 内部先看 `selectionKind === 'transition'`，
 * 有转场就只删转场（不动片段），这正是「转场图标高亮时按 Delete/退格删除」的语义；
 * 没有转场选中时才回落到原来的字幕条 / 媒体段 / 音频段删除，行为与旧版一致。
 *
 * 让位规则与 useEditKeys 同一口径：
 * 1. 焦点在输入框/文本控件里完全不接管（框内的退格是删字，不是删片段）；
 * 2. 门禁弹窗排队中不接手；
 * 3. 已被别处 preventDefault 的按键不接手第二次。
 */
export function isDeleteKey(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Delete' || event.key === 'Backspace'
}

export function useDeleteSelected(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isDeleteKey(event)) return
      if (event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      if (useUiStore.getState().dialogQueue.length > 0) return
      const state = useProjectStore.getState()
      // M5：Shift+Delete 或「磁性删除」开关 = 波纹删除（删该段并把同轨后续片段左移合拢）
      const magneticDelete = event.shiftKey || useUiStore.getState().timelineTools.rippleDelete
      if (magneticDelete && state.selectionKind === 'media' && state.selectedMediaClipId !== null) {
        if (!state.rippleDeleteMediaClip(state.selectedMediaClipId)) return
        event.preventDefault()
        return
      }
      // 没有可删目标时保持安静：不吞事件、不 preventDefault
      if (!state.removeSelected()) return
      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
