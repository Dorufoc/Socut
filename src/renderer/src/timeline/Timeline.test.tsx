import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { frameTimeSec } from '@shared/fps'
import type { Project } from '@shared/types'
import { Timeline } from './Timeline'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 时间轴刮擦（拖拽定位）契约：
 * 1) 在尺规/轨道空白上按下即定位，持续拖动逐帧跟随，抬起结束；
 * 2) 刮擦接管播放头：若正在播放必须先暂停；
 * 3) 片段卡片上的指针按下归卡片自己的入出点拖拽，不触发定位。
 */

const TRACK_WIDTH = 1000

function seed(): Project {
  const project = createDefaultProject('刮擦测试')
  project.fps = FPS_30
  const clip = createClip({ startTime: 2, fps: FPS_30 })
  // 直接给出落在帧边界上的整秒出点：轨道时长 = 4 + 1 = 5s，换位算好断言
  clip.startTime = 2
  clip.endTime = 4
  project.clips = [clip]
  useProjectStore.setState({ project, selectedClipId: null, fonts: [] })
  return project
}

/** jsdom 没有指针捕获与 ResizeObserver：用最小桩替代，几何统一按 1000px 宽、0 起点。 */
beforeAll(() => {
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.getBoundingClientRect = function getRect(this: Element): DOMRect {
    const width = this.classList.contains('clip-card') ? 400 : TRACK_WIDTH
    const left = this.classList.contains('clip-card') ? 400 : 0
    return { width, left, top: 0, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) } as DOMRect
  }
  class ResizeObserverStub {
    private readonly callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe(target: Element): void {
      const rect = target.getBoundingClientRect()
      this.callback(
        [{ target, contentRect: { width: rect.width } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver
      )
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  act(() => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
    useUiStore.setState({ playing: false, displayTimeSec: 0, notice: null })
  })
})

function pointerInit(clientX: number, button = 0): PointerEventInit {
  return { clientX, button, pointerId: 1, bubbles: true, cancelable: true }
}

function renderTimeline(seekTo: (sec: number) => void): HTMLElement {
  const { container } = render(<Timeline seekTo={seekTo} />)
  return container as unknown as HTMLElement
}

function findTrack(root: HTMLElement): HTMLElement {
  return root.querySelector('.timeline__track') as HTMLElement
}

function findRuler(root: HTMLElement): HTMLElement {
  return root.querySelector('.timeline__ruler') as HTMLElement
}

describe('Timeline 拖拽刮擦定位', () => {
  it('轨道按下即定位到鼠标所在帧，持续拖动逐帧跟随，抬起结束刮擦', () => {
    seed()
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)
    const element = findTrack(root)

    fireEvent.pointerDown(element, pointerInit(250))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(38, FPS_30))

    fireEvent.pointerMove(element, pointerInit(500))
    // 250/500/750px → 1.25/2.5/3.75s：1.25s 恰在两帧中间就近归第 38 帧，2.5s 正好落在第 75 帧边界
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(75, FPS_30))
    fireEvent.pointerMove(element, pointerInit(750))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(113, FPS_30))
    expect(element.className).toContain('timeline__track--scrubbing')

    fireEvent.pointerUp(element, pointerInit(750))
    expect(element.className).not.toContain('timeline__track--scrubbing')
    // 抬起之后的移动不再定位
    seekTo.mockClear()
    fireEvent.pointerMove(element, pointerInit(100))
    expect(seekTo).not.toHaveBeenCalled()
  })

  it('刮擦接管播放头：正在播放时按下先暂停', () => {
    seed()
    useUiStore.setState({ playing: true })
    const root = renderTimeline(vi.fn())

    fireEvent.pointerDown(findTrack(root), pointerInit(500))
    expect(useUiStore.getState().playing).toBe(false)
  })

  it('尺规同样支持按下即定位、拖动跟随（与轨道同一水平几何）', () => {
    seed()
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)
    const ruler = findRuler(root)

    fireEvent.pointerDown(ruler, pointerInit(200))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(30, FPS_30))
    fireEvent.pointerMove(ruler, pointerInit(800))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(120, FPS_30))
    expect(ruler.className).toContain('timeline__ruler--scrubbing')
    fireEvent.pointerUp(ruler, pointerInit(800))
    expect(ruler.className).not.toContain('timeline__ruler--scrubbing')
  })

  it('按下在片段卡片上时不刮擦，卡片自己的拖拽不被打断', () => {
    seed()
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)
    const card = root.querySelector('.clip-card') as HTMLElement

    fireEvent.pointerDown(card, pointerInit(600))
    expect(seekTo).not.toHaveBeenCalled()
    expect(findTrack(root).className).not.toContain('timeline__track--scrubbing')
    // 卡片按下会选中自己（沿放入出点拖拽的开始逻辑）
    expect(useProjectStore.getState().selectedClipId).toBe(useProjectStore.getState().project.clips[0]!.id)
  })
})
