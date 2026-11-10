import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createDefaultProject } from '@shared/projectSchema'
import type { MediaClip, MediaItem, Project, VideoMeta } from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { TRANSITION_LONG_PRESS_MS, TransitionPanel, junctionClipIdAtPoint } from './TransitionPanel'

/**
 * v11：左侧「转场」Tab 的交互契约。
 *
 * 1. 19 种样式按族分组展示；点击不再「对片段生效」，只提示怎么拖（或替换已选中转场）；
 * 2. 长按 280ms 才进入拖拽：短按释放、长按前移动超阈值都不产生拖拽；
 * 3. 拖拽幽灵跟随指针（portal 到 body，pointer-events: none）；
 * 4. 松手读取时间轴写入的缝隙落点：命中就落库并自动选中，未命中只提示不写工程。
 */

function meta(): VideoMeta {
  return {
    path: 'C:/media/a.mp4',
    containerName: 'mp4',
    width: 1920,
    height: 1080,
    sar: null,
    displayRatio: 1920 / 1080,
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 },
    pixFmt: 'yuv420p',
    colorPrimaries: null,
    colorSpace: null,
    colorTransfer: null,
    colorRange: null,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioChannels: 2,
    durationSec: 30,
    nbFrames: null,
    bitRateKbps: null
  }
}

function seedProject(): Project {
  const project = createDefaultProject('转场面板')
  project.fps = FPS_30
  const item: MediaItem = {
    id: 'media-1',
    path: 'C:/media/a.mp4',
    name: 'a.mp4',
    meta: meta(),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
  // A [0,2] 源 0→2；B 紧贴 A 且源入点 2（两侧都有转场手柄）
  const a: MediaClip = {
    id: 'a',
    mediaId: item.id,
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 0,
    sourceOutSec: 2
  }
  const b: MediaClip = {
    id: 'b',
    mediaId: item.id,
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: 2,
    timelineEndSec: 4,
    sourceInSec: 2,
    sourceOutSec: 4
  }
  project.media = [item]
  project.mediaClips = [a, b]
  useProjectStore.setState({
    project,
    selectedTransitionClipId: null,
    selectedMediaClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 1
  })
  return project
}

const clipOf = (id: string) => useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!

/** 按下样式卡并让长按计时器走完；返回该按钮，后续用例自己决定松手位置。 */
function longPressStyle(label: string): HTMLButtonElement {
  const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
  fireEvent.pointerDown(button, { pointerId: 1, button: 0, clientX: 40, clientY: 40 })
  act(() => {
    vi.advanceTimersByTime(TRANSITION_LONG_PRESS_MS)
  })
  return button
}

beforeEach(() => {
  vi.useFakeTimers()
  seedProject()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  act(() => {
    useProjectStore.setState({
      project: createDefaultProject('空'),
      selectedTransitionClipId: null,
      selectedMediaClipId: null,
      selectionKind: 'subtitle',
      fonts: []
    })
    useUiStore.setState({ notice: null, transitionDrag: null, transitionDropClipId: null })
  })
})

describe('转场样式面板（v11）', () => {
  it('19 种样式按族分组展示，并且不再跟随某个片段选中', () => {
    const { container } = render(<TransitionPanel />)

    expect(container.querySelectorAll('[data-transition-type]')).toHaveLength(59)
    expect(container.querySelectorAll('.transition-panel__group')).toHaveLength(10)
    // 分组标题（基础 / 模糊 / 运镜等）都在
    expect(screen.getByText('基础')).toBeTruthy()
    expect(screen.getByText('运镜')).toBeTruthy()
    expect(screen.getByText(TEXT.transition.panelHint)).toBeTruthy()
  })

  it('短按（长按计时未到）不进入拖拽，只提示用法', () => {
    render(<TransitionPanel />)
    const button = screen.getByRole('button', { name: '溶解' }) as HTMLButtonElement

    fireEvent.pointerDown(button, { pointerId: 2, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 10, clientY: 10 })

    expect(useUiStore.getState().transitionDrag).toBeNull()
    expect(useUiStore.getState().notice).toBeNull()
    fireEvent.click(button)
    expect(useUiStore.getState().notice).toBe(TEXT.transition.dragFirst)
  })

  it('长按后移动超过阈值不进入拖拽（仍是点击/滚动）', () => {
    render(<TransitionPanel />)
    const button = screen.getByRole('button', { name: '溶解' }) as HTMLButtonElement

    fireEvent.pointerDown(button, { pointerId: 3, button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 40, clientY: 10 })
    act(() => {
      vi.advanceTimersByTime(TRANSITION_LONG_PRESS_MS)
    })

    expect(useUiStore.getState().transitionDrag).toBeNull()
  })

  it('长按进入拖拽：幽灵出现，松手命中缝隙后写入转场并自动选中', () => {
    render(<TransitionPanel />)
    longPressStyle('溶解')

    // 长按成立：uiStore 有拖拽态，body 上出现跟随幽灵
    expect(useUiStore.getState().transitionDrag?.type).toBe('dissolve')
    const ghost = document.querySelector('.transition-drag-ghost') as HTMLElement
    expect(ghost).toBeTruthy()
    expect(ghost.textContent).toContain('溶解')

    // 时间轴把「指针下的合法切点」写进 store（真实环境由 Timeline 计算）
    act(() => useUiStore.getState().setTransitionDropTarget('b'))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 40 })

    expect(clipOf('b').transitionIn).toEqual({ type: 'dissolve', durationSec: 0.5 })
    expect(useProjectStore.getState().selectedTransitionClipId).toBe('b')
    expect(useProjectStore.getState().selectionKind).toBe('transition')
    expect(useUiStore.getState().notice).toBe(TEXT.transition.added('溶解'))
    expect(useUiStore.getState().transitionDrag).toBeNull()
    expect(document.querySelector('.transition-drag-ghost')).toBeNull()
  })

  it('长按拖到非法位置（空隙/轨道外）只提示，不写工程', () => {
    render(<TransitionPanel />)
    longPressStyle('溶解')

    // 没有命中任何缝隙：dropTarget 保持 null
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 600, clientY: 600 })

    expect('transitionIn' in clipOf('b')).toBe(false)
    expect(useUiStore.getState().notice).toBe(TEXT.transition.dropInvalid)
    expect(useUiStore.getState().transitionDrag).toBeNull()
  })

  it('拖到没有足够手柄的缝隙（store 拒绝）时给出拒绝提示', () => {
    // 把 B 的源入点改成 0：头部没有手柄，切点不可用
    act(() => {
      const project = useProjectStore.getState().project
      useProjectStore.setState({
        project: {
          ...project,
          mediaClips: project.mediaClips.map((clip) =>
            clip.id === 'b' ? { ...clip, sourceInSec: 0, sourceOutSec: 2 } : clip
          )
        }
      })
    })
    render(<TransitionPanel />)
    longPressStyle('溶解')
    // 真实 Timeline 不会把这种切点写进 dropTarget；但面板要能兜住「store 拒绝」
    act(() => useUiStore.getState().setTransitionDropTarget('b'))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 40 })

    expect('transitionIn' in clipOf('b')).toBe(false)
    expect(useUiStore.getState().notice).toBe(TEXT.transition.rejected)
  })

  it('已选中转场时单击样式 = 原地替换类型并保留时长', () => {
    act(() => useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 }))
    act(() => useProjectStore.getState().selectTransition('b'))
    render(<TransitionPanel />)

    fireEvent.click(screen.getByRole('button', { name: '推入左侧' }))

    expect(clipOf('b').transitionIn).toEqual({ type: 'pushLeft', durationSec: 0.5 })
    expect(useUiStore.getState().notice).toBe(TEXT.transition.replaced('推入左侧'))
  })

  it('拖到已有转场的缝隙：只换效果，保留用户已经调好的时长', () => {
    act(() => useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.4 }))
    render(<TransitionPanel />)
    longPressStyle('黑场')
    act(() => useUiStore.getState().setTransitionDropTarget('b'))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 40, clientY: 40 })

    expect(clipOf('b').transitionIn).toEqual({ type: 'fadeBlack', durationSec: 0.4 })
  })
})

describe('缝隙命中复核（junctionClipIdAtPoint）', () => {
  it('命中的元素不是缝隙时返回 null；命中缝隙时取右侧片段 id', () => {
    const plain = document.createElement('div')
    expect(junctionClipIdAtPoint(0, 0, () => plain)).toEqual({ clipId: null })

    const junction = document.createElement('div')
    junction.setAttribute('data-transition-junction', '')
    junction.dataset.clipId = 'b'
    const child = document.createElement('span')
    junction.appendChild(child)
    // 从图标内部（子元素）往上找也能命中外层命中区
    expect(junctionClipIdAtPoint(0, 0, () => child)).toEqual({ clipId: 'b' })

    expect(junctionClipIdAtPoint(0, 0, () => null)).toEqual({ clipId: null })
  })
})
