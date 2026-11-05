import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { Project, SubtitleClip } from '@shared/types'
import { CaptionListPanel } from './CaptionListPanel'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 左侧「字幕」Tab（v4）：按时间顺序列出全部已添加标题，点一条 = 选中 + 跳到入点。
 * 这里锁住四条契约：排序、内容（主标题 + 副标题）、跳转与暂停接管、选中/正在显示态。
 */

function clipAt(start: number, title: string, subtitle: string): SubtitleClip {
  const clip = createClip({ startTime: start, fps: FPS_30 })
  clip.content = { title, subtitle }
  return clip
}

/** 故意乱序写入工程：面板必须自己按时间顺序排（这是它的契约，不是 store 的顺序）。 */
function seed(): Project {
  const project = createDefaultProject('字幕列表')
  project.fps = FPS_30
  project.clips = [
    clipAt(12, '第三条：地铁新线开通', '市交通委发布'),
    clipAt(0, '第一条：长三角一体化新规', '省发展改革委解读'),
    clipAt(6, '第二条：汛期防御启动', '省应急管理厅')
  ]
  useProjectStore.setState({ project, selectedClipId: project.clips[1]!.id, fonts: [] })
  return project
}

afterEach(() => {
  cleanup()
  act(() => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
    useUiStore.setState({ displayTimeSec: 0, playing: false, seekHandler: null, notice: null })
  })
})

describe('CaptionListPanel（字幕列表 Tab）', () => {
  it('按时间顺序列出全部标题，每项都带主标题与副标题', () => {
    seed()
    const { container } = render(<CaptionListPanel />)

    const titles = [...container.querySelectorAll('.caption-item__title')].map((node) => node.textContent)
    expect(titles).toEqual(['第一条：长三角一体化新规', '第二条：汛期防御启动', '第三条：地铁新线开通'])
    const subs = [...container.querySelectorAll('.caption-item__sub')].map((node) => node.textContent)
    expect(subs).toEqual(['省发展改革委解读', '省应急管理厅', '市交通委发布'])
    expect(screen.getByText('3 条')).toBeTruthy()
  })

  it('点击一条：选中它并把播放头跳到它的入点（预览与时间轴同步）', () => {
    const project = seed()
    const seek = vi.fn()
    useUiStore.getState().setSeekHandler(seek)
    render(<CaptionListPanel />)

    fireEvent.click(screen.getByText('第二条：汛期防御启动'))

    const second = project.clips[2]!
    expect(useProjectStore.getState().selectedClipId).toBe(second.id)
    expect(seek).toHaveBeenCalledWith(second.startTime)
  })

  it('播放中点击先暂停：否则跳过去立刻被时钟带走，看不出跳到入点', () => {
    const project = seed()
    const seek = vi.fn()
    act(() => {
      useUiStore.setState({ playing: true, seekHandler: seek })
    })
    render(<CaptionListPanel />)

    fireEvent.click(screen.getByText('第三条：地铁新线开通'))

    expect(useUiStore.getState().playing).toBe(false)
    expect(seek).toHaveBeenCalledWith(project.clips[0]!.startTime)
  })

  it('没有 seekHandler（预览还没挂载）时仍然选中，不抛异常', () => {
    const project = seed()
    render(<CaptionListPanel />)

    fireEvent.click(screen.getByText('第一条：长三角一体化新规'))

    expect(useProjectStore.getState().selectedClipId).toBe(project.clips[1]!.id)
  })

  it('播放头落在区间内的那条标为「正在显示」，区间外的不标', () => {
    seed()
    act(() => {
      useUiStore.setState({ displayTimeSec: 7 })
    })
    const { container } = render(<CaptionListPanel />)

    const items = [...container.querySelectorAll('.caption-item')]
    expect(items).toHaveLength(3)
    // 第二条占 6→10s：7s 落在它里面
    expect(items[1]!.className).toContain('caption-item--onair')
    expect(items[1]!.textContent).toContain(TEXT.captions.onAir)
    expect(items[0]!.className).not.toContain('caption-item--onair')
    expect(items[2]!.className).not.toContain('caption-item--onair')
  })

  it('当前选中项带 aria-pressed，与右侧检查器指向同一条', () => {
    const project = seed()
    render(<CaptionListPanel />)

    const active = screen.getByRole('button', { pressed: true })
    expect(active.textContent).toContain('第一条：长三角一体化新规')
    expect(active.className).toContain('caption-item--active')
    expect(useProjectStore.getState().selectedClipId).toBe(project.clips[1]!.id)
  })

  it('工程里没有字幕条时给出可操作的空态，而不是空白面板', () => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
    render(<CaptionListPanel />)

    expect(screen.getByText(TEXT.captions.empty)).toBeTruthy()
    expect(screen.queryAllByText('第二条：汛期防御启动')).toHaveLength(0)
    expect(screen.getByText('0 条')).toBeTruthy()
  })
})
