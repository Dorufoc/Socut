import { useEffect, useRef } from 'react'
import { isEditableTarget } from './useTransportKeys'
import { useUiStore } from '../state/uiStore'

/**
 * 编辑快捷键：`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 或 `Ctrl/Cmd+Y` 重做。
 *
 * 让位规则与播放键盘（`useTransportKeys`）同一口径：
 * 1. 焦点在文本类控件里**完全不接管**——框内的 Ctrl+Z 是浏览器自己的文字撤销，
 *    抢走它会让用户在输入框里改错字都退不回去；
 * 2. 门禁弹窗排队中不接手（不能用快捷键绕过阻断，规格 §6）；
 * 3. 已被别处 preventDefault 的组合键不接手第二次。
 */

export type EditAction = 'undo' | 'redo'

export interface KeyModifiers {
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** 按键 → 编辑动作；不属于编辑快捷键时返回 null（Alt 组合一律让开）。 */
export function editActionOf(key: string, modifiers: KeyModifiers): EditAction | null {
  if (!modifiers.ctrl && !modifiers.meta) return null
  if (modifiers.alt) return null
  const normalized = key.toLowerCase()
  if (normalized === 'z') return modifiers.shift ? 'redo' : 'undo'
  if (normalized === 'y') return 'redo'
  return null
}

export interface EditKeys {
  undo: () => void
  redo: () => void
}

export function useEditKeys(keys: EditKeys): void {
  // 回调进 ref：处理器只挂一次，不必因为父组件重渲染反复重挂监听
  const keysRef = useRef(keys)
  keysRef.current = keys

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      if (useUiStore.getState().dialogQueue.length > 0) return
      if (event.defaultPrevented) return
      const action = editActionOf(event.key, {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey
      })
      if (!action) return
      event.preventDefault()
      if (action === 'undo') keysRef.current.undo()
      else keysRef.current.redo()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
