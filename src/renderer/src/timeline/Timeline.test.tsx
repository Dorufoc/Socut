import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { frameTimeSec } from '@shared/fps'
import type { MediaItem, Project, VideoMeta } from '@shared/types'
import { Timeline } from './Timeline'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 时间轴交互契约（v2 双轨）：
 * 1) 在尺规/轨道空白上按下即定位，持续拖动逐帧跟随，抬起结束；
 * 2) 刮擦接管播放头：若正在播放必须先暂停；
 * 3) 片段卡片上的指针按下归卡片自己的入出点拖拽，不触发定位；
 * 4) 媒体轨：卡片渲染、拆分按钮按播放头态启用。
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

/** v2 媒体轨用例的夹具素材：10s 1080p30，导入即自动铺满全段。 */
function seedMedia(): MediaItem {
  const meta: VideoMeta = {
    path: 'C:/media/a.mp4',
    containerName: 'mov,mp4,m4a,3gp,2b2,gif,webm',
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
    durationSec: 10,
    nbFrames: null,
    bitRateKbps: null
  }
  const store = useProjectStore.getState()
  const id = store.addMedia({
    path: meta.path,
    name: 'a.mp4',
    meta,
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  })
  store.insertMediaClip({ mediaId: id, timelineStartSec: 0 })
  return useProjectStore.getState().project.media.find((m) => m.id === id)!
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

describe('Timeline v2 媒体轨', () => {
  it('媒体轨渲染卡片，尺规时长跟随媒体覆盖（不再看旧 refVideo）', () => {
    seed()
    seedMedia()
    const root = renderTimeline(vi.fn())
    const lane = root.querySelector('.timeline__track--media') as HTMLElement
    expect(lane).toBeTruthy()
    const card = lane.querySelector('.media-clip-card') as HTMLElement
    expect(card.textContent).toContain('a.mp4')
    // 媒体 10s：总时长至少 11s（覆盖 + 1s 余量）
    expect(root.textContent).toMatch(/总时长 1[1-9]\.\d\ds/)
  })

  it('拆分按钮：播放头在段内且两半够长时启用，点击拆出右段并选中', () => {
    seed()
    const media = seedMedia()
    const clip = useProjectStore.getState().project.mediaClips.find((c) => c.mediaId === media.id)!
    act(() => useUiStore.setState({ displayTimeSec: clip.timelineStartSec + 2 }))
    const root = renderTimeline(vi.fn())
    const splitBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === '拆分媒体段') as HTMLButtonElement
    expect(splitBtn.disabled).toBe(false)

    fireEvent.click(splitBtn)
    const after = useProjectStore.getState()
    expect(after.project.mediaClips.filter((c) => c.mediaId === media.id)).toHaveLength(2)
    expect(after.selectedMediaClipId).not.toBe(clip.id)
  })

  it('播放头落在段外（空隙）时拆分按钮禁用', () => {
    seed()
    const media = seedMedia()
    // 重新铺一段 4s 的：段尾 4s，播放头 6s 落在空隙里
    const clip = useProjectStore.getState().project.mediaClips.find((c) => c.mediaId === media.id)!
    act(() => useProjectStore.getState().trimMediaClip(clip.id, { timelineEndSec: 4 }))
    act(() => useUiStore.setState({ displayTimeSec: 6 }))
    const root = renderTimeline(vi.fn())
    const splitBtn = [...root.querySelectorAll('button')].find((b) => b.textContent === '拆分媒体段') as HTMLButtonElement
    expect(splitBtn.disabled).toBe(true)
  })

  it('媒体卡片按下选中媒体段而不是字幕段', () => {
    seed()
    const media = seedMedia()
    const root = renderTimeline(vi.fn())
    const card = root.querySelector('.media-clip-card') as HTMLElement
    fireEvent.pointerDown(card, pointerInit(300))
    expect(useProjectStore.getState().selectedMediaClipId).toBe(
      useProjectStore.getState().project.mediaClips.find((c) => c.mediaId === media.id)!.id
    )
  })
})

/**
 * v4：字幕轨只留一条上下更窄的示意条。
 * 摆位就是这条字幕在当前画面的入点→出点；标签只放主标题；
 * 播放头落在区间内时条内出现一条细游标，标出当前位置相对出入点的关系。
 */
describe('Timeline 字幕轨示意条', () => {
  function seedTitled(): void {
    const project = seed()
    const clip = project.clips[0]!
    clip.content = { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' }
    useProjectStore.setState({ project, selectedClipId: clip.id, fonts: [] })
  }

  it('标签只放主标题，副标题与秒数读数不再占轨道空间', () => {
    seedTitled()
    const root = renderTimeline(vi.fn())

    const card = root.querySelector('.clip-card') as HTMLElement
    expect((card.querySelector('.clip-card__label') as HTMLElement).textContent).toBe('长三角一体化新规发布')
    // 旧的副标题/预设名/秒数行彻底消失
    expect(card.querySelector('.clip-card__meta')).toBeNull()
    expect(card.textContent).not.toContain('省发展改革委负责人解读')
    // 但信息不丢：完整读数仍在 title 里
    expect(card.getAttribute('title')).toContain('00:00:02:00')
    expect(card.getAttribute('title')).toContain('00:00:04:00')
  })

  it('播放头落在区间内才画游标，位置按同一 secToPx 口径落在条内', () => {
    seedTitled()
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)

    // 片段 2→4s，播放头在 0s（区间外）：没有游标
    expect(root.querySelector('.clip-card__cursor')).toBeNull()
    expect((root.querySelector('.clip-card') as HTMLElement).className).not.toContain('clip-card--onair')

    act(() => {
      useUiStore.setState({ displayTimeSec: 3 })
    })

    const cursor = root.querySelector('.clip-card__cursor') as HTMLElement
    expect(cursor).toBeTruthy()
    // 游标的 left 是相对条体原点的像素值（与全局播放头同一 secToPx 口径）
    const offset = Number.parseFloat(cursor.style.left)
    expect(Number.isFinite(offset)).toBe(true)
    expect(offset).toBeGreaterThan(0)
    expect((root.querySelector('.clip-card') as HTMLElement).className).toContain('clip-card--onair')
  })

  it('没有主标题时用可读的占位标签，而不是空白条', () => {
    seed()
    const root = renderTimeline(vi.fn())
    expect((root.querySelector('.clip-card__label') as HTMLElement).textContent).toBe(TEXT.captions.noTitle)
  })
})
