/**
 * 播放键盘测试（空格播放/暂停 + 方向键逐帧、长按连跳）：
 * - 空格切换一次算一次：系统按键重复（event.repeat）不再翻第二下；
 * - 焦点在文本类控件（input / textarea / select / contentEditable）时完全不接管，也不 preventDefault；
 * - 门禁弹窗排队中整组快捷键让位（不能拿空格绕过必须确认的阻断）；
 * - ←/→ 按一下跳一帧，按住到 FRAME_HOLD_DELAY_MS 起按 FRAME_REPEAT_INTERVAL_MS 连跳；
 * - 松手（keyup）、窗口失焦（blur）、换方向、焦点跑进输入框，四种路径都断掉连跳。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { FRAME_HOLD_DELAY_MS, FRAME_REPEAT_INTERVAL_MS, stepDeltaOf, useTransportKeys } from './useTransportKeys'
import { useUiStore } from '../state/uiStore'

const togglePlay = vi.fn()
const stepFrame = vi.fn()

function press(type: 'keydown' | 'keyup', init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

/** 建一个可聚焦的控件并让它成为焦点（jsdom 的 activeElement 由 focus() 决定） */
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

/**
 * 可编辑容器：jsdom 没实现 isContentEditable（探针实测返回 undefined），
 * 按浏览器契约把属性补到节点上，测的是本模块的判据而不是 jsdom 的完整度。
 */
function mountContentEditable(): HTMLElement {
  const element = mountFocused('div', { contenteditable: 'true' })
  Object.defineProperty(element, 'isContentEditable', { value: true, configurable: true })
  return element
}

beforeEach(() => {
  vi.useFakeTimers()
  togglePlay.mockReset()
  stepFrame.mockReset()
  useUiStore.setState({ playing: false, dialogQueue: [] })
  renderHook(() => useTransportKeys({ togglePlay, stepFrame }))
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('useTransportKeys 空格', () => {
  it('焦点在界面上：按下切换播放/暂停，并拦下默认行为', () => {
    const event = press('keydown', { key: ' ' })
    expect(togglePlay).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('按住连发的 keydown 只算一次', () => {
    press('keydown', { key: ' ' })
    press('keydown', { key: ' ', repeat: true })
    press('keydown', { key: ' ', repeat: true })
    expect(togglePlay).toHaveBeenCalledTimes(1)
  })

  it('旧键名 Spacebar 同样认', () => {
    press('keydown', { key: 'Spacebar' })
    expect(togglePlay).toHaveBeenCalledTimes(1)
  })

  it('文本框 / 多行文本 / 下拉 / contentEditable 里不接管，也不吃掉默认行为', () => {
    for (const build of [
      () => mountFocused('input', { type: 'text' }),
      () => mountFocused('textarea'),
      () => mountFocused('select'),
      () => mountContentEditable()
    ]) {
      togglePlay.mockClear()
      const element = build()
      const event = press('keydown', { key: ' ' }, element)
      expect(togglePlay).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
      element.remove()
    }
  })

  it('勾选框上的空格留给控件本身（安全区开关不能被抢）', () => {
    const checkbox = mountFocused('input', { type: 'checkbox' })
    press('keydown', { key: ' ' }, checkbox)
    expect(togglePlay).not.toHaveBeenCalled()
  })

  it('带修饰键的组合归别的快捷键（Ctrl+空格不切换）', () => {
    press('keydown', { key: ' ', ctrlKey: true })
    press('keydown', { key: ' ', metaKey: true })
    press('keydown', { key: ' ', altKey: true })
    expect(togglePlay).not.toHaveBeenCalled()
  })
})

describe('useTransportKeys 方向键逐帧', () => {
  it('← 上一帧、→ 下一帧，各按一次跳一帧', () => {
    const left = press('keydown', { key: 'ArrowLeft' })
    expect(stepFrame).toHaveBeenCalledWith(-1)
    press('keyup', { key: 'ArrowLeft' })
    press('keydown', { key: 'ArrowRight' })
    expect(stepFrame).toHaveBeenLastCalledWith(1)
    expect(left.defaultPrevented).toBe(true)
  })

  it('方向键映射：只有左右是逐帧，上下不管', () => {
    expect(stepDeltaOf('ArrowLeft')).toBe(-1)
    expect(stepDeltaOf('ArrowRight')).toBe(1)
    expect(stepDeltaOf('ArrowUp')).toBe(0)
    press('keydown', { key: 'ArrowDown' })
    expect(stepFrame).not.toHaveBeenCalled()
  })

  it('系统按键重复不额外起跳（节奏由本模块计时）', () => {
    press('keydown', { key: 'ArrowRight' })
    press('keydown', { key: 'ArrowRight', repeat: true })
    expect(stepFrame).toHaveBeenCalledTimes(1)
  })

  it('按住不放：到等待时长后开始连跳，之后每帧一跳', () => {
    press('keydown', { key: 'ArrowRight' })
    expect(stepFrame).toHaveBeenCalledTimes(1)
    // 阈值前：只有按下那一次
    act(() => {
      vi.advanceTimersByTime(FRAME_HOLD_DELAY_MS - 1)
    })
    expect(stepFrame).toHaveBeenCalledTimes(1)
    // 阈值到：连跳计时器起头（起头本身不跳帧），第一跳要再等一个间隔
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(stepFrame).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(FRAME_REPEAT_INTERVAL_MS)
    })
    expect(stepFrame).toHaveBeenCalledTimes(2)
    act(() => {
      vi.advanceTimersByTime(FRAME_REPEAT_INTERVAL_MS * 3)
    })
    expect(stepFrame).toHaveBeenCalledTimes(5)
  })

  it('松手（keyup）停住连跳', () => {
    press('keydown', { key: 'ArrowLeft' })
    press('keyup', { key: 'ArrowLeft' })
    act(() => {
      vi.advanceTimersByTime(FRAME_HOLD_DELAY_MS + FRAME_REPEAT_INTERVAL_MS * 4)
    })
    expect(stepFrame).toHaveBeenCalledTimes(1)
  })

  it('窗口失焦（blur）停住连跳：按住方向键出门不能一路跳下去', () => {
    press('keydown', { key: 'ArrowRight' })
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    act(() => {
      vi.advanceTimersByTime(FRAME_HOLD_DELAY_MS + FRAME_REPEAT_INTERVAL_MS * 4)
    })
    expect(stepFrame).toHaveBeenCalledTimes(1)
  })

  it('换方向只留一条连跳：上一个方向的定时器必须断开', () => {
    press('keydown', { key: 'ArrowRight' })
    press('keydown', { key: 'ArrowLeft' })
    // 两次按下各跳一帧（+1 / -1），之后只应剩下 -1 的连跳
    const afterPresses = stepFrame.mock.calls.length
    expect(afterPresses).toBe(2)
    act(() => {
      vi.advanceTimersByTime(FRAME_HOLD_DELAY_MS + FRAME_REPEAT_INTERVAL_MS * 2)
    })
    expect(stepFrame).toHaveBeenCalledTimes(afterPresses + 2)
    expect(stepFrame.mock.calls.slice(afterPresses).every(([delta]) => delta === -1)).toBe(true)
  })

  it('连跳中焦点进输入框：立刻停住，不背着用户继续推进播放头', () => {
    press('keydown', { key: 'ArrowRight' })
    act(() => {
      vi.advanceTimersByTime(FRAME_HOLD_DELAY_MS + FRAME_REPEAT_INTERVAL_MS)
    })
    const before = stepFrame.mock.calls.length
    const input = mountFocused('input', { type: 'text' })
    act(() => {
      vi.advanceTimersByTime(FRAME_REPEAT_INTERVAL_MS * 5)
    })
    expect(stepFrame).toHaveBeenCalledTimes(before)
    input.remove()
  })

  it('文本框里的方向键交还给光标', () => {
    const input = mountFocused('input', { type: 'text' })
    const event = press('keydown', { key: 'ArrowRight' }, input)
    expect(stepFrame).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('useTransportKeys 与其他按键消费者的让位', () => {
  it('已经被 preventDefault 的按键不再接手（分隔线调布局不会顺带推播放头）', () => {
    const separator = mountFocused('div', { role: 'separator' })
    const consume = (event: Event): void => {
      event.preventDefault()
    }
    separator.addEventListener('keydown', consume)
    const event = press('keydown', { key: 'ArrowRight' }, separator)
    expect(event.defaultPrevented).toBe(true)
    expect(stepFrame).not.toHaveBeenCalled()
    separator.removeEventListener('keydown', consume)
  })
})

describe('useTransportKeys 与门禁弹窗', () => {
  it('弹窗排队中空格与方向键都不生效', () => {
    useUiStore.setState({
      dialogQueue: [
        {
          id: 'p1',
          dialog: { kind: 'non169', label: '《a.mp4》非 16:9' },
          resolve: () => undefined
        }
      ]
    })
    const space = press('keydown', { key: ' ' })
    const arrow = press('keydown', { key: 'ArrowRight' })
    expect(togglePlay).not.toHaveBeenCalled()
    expect(stepFrame).not.toHaveBeenCalled()
    expect(space.defaultPrevented).toBe(false)
    expect(arrow.defaultPrevented).toBe(false)
  })
})
