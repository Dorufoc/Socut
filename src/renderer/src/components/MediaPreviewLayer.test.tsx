import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import type { MediaClip, MediaClipMask } from '@shared/types'
import type { PreviewCandidate } from '../render/previewCandidates'
import type { PreviewTransitionState } from '../render/previewTransition'
import { previewPerf, resetPreviewPerf } from '../render/previewPerf'
import { MediaPreviewLayer, shouldRefreshPreviewUrl, type MediaPreviewHandle } from './MediaPreviewLayer'

/**
 * 转场预览的 DOM 纪律（v10 Task 6）：
 * 1. 窗口内两层都可见，opacity/translate/blur/色块写进 inline style（不走 React state）；
 * 2. 音频仍按切点硬切：只有切点一侧的视频元素解除静音；
 * 3. 退出转场后 transform/filter 还原成片段基座样式。
 */

function clip(over: Partial<MediaClip>): MediaClip {
  return {
    id: over.id ?? 'clip',
    mediaId: over.mediaId ?? 'media-1',
    trackId: over.trackId ?? DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: over.timelineStartSec ?? 0,
    timelineEndSec: over.timelineEndSec ?? 2,
    sourceInSec: over.sourceInSec ?? 0,
    sourceOutSec: over.sourceOutSec ?? 2,
    ...over
  }
}

const left = clip({ id: 'left', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0.5, sourceOutSec: 2.5 })
const right = clip({ id: 'right', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 1, sourceOutSec: 3 })

describe('MediaPreviewLayer 媒体段关键帧（M6-E）', () => {
  /** 一段挂了「位移 0→100%、不透明度 1→0.5」关键帧的 2 秒素材。 */
  function keyframedClip(): MediaClip {
    return clip({
      id: 'kf',
      timelineStartSec: 0,
      timelineEndSec: 2,
      sourceInSec: 0,
      sourceOutSec: 2,
      keyframes: [
        {
          param: 'offsetXPct',
          points: [
            { t: 0, value: 0, easing: 'linear' },
            { t: 1, value: 100, easing: 'linear' }
          ]
        },
        {
          param: 'opacity',
          points: [
            { t: 0, value: 1, easing: 'linear' },
            { t: 1, value: 0.5, easing: 'linear' }
          ]
        }
      ]
    })
  }

  async function renderKeyframed(staticScale = 100) {
    const target = keyframedClip()
    if (staticScale !== 100) target.video = { ...defaultMediaVideo(), scalePercent: staticScale }
    const ref = createRef<MediaPreviewHandle>()
    const candidate: PreviewCandidate = {
      clip: target,
      kind: 'video',
      hasAudio: true,
      sourcePath: 'C:/media/keyframed.mp4',
      useStabProxy: false
    }
    const view = render(<MediaPreviewLayer ref={ref} candidates={[candidate]} fps={FPS_30} />)
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = view.container.querySelector('video')!
    fireEvent.loadedMetadata(video)
    fireEvent.seeked(video)
    fireEvent.loadedData(video)
    const wrapper = view.container.querySelector('.stage__media-keyframes') as HTMLDivElement
    expect(wrapper).toBeTruthy()
    return { ...view, ref, video, wrapper }
  }

  it('逐帧把关键帧几何/不透明度写到包裹层（t=0 / t=1s / t=2s）', async () => {
    const { ref, wrapper, video } = await renderKeyframed()

    act(() => ref.current?.tick(0, false))
    expect(wrapper.style.transform).toBe('')
    expect(wrapper.style.opacity).toBe('1')

    // 1s = 片段中点：位移 50%、不透明度 0.75
    act(() => ref.current?.tick(1, false))
    expect(wrapper.style.transform).toContain('translate(50%')
    expect(Number(wrapper.style.opacity)).toBeCloseTo(0.75, 2)

    // 2s = 出点：位移 100%、不透明度 0.5
    act(() => ref.current?.tick(2, false))
    expect(wrapper.style.transform).toContain('translate(100%')
    expect(Number(wrapper.style.opacity)).toBeCloseTo(0.5, 2)

    // 元素自身的静态 transform 不再叠加（否则被关键帧覆盖的参数会翻倍）
    expect(video.style.transform).toBe('')
  })

  it('静态缩放 + 关键帧位移：覆盖语义下未挂轨道的参数仍取静态值', async () => {
    const { ref, wrapper } = await renderKeyframed(150)
    act(() => ref.current?.tick(0, false))
    expect(wrapper.style.transform).toContain('scale(1.5)')
  })

  it('没有关键帧的段：包裹层保持默认（空 transform / 1），元素仍走静态 transform', async () => {
    const ref = createRef<MediaPreviewHandle>()
    const plain = clip({ id: 'plain', timelineStartSec: 0, timelineEndSec: 2 })
    plain.video = { ...defaultMediaVideo(), scalePercent: 150 }
    const candidate: PreviewCandidate = {
      clip: plain,
      kind: 'video',
      hasAudio: true,
      sourcePath: 'C:/media/plain.mp4',
      useStabProxy: false
    }
    const view = render(<MediaPreviewLayer ref={ref} candidates={[candidate]} fps={FPS_30} />)
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const wrapper = view.container.querySelector('.stage__media-keyframes') as HTMLDivElement
    act(() => ref.current?.tick(1, false))
    expect(wrapper.style.transform).toBe('')
    expect(wrapper.style.opacity).toBe('1')
    expect((view.container.querySelector('video') as HTMLVideoElement).style.transform).toContain('scale(1.5)')
  })
})

let pathSeq = 0

/** 每个用例用独立源路径：模块级 URL 缓存跨用例复用，独立路径避免用例之间互相影响。 */
function candidates(): PreviewCandidate[] {
  const seq = ++pathSeq
  return [
    {
      clip: left,
      kind: 'video',
      hasAudio: true,
      sourcePath: `C:/media/${seq}-left.mp4`,
      useStabProxy: false
    },
    {
      clip: right,
      kind: 'video',
      hasAudio: true,
      sourcePath: `C:/media/${seq}-right.mp4`,
      useStabProxy: false
    }
  ]
}

function state(over: Partial<PreviewTransitionState> = {}): PreviewTransitionState {
  return {
    leftClipId: 'left',
    rightClipId: 'right',
    type: 'dissolve',
    cutSec: 2,
    startSec: 1.75,
    endSec: 2.25,
    durationSec: 0.5,
    progress: 0.5,
    ...over
  }
}

let originalPlay: typeof HTMLMediaElement.prototype.play
let originalPause: typeof HTMLMediaElement.prototype.pause
let originalSeeking: PropertyDescriptor | undefined

/** 可控的在飞 seek 标记：测试里直接 `video.__seeking = true` 模拟 seek 未完成。 */
type SeekingHook = HTMLVideoElement & { __seeking?: boolean }

beforeAll(() => {
  // jsdom 没有媒体解码：把 readyState / currentTime 变成可控的简单属性
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => 2
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return (this as unknown as { __ct?: number }).__ct ?? 0
    },
    set(this: HTMLMediaElement, value: number) {
      (this as unknown as { __ct?: number }).__ct = value
    }
  })
  // seek 合并器要读 video.seeking：用可配置的桩替代 jsdom 的只读实现，afterAll 还原
  originalSeeking = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seeking')
  Object.defineProperty(HTMLMediaElement.prototype, 'seeking', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return (this as unknown as SeekingHook).__seeking === true
    }
  })
  originalPlay = HTMLMediaElement.prototype.play
  originalPause = HTMLMediaElement.prototype.pause
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
  ;(window as unknown as { socut?: unknown }).socut = {
    video: {
      previewUrl: async (path: string) => `mock://${path}`
    }
  }
})

afterAll(() => {
  HTMLMediaElement.prototype.play = originalPlay
  HTMLMediaElement.prototype.pause = originalPause
  if (originalSeeking) {
    Object.defineProperty(HTMLMediaElement.prototype, 'seeking', originalSeeking)
  } else {
    delete (HTMLMediaElement.prototype as unknown as { seeking?: unknown }).seeking
  }
  delete (window as unknown as { socut?: unknown }).socut
})

beforeEach(() => resetPreviewPerf())

afterEach(() => cleanup())

async function renderLayer(
  transition: PreviewTransitionState | null,
  transitionResolver?: (atSec: number) => PreviewTransitionState | null
) {
  const ref = createRef<MediaPreviewHandle>()
  const view = render(
    <MediaPreviewLayer
      ref={ref}
      candidates={candidates()}
      fps={FPS_30}
      transition={transition}
      transitionResolver={transitionResolver}
    />
  )
  await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(2))
  const videos = Array.from(view.container.querySelectorAll('video'))
  for (const video of videos) {
    fireEvent.loadedMetadata(video)
    fireEvent.seeked(video)
    fireEvent.loadedData(video)
  }
  return { ...view, ref, videos }
}

/** 候选按数组顺序渲染：0 = 左侧（前段），1 = 右侧（后段）。 */
function videoAt(container: HTMLElement, index: number): HTMLVideoElement {
  const element = container.querySelectorAll('video')[index]
  if (!element) throw new Error(`video ${index} not found`)
  return element
}

describe('MediaPreviewLayer 转场', () => {
  it('窗口内两层同时可见：透明度交叉淡化写进 inline style', async () => {
    const { container, ref } = await renderLayer(state())
    expect(container.querySelectorAll('video')).toHaveLength(2)

    act(() => ref.current?.tick(2, false))
    expect(videoAt(container, 0).style.opacity).toBe('0.5')
    expect(videoAt(container, 1).style.opacity).toBe('0.5')
  })

  it('transitionResolver 返回窗口内状态时两层交叉淡化生效（按实时 tick 时间现算）', async () => {
    const resolver = (atSec: number) => (atSec >= 1.75 && atSec <= 2.25 ? state() : null)
    const { container, ref } = await renderLayer(null, resolver)

    act(() => ref.current?.tick(2, false))
    expect(videoAt(container, 0).style.opacity).toBe('0.5')
    expect(videoAt(container, 1).style.opacity).toBe('0.5')

    // 窗口外 resolver 返回 null：回到单层可见，右侧（当前活动段）不透明
    act(() => ref.current?.tick(2.6, false))
    expect(videoAt(container, 0).style.opacity).toBe('0')
    expect(videoAt(container, 1).style.opacity).toBe('1')
  })

  it('风感把转场位移叠加在片段基座 transform 之后', async () => {
    const { container, ref } = await renderLayer(state({ type: 'windLeft' }))

    act(() => ref.current?.tick(2, false))
    expect(videoAt(container, 0).style.transform).toBe('translate(-87.5%, 0%)')
    expect(videoAt(container, 1).style.transform).toBe('translate(12.5%, 0%)')
    expect(videoAt(container, 0).style.filter).toBe('blur(12px)')
  })

  it('黑场色块峰值在中点：flash opacity = 1', async () => {
    const { container, ref } = await renderLayer(state({ type: 'fadeBlack' }))
    const flash = container.querySelector('.stage__transition-flash') as HTMLElement

    act(() => ref.current?.tick(2, false))
    expect(flash.style.opacity).toBe('1')
    // 切片中点两层都透明
    expect(videoAt(container, 0).style.opacity).toBe('0')
    expect(videoAt(container, 1).style.opacity).toBe('0')
  })

  it('音频硬切：切点前只有左侧出声，切点后只有右侧出声', async () => {
    const { container, ref } = await renderLayer(state())

    act(() => ref.current?.tick(1.9, true))
    expect(videoAt(container, 0).muted).toBe(false)
    expect(videoAt(container, 1).muted).toBe(true)

    act(() => ref.current?.tick(2.1, true))
    expect(videoAt(container, 0).muted).toBe(true)
    expect(videoAt(container, 1).muted).toBe(false)
  })

  it('退出转场后 transform/filter 还原，回到单层可见', async () => {
    const leftWithScale: MediaClip = {
      ...left,
      video: { ...defaultMediaVideo(), scalePercent: 120 }
    }
    const ref = createRef<MediaPreviewHandle>()
    const view = render(
      <MediaPreviewLayer
        ref={ref}
        candidates={[
          { clip: leftWithScale, kind: 'video', hasAudio: true, sourcePath: 'C:/media/left.mp4', useStabProxy: false },
          { clip: right, kind: 'video', hasAudio: true, sourcePath: 'C:/media/right.mp4', useStabProxy: false }
        ]}
        fps={FPS_30}
        transition={state({ type: 'windLeft' })}
      />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(2))
    for (const video of Array.from(view.container.querySelectorAll('video'))) {
      fireEvent.loadedMetadata(video)
      fireEvent.seeked(video)
      fireEvent.loadedData(video)
    }

    act(() => ref.current?.tick(2, false))
    expect(view.container.querySelectorAll('video')[0]!.style.transform).toBe(
      'scale(1.2) translate(-87.5%, 0%)'
    )

    view.rerender(
      <MediaPreviewLayer ref={ref} candidates={[leftWithScale, right].map((item) => ({
        clip: item,
        kind: 'video' as const,
        hasAudio: true,
        sourcePath: `C:/media/${item.id}.mp4`,
        useStabProxy: false
      }))} fps={FPS_30} transition={null} />
    )
    act(() => ref.current?.tick(2, false))
    expect(view.container.querySelectorAll('video')[0]!.style.transform).toBe('scale(1.2)')
    expect(view.container.querySelectorAll('video')[0]!.style.opacity).toBe('0')
    expect(view.container.querySelectorAll('video')[1]!.style.opacity).toBe('1')
  })
})

describe('MediaPreviewLayer 切点与循环重启（Task 4）', () => {
  it('restart() 把每个候选送回各自入点，并还原转场样式与色块', async () => {
    const { container, ref } = await renderLayer(state({ type: 'windLeft' }))
    const flash = container.querySelector('.stage__transition-flash') as HTMLElement

    act(() => ref.current?.tick(2, false))
    // 先确认确实进了转场：位移与 zIndex 都是转场增量
    expect(videoAt(container, 0).style.transform).toBe('translate(-87.5%, 0%)')
    expect(videoAt(container, 1).style.zIndex).toBe('2')

    act(() => ref.current?.restart())
    // jsdom 没有 duration，钳制退化成 target - 1ms（与 `seekVideo` 同口径），所以只比到 0.01
    expect(videoAt(container, 0).currentTime).toBeCloseTo(0.5, 2)
    expect(videoAt(container, 1).currentTime).toBeCloseTo(1, 2)
    expect(videoAt(container, 0).style.transform).toBe('')
    expect(videoAt(container, 0).style.filter).toBe('')
    expect(videoAt(container, 1).style.transform).toBe('')
    expect(videoAt(container, 1).style.zIndex).toBe('')
    expect(flash.style.opacity).toBe('0')
  })

  it('切点目标未就绪时停在上一段，就绪后同一时刻切过去', async () => {
    const ref = createRef<MediaPreviewHandle>()
    const view = render(
      <MediaPreviewLayer ref={ref} candidates={candidates()} fps={FPS_30} transition={null} />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(2))
    const videos = Array.from(view.container.querySelectorAll('video'))

    // 只让 left（前段）就绪：right 不发任何加载事件
    fireEvent.loadedMetadata(videos[0]!)
    fireEvent.seeked(videos[0]!)
    fireEvent.loadedData(videos[0]!)

    act(() => ref.current?.tick(2.1, true))
    expect(videos[1]!.style.opacity).toBe('0')
    expect(videos[0]!.style.opacity).toBe('1')
    // 画面停在已结束的兜底段 = 一次迟到切换
    expect(previewPerf.lateSwitches).toBe(1)

    fireEvent.loadedMetadata(videos[1]!)
    fireEvent.seeked(videos[1]!)
    fireEvent.loadedData(videos[1]!)

    act(() => ref.current?.tick(2.1, true))
    expect(videos[1]!.style.opacity).toBe('1')
    expect(videos[0]!.style.opacity).toBe('0')
  })

  it('seek 合并：在飞期间只换目标，seeked 后落到最后一次目标', async () => {
    const { container, ref } = await renderLayer(null)
    const rightVideo = videoAt(container, 1) as SeekingHook
    // 挂载阶段 primeVideo 已经各发过一次 seek，这里只看 tick 之后的增量
    const baseRequests = previewPerf.seekRequests
    const baseCoalesced = previewPerf.seekCoalesced

    act(() => ref.current?.tick(2.1, true))
    // 首次进入活动段：强制对齐到 1 + (2.1 - 2) = 1.1
    expect(rightVideo.currentTime).toBeCloseTo(1.1, 2)
    expect(previewPerf.seekRequests).toBe(baseRequests + 1)

    // 模拟一次在飞 seek：之后的连续 tick 只能合并目标
    rightVideo.__seeking = true
    act(() => ref.current?.tick(2.4, true))
    act(() => ref.current?.tick(2.6, true))
    expect(previewPerf.seekRequests).toBe(baseRequests + 1)
    expect(previewPerf.seekCoalesced).toBeGreaterThanOrEqual(baseCoalesced + 2)

    rightVideo.__seeking = false
    fireEvent.seeked(rightVideo)
    expect(rightVideo.currentTime).toBeCloseTo(1.6, 2)
  })
})

describe('MediaPreviewLayer 回绕预对齐（Task 8）', () => {
  const head = clip({
    id: 'head',
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 0.5,
    sourceOutSec: 2.5
  })

  /** 只挂头部片段：loopDurationSec 缺省时不启用回绕前瞻。 */
  async function renderHead(loopDurationSec?: number) {
    const ref = createRef<MediaPreviewHandle>()
    const view = render(
      <MediaPreviewLayer
        ref={ref}
        candidates={[
          {
            clip: head,
            kind: 'video',
            hasAudio: true,
            sourcePath: `C:/media/head-${++pathSeq}.mp4`,
            useStabProxy: false
          }
        ]}
        fps={FPS_30}
        transition={null}
        loopDurationSec={loopDurationSec}
      />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = videoAt(view.container, 0)
    fireEvent.loadedMetadata(video)
    fireEvent.seeked(video)
    fireEvent.loadedData(video)
    return { ...view, ref, video }
  }

  it('回绕前瞻窗口内把「已结束」的头部片段送回入点', async () => {
    const { ref, video } = await renderHead(12)
    // 模拟本轮已播到片段末尾
    video.currentTime = 2

    act(() => ref.current?.tick(11.5, false))
    // jsdom 无 duration，钳制保留 1ms 余量，按两位小数比较
    expect(video.currentTime).toBeCloseTo(0.5, 2)
  })

  it('loopDurationSec = 0（不循环）时保持旧行为：停在最后一帧', async () => {
    const { ref, video } = await renderHead()
    video.currentTime = 2

    act(() => ref.current?.tick(11.5, false))
    expect(video.currentTime).toBe(2)
  })
})

describe('MediaPreviewLayer 裁切片段首帧（DOM 顺序 / 媒体重载）', () => {
  /**
   * 现场反馈：裁切片段（源入点 ≠ 0）预览时总会先闪一下**原素材第一帧**，再回到入点。
   *
   * 机制：候选池顺序随角色变化（活动段在前、兜底段在后），切点前后会从 [前段, 后段]
   * 翻成 [后段, 前段]；React 随即把 `<video>` 节点在 DOM 里搬一次，浏览器会把被搬动的
   * 媒体元素重新加载（currentTime 归零 → 先画首帧）。未裁切的片段首帧本来就是对的，
   * 所以只有裁切片段看得见这次闪光。
   */
  const trimmed: MediaClip = clip({
    id: 'trimmed',
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 5,
    sourceOutSec: 7
  })
  const later: MediaClip = clip({
    id: 'later',
    timelineStartSec: 2,
    timelineEndSec: 4,
    sourceInSec: 9,
    sourceOutSec: 11
  })

  function candidateOf(item: MediaClip, seq = 0): PreviewCandidate {
    return {
      clip: item,
      kind: 'video',
      hasAudio: false,
      sourcePath: `C:/media/trim-${item.id}-${seq}.mp4`,
      useStabProxy: false
    }
  }

  it('候选池换序（活动 ↔ 兜底）不搬动 <video> 节点，节点顺序按时间轴固定', async () => {
    const ref = createRef<MediaPreviewHandle>()
    const first = candidateOf(trimmed, 1)
    const second = candidateOf(later, 1)
    const view = render(
      <MediaPreviewLayer ref={ref} candidates={[first, second]} fps={FPS_30} transition={null} />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(2))
    const [beforeA, beforeB] = Array.from(view.container.querySelectorAll('video'))

    // 切点之后候选池把「刚结束的段」排在后面：数组顺序整体翻转
    view.rerender(
      <MediaPreviewLayer ref={ref} candidates={[second, first]} fps={FPS_30} transition={null} />
    )
    const after = Array.from(view.container.querySelectorAll('video'))
    expect(after).toHaveLength(2)
    expect(after[0]).toBe(beforeA)
    expect(after[1]).toBe(beforeB)
  })

  it('媒体被复位（重载）时当场隐藏，不等下一帧 tick：不会露出源片首帧', async () => {
    const ref = createRef<MediaPreviewHandle>()
    const view = render(
      <MediaPreviewLayer ref={ref} candidates={[candidateOf(trimmed, 2)]} fps={FPS_30} transition={null} />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = videoAt(view.container, 0)
    fireEvent.loadedMetadata(video)
    fireEvent.seeked(video)
    fireEvent.loadedData(video)

    act(() => ref.current?.tick(1, false))
    expect(video.style.opacity).toBe('1')
    // 媒体被浏览器复位（DOM 搬动 / src 换版本）→ 画面退回源片首帧
    fireEvent.emptied(video)
    expect(video.style.opacity).toBe('0')
  })

  it('合并器排队的 seek 没落地就不标就绪（不会把上一次 seek 的帧翻到最上层）', async () => {
    const ref = createRef<MediaPreviewHandle>()
    const view = render(
      <MediaPreviewLayer ref={ref} candidates={[candidateOf(trimmed, 3)]} fps={FPS_30} transition={null} />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = videoAt(view.container, 0) as SeekingHook

    // 加载阶段浏览器已经在 seek：primeVideo 的入点 seek 只能排队
    video.__seeking = true
    fireEvent.loadedMetadata(video)
    fireEvent.loadedData(video)
    act(() => ref.current?.tick(1, false))
    expect(video.style.opacity).toBe('0')

    // 旧的 seek 结束：合并器补发入点 seek。`currentTime` 已经读出 5，但帧还没解出来，
    // 这一瞬间标就绪就会把上一帧（源片首帧）当成入点画面翻到最上层。
    video.__seeking = false
    fireEvent.seeked(video)
    act(() => ref.current?.tick(1, false))
    expect(video.currentTime).toBeCloseTo(5, 2)
    expect(video.style.opacity).toBe('0')

    // 入点 seek 真正落地后才允许出画；随后 tick 再按播放头精确落位（源 5 + 本地 1 = 6）
    fireEvent.seeked(video)
    act(() => ref.current?.tick(1, false))
    expect(video.style.opacity).toBe('1')
    expect(video.currentTime).toBeCloseTo(6, 2)
  })
})

describe('MediaPreviewLayer 源地址缓存（叠加层 / 顺序段）', () => {
  function one(path: string, id: string): PreviewCandidate {
    return {
      clip: clip({ id, mediaId: `media-${id}`, timelineStartSec: 0, timelineEndSec: 4 }),
      kind: 'video',
      hasAudio: false,
      sourcePath: path,
      useStabProxy: false
    }
  }

  it('模块级缓存命中时新挂载的图层仍然拿到 src（新增轨道不能空渲染）', async () => {
    const path = `C:/media/reuse-${++pathSeq}.mp4`

    const first = render(<MediaPreviewLayer candidates={[one(path, 'reuse-a')]} fps={FPS_30} transition={null} />)
    await waitFor(() => expect(first.container.querySelectorAll('video')).toHaveLength(1))
    // 卸载后再用同一路径挂新实例：模拟「新建轨道 / 再次切回该段」时缓存已经命中
    first.unmount()

    const second = render(<MediaPreviewLayer candidates={[one(path, 'reuse-b')]} fps={FPS_30} transition={null} />)
    await waitFor(() => expect(second.container.querySelectorAll('video')).toHaveLength(1))
  })

  it('两个图层同时引用同一源路径时都能挂载（在飞请求按路径共享而不是互相吞掉）', async () => {
    const path = `C:/media/shared-${++pathSeq}.mp4`

    const view = render(
      <>
        <MediaPreviewLayer candidates={[one(path, 'shared-a')]} fps={FPS_30} transition={null} />
        <MediaPreviewLayer candidates={[one(path, 'shared-b')]} fps={FPS_30} transition={null} />
      </>
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(2))
  })

  it('同一轨道上紧邻的第二段在切点后接替显示', async () => {
    const ref = createRef<MediaPreviewHandle>()
    const first = clip({ id: 'seq-a', timelineStartSec: 0, timelineEndSec: 2 })
    const second = clip({ id: 'seq-b', timelineStartSec: 2, timelineEndSec: 4 })
    const view = render(
      <MediaPreviewLayer
        ref={ref}
        candidates={[
          { clip: first, kind: 'video', hasAudio: false, sourcePath: `C:/media/seq-a-${++pathSeq}.mp4`, useStabProxy: false },
          { clip: second, kind: 'video', hasAudio: false, sourcePath: `C:/media/seq-b-${++pathSeq}.mp4`, useStabProxy: false }
        ]}
        fps={FPS_30}
        transition={null}
      />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(2))
    for (const video of Array.from(view.container.querySelectorAll('video'))) {
      fireEvent.loadedMetadata(video)
      fireEvent.seeked(video)
      fireEvent.loadedData(video)
    }

    act(() => ref.current?.tick(1.9, true))
    expect(videoAt(view.container, 0).style.opacity).toBe('1')
    expect(videoAt(view.container, 1).style.opacity).toBe('0')

    act(() => ref.current?.tick(2.1, true))
    expect(videoAt(view.container, 0).style.opacity).toBe('0')
    expect(videoAt(view.container, 1).style.opacity).toBe('1')
  })

  it('上层轨道与下层轨道同时有画面时两层各自出图', async () => {
    const bottomPath = `C:/media/bottom-${++pathSeq}.mp4`
    const topPath = `C:/media/top-${++pathSeq}.mp4`
    const view = render(
      <>
        <MediaPreviewLayer
          candidates={[
            {
              clip: clip({ id: 'bottom', trackId: 'track-media-0', timelineStartSec: 0, timelineEndSec: 10 }),
              kind: 'video',
              hasAudio: false,
              sourcePath: bottomPath,
              useStabProxy: false
            }
          ]}
          fps={FPS_30}
          transition={null}
        />
        <MediaPreviewLayer
          candidates={[
            {
              clip: clip({ id: 'top', trackId: 'track-media-1', timelineStartSec: 0, timelineEndSec: 10 }),
              kind: 'video',
              hasAudio: false,
              sourcePath: topPath,
              useStabProxy: false
            }
          ]}
          fps={FPS_30}
          transition={null}
        />
      </>
    )
    // 两个不同源并发解析：各层都要有自己的元素，不能因为共享缓存的竞态少挂一层
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(2))
  })
})

describe('MediaPreviewLayer 段落结束边界（叠加层收尾）', () => {
  async function renderSingle(target: MediaClip, trackClips: MediaClip[]) {
    const ref = createRef<MediaPreviewHandle>()
    const view = render(
      <MediaPreviewLayer
        ref={ref}
        candidates={[
          {
            clip: target,
            kind: 'video',
            hasAudio: false,
            sourcePath: `C:/media/end-${++pathSeq}.mp4`,
            useStabProxy: false
          }
        ]}
        trackClips={trackClips}
        fps={FPS_30}
        transition={null}
      />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = videoAt(view.container, 0)
    fireEvent.loadedMetadata(video)
    fireEvent.seeked(video)
    fireEvent.loadedData(video)
    return { ...view, ref, video }
  }

  it('轨道末端：结束帧之后立即隐藏，不再用最后一帧压住下层', async () => {
    const a = clip({ id: 'end-a', timelineStartSec: 0, timelineEndSec: 2 })
    const { ref, video } = await renderSingle(a, [a])

    act(() => ref.current?.tick(1.9, false))
    expect(video.style.opacity).toBe('1')

    act(() => ref.current?.tick(2.05, false))
    expect(video.style.opacity).toBe('0')
  })

  it('段后留有空隙时同样立即隐藏（空隙属于空白画面）', async () => {
    const a = clip({ id: 'gap-a', timelineStartSec: 0, timelineEndSec: 2 })
    const next = clip({ id: 'gap-b', timelineStartSec: 2.5, timelineEndSec: 4 })
    const { ref, video } = await renderSingle(a, [a, next])

    act(() => ref.current?.tick(1.9, false))
    expect(video.style.opacity).toBe('1')

    act(() => ref.current?.tick(2.2, false))
    expect(video.style.opacity).toBe('0')
  })

  it('终点处紧贴下一段、但下一段还没进候选池时仍用最后一帧兜底', async () => {
    const a = clip({ id: 'seam-a', timelineStartSec: 0, timelineEndSec: 2 })
    const b = clip({ id: 'seam-b', timelineStartSec: 2, timelineEndSec: 4 })
    // 候选池只因上限被裁剪成 [a]；轨道数据里 b 紧贴 a 的终点，属于真正的缝口
    const { ref, video } = await renderSingle(a, [a, b])

    act(() => ref.current?.tick(2.05, false))
    expect(video.style.opacity).toBe('1')
  })
})

describe('shouldRefreshPreviewUrl（Task 8：URL 版本刷新）', () => {
  it('没有缓存条目时必须刷新', () => {
    expect(shouldRefreshPreviewUrl(undefined, 100)).toBe(true)
  })

  it('TTL 内不刷新', () => {
    expect(shouldRefreshPreviewUrl({ fetchedAt: 100 }, 100 + 4_999, 5_000)).toBe(false)
  })

  it('TTL 外刷新', () => {
    expect(shouldRefreshPreviewUrl({ fetchedAt: 100 }, 100 + 5_000, 5_000)).toBe(true)
  })
})

describe('手绘遮罩预览（M8）', () => {
  const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  let seq = 0
  const created: string[] = []
  const revoked: string[] = []
  let canvasSizes: Array<{ width: number; height: number }> = []
  const createObjectURL = vi.fn(() => {
    const url = `blob:mask-${++seq}`
    created.push(url)
    return url
  })
  const revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url)
  })

  beforeEach(() => {
    seq = 0
    created.length = 0
    revoked.length = 0
    canvasSizes = []
    createObjectURL.mockClear()
    revokeObjectURL.mockClear()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL })
    class FakeOffscreenCanvas {
      width: number
      height: number
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
        canvasSizes.push({ width, height })
      }
      getContext(kind: string): Record<string, unknown> | null {
        if (kind !== '2d') return null
        return {
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 0,
          lineCap: 'butt',
          lineJoin: 'miter',
          globalCompositeOperation: 'source-over',
          save: () => undefined,
          restore: () => undefined,
          fillRect: () => undefined,
          beginPath: () => undefined,
          moveTo: () => undefined,
          lineTo: () => undefined,
          arc: () => undefined,
          stroke: () => undefined,
          fill: () => undefined
        }
      }
      convertToBlob(): Promise<Blob> {
        return Promise.resolve(new Blob(['mask'], { type: 'image/png' }))
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })

  afterEach(() => {
    if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
    else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL
    if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
    else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    vi.unstubAllGlobals()
  })

  const MASK: MediaClipMask = {
    strokes: [{ mode: 'hide', radiusPct: 4, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.6 }] }]
  }

  function maskedCandidate(clipMask?: MediaClipMask, id = 'masked', path = 'C:/media/masked.mp4'): PreviewCandidate {
    return {
      clip: clip({ id, ...(clipMask ? { mask: clipMask } : {}) }),
      kind: 'video',
      hasAudio: false,
      sourcePath: path,
      useStabProxy: false
    }
  }

  it('有 mask 的媒体元素挂上 mask-image / mask-size / mask-mode（blob URL）', async () => {
    const view = render(
      <MediaPreviewLayer candidates={[maskedCandidate(MASK)]} fps={FPS_30} maskAspect={16 / 9} transition={null} />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = view.container.querySelector('video')!

    await waitFor(() => expect(video.style.maskImage).toContain('blob:mask-1'))
    expect(video.style.maskImage).toContain('blob:mask-1')
    // -webkit- 兼容写法也要有
    expect(video.style.webkitMaskImage ?? video.style.getPropertyValue('-webkit-mask-image')).toContain('blob:mask-1')
    expect(video.style.maskSize).toBe('100% 100%')
    expect(video.style.maskMode).toBe('alpha')
    expect(video.style.maskRepeat).toBe('no-repeat')
    // 光栅化画布按 maskAspect 保持比例（16:9 → 1024×576）
    expect(canvasSizes).toEqual([{ width: 1024, height: 576 }])
    expect(created).toEqual(['blob:mask-1'])
  })

  it('无 mask 的段不设任何 mask 样式（零回归）且完全不生成 blob URL', async () => {
    const view = render(<MediaPreviewLayer candidates={[maskedCandidate(undefined, 'plain')]} fps={FPS_30} transition={null} />)
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = view.container.querySelector('video')!
    // 等一轮微任务，确认遮罩 effect 完全没有触发
    await act(async () => Promise.resolve())
    expect(video.style.maskImage).toBe('')
    expect(video.style.getPropertyValue('mask-image')).toBe('')
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('笔画变化：重建 blob URL，旧 URL 被 revoke（防泄漏）', async () => {
    const view = render(
      <MediaPreviewLayer candidates={[maskedCandidate(MASK)]} fps={FPS_30} maskAspect={16 / 9} transition={null} />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    const video = view.container.querySelector('video')!
    await waitFor(() => expect(video.style.maskImage).toContain('blob:mask-1'))

    const changed: MediaClipMask = { strokes: [...MASK.strokes, { mode: 'restore', radiusPct: 2, points: [{ x: 0.5, y: 0.5 }] }] }
    view.rerender(<MediaPreviewLayer candidates={[maskedCandidate(changed)]} fps={FPS_30} maskAspect={16 / 9} transition={null} />)

    await waitFor(() => expect(video.style.maskImage).toContain('blob:mask-2'))
    expect(revoked).toContain('blob:mask-1')
  })

  it('卸载时回收当前遮罩 blob URL', async () => {
    const view = render(
      <MediaPreviewLayer candidates={[maskedCandidate(MASK)]} fps={FPS_30} maskAspect={16 / 9} transition={null} />
    )
    await waitFor(() => expect(view.container.querySelectorAll('video')).toHaveLength(1))
    await waitFor(() => expect(view.container.querySelector('video')!.style.maskImage).toContain('blob:mask-1'))

    view.unmount()
    expect(revoked).toContain('blob:mask-1')
  })
})
