import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_CLIP_DURATION_SEC, FPS_30 } from '@shared/constants'
import { DEFAULT_PRESET_ID } from '@shared/presets'
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
describe('M11 字幕导入', () => {
  it('导入 SRT：按文件时间码生成字幕条并提示条数', async () => {
    const project = createDefaultProject('导入')
    project.fps = FPS_30
    useProjectStore.setState({ project, selectedClipId: null, selectionKind: 'subtitle', fonts: [] })
    render(<CaptionListPanel />)

    const input = screen.getByLabelText(TEXT.captions.importSubtitle) as HTMLInputElement
    const file = new File(['1\n00:00:01,000 --> 00:00:03,000\n今日头条\n\n2\n00:00:04,000 --> 00:00:06,000\n第二条\n'], 'a.srt', {
      type: 'text/plain'
    })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
      await Promise.resolve()
    })

    const clips = useProjectStore.getState().project.clips
    expect(clips).toHaveLength(2)
    expect(clips[0]!.content.title).toBe('今日头条')
    expect(clips[1]!.startTime).toBe(4)
    expect(useUiStore.getState().notice).toContain('已导入 2 条字幕')
  })

  it('导入 CSV 名单：首尾相接生成字幕条', async () => {
    const project = createDefaultProject('导入名单')
    project.fps = FPS_30
    useProjectStore.setState({ project, selectedClipId: null, selectionKind: 'subtitle', fonts: [] })
    render(<CaptionListPanel />)

    const input = screen.getByLabelText(TEXT.captions.importList) as HTMLInputElement
    const file = new File(['标题,副标题,时长\n张伟,主任,4\n李娜,记者,2'], 'list.csv', { type: 'text/csv' })
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
      await Promise.resolve()
    })

    const clips = useProjectStore.getState().project.clips
    expect(clips).toHaveLength(2)
    expect(clips[0]!.content).toEqual({ title: '张伟', subtitle: '主任' })
    expect(clips[0]!.endTime - clips[0]!.startTime).toBe(4)
    expect(clips[1]!.startTime).toBe(4)
    expect(useUiStore.getState().notice).toContain('已生成 2 条字幕')
  })

  it('字幕后处理区有「自动字幕」入口：未选中媒体片段时禁用并提示先选片段', () => {
    seed()
    render(<CaptionListPanel />)

    const button = screen.getByRole('button', { name: TEXT.captions.autoCaption }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText(TEXT.captions.autoCaptionNoMedia)).toBeTruthy()
  })
})

describe('M11-I 字幕批量编辑（多选 + 批量预设/时长/删除/开关）', () => {
  /** 进入批量态（工具栏与勾选框随后出现） */
  const enterBatch = (): void => {
    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.batchMode }))
  }

  /** 点卡片 = 勾选（批量态下不跳转、不改单条选中） */
  const clickCard = (title: string): void => {
    fireEvent.click(screen.getByText(title))
  }

  const countChip = (n: number): HTMLElement => screen.getByText(TEXT.captions.batchSelectedCount(n))

  it('进入批量：出现工具栏；卡片点击变为勾选（不跳转、不改单条选中）', () => {
    const project = seed()
    const seek = vi.fn()
    useUiStore.getState().setSeekHandler(seek)
    render(<CaptionListPanel />)

    enterBatch()

    expect(screen.getByRole('group', { name: TEXT.captions.batchGroup })).toBeTruthy()
    expect(countChip(0)).toBeTruthy()

    clickCard('第二条：汛期防御启动')

    // 勾选 ≠ 选中：播放头不动、右侧检查器的单条选中不变
    expect(seek).not.toHaveBeenCalled()
    expect(useProjectStore.getState().selectedClipId).toBe(project.clips[1]!.id)
    expect(countChip(1)).toBeTruthy()
    const checkbox = screen.getByRole('checkbox', {
      name: TEXT.captions.selectNamed('第二条：汛期防御启动')
    }) as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    // 退出批量：工具栏收起、勾选清空
    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.batchModeExit }))
    expect(screen.queryByRole('group', { name: TEXT.captions.batchGroup })).toBeNull()
  })

  it('批量改预设：只改勾选的两条，未选中的保持原预设', () => {
    seed()
    render(<CaptionListPanel />)
    enterBatch()
    clickCard('第一条：长三角一体化新规')
    clickCard('第三条：地铁新线开通')

    fireEvent.change(screen.getByLabelText(TEXT.captions.batchPreset), { target: { value: 'breakingRed' } })
    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.batchApplyPreset }))

    const clips = useProjectStore.getState().project.clips
    const first = clips.find((clip) => clip.content.title.startsWith('第一条'))!
    const second = clips.find((clip) => clip.content.title.startsWith('第二条'))!
    const third = clips.find((clip) => clip.content.title.startsWith('第三条'))!
    expect(first.presetId).toBe('breakingRed')
    expect(third.presetId).toBe('breakingRed')
    expect(second.presetId).toBe(DEFAULT_PRESET_ID)
    expect(useUiStore.getState().notice).toContain('已为 2 条字幕应用预设')
  })

  it('统一时长：从各自入点顺延、出点吸附帧边界', () => {
    const project = seed()
    render(<CaptionListPanel />)
    enterBatch()
    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.batchSelectAll }))

    // 30fps 下 2.017s 吸附到 61 帧
    fireEvent.change(screen.getByLabelText(TEXT.captions.batchDuration), { target: { value: '2.017' } })
    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.batchApplyDuration }))

    const clips = useProjectStore.getState().project.clips
    for (const clip of clips) {
      expect(clip.endTime - clip.startTime).toBeCloseTo(61 / 30, 6)
    }
    // 入点一律不动（批量只改时长）
    for (const before of project.clips) {
      const after = clips.find((clip) => clip.id === before.id)!
      expect(after.startTime).toBe(before.startTime)
    }
    expect(useUiStore.getState().notice).toContain('已统一 3 条字幕的时长')
  })

  it('批量删除：只删勾选条目、清空勾选，选中态不留在已删片段上', () => {
    seed()
    render(<CaptionListPanel />)
    enterBatch()
    clickCard('第一条：长三角一体化新规')
    clickCard('第二条：汛期防御启动')

    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.batchDelete }))

    const clips = useProjectStore.getState().project.clips
    expect(clips).toHaveLength(1)
    expect(clips[0]!.content.title).toContain('第三条')
    expect(countChip(0)).toBeTruthy()
    // 删掉的包含原来选中的 0s 条 → 选中态已挪到剩余那条
    expect(useProjectStore.getState().selectedClipId).toBe(clips[0]!.id)
    expect(useUiStore.getState().notice).toContain('已删除 2 条字幕')
  })

  it('切换单条选中后批量勾选清空（旧 id 不再属于当前操作面）', () => {
    const project = seed()
    render(<CaptionListPanel />)
    enterBatch()
    clickCard('第一条：长三角一体化新规')
    clickCard('第二条：汛期防御启动')
    expect(countChip(2)).toBeTruthy()

    const other = project.clips.find((clip) => clip.content.title.startsWith('第三条'))!
    act(() => {
      useProjectStore.getState().selectClip(other.id)
    })

    expect(countChip(0)).toBeTruthy()
    const checkbox = screen.getByRole('checkbox', {
      name: TEXT.captions.selectNamed('第一条：长三角一体化新规')
    }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)
  })

  it('批量开关「强制紧凑」：开 → 全部写 true；关 → 删键', () => {
    seed()
    render(<CaptionListPanel />)
    enterBatch()
    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.batchSelectAll }))

    const compact = screen.getByRole('checkbox', { name: TEXT.captions.batchCompact }) as HTMLInputElement
    expect(compact.checked).toBe(false)

    fireEvent.click(compact)
    expect(useProjectStore.getState().project.clips.every((clip) => clip.styleOverrides.compact === true)).toBe(true)
    expect(compact.checked).toBe(true)

    fireEvent.click(compact)
    expect(
      useProjectStore.getState().project.clips.every((clip) => !('compact' in clip.styleOverrides))
    ).toBe(true)
    expect(compact.checked).toBe(false)
  })

  it('未勾选任何条目时批量按钮禁用、常驻提示', () => {
    seed()
    render(<CaptionListPanel />)
    enterBatch()

    expect(screen.getByText(TEXT.captions.batchEmptyHint)).toBeTruthy()
    expect((screen.getByRole('button', { name: TEXT.captions.batchApplyPreset }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: TEXT.captions.batchApplyDuration }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: TEXT.captions.batchDelete }) as HTMLButtonElement).disabled).toBe(true)
  })
})