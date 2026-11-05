import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { getPreset } from '@shared/presets'
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
    useUiStore.setState({ dialogQueue: [], notice: null, uiMode: 'basic', seekHandler: null })
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

  /**
   * 用户要求：改完参数预览区要**及时响应**。
   * 两件事缺一不可：写回的是真正偏离预设的差集（否则切预设时被旧值拖住），
   * 以及播放头落到能看清样式的帧（否则片段还没开始时预览看着毫无变化）。
   */
  it('改配色：只写偏离预设的令牌，并把播放头落到入场完成后的可见帧', () => {
    const project = seed(1)
    const clipId = project.clips[0]!.id
    const presetPrimary = getPreset(clipOf(clipId).presetId).tokens.primary
    const seeks: number[] = []

    act(() => {
      useUiStore.setState({ uiMode: 'advanced', displayTimeSec: 0, playing: false })
    })
    useUiStore.getState().setSeekHandler((sec: number) => {
      seeks.push(sec)
    })
    render(<ClipInspector />)
    fireEvent.click(screen.getByText(TEXT.inspector.color))

    fireEvent.change(screen.getByLabelText(TEXT.inspector.tokens.primary), { target: { value: '#101010' } })

    const after = clipOf(clipId)
    // 只有被改动的一个键进了覆盖，其余五个预设声明值一个都没写
    expect(after.styleOverrides.tokens).toEqual({ primary: '#101010' })
    // 播放头从 0s（入场未完）被带到入场完成后的第一帧
    expect(seeks).toEqual([after.startTime + after.animation.inDuration])

    // 改回预设声明色 = 撤销这一项，不能留下一个「看起来像自定义」的同值
    fireEvent.change(screen.getByLabelText(TEXT.inspector.tokens.primary), { target: { value: presetPrimary } })
    expect('tokens' in clipOf(clipId).styleOverrides).toBe(false)
  })

  it('恢复预设默认：先二次确认，确认后清空本条自定义并提示完成', async () => {
    const project = seed(1)
    const clipId = project.clips[0]!.id
    act(() => {
      useProjectStore.getState().updateClip(clipId, {
        styleOverrides: { tokens: { primary: '#101010' }, barOpacity: 0.5 }
      })
      useUiStore.setState({ uiMode: 'advanced' })
    })
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: /恢复预设默认/ }))
    const prompt = useUiStore.getState().dialogQueue[0]
    expect(prompt?.dialog.kind).toBe('confirm')
    // 确认之前不许生效
    expect(clipOf(clipId).styleOverrides.tokens?.primary).toBe('#101010')

    await act(async () => {
      prompt?.resolve('ok')
      useUiStore.getState().shiftPrompt()
    })

    expect(clipOf(clipId).styleOverrides).toEqual({})
    expect(useUiStore.getState().notice).toBe(TEXT.inspector.resetAllCustomDone)
    // 文字不属于样式，仍然保留
    expect(clipOf(clipId).content.title).toBe('第 1 段标题')
  })

  it('没有自定义时不显示「恢复预设默认」按钮', () => {
    seed(1)
    render(<ClipInspector />)
    expect(screen.queryByRole('button', { name: /恢复预设默认/ })).toBeNull()
  })
})

function clipOf(id: string) {
  return useProjectStore.getState().project.clips.find((clip) => clip.id === id)!
}
