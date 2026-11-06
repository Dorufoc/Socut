import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_CLIP_DURATION_SEC, FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { Project, SubtitleClip } from '@shared/types'
import { CaptionListPanel } from './CaptionListPanel'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { attachProjectHistory, useHistoryStore } from '../state/projectHistory'

/**
 * 左侧「字幕」Tab（P2：新建/删除合并到这里）：
 * 按时间顺序列出全部字幕条，点一条 = 选中 + 跳到**区间中点**；
 * 0 条时整块面板就是新建入口（大虚线加号），有字幕时列表末尾常驻虚线加号条；
 * 每张卡片自带删除按钮（SVG 垃圾桶），删掉后靠项目级撤销找回。
 * 这里锁住：排序、内容、中点跳转与暂停接管、选中/正在显示态、两个新建入口、删除与撤销。
 */

/** 默认新建时长下的中点：入点 + 半个条长 */
const mid = (startSec: number): number => startSec + DEFAULT_CLIP_DURATION_SEC / 2

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

  it('点击一条：选中它并把播放头跳到它的区间中点（预览与时间轴同步）', () => {
    const project = seed()
    const seek = vi.fn()
    useUiStore.getState().setSeekHandler(seek)
    render(<CaptionListPanel />)

    fireEvent.click(screen.getByText('第二条：汛期防御启动'))

    const second = project.clips[2]!
    expect(useProjectStore.getState().selectedClipId).toBe(second.id)
    // 中点天然落在「入场完成→出场开始」窗口内，预览一定看得见完整样式
    expect(seek).toHaveBeenCalledWith(mid(second.startTime))
  })

  it('播放中点击先暂停：否则跳过去立刻被时钟带走，看不出跳到中点', () => {
    const project = seed()
    const seek = vi.fn()
    act(() => {
      useUiStore.setState({ playing: true, seekHandler: seek })
    })
    render(<CaptionListPanel />)

    fireEvent.click(screen.getByText('第三条：地铁新线开通'))

    expect(useUiStore.getState().playing).toBe(false)
    expect(seek).toHaveBeenCalledWith(mid(project.clips[0]!.startTime))
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
    // 选中态在卡片行容器上（左边那一条强调色），按钮只是行里的点击区
    expect((active.closest('.caption-item') as HTMLElement).className).toContain('caption-item--active')
    expect(useProjectStore.getState().selectedClipId).toBe(project.clips[1]!.id)
  })

  it('工程里没有字幕条时，整块面板就是新建入口（大虚线加号）', () => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
    const { container } = render(<CaptionListPanel />)

    expect(screen.getByText('0 条')).toBeTruthy()
    expect(container.querySelector('.caption-add--hero')).toBeTruthy()
    expect(screen.queryAllByText('第二条：汛期防御启动')).toHaveLength(0)
  })

  it('点空态的大加号：新建一条、选中它，并把播放头跳到这条的中点', () => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
    const seek = vi.fn()
    useUiStore.getState().setSeekHandler(seek)
    const { container } = render(<CaptionListPanel />)

    fireEvent.click(container.querySelector('.caption-add--hero')!)

    const created = useProjectStore.getState().project.clips[0]!
    expect(useProjectStore.getState().project.clips).toHaveLength(1)
    expect(useProjectStore.getState().selectedClipId).toBe(created.id)
    expect(seek).toHaveBeenCalledWith(mid(created.startTime))
  })

  it('有字幕时列表末尾常驻虚线加号条，点它继续往后接一条', () => {
    seed()
    const seek = vi.fn()
    useUiStore.getState().setSeekHandler(seek)
    const { container } = render(<CaptionListPanel />)

    const rows = container.querySelectorAll('.caption-item')
    expect(rows).toHaveLength(3)
    // 有字幕时空态大加号让位给列表末尾那条矮加号条
    expect(container.querySelector('.caption-add--hero')).toBeNull()

    fireEvent.click(container.querySelector('.caption-add')!)

    const clips = useProjectStore.getState().project.clips
    expect(clips).toHaveLength(4)
    const created = clips[3]!
    expect(useProjectStore.getState().selectedClipId).toBe(created.id)
    expect(seek).toHaveBeenCalledWith(mid(created.startTime))
  })

  it('每张卡片都有删除按钮，点它只删那一条且不会顺带选中别的条', () => {
    const project = seed()
    const target = project.clips.find((clip) => clip.content.title === '第二条：汛期防御启动')!
    act(() => {
      useProjectStore.setState({ selectedClipId: target.id })
    })
    render(<CaptionListPanel />)

    const removeButtons = screen.getAllByRole('button', { name: /^删除字幕条/ })
    expect(removeButtons).toHaveLength(3)
    // 列表按时间排序：6s 的「第二条」在卡片里排第二
    expect(removeButtons[1]!.getAttribute('aria-label')).toBe(TEXT.captions.removeNamed(target.content.title))

    fireEvent.click(removeButtons[1]!)

    const left = useProjectStore.getState().project.clips
    expect(left).toHaveLength(2)
    expect(left.some((clip) => clip.id === target.id)).toBe(false)
    // 选中不会落在已删的那条上，也不会因此把播放头推到别处
    const selected = useProjectStore.getState().selectedClipId
    expect(selected).not.toBe(target.id)
    expect(left.some((clip) => clip.id === selected)).toBe(true)
  })

  it('删掉的这条能靠项目级撤销找回来，连选中一起恢复', () => {
    const project = seed()
    const detach = attachProjectHistory()
    try {
      const third = project.clips[0]! // 排序后是第三条（写入顺序 12s 那条）
      act(() => {
        useProjectStore.setState({ selectedClipId: third.id })
      })
      render(<CaptionListPanel />)

      fireEvent.click(screen.getAllByRole('button', { name: /^删除字幕条/ })[2]!)
      expect(useProjectStore.getState().project.clips).toHaveLength(2)

      useHistoryStore.getState().undo()

      expect(useProjectStore.getState().project.clips).toHaveLength(3)
      expect(useProjectStore.getState().selectedClipId).toBe(third.id)
    } finally {
      detach()
    }
  })
})
