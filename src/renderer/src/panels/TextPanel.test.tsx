import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import { FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { TextPanel } from './TextPanel'
import { useProjectStore } from '../state/projectStore'

/** 文案输入面板（计划 M2-4）：输入必须落到工程状态的 content，不影响时间轴。 */

function seedClip(): string {
  const project = createDefaultProject('文案面板测试')
  const clip = createClip({ startTime: 0, fps: FPS_30 })
  project.clips = [clip]
  useProjectStore.setState({ project, selectedClipId: clip.id, fonts: [] })
  return clip.id
}

function clipContent(clipId: string): { title: string; subtitle: string } | undefined {
  return useProjectStore.getState().project.clips.find((clip) => clip.id === clipId)?.content
}

afterEach(() => {
  cleanup()
  useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
})

describe('TextPanel（标题 / 副标题输入）', () => {
  it('输入标题与副标题都写入工程，且时间轴不被改动', () => {
    const clipId = seedClip()
    const before = useProjectStore.getState().project.clips[0]!
    render(<TextPanel />)
    const [title, subtitle] = screen.getAllByRole('textbox')
    fireEvent.change(title!, { target: { value: '长三角一体化新规发布' } })
    fireEvent.change(subtitle!, { target: { value: '省发展改革委负责人解读' } })
    expect(clipContent(clipId)).toEqual({
      title: '长三角一体化新规发布',
      subtitle: '省发展改革委负责人解读'
    })
    const after = useProjectStore.getState().project.clips[0]!
    expect(after.startTime).toBe(before.startTime)
    expect(after.endTime).toBe(before.endTime)
  })

  it('长标题可以整段存入（换行与省略由排版层决定，不在输入层截断）', () => {
    const clipId = seedClip()
    const long = '长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(2)
    render(<TextPanel />)
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: long } })
    expect(clipContent(clipId)?.title).toBe(long)
    expect(clipContent(clipId)?.title.length).toBeGreaterThan(40)
  })

  it('没有选中片段时输入框禁用且提示文案存在', () => {
    const project = createDefaultProject('无选中')
    project.clips = [createClip({ startTime: 0, fps: FPS_30 })]
    useProjectStore.setState({ project, selectedClipId: null, fonts: [] })
    render(<TextPanel />)
    for (const box of screen.getAllByRole('textbox')) {
      expect((box as HTMLTextAreaElement).disabled).toBe(true)
    }
    expect(screen.getByText(TEXT.inspector.text)).toBeTruthy()
  })
})
