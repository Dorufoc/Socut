import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { secondsToTimecode } from '@shared/timecode'
import type { AudioPeaksRequest, AudioPeaksResult, MediaClip, MediaItem, MediaStripRequest, MediaStripResult, VideoMeta } from '@shared/types'
import { MediaClipCard, type MediaClipCardProps } from './MediaClipCard'
import { resetSpectrumCache } from './useMediaPeaks'
import { resetStripCache } from './useMediaStrips'

/**
 * 媒体轨卡片的时间帧预览条（Thumbnail Strip，v5）。
 *
 * 除了"看得见"，更关键的是**不能破坏原有交互**：拖入出点、整段平移、手柄区域
 * 的行为必须与加预览条之前一致，只有"按下与抬起几乎没位移"才当作点一格跳转。
 */

const CARD_WIDTH_PX = 400

const clip: MediaClip = {
  id: 'mclip-1',
  mediaId: 'media-1',
  timelineStartSec: 2,
  timelineEndSec: 8,
  sourceInSec: 1,
  sourceOutSec: 7
}

function meta(over: Partial<VideoMeta> = {}): VideoMeta {
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
    bitRateKbps: null,
    ...over
  }
}

const item: MediaItem = {
  id: 'media-1',
  path: 'C:/media/a.mp4',
  name: 'a.mp4',
  meta: meta(),
  non169Ack: true,
  hdrAck: true,
  vfrPolicy: 'none',
  compactMode: 'auto',
  thumbnailUrl: 'focusnews-thumb://media-1',
  importedAt: '2026-01-01T00:00:00.000Z'
}

/** 可控的 strip IPC：默认成功返回长图地址，单个用例可临时改写 */
let stripCalls: MediaStripRequest[] = []
let stripImpl: (request: MediaStripRequest) => Promise<MediaStripResult> = async (request) => ({
  url: `focusnews-strip://${request.frames}`,
  frames: request.frames,
  key: 'token',
  cached: false
})

/** 可控的频谱取样 IPC：默认给满刻度平峰，单个用例可临时改写 */
let peaksCalls: AudioPeaksRequest[] = []
let peaksImpl: (request: AudioPeaksRequest) => Promise<AudioPeaksResult> = async (request) => ({
  peaks: Array.from({ length: request.buckets }, () => 1),
  buckets: request.buckets,
  key: 'token',
  cached: false,
  hasAudio: true
})

beforeAll(() => {
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.getBoundingClientRect = function rect(): DOMRect {
    // 卡片本体按 400px 宽、0 起点算指针比例；其它元素给轨道内容宽
    const width = this.classList.contains('media-clip-card') ? CARD_WIDTH_PX : 1000
    return { width, height: 52, left: 0, top: 0, right: width, bottom: 52, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver

  const strip = vi.fn(async (request: MediaStripRequest): Promise<MediaStripResult> => {
    stripCalls.push(request)
    return stripImpl(request)
  })
  const peaks = vi.fn(async (request: AudioPeaksRequest): Promise<AudioPeaksResult> => {
    peaksCalls.push(request)
    return peaksImpl(request)
  })
  ;(window as unknown as { focusnews: unknown }).focusnews = {
    media: { strip, peaks },
    app: { writeLog: async () => undefined }
  }
})

beforeEach(() => {
  stripCalls = []
  stripImpl = async (request) => ({ url: `focusnews-strip://${request.frames}`, frames: request.frames, key: 'token', cached: false })
  peaksCalls = []
  peaksImpl = async (request) => ({
    peaks: Array.from({ length: request.buckets }, () => 1),
    buckets: request.buckets,
    key: 'token',
    cached: false,
    hasAudio: true
  })
})

afterEach(() => {
  cleanup()
  resetStripCache()
  resetSpectrumCache()
})

function makeProps(overrides: Partial<MediaClipCardProps> = {}): MediaClipCardProps {
  return {
    clip,
    item,
    durationSec: 10,
    widthPx: 1000,
    fps: FPS_30,
    selected: false,
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onTrim: vi.fn(),
    ...overrides
  }
}

function pointer(clientX: number, button = 0): PointerEventInit {
  return { clientX, clientY: 20, button, pointerId: 5, bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 1 }
}

function hover(clientX: number): PointerEventInit {
  return { clientX, clientY: 20, button: -1, pointerId: 5, bubbles: true, cancelable: true, pointerType: 'mouse', buttons: 0 }
}

async function renderCard(props: MediaClipCardProps): Promise<HTMLElement> {
  const { container } = render(<MediaClipCard {...props} />)
  // 预览条是异步取数：让 promise 落地一次
  await act(async () => {
    await Promise.resolve()
  })
  return container.querySelector('.media-clip-card') as HTMLElement
}

describe('MediaClipCard 时间帧预览条', () => {
  it('按卡片像素宽请求格数，并把长图铺成卡片底图', async () => {
    const card = await renderCard(makeProps())

    expect(stripCalls).toHaveLength(1)
    expect(stripCalls[0]).toMatchObject({ mediaId: 'media-1', path: 'C:/media/a.mp4', sourceInSec: 1, sourceOutSec: 7 })
    // 1000px 宽 → 20 格（每约 44px 一格取档位）
    expect(stripCalls[0]!.frames).toBe(20)
    const strip = card.querySelector('.media-clip-card__strip') as HTMLImageElement
    expect(strip.src).toContain('focusnews-strip://20')
    // 有长图时不再显示占位符
    expect(card.querySelector('.media-clip-card__fallback')).toBeNull()
  })

  it('同一 key 命中会话缓存：第二次渲染不再发 IPC（避免重复计算）', async () => {
    const props = makeProps()
    await renderCard(props)
    expect(stripCalls).toHaveLength(1)

    cleanup()
    await renderCard(makeProps(props))
    expect(stripCalls).toHaveLength(1)
  })

  it('拖入出点改变源区间 → key 变，重新抽一条', async () => {
    await renderCard(makeProps())
    expect(stripCalls).toHaveLength(1)

    cleanup()
    await renderCard(makeProps({ clip: { ...clip, sourceInSec: 2 } }))
    expect(stripCalls).toHaveLength(2)
    expect(stripCalls[1]!.sourceInSec).toBe(2)
  })

  it('主进程抽不出帧时显示「无法预览」占位，而不是空白或黑洞', async () => {
    stripImpl = async () => ({ url: null, frames: 8, key: 'token', cached: false })
    const card = await renderCard(makeProps())

    expect(card.querySelector('.media-clip-card__strip')).toBeNull()
    const fallback = card.querySelector('.media-clip-card__fallback') as HTMLElement
    expect(fallback.textContent).toContain('无法预览')
    // 失败结果也进缓存：不会因为重渲染反复轰炸主进程
    expect(stripCalls).toHaveLength(1)
  })

  it('素材已移出池：不发请求，直接说明原因', async () => {
    const card = await renderCard(makeProps({ item: null }))

    expect(stripCalls).toHaveLength(0)
    expect((card.querySelector('.media-clip-card__fallback') as HTMLElement).textContent).toContain('素材已移出')
  })

  it('悬停读出指针处的时间点（时间轴与源两个坐标）', async () => {
    const card = await renderCard(makeProps())

    fireEvent.pointerEnter(card, hover(200))
    fireEvent.pointerMove(card, hover(200))

    const hint = card.querySelector('.media-clip-card__hint') as HTMLElement
    // 卡片 400px 宽、中点 → 源 1+6×0.5=4s，时间轴 2+6×0.5=5s
    expect(hint.textContent).toBe(
      `${secondsToTimecode(5, FPS_30)} · 源 ${secondsToTimecode(4, FPS_30)}`
    )
    expect(hint.className).toContain('media-clip-card__hint--visible')
  })

  it('点一格只选中：不再顺手跳转（跳转留给轨道空白处、尺规与「定位到这一段」）', async () => {
    const props = makeProps()
    const card = await renderCard(props)

    fireEvent.pointerDown(card, pointer(300))
    fireEvent.pointerUp(card, pointer(300))

    expect(props.onSelect).toHaveBeenCalledWith(clip.id)
    expect(props.onMove).not.toHaveBeenCalled()
    expect(props.onTrim).not.toHaveBeenCalled()
  })

  it('拖拽平移：只 onMove，不动区间', async () => {
    const props = makeProps()
    const card = await renderCard(props)

    fireEvent.pointerDown(card, pointer(200))
    fireEvent.pointerMove(card, pointer(260))
    fireEvent.pointerUp(card, pointer(260))

    expect(props.onMove).toHaveBeenCalled()
  })

  it('拖入点手柄：只调区间，不平移', async () => {
    const props = makeProps()
    const card = await renderCard(props)
    const handle = card.querySelector('.media-clip-card__handle--left') as HTMLElement

    fireEvent.pointerDown(handle, pointer(4))
    fireEvent.pointerMove(handle, pointer(60))
    fireEvent.pointerUp(handle, pointer(60))

    expect(props.onTrim).toHaveBeenCalled()
    expect(props.onMove).not.toHaveBeenCalled()
  })

  it('手柄上「点一下」不改区间（抬起时拖拽状态已被手柄清掉），也不选中之外的任何段', async () => {
    const props = makeProps()
    const card = await renderCard(props)
    const handle = card.querySelector('.media-clip-card__handle--right') as HTMLElement

    fireEvent.pointerDown(handle, pointer(398))
    fireEvent.pointerUp(handle, pointer(398))

    expect(props.onTrim).not.toHaveBeenCalled()
    expect(props.onMove).not.toHaveBeenCalled()
    // 手柄也是段落的一部分：点它同样只把选中交给上层
    expect(props.onSelect).toHaveBeenCalledWith(clip.id)
  })

  it('卡片加宽但没跨密度档时不重复抽帧（逐像素拖宽不会连环请求）', async () => {
    await renderCard(makeProps({ widthPx: 1000 }))
    expect(stripCalls).toHaveLength(1)

    cleanup()
    await renderCard(makeProps({ widthPx: 1010 }))
    expect(stripCalls).toHaveLength(1)

    cleanup()
    await renderCard(makeProps({ widthPx: 1100 }))
    expect(stripCalls).toHaveLength(2)
  })
})

/**
 * 音频频谱条（v9）：卡片底 1/3 的幅度包络。
 *
 * 除了「看得见」，更关键的是**不该画的时候一个请求都不发**（无音轨 / 图像 / 素材已移出），
 * 以及取样拿不到时只能没有柱子，不许拖垮预览条与原有拖入出点交互。
 */
describe('MediaClipCard 音频频谱条', () => {
  it('有音轨：按卡片像素宽请求峰，柱子铺满整卡并标记 --spectrum', async () => {
    const card = await renderCard(makeProps())

    expect(peaksCalls).toHaveLength(1)
    expect(peaksCalls[0]).toMatchObject({ mediaId: 'media-1', path: 'C:/media/a.mp4', sourceInSec: 1, sourceOutSec: 7 })
    // 1000px 宽 / 每 7px 一根 → 上限档 96
    expect(peaksCalls[0]!.buckets).toBe(96)
    const spectrum = card.querySelector('.media-clip-card__spectrum') as HTMLElement
    expect(spectrum.getAttribute('data-bars')).toBe('96')
    expect(spectrum.querySelectorAll('.media-clip-card__spectrum-bar')).toHaveLength(96)
    expect(card.className).toContain('media-clip-card--spectrum')
    // 频谱是纯装饰，不能抢读屏与鼠标
    expect(spectrum.getAttribute('aria-hidden')).toBe('true')
  })

  it('无音轨：一个取样请求都不发，也不画柱子', async () => {
    const card = await renderCard(makeProps({ item: { ...item, meta: meta({ audioCodec: null }) } }))

    expect(peaksCalls).toHaveLength(0)
    expect(card.querySelector('.media-clip-card__spectrum-bar')).toBeNull()
    expect(card.className).not.toContain('media-clip-card--spectrum')
  })

  it('图像素材没有声流：同样不请求', async () => {
    await renderCard(makeProps({ item: { ...item, kind: 'image' } }))
    expect(peaksCalls).toHaveLength(0)
  })

  it('素材已移出池：不请求（文件都不在了）', async () => {
    const card = await renderCard(makeProps({ item: null }))
    expect(peaksCalls).toHaveLength(0)
    expect(card.querySelector('.media-clip-card__spectrum-bar')).toBeNull()
  })

  it('主进程取不到峰：安静地不画，预览条与文字照旧', async () => {
    peaksImpl = async (request) => ({ peaks: [], buckets: request.buckets, key: 'token', cached: false, hasAudio: false })
    const card = await renderCard(makeProps())

    expect(peaksCalls).toHaveLength(1)
    expect(card.querySelector('.media-clip-card__spectrum-bar')).toBeNull()
    expect(card.querySelector('.media-clip-card__strip')).not.toBeNull()
    // 失败结果也进缓存：不会重渲染一次就轰炸主进程
    cleanup()
    await renderCard(makeProps())
    expect(peaksCalls).toHaveLength(1)
  })

  it('音量与淡入立刻改变柱子高度（频谱条是音频参数的真实反馈）', async () => {
    const half = await renderCard(makeProps({ clip: { ...clip, audio: { volumePercent: 50, fadeInSec: 0, fadeOutSec: 0 } } }))
    expect((half.querySelector('.media-clip-card__spectrum-bar') as HTMLElement).style.height).toBe('50%')

    cleanup()
    const muted = await renderCard(makeProps({ clip: { ...clip, audio: { volumePercent: 0, fadeInSec: 0, fadeOutSec: 0 } } }))
    // 音量 0：柱子塌到底（只保留可见基准）
    expect((muted.querySelector('.media-clip-card__spectrum-bar') as HTMLElement).style.height).toBe('4%')

    cleanup()
    const faded = await renderCard(makeProps({ clip: { ...clip, audio: { volumePercent: 100, fadeInSec: 3, fadeOutSec: 0 } } }))
    const bars = faded.querySelectorAll('.media-clip-card__spectrum-bar') as NodeListOf<HTMLElement>
    // 渐入 3s / 片段 6s：起点仍是静音
    expect(bars[0]!.style.height).toBe('4%')
    // 后半段恢复到满刻度
    expect(bars[bars.length - 1]!.style.height).toBe('100%')
  })

  it('拖入出点改变源区间 → 取样键变，重新折一次峰', async () => {
    await renderCard(makeProps())
    expect(peaksCalls).toHaveLength(1)

    cleanup()
    await renderCard(makeProps({ clip: { ...clip, sourceOutSec: 8 } }))
    expect(peaksCalls).toHaveLength(2)
    expect(peaksCalls[1]!.sourceOutSec).toBe(8)
  })
})
