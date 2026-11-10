import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import { createDefaultProject } from '@shared/projectSchema'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { TextElementsPanel } from './TextElementsPanel'

/** M7-D：左侧「包装」Tab 的文本元素列表（新增 / 选中并跳中点 / 删除）。 */

function fresh(): void {
  useProjectStore.setState({
    project: createDefaultProject('文本元素面板'),
    selectedClipId: null,
    selectedTextClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0
  })
  useUiStore.setState({ seekHandler: null, playing: false })
}

beforeEach(() => {
  fresh()
})

afterEach(() => {
  cleanup()
})

describe('TextElementsPanel', () => {
  it('空态：只有新增入口与空提示', () => {
    render(<TextElementsPanel />)
    expect(screen.getByText(TEXT.textElement.empty)).toBeTruthy()
    expect(screen.getByRole('button', { name: new RegExp(TEXT.textElement.add) })).toBeTruthy()
  })

  it('点新增：追加一条文本元素、选中，并把播放头带到区间中点', () => {
    const seek = vi.fn()
    act(() => useUiStore.setState({ seekHandler: seek }))
    render(<TextElementsPanel />)

    act(() => fireEvent.click(screen.getByRole('button', { name: new RegExp(TEXT.textElement.add) })))

    const clips = useProjectStore.getState().project.textClips ?? []
    expect(clips).toHaveLength(1)
    expect(useProjectStore.getState().selectedTextClipId).toBe(clips[0]!.id)
    expect(useProjectStore.getState().selectionKind).toBe('text')
    expect(seek).toHaveBeenCalledWith((clips[0]!.startTime + clips[0]!.endTime) / 2)
  })

  it('已有条目点选：选中并跳到中点；再点删除从工程里移除', () => {
    const seek = vi.fn()
    act(() => useUiStore.setState({ seekHandler: seek }))
    const clip = useProjectStore.getState().addTextClip({ at: 2, text: '今日头条' })!
    act(() => useProjectStore.getState().selectTextClip(null))
    render(<TextElementsPanel />)

    act(() => fireEvent.click(screen.getByRole('button', { name: new RegExp('今日头条') })))
    expect(useProjectStore.getState().selectedTextClipId).toBe(clip.id)
    expect(seek).toHaveBeenCalledWith((clip.startTime + clip.endTime) / 2)

    act(() => fireEvent.click(screen.getByRole('button', { name: TEXT.textElement.remove })))
    expect(useProjectStore.getState().project.textClips).toBeUndefined()
  })
})
