/**
 * 编辑快捷键（撤销 / 重做）测试：
 * - `Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 与 `Ctrl/Cmd+Y` 重做，都要吃掉默认行为；
 * - 焦点在文本类控件时完全不接管：框里的 Ctrl+Z 属于浏览器自己的文字撤销；
 * - 门禁弹窗排队中让位（与播放键盘同一口径）；
 * - 没有 Ctrl/Cmd 的裸 z / 已被别处 preventDefault 的组合键不接手。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { editActionOf, useEditKeys } from './useEditKeys'
import { useUiStore } from '../state/uiStore'

const undo = vi.fn()
const redo = vi.fn()

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function mountFocused(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value)
  element.tabIndex = 0
  document.body.appendChild(element)
  act(() => {
    element.focus()
  })
  return element
}

beforeEach(() => {
  undo.mockReset()
  redo.mockReset()
  useUiStore.setState({ dialogQueue: [] })
  renderHook(() => useEditKeys({ undo, redo }))
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('editActionOf（按键 → 动作）', () => {
  it('Ctrl+Z 撤销，Ctrl+Shift+Z 与 Ctrl+Y 重做', () => {
    expect(editActionOf('z', { ctrl: true, meta: false, shift: false, alt: false })).toBe('undo')
    expect(editActionOf('z', { ctrl: true, meta: false, shift: true, alt: false })).toBe('redo')
    expect(editActionOf('y', { ctrl: true, meta: false, shift: false, alt: false })).toBe('redo')
    // Cmd 等价（Mac 手势一致），大写 Z（CapsLock）也认
    expect(editActionOf('Z', { ctrl: false, meta: true, shift: false, alt: false })).toBe('undo')
  })

  it('裸键与 Alt 组合不属于编辑快捷键', () => {
    expect(editActionOf('z', { ctrl: false, meta: false, shift: false, alt: false })).toBeNull()
    expect(editActionOf('z', { ctrl: true, meta: false, shift: false, alt: true })).toBeNull()
    expect(editActionOf('b', { ctrl: true, meta: false, shift: false, alt: false })).toBeNull()
  })
})

describe('useEditKeys（挂到 window 上）', () => {
  it('Ctrl+Z 触发撤销并 preventDefault', () => {
    const event = press({ key: 'z', ctrlKey: true })

    expect(undo).toHaveBeenCalledTimes(1)
    expect(redo).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('Ctrl+Shift+Z 与 Ctrl+Y 都触发重做', () => {
    press({ key: 'z', ctrlKey: true, shiftKey: true })
    press({ key: 'y', ctrlKey: true })

    expect(undo).not.toHaveBeenCalled()
    expect(redo).toHaveBeenCalledTimes(2)
  })

  it('焦点在输入框里时完全不接管，也不 preventDefault（让浏览器撤销文字）', () => {
    const input = mountFocused('input', { type: 'text' })

    const event = press({ key: 'z', ctrlKey: true }, input)

    expect(undo).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('门禁弹窗排队中让位：不能用快捷键绕过阻断', () => {
    const resolve = vi.fn()
    useUiStore.getState().pushPrompt({ id: 'dlg-1', dialog: { kind: 'confirm', title: 't', body: 'b' }, resolve })

    const event = press({ key: 'z', ctrlKey: true })

    expect(undo).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('已被别处消费掉的 Ctrl+Z 不再接手第二次', () => {
    const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    event.preventDefault()
    act(() => {
      window.dispatchEvent(event)
    })

    expect(undo).not.toHaveBeenCalled()
  })

  it('裸 z 不触发任何编辑动作', () => {
    press({ key: 'z' })

    expect(undo).not.toHaveBeenCalled()
    expect(redo).not.toHaveBeenCalled()
  })
})
