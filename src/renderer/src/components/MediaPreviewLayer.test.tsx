import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import type { MediaClip } from '@shared/types'
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
  ;(window as unknown as { focusnews?: unknown }).focusnews = {
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
  delete (window as unknown as { focusnews?: unknown }).focusnews
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
