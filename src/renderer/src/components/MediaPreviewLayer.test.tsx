import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import type { MediaClip } from '@shared/types'
import type { PreviewCandidate } from '../render/previewCandidates'
import type { PreviewTransitionState } from '../render/previewTransition'
import { MediaPreviewLayer, type MediaPreviewHandle } from './MediaPreviewLayer'

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

/** 每个用例用独立源路径：模块级 URL 缓存跨挂载复用，同路径会让后续挂载拿不到元素。 */
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
  delete (window as unknown as { focusnews?: unknown }).focusnews
})

afterEach(() => cleanup())

async function renderLayer(transition: PreviewTransitionState | null) {
  const ref = createRef<MediaPreviewHandle>()
  const view = render(
    <MediaPreviewLayer ref={ref} candidates={candidates()} fps={FPS_30} transition={transition} />
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
