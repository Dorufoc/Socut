import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { Project } from '@shared/types'
import { ClipInspector } from './ClipInspector'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 右侧「当前字幕条」检查器（时间轴 / 预览选中后的唯一编辑入口）。
 * 测的是两个用户可见契约：
 * 1) 显示与修改都只跟当前选中的那一条走；
 * 2) 「把样式应用到全部字幕条」复制除文字外的所有内容，且必须二次确认。
 */

function seed(clipCount = 2): Project {
  const project = createDefaultProject('检查器测试')
  project.fps = FPS_30
  project.clips = Array.from({ length: clipCount }, (_, index) => {
    const clip = createClip({ startTime: index * 4, fps: FPS_30 })
    clip.content = { title: `第 ${index + 1} 段标题`, subtitle: `第 ${index + 1} 段副标题` }
    return clip
  })
  useProjectStore.setState({ project, selectedClipId: project.clips[0]!.id, fonts: [] })
  return project
}

afterEach(() => {
  cleanup()
  act(() => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
    useUiStore.setState({ dialogQueue: [], notice: null, uiMode: 'basic' })
  })
})

describe('ClipInspector（右侧当前字幕条）', () => {
  it('未选中任何片段时给出可操作的提示，而不是空白面板', () => {
    seed()
    useProjectStore.setState({ selectedClipId: null })
    render(<ClipInspector />)
    expect(screen.getByText(TEXT.inspector.selectedClip)).toBeTruthy()
    expect(screen.getByText(TEXT.inspector.noneSelectedHint)).toBeTruthy()
    // 片段还在，只是没有选中项
    expect(useProjectStore.getState().project.clips).toHaveLength(2)
  })

  it('显示当前片段的序号 / 预设 / 时间码，且只影响该片段的编辑入口', () => {
    const project = seed(3)
    useProjectStore.getState().selectClip(project.clips[1]!.id)
    render(<ClipInspector />)
    expect(screen.getByText(/第 2 \/ 3 段/)).toBeTruthy()
    // 副标题输入框显示的是第 2 段自己的文字
    const boxes = screen.getAllByRole('textbox') as HTMLTextAreaElement[]
    expect(boxes[0]!.value).toBe('第 2 段标题')
    expect(boxes[1]!.value).toBe('第 2 段副标题')
  })

  it('改文字只写当前片段，其他片段不受影响', () => {
    seed(2)
    render(<ClipInspector />)
    const [titleBox] = screen.getAllByRole('textbox') as HTMLTextAreaElement[]
    fireEvent.change(titleBox!, { target: { value: '只改第一段' } })
    const clips = useProjectStore.getState().project.clips
    expect(clips[0]!.content.title).toBe('只改第一段')
    expect(clips[1]!.content.title).toBe('第 2 段标题')
  })

  it('应用到全部：先弹二次确认；确认后预设/配色/字号复制到其余片段，文字保留', async () => {
    const project = seed(3)
    const source = project.clips[0]!
    useProjectStore.getState().updateClip(source.id, {
      presetId: 'breakingRed',
      styleOverrides: { tokens: { primary: '#101010' }, barOpacity: 0.8, fontScale: { title: 1.3 } }
    })
    render(<ClipInspector />)

    fireEvent.click(screen.getByText(TEXT.inspector.applyAll))
    const prompt = useUiStore.getState().dialogQueue[0]
    expect(prompt?.dialog.kind).toBe('confirm')
    // 确认之前不许生效
    expect(useProjectStore.getState().project.clips[1]!.presetId).not.toBe('breakingRed')

    await act(async () => {
      prompt?.resolve('ok')
      useUiStore.getState().shiftPrompt()
    })

    const clips = useProjectStore.getState().project.clips
    for (const clip of clips.slice(1)) {
      expect(clip.presetId).toBe('breakingRed')
      expect(clip.styleOverrides.tokens?.primary).toBe('#101010')
      expect(clip.styleOverrides.barOpacity).toBe(0.8)
      expect(clip.styleOverrides.fontScale?.title).toBe(1.3)
      // 文字与入出点保留
      expect(clip.content.title.startsWith('第 ')).toBe(true)
    }
    expect(clips[1]!.content.title).toBe('第 2 段标题')
    expect(useUiStore.getState().notice).toBe(TEXT.inspector.applyAllDone(2))
  })

  it('取消确认时一个片段都不改', async () => {
    const project = seed(2)
    useProjectStore.getState().updateClip(project.clips[0]!.id, { presetId: 'breakingRed' })
    render(<ClipInspector />)
    fireEvent.click(screen.getByText(TEXT.inspector.applyAll))
    const prompt = useUiStore.getState().dialogQueue[0]
    await act(async () => {
      prompt?.resolve('cancel')
      useUiStore.getState().shiftPrompt()
    })
    expect(useProjectStore.getState().project.clips[1]!.presetId).toBe('stackedNews')
  })

  it('只有一个片段时不弹确认，直接提示无需应用', () => {
    seed(1)
    render(<ClipInspector />)
    fireEvent.click(screen.getByText(TEXT.inspector.applyAll))
    expect(useUiStore.getState().dialogQueue).toHaveLength(0)
    expect(useUiStore.getState().notice).toBe(TEXT.inspector.applyAllNoTarget)
  })

  it('基础模式只给入口；点击后进入高级模式，折叠区可展开', () => {
    seed()
    render(<ClipInspector />)
    // 基础模式不出现配色/字体/动画面板的标题
    expect(screen.queryByText(TEXT.inspector.color)).toBeNull()

    fireEvent.click(screen.getByText('更多样式设置'))
    expect(useUiStore.getState().uiMode).toBe('advanced')
    expect(screen.getByText('高级模式')).toBeTruthy()

    const colorHeader = screen.getByText(TEXT.inspector.color).closest('button')
    expect(colorHeader?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByText(TEXT.inspector.color))
    expect(colorHeader?.getAttribute('aria-expanded')).toBe('true')
    expect(colorHeader?.closest('.expander')?.className).toContain('expander--open')
  })
})
