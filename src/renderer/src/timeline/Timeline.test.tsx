import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { frameTimeSec, snapTimeToFrame } from '@shared/fps'
import { secondsToTimecode } from '@shared/timecode'
import type { MediaItem, Project, VideoMeta } from '@shared/types'
import { Timeline } from './Timeline'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { attachProjectHistory } from '../state/projectHistory'

/**
 * 时间轴交互契约（v2 双轨）：
 * 1) 在尺规/轨道空白上按下即定位，持续拖动逐帧跟随，抬起结束；
 * 2) 刮擦接管播放头：若正在播放必须先暂停；
 * 3) 片段卡片上的指针按下归卡片自己的入出点拖拽，不触发定位；
 * 4) 媒体轨：卡片渲染、拆分按钮按播放头态启用。
 */

const TRACK_WIDTH = 1000
/** v12：100% 缩放下的固定比例尺（px/秒）——轨道不再「把一屏摊满」 */
const PX_PER_SEC = 72

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

/** jsdom 没有指针捕获与 ResizeObserver：用最小桩替代。几何优先读 inline 宽/left（车道宽度=时长×比例尺）。 */
beforeAll(() => {
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.getBoundingClientRect = function getRect(this: Element): DOMRect {
    const element = this as HTMLElement
    const inlineWidth = Number.parseFloat(element.style?.width ?? '')
    const inlineLeft = Number.parseFloat(element.style?.left ?? '')
    const isCard =
      element.classList?.contains('clip-card') ||
      element.classList?.contains('media-clip-card') ||
      element.classList?.contains('audio-clip-card')
    const width = Number.isFinite(inlineWidth) && inlineWidth > 0 ? inlineWidth : isCard ? 400 : TRACK_WIDTH
    const left = Number.isFinite(inlineLeft) ? inlineLeft : isCard ? 400 : 0
    return { width, left, top: 0, height: 40, right: left + width, bottom: 40, x: left, y: 0, toJSON: () => ({}) } as DOMRect
  }
  // jsdom 的 clientWidth 恒为 0：不给个值的话，effect 里那句
  // `setWidthPx(Math.max(120, element.clientWidth))` 会盖掉 ResizeObserver 刚写入的真实宽度
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => TRACK_WIDTH })
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
    useUiStore.setState({ playing: false, displayTimeSec: 0, notice: null, timelineZoom: 1 })
    useUiStore.setState({ timelineTools: { snapTogether: false, magneticSnap: false, hoverPreview: false } })
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

    fireEvent.pointerDown(element, pointerInit(90))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(38, FPS_30))

    fireEvent.pointerMove(element, pointerInit(180))
    // 90/180/270px = 1.25/2.5/3.75s（比例尺 72px/s）：1.25s 恰在两帧中间就近归第 38 帧，2.5s 正好落在第 75 帧边界
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(75, FPS_30))
    fireEvent.pointerMove(element, pointerInit(270))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(113, FPS_30))
    expect(element.className).toContain('timeline__track--scrubbing')

    fireEvent.pointerUp(element, pointerInit(270))
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

    fireEvent.pointerDown(ruler, pointerInit(72))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(30, FPS_30))
    fireEvent.pointerMove(ruler, pointerInit(288))
    expect(seekTo).toHaveBeenLastCalledWith(frameTimeSec(120, FPS_30))
    expect(ruler.className).toContain('timeline__ruler--scrubbing')
    fireEvent.pointerUp(ruler, pointerInit(288))
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
    // 媒体 10s：总时长按内容末尾算（不再凭空加 1s 余量）
    expect(root.textContent).toMatch(/总时长 10\.00s/)
  })

  it('拆分按钮：永远可点，播放头在段内且两半够长时拆出右段并选中', () => {
    seed()
    const media = seedMedia()
    const clip = useProjectStore.getState().project.mediaClips.find((c) => c.mediaId === media.id)!
    act(() => useUiStore.setState({ displayTimeSec: clip.timelineStartSec + 2 }))
    const root = renderTimeline(vi.fn())
    const splitBtn = toolButton(root, TEXT.timeline.splitClip)
    expect(splitBtn.disabled).toBe(false)

    fireEvent.click(splitBtn)
    const after = useProjectStore.getState()
    expect(after.project.mediaClips.filter((c) => c.mediaId === media.id)).toHaveLength(2)
    expect(after.selectedMediaClipId).not.toBe(clip.id)
    expect(useUiStore.getState().notice).toBeNull()
  })

  it('播放头落在空隙（没有目标段）：不动工程，只提示没有可拆的', () => {
    seed()
    const media = seedMedia()
    // 重新铺一段 4s 的：段尾 4s，播放头 6s 落在空隙里
    const clip = useProjectStore.getState().project.mediaClips.find((c) => c.mediaId === media.id)!
    act(() => useProjectStore.getState().trimMediaClip(clip.id, { timelineEndSec: 4 }))
    act(() => useUiStore.setState({ displayTimeSec: 6 }))
    const root = renderTimeline(vi.fn())
    const splitBtn = toolButton(root, TEXT.timeline.splitClip)
    // 不置灰：保持可点才能把「没有」说给用户听
    expect(splitBtn.disabled).toBe(false)
    const before = useProjectStore.getState().project.mediaClips.length

    fireEvent.click(splitBtn)

    expect(useProjectStore.getState().project.mediaClips).toHaveLength(before)
    expect(useUiStore.getState().notice).toBe(TEXT.timeline.noSplitTarget)
  })

  it('媒体卡片按下选中媒体段而不是字幕段，且不推动播放头', () => {
    seed()
    const media = seedMedia()
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)
    const card = root.querySelector('.media-clip-card') as HTMLElement
    fireEvent.pointerDown(card, pointerInit(300))
    expect(useProjectStore.getState().selectedMediaClipId).toBe(
      useProjectStore.getState().project.mediaClips.find((c) => c.mediaId === media.id)!.id
    )
    // P5：点段落只管选中
    expect(seekTo).not.toHaveBeenCalled()
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

/** 音频轨（v7.1）：独立车道 + 时长条宽度 = 片段占比，删除按钮跟选中态联动 */
describe('音频轨', () => {
  function seedAudio(): void {
    seedTools()
    const project = useProjectStore.getState().project
    useProjectStore.setState({
      project: {
        ...project,
        audioClips: [
          { id: 'a1', mediaId: 'media-1', trackId: 'track-audio-0', timelineStartSec: 2, timelineEndSec: 10, sourceInSec: 0, sourceOutSec: 8 }
        ]
      },
      selectedAudioClipId: null,
      // 选中态三个 id + 类型一起归零：这几条测的就是「未选中时退到哪里」，不能继承上一条用例的选中
      selectedMediaClipId: null,
      selectedClipId: null,
      selectionKind: 'subtitle'
    })
  }

  const audioButton = (root: HTMLElement): HTMLButtonElement =>
    toolButton(root, TEXT.timeline.removeTarget)

  it('音频段渲染在独立车道：宽度按占比、名称在条上', () => {
    seedAudio()
    const root = renderTimeline(vi.fn())
    const card = root.querySelector('.timeline__track--audio .audio-clip-card') as HTMLElement
    expect(card).toBeTruthy()
    expect(card.textContent).toContain('a.mp4')
    // 2s→10s 共 8s：宽度 = 时长 × 比例尺（车道总宽另有「内容 + 余量」，所以只看卡片自身）
    expect(parseFloat(card.style.width)).toBeCloseTo(8 * PX_PER_SEC, 0)
  })

  it('一个删除按钮管三条轨：选中音频段就删它', () => {
    seedAudio()
    const root = renderTimeline(vi.fn())

    act(() => useProjectStore.getState().selectAudioClip('a1'))
    fireEvent.click(audioButton(root))

    expect(useProjectStore.getState().project.audioClips).toBeUndefined()
    expect(useProjectStore.getState().selectedAudioClipId).toBeNull()
    expect(useUiStore.getState().notice).toBeNull()
  })

  it('选中字幕条时删除删的是字幕条，媒体段一个不少', () => {
    seedAudio()
    const subtitleId = useProjectStore.getState().project.clips[0]!.id
    const mediaCount = useProjectStore.getState().project.mediaClips.length
    const root = renderTimeline(vi.fn())

    act(() => useProjectStore.getState().selectClip(subtitleId))
    fireEvent.click(audioButton(root))

    expect(useProjectStore.getState().project.clips).toHaveLength(0)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(mediaCount)
  })

  it('什么都没选中且播放头处没有媒体段：删除只给提示', () => {
    seedAudio()
    act(() => useUiStore.setState({ displayTimeSec: 25 }))
    const root = renderTimeline(vi.fn())

    fireEvent.click(audioButton(root))

    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2)
    expect(useUiStore.getState().notice).toBe(TEXT.timeline.noRemoveTarget)
  })

  it('音频素材拖到媒体轨被拒（提示去音频轨）', () => {
    seedTools()
    const project = useProjectStore.getState().project
    useProjectStore.setState({
      project: { ...project, media: project.media.map((item) => ({ ...item, kind: 'audio' as const })) }
    })
    const root = renderTimeline(vi.fn())
    const mediaTrack = root.querySelector('.timeline__track--media') as HTMLElement

    const transfer = {
      types: ['application/x-focusnews-media'],
      setData: () => undefined,
      getData: () => 'media-1',
      dropEffect: 'copy'
    }
    fireEvent.dragOver(mediaTrack, { dataTransfer: transfer, clientX: 0, clientY: 0 })
    fireEvent.drop(mediaTrack, { dataTransfer: transfer, clientX: 0, clientY: 0 })

    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2) // 原有两段，没多出来
    expect(useUiStore.getState().notice).toContain('音频轨')
  })
})

/**
 * 时间轴工具栏（v6.2）：主轨对齐 / 自动吸附 / 预览轴。
 *
 * 轨道宽 1000px、总长 8s（见下方 seedTools），所以吸附窗口 = 10px = 0.08s，
 * 拖拽位移可以直接换算成秒来断言。
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

/**
 * 媒体轨：A [0,2] + B [5,7]（中间留 3s 空隙）；
 * 另放一条 [0,30] 的字幕条把时间轴拉到 31s 内容长度，这样拖拽不会撞到轨道末尾的夹取。
 * v12 起轨道不再「把一屏摊满」：比例尺固定 72px/s（100%），所以 px 与秒是线性换算。
 */
const timeAtPx = (px: number): number => px / PX_PER_SEC
const pxAtSec = (sec: number): number => sec * PX_PER_SEC

function seedTools(): void {
  const project = createDefaultProject('工具')
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
  project.media = [item]
  const subtitle = createClip({ startTime: 0, fps: FPS_30 })
  subtitle.endTime = 30
  project.clips = [subtitle]
  project.mediaClips = [
    { id: 'a', mediaId: item.id, trackId: 'track-media-0', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0, sourceOutSec: 2 },
    { id: 'b', mediaId: item.id, trackId: 'track-media-0', timelineStartSec: 5, timelineEndSec: 7, sourceInSec: 0, sourceOutSec: 2 }
  ]
  useProjectStore.setState({ project, selectedClipId: null, selectedMediaClipId: null, fonts: [] })
}

const toolButton = (root: HTMLElement, name: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll('.timeline__bar button')).find((button) => button.textContent === name) as HTMLButtonElement

const mediaClip = (id: string) => useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!

describe('时间轴工具栏', () => {
  it('三个开关默认关闭，点一下变选中态（aria-pressed 同步）', () => {
    seedTools()
    const root = renderTimeline(vi.fn())

    for (const name of [TEXT.timeline.snapTogether, TEXT.timeline.magneticSnap, TEXT.timeline.hoverPreview]) {
      expect(toolButton(root, name).getAttribute('aria-pressed')).toBe('false')
    }

    fireEvent.click(toolButton(root, TEXT.timeline.magneticSnap))
    expect(toolButton(root, TEXT.timeline.magneticSnap).getAttribute('aria-pressed')).toBe('true')
    expect(toolButton(root, TEXT.timeline.magneticSnap).className).toContain('btn--primary')
    // 其余两个不受影响
    expect(toolButton(root, TEXT.timeline.snapTogether).getAttribute('aria-pressed')).toBe('false')
  })

  it('主轨对齐打开：所有媒体段从左到右紧贴，间隙为 0；关掉后允许再拉开', () => {
    seedTools()
    const root = renderTimeline(vi.fn())
    expect(mediaClip('b').timelineStartSec).toBe(5)

    fireEvent.click(toolButton(root, TEXT.timeline.snapTogether))

    expect(mediaClip('a').timelineStartSec).toBe(0)
    expect(mediaClip('a').timelineEndSec).toBe(2)
    expect(mediaClip('b').timelineStartSec).toBe(2)
    expect(mediaClip('b').timelineEndSec).toBe(4)

    // 关掉开关：不再重排，片段停在当前位置（行为回到「允许空隙」）
    fireEvent.click(toolButton(root, TEXT.timeline.snapTogether))
    expect(toolButton(root, TEXT.timeline.snapTogether).getAttribute('aria-pressed')).toBe('false')
    expect(mediaClip('b').timelineStartSec).toBe(2)
  })

  it('自动吸附打开：拖到邻居边缘附近会被吸住，并画出目标边缘高亮线', () => {
    seedTools()
    const root = renderTimeline(vi.fn())
    fireEvent.click(toolButton(root, TEXT.timeline.magneticSnap))

    const card = root.querySelector('.media-clip-card') as HTMLElement
    // 往右拖 210px → 起点≈2.92s、尾巴≈4.92s，离 B 的开头 5s 只差 0.08s（吸附窗口按 10px 换算）
    fireEvent.pointerDown(card, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(card, { pointerId: 1, clientX: pxAtSec(2.92) })

    expect(mediaClip('a').timelineStartSec).toBe(3) // 吸附后尾巴恰好接上 B 的开头
    expect(mediaClip('a').timelineEndSec).toBe(5)
    expect(root.querySelector('.timeline__snap-line')).toBeTruthy()
  })

  it('自动吸附关闭：同样的拖动不吸附，也没有高亮线', () => {
    seedTools()
    const root = renderTimeline(vi.fn())
    const target = root.querySelector('.media-clip-card') as HTMLElement

    fireEvent.pointerDown(target, { pointerId: 2, clientX: 0 })
    fireEvent.pointerMove(target, { pointerId: 2, clientX: pxAtSec(2.92) })

    // 不吸附：停在帧吸附后的原位（≈2.93s），不会跳到 3s
    expect(mediaClip('a').timelineStartSec).not.toBe(3)
    expect(mediaClip('a').timelineStartSec).toBeCloseTo(snapTimeToFrame(2.92, FPS_30), 3)
    expect(root.querySelector('.timeline__snap-line')).toBeNull()
  })

  it('预览轴：开着时悬停出黄线并写进 uiStore，蓝色播放头留在原地', () => {
    seedTools()
    const root = renderTimeline(vi.fn())
    const timelineEl = root.querySelector('.timeline') as HTMLElement

    // 默认关闭：移动鼠标不产生预览轴，也不写 uiStore
    fireEvent.pointerMove(timelineEl, { pointerId: 3, pointerType: 'mouse', clientX: 500 })
    expect(root.querySelector('.timeline__hover-line')).toBeNull()
    expect(useUiStore.getState().hoverPreviewSec).toBeNull()

    fireEvent.click(toolButton(root, TEXT.timeline.hoverPreview))
    fireEvent.pointerMove(timelineEl, { pointerId: 3, pointerType: 'mouse', clientX: 500 })

    const line = root.querySelector('.timeline__hover-line') as HTMLElement
    expect(line).toBeTruthy()
    // 500px → 时间轴上对应的帧
    expect(line.querySelector('.timeline__hover-tag')?.textContent).toBe(secondsToTimecode(timeAtPx(500), FPS_30))
    expect(useUiStore.getState().hoverPreviewSec).toBe(snapTimeToFrame(timeAtPx(500), FPS_30))
    // P4：黄线接管预览，蓝线不再被顶掉：只是压暗，位置仍是播放头那里
    const head = root.querySelector('.timeline__playhead') as HTMLElement
    expect(head).toBeTruthy()
    // 播放头挂在整块轨道内容上：左侧 56px 是 sticky 标签槽，0s 就落在槽的右缘
    expect(head.style.left).toBe('56px')
    expect(timelineEl.className).toContain('timeline--hover-preview')

    fireEvent.pointerLeave(timelineEl)
    expect(root.querySelector('.timeline__hover-line')).toBeNull()
    expect(useUiStore.getState().hoverPreviewSec).toBeNull()
  })

  it('正在播放时预览轴整体禁用：黄线不出现，已经画出来的立即收起', () => {
    seedTools()
    const root = renderTimeline(vi.fn())
    fireEvent.click(toolButton(root, TEXT.timeline.hoverPreview))
    const timelineEl = root.querySelector('.timeline') as HTMLElement

    // 暂停态下悬停有效
    fireEvent.pointerMove(timelineEl, { pointerId: 4, pointerType: 'mouse', clientX: 300 })
    expect(root.querySelector('.timeline__hover-line')).toBeTruthy()

    // 开始播放：黄线与接管态立刻收起，不必等鼠标移出
    act(() => useUiStore.setState({ playing: true }))
    expect(root.querySelector('.timeline__hover-line')).toBeNull()
    expect(useUiStore.getState().hoverPreviewSec).toBeNull()

    // 暂停后同样的悬停又有效
    act(() => useUiStore.setState({ playing: false }))
    fireEvent.pointerMove(timelineEl, { pointerId: 4, pointerType: 'mouse', clientX: 300 })
    expect(root.querySelector('.timeline__hover-line')).toBeTruthy()
  })

  it('拆分以黄线指向的帧为准，蓝线位置不动', () => {
    seedTools()
    const root = renderTimeline(vi.fn())
    fireEvent.click(toolButton(root, TEXT.timeline.hoverPreview))
    const timelineEl = root.querySelector('.timeline') as HTMLElement
    // 蓝线停在 3s 的空隙（那里没有媒体段），黄线指到 B 段 [5,7] 的 6s
    act(() => useUiStore.setState({ displayTimeSec: 3 }))
    fireEvent.pointerMove(timelineEl, { pointerId: 6, pointerType: 'mouse', clientX: pxAtSec(6) })

    fireEvent.click(toolButton(root, TEXT.timeline.splitClip))

    const clips = useProjectStore.getState().project.mediaClips
    expect(clips).toHaveLength(3)
    expect(clips.some((clip) => Math.abs(clip.timelineStartSec - 6) < 0.05)).toBe(true)
    // 拆分没有顺手把播放头推走
    expect(useUiStore.getState().displayTimeSec).toBe(3)
  })
})

describe('时间轴工具栏：撤销 / 重做', () => {
  it('「新建片段」「删除片段」不在工具栏里了（入口已合并到左侧字幕 Tab）', () => {
    seedTools()
    const root = renderTimeline(vi.fn())

    const names = Array.from(root.querySelectorAll('.timeline__bar button')).map((button) => button.textContent)
    // 这两个文案已经只属于左侧「字幕」Tab（TEXT.captions.add），工具栏不再重复提供入口
    expect(names).not.toContain('新建片段')
    expect(names).not.toContain('删除片段')
  })

  it('没有可撤销的改动时，撤销与重做都是禁用态', () => {
    seedTools()
    const detach = attachProjectHistory()
    try {
      const root = renderTimeline(vi.fn())

      expect((toolButton(root, TEXT.timeline.undo) as HTMLButtonElement).disabled).toBe(true)
      expect((toolButton(root, TEXT.timeline.redo) as HTMLButtonElement).disabled).toBe(true)
    } finally {
      detach()
    }
  })

  it('点「撤销」回到改动前，点「重做」再回来', () => {
    seedTools()
    const detach = attachProjectHistory()
    try {
      const root = renderTimeline(vi.fn())
      act(() => {
        useProjectStore.getState().addClip(0)
      })
      expect(useProjectStore.getState().project.clips).toHaveLength(2)

      fireEvent.click(toolButton(root, TEXT.timeline.undo))
      expect(useProjectStore.getState().project.clips).toHaveLength(1)

      fireEvent.click(toolButton(root, TEXT.timeline.redo))
      expect(useProjectStore.getState().project.clips).toHaveLength(2)
    } finally {
      detach()
    }
  })
})

/**
 * P5：轨道上的段落只管选中。
 * 跳转只留给两处「指着时间说我要过去」的入口：轨道空白处与上方尺规；
 * 段内点击不再顺手推动播放头，想过去时在右侧编辑器点「定位到这一段」。
 */
describe('Timeline 点段落只选中不跳转（P5）', () => {
  it('点媒体段：选中它，但 seek 与播放头读数都不动', () => {
    seedTools()
    act(() => useUiStore.setState({ displayTimeSec: 10 }))
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)

    const cards = root.querySelectorAll('.timeline__track--media .media-clip-card')
    fireEvent.pointerDown(cards[1] as Element, pointerInit(600))

    expect(useProjectStore.getState().selectedMediaClipId).toBe('b')
    expect(seekTo).not.toHaveBeenCalled()
    expect(useUiStore.getState().displayTimeSec).toBe(10)
  })

  it('点音频段：同样只选中，不跳到这一段', () => {
    seedTools()
    act(() => {
      const project = useProjectStore.getState().project
      useProjectStore.setState({
        project: {
          ...project,
          audioClips: [{ id: 'a1', mediaId: 'media-1', trackId: 'track-audio-0', timelineStartSec: 5, timelineEndSec: 7, sourceInSec: 0, sourceOutSec: 2 }]
        }
      })
    })
    act(() => useUiStore.setState({ displayTimeSec: 10 }))
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)

    fireEvent.pointerDown(root.querySelector('.audio-clip-card') as Element, pointerInit(600))

    expect(useProjectStore.getState().selectedAudioClipId).toBe('a1')
    expect(seekTo).not.toHaveBeenCalled()
    expect(useUiStore.getState().displayTimeSec).toBe(10)
  })

  it('轨道空白处按下仍然跳转：入口只换了位置，没有丢掉', () => {
    seedTools()
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)

    fireEvent.pointerDown(findTrack(root), pointerInit(250))

    expect(seekTo).toHaveBeenCalled()
  })
})

/**
 * v12 缩放与横滚：Ctrl/Cmd+滚轮以鼠标为锚点改比例尺（10%~800%），
 * 普通竖向滚轮转成横向滚动。jsdom 没有真实滚动几何，这里手动给滚动容器补 scrollLeft/scrollWidth。
 */
describe('Timeline 缩放与横向滚动', () => {
  function stubScroll(element: HTMLElement): { get: () => number } {
    let scrollLeft = 0
    Object.defineProperty(element, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value
      }
    })
    Object.defineProperty(element, 'scrollWidth', { configurable: true, get: () => 100_000 })
    return { get: () => scrollLeft }
  }

  it('Ctrl+滚轮放大：比例尺 ×1.15，且指针下的时刻留在原列', () => {
    seed()
    const root = renderTimeline(vi.fn())
    const scroller = root.querySelector('.timeline__scroll') as HTMLElement
    const scrollLeft = stubScroll(scroller)

    // 100%：72px/s，指针 clientX=300 → 锚点时间 (0+300-56)/72 ≈ 3.389s
    fireEvent.wheel(scroller, { deltaY: -120, ctrlKey: true, clientX: 300 })

    expect(useUiStore.getState().timelineZoom).toBeCloseTo(1.15, 6)
    expect(root.querySelector('.timeline__rows')!.getAttribute('data-px-per-sec')).toBe('82.8')
    // 82.8px/s 下把 3.389s 放回第 300px 这一列：3.389×82.8 − 300 + 56 ≈ 36.6
    expect(scrollLeft.get()).toBeCloseTo(36.6, 1)
  })

  it('缩放夹在 10%~800%：到顶到底再滚都不越界', () => {
    seed()
    const root = renderTimeline(vi.fn())
    const scroller = root.querySelector('.timeline__scroll') as HTMLElement
    stubScroll(scroller)

    act(() => useUiStore.getState().setTimelineZoom(8))
    fireEvent.wheel(scroller, { deltaY: -120, ctrlKey: true, clientX: 300 })
    expect(useUiStore.getState().timelineZoom).toBe(8)

    act(() => useUiStore.getState().setTimelineZoom(0.1))
    fireEvent.wheel(scroller, { deltaY: 120, ctrlKey: true, clientX: 300 })
    expect(useUiStore.getState().timelineZoom).toBe(0.1)
  })

  it('普通竖向滚轮只横滚，不动缩放', () => {
    seed()
    const root = renderTimeline(vi.fn())
    const scroller = root.querySelector('.timeline__scroll') as HTMLElement
    const scrollLeft = stubScroll(scroller)

    fireEvent.wheel(scroller, { deltaY: 240, clientX: 300 })

    expect(useUiStore.getState().timelineZoom).toBe(1)
    expect(scrollLeft.get()).toBe(240)
  })
})

/**
 * v3 多轨：行序、增删轨道、锁定轨道不拖拽、跨轨拖拽命中。
 * 行序约定：媒体轨数组反向（新加的在上）→ 字幕（固定一条）→ 音频轨同样反向。
 */
describe('Timeline v3 多轨', () => {
  const groupButton = (root: HTMLElement, label: string): HTMLButtonElement =>
    Array.from(root.querySelectorAll('.timeline__group-actions button')).find(
      (button) => button.textContent === label
    ) as HTMLButtonElement

  const rowKinds = (root: HTMLElement): string[] =>
    Array.from(root.querySelectorAll('.timeline__track')).map((row) =>
      row.classList.contains('timeline__track--media')
        ? 'media'
        : row.classList.contains('timeline__track--audio')
          ? 'audio'
          : 'subtitle'
    )

  it('新增媒体/音频轨后行序为「媒体反向 → 字幕 → 音频反向」', () => {
    seedTools()
    const root = renderTimeline(vi.fn())

    fireEvent.click(groupButton(root, '+ 媒体轨'))
    fireEvent.click(groupButton(root, '+ 音频轨'))

    expect(rowKinds(root)).toEqual(['media', 'media', 'subtitle', 'audio', 'audio'])
    const [newMedia, baseMedia] = Array.from(root.querySelectorAll('.timeline__track--media'))
    expect((newMedia as HTMLElement).dataset.trackId).toBe('track-media-1')
    expect((baseMedia as HTMLElement).dataset.trackId).toBe('track-media-0')
  })

  it('轨道头按钮按类型裁剪：字幕轨只有 隐/锁，且最后一条轨道不能删', () => {
    seedTools()
    const root = renderTimeline(vi.fn())

    const subtitleActions = Array.from(
      root.querySelectorAll('.timeline__track--subtitle [data-action]')
    ).map((element) => (element as HTMLElement).dataset.action)
    expect(subtitleActions).toEqual(['name', 'hide', 'lock'])

    const deleteBtn = root.querySelector('.timeline__track--media [data-action="delete"]') as HTMLButtonElement
    expect(deleteBtn.disabled).toBe(true)

    fireEvent.click(groupButton(root, '+ 媒体轨'))
    expect(useProjectStore.getState().project.mediaTracks).toHaveLength(2)
    const enabledDelete = root.querySelector('.timeline__track--media [data-action="delete"]') as HTMLButtonElement
    expect(enabledDelete.disabled).toBe(false)

    fireEvent.click(enabledDelete)
    expect(useProjectStore.getState().project.mediaTracks).toHaveLength(1)
  })

  it('锁定轨道：片段仍可选中，但不开始拖拽、不接管播放头', () => {
    seedTools()
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)

    fireEvent.click(root.querySelector('.timeline__track--media [data-action="lock"]') as Element)
    expect(useProjectStore.getState().project.mediaTracks[0]!.locked).toBe(true)

    const card = root.querySelector('.media-clip-card') as HTMLElement
    fireEvent.pointerDown(card, pointerInit(0))
    fireEvent.pointerMove(card, { ...pointerInit(200), clientY: 0 })

    expect(mediaClip('a').timelineStartSec).toBe(0)
    expect(useProjectStore.getState().selectedMediaClipId).toBe('a')
    expect(seekTo).not.toHaveBeenCalled()
    expect(findTrack(root).className).not.toContain('timeline__track--scrubbing')
  })

  it('纵向拖到另一条媒体轨：按指针 Y 命中目标轨道并提交 trackId', () => {
    seedTools()
    const root = renderTimeline(vi.fn())
    fireEvent.click(groupButton(root, '+ 媒体轨'))
    const newTrackId = useProjectStore.getState().project.mediaTracks[1]!.id

    const rows = Array.from(root.querySelectorAll<HTMLElement>('.timeline__track--media'))
    expect(rows).toHaveLength(2)
    const rect = (top: number) =>
      ({ top, bottom: top + 40, left: 0, right: TRACK_WIDTH, width: TRACK_WIDTH, height: 40, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    // 行序：新轨（track-media-1）在上，原轨在下
    rows[0]!.getBoundingClientRect = () => rect(0)
    rows[1]!.getBoundingClientRect = () => rect(40)

    const card = root.querySelector('.media-clip-card') as HTMLElement
    fireEvent.pointerDown(card, pointerInit(0))
    fireEvent.pointerMove(card, { ...pointerInit(0), clientY: 20 })

    expect(mediaClip('a').trackId).toBe(newTrackId)
  })
})

/** v10：切点转场标记（合法才出现；点击选中右侧片段且不跳转）。 */
describe('v10 转场标记', () => {
  function seedMarker(options: { bStart: number; transitionOn: 'a' | 'b' }): void {
    seedTools()
    const project = useProjectStore.getState().project
    const transition = { type: 'dissolve' as const, durationSec: 0.5 }
    const a = {
      ...mediaClip('a'),
      ...(options.transitionOn === 'a' ? { transitionIn: transition } : {})
    }
    const b = {
      ...mediaClip('b'),
      timelineStartSec: options.bStart,
      timelineEndSec: options.bStart + 2,
      sourceInSec: 2,
      sourceOutSec: 4,
      ...(options.transitionOn === 'b' ? { transitionIn: transition } : {})
    }
    useProjectStore.setState({
      project: { ...project, mediaClips: [a, b] },
      selectedMediaClipId: null,
      selectionKind: 'subtitle'
    })
  }

  it('合法转场在切点画出标记（类型 + 时长），点击选中右侧片段且不跳转', () => {
    seedMarker({ bStart: 2, transitionOn: 'b' })
    const seekTo = vi.fn()
    const root = renderTimeline(seekTo)

    const marker = root.querySelector('.timeline__transition-marker') as HTMLButtonElement
    expect(marker).toBeTruthy()
    expect(marker.getAttribute('aria-label')).toBe('转场：溶解 0.5 秒')
    expect(marker.getAttribute('title')).toContain('溶解')
    // 标记挂在切点位置（B 起点 2s × 72px/s = 144px）
    expect(parseFloat(marker.style.left)).toBeCloseTo(2 * PX_PER_SEC, 6)

    fireEvent.click(marker)
    expect(useProjectStore.getState().selectedMediaClipId).toBe('b')
    expect(seekTo).not.toHaveBeenCalled()
  })

  it('前段与后段之间有空隙：不画标记', () => {
    seedMarker({ bStart: 5, transitionOn: 'b' })
    const root = renderTimeline(vi.fn())
    expect(root.querySelector('.timeline__transition-marker')).toBeNull()
  })

  it('首段没有入场转场：即使数据里写了也不画标记', () => {
    seedMarker({ bStart: 2, transitionOn: 'a' })
    const root = renderTimeline(vi.fn())
    expect(root.querySelector('.timeline__transition-marker')).toBeNull()
  })
})
