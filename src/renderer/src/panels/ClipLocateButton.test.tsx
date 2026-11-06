import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import { ClipLocateButton } from './ClipLocateButton'
import { useUiStore } from '../state/uiStore'

/**
 * 「定位到这一段」（P5）：点段落不再顺带跳播放头之后，右侧编辑器要给用户一个明确的入口
 * 把画面带到选中的那一段上，否则会出现「在改这条、预览里却没有这条」。
 *
 * 锁三件事：段外才出现、点击跳到该段**中点**、跳转前先接管播放时钟。
 */

afterEach(() => {
  cleanup()
  act(() => {
    useUiStore.setState({ displayTimeSec: 0, playing: false, seekHandler: null, notice: null })
  })
})

describe('ClipLocateButton', () => {
  it('播放头已经在这一段区间内：不出现（没必要定位）', () => {
    act(() => useUiStore.setState({ displayTimeSec: 4 }))
    const { container } = render(<ClipLocateButton startSec={2} endSec={8} />)

    expect(container.querySelector('button')).toBeNull()
  })

  it('播放头在段外时出现，点击跳到该段中点', () => {
    const seek = vi.fn()
    act(() => useUiStore.setState({ displayTimeSec: 20, seekHandler: seek }))
    render(<ClipLocateButton startSec={2} endSec={8} />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.inspector.locate }))

    expect(seek).toHaveBeenCalledWith(5)
  })

  it('区间边界按「出点不在段内」算：正好停在出点上仍然给定位', () => {
    const seek = vi.fn()
    act(() => useUiStore.setState({ displayTimeSec: 8, seekHandler: seek }))

    render(<ClipLocateButton startSec={2} endSec={8} />)

    expect(screen.getByRole('button', { name: TEXT.inspector.locate })).toBeTruthy()
  })

  it('播放中先暂停再跳：否则跳过去立刻被时钟带走', () => {
    const seek = vi.fn()
    act(() => useUiStore.setState({ displayTimeSec: 20, playing: true, seekHandler: seek }))
    render(<ClipLocateButton startSec={2} endSec={8} />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.inspector.locate }))

    expect(useUiStore.getState().playing).toBe(false)
    expect(seek).toHaveBeenCalledWith(5)
  })

  it('预览还没挂载（没有 seekHandler）时不抛异常，也不假装跳了', () => {
    act(() => useUiStore.setState({ displayTimeSec: 20, seekHandler: null }))
    render(<ClipLocateButton startSec={2} endSec={8} />)

    expect(() => fireEvent.click(screen.getByRole('button', { name: TEXT.inspector.locate }))).not.toThrow()
  })
})
