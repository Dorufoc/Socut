import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import { createDefaultProject } from '@shared/projectSchema'
import { useProjectStore } from '../state/projectStore'
import { TextElementInspector } from './TextElementInspector'

/** M7-D：文本元素检查器（文字/预设/时间/样式/背景板/动画/删除）。 */

function seed(): string {
  useProjectStore.setState({
    project: createDefaultProject('文本元素检查器'),
    selectedClipId: null,
    selectedTextClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0
  })
  const clip = useProjectStore.getState().addTextClip({ at: 1, text: '今日头条' })!
  return clip.id
}

const clipOf = (id: string) => (useProjectStore.getState().project.textClips ?? []).find((item) => item.id === id)!

beforeEach(() => {
  seed()
})

afterEach(() => {
  cleanup()
})

describe('TextElementInspector', () => {
  it('文字修改写回工程', () => {
    const id = useProjectStore.getState().selectedTextClipId!
    render(<TextElementInspector />)
    const textarea = screen.getByLabelText(TEXT.textElement.text) as HTMLTextAreaElement
    expect(textarea.value).toBe('今日头条')

    act(() => fireEvent.change(textarea, { target: { value: '新的标题' } }))
    expect(clipOf(id).text).toBe('新的标题')
  })

  it('切预设：换 presetId 并清空旧覆盖（回到预设默认）', () => {
    const id = useProjectStore.getState().selectedTextClipId!
    act(() => useProjectStore.getState().updateTextClip(id, { styleOverrides: { sizePx: 120 } }))
    render(<TextElementInspector />)

    const preset = screen.getByLabelText(TEXT.textElement.preset) as HTMLSelectElement
    act(() => fireEvent.change(preset, { target: { value: 'quoteCard' } }))
    expect(clipOf(id).presetId).toBe('quoteCard')
    expect(clipOf(id).styleOverrides).toEqual({})
  })

  it('入点/出点可改；出点过小被归一夹到最短时长', () => {
    const id = useProjectStore.getState().selectedTextClipId!
    render(<TextElementInspector />)

    const start = screen.getByLabelText(TEXT.textElement.inPoint) as HTMLInputElement
    act(() => fireEvent.change(start, { target: { value: '3' } }))
    expect(clipOf(id).startTime).toBe(3)

    const end = screen.getByLabelText(TEXT.textElement.outPoint) as HTMLInputElement
    act(() => fireEvent.change(end, { target: { value: '3.01' } }))
    expect(clipOf(id).endTime).toBeGreaterThan(clipOf(id).startTime)
  })

  it('字号滑杆写入 styleOverrides（只存偏离预设的部分）', () => {
    const id = useProjectStore.getState().selectedTextClipId!
    render(<TextElementInspector />)

    const size = screen.getByRole('slider', { name: TEXT.textElement.size })
    act(() => fireEvent.change(size, { target: { value: '120' } }))
    expect(clipOf(id).styleOverrides.sizePx).toBe(120)
  })

  it('开启背景板：写入 plate.enabled，且只覆盖这一项（预设底色不丢）', () => {
    const id = useProjectStore.getState().selectedTextClipId!
    render(<TextElementInspector />)

    act(() => fireEvent.click(screen.getByLabelText(TEXT.textElement.plateEnabled)))
    expect(clipOf(id).styleOverrides.plate).toEqual({ enabled: true })

    // 再改透明度：plate 是部分覆盖，不把 enabled 冲掉
    const opacity = screen.getByRole('slider', { name: TEXT.textElement.plateOpacity })
    act(() => fireEvent.change(opacity, { target: { value: '0.5' } }))
    expect(clipOf(id).styleOverrides.plate).toEqual({ enabled: true, opacity: 0.5 })
  })

  it('删除按钮把文本元素移出工程', () => {
    render(<TextElementInspector />)
    act(() => fireEvent.click(screen.getByRole('button', { name: TEXT.textElement.remove })))
    expect(useProjectStore.getState().project.textClips).toBeUndefined()
  })
})
