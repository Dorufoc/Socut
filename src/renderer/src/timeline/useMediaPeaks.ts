import { useEffect, useState } from 'react'
import {
  SPECTRUM_IDLE_STATE,
  spectrumBucketCount,
  spectrumCacheKey,
  clipShowsSpectrum,
  type SpectrumState
} from '@shared/audioPeaks'
import type { MediaClip, MediaItem } from '@shared/types'

/**
 * 频谱条（v9）的渲染层取数与缓存，与 `useMediaStrips` 同一套三层防重复：
 * 会话内存缓存 → 并发闸门 → 同键合并（主进程还有一层同样的合并）。
 *
 * 只有跨「桶数档位」或改源区间才会重新取样：拖宽卡片时像素连续变化，
 * 逐像素请求会把主进程打成连续解码器。
 */

const memoryCache = new Map<string, SpectrumState>()
const inflight = new Map<string, Promise<SpectrumState>>()

/** 同时最多几个取样任务在跑（其余排队）。 */
const MAX_CONCURRENT = 2

let running = 0
const queue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      running += 1
      resolve()
    })
  })
}

function releaseSlot(): void {
  running -= 1
  queue.shift()?.()
}

async function requestPeaks(key: string, input: {
  mediaId: string
  path: string
  sourceInSec: number
  sourceOutSec: number
  buckets: number
}): Promise<SpectrumState> {
  const existing = inflight.get(key)
  if (existing) return existing

  const task = (async (): Promise<SpectrumState> => {
    await acquireSlot()
    try {
      // 测试环境没有 preload 注入：拿不到取样就当「这条不画频谱」，不能抛未处理拒绝
      const api = window.socut?.media
      if (!api?.peaks) {
        const state: SpectrumState = { status: 'failed', peaks: [], buckets: input.buckets }
        memoryCache.set(key, state)
        return state
      }
      const result = await api.peaks(input)
      const state: SpectrumState = result.peaks.length > 0
        ? { status: 'ready', peaks: result.peaks, buckets: result.buckets }
        : { status: 'failed', peaks: [], buckets: result.buckets }
      memoryCache.set(key, state)
      return state
    } catch {
      const state: SpectrumState = { status: 'failed', peaks: [], buckets: input.buckets }
      memoryCache.set(key, state)
      return state
    } finally {
      releaseSlot()
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

/** 清空会话缓存（测试与「重新探测」用）。 */
export function resetSpectrumCache(): void {
  memoryCache.clear()
  inflight.clear()
  queue.length = 0
  running = 0
}

export interface MediaSpectrumInput {
  clip: MediaClip
  item: MediaItem | null
  /** 卡片可用的像素宽：密度由它决定 */
  widthPx: number
}

/**
 * 一条媒体片段的频谱状态。
 * 素材没有音轨（或已移出池）时直接返回 idle —— 连 IPC 都不发，卡片自然不画柱子。
 */
export function useMediaSpectrum(input: MediaSpectrumInput): SpectrumState {
  const { clip, item, widthPx } = input
  // 没音轨 / 素材已移出 / 源区间退化 → 连 IPC 都不发（卡片不画柱子）
  const source: MediaItem | null = clipShowsSpectrum(item) && clip.sourceOutSec > clip.sourceInSec ? item : null
  const buckets = spectrumBucketCount(widthPx)
  const key = source
    ? spectrumCacheKey({
        mediaId: source.id,
        path: source.path,
        sourceInSec: clip.sourceInSec,
        sourceOutSec: clip.sourceOutSec,
        buckets
      })
    : ''

  const [state, setState] = useState<SpectrumState>(() => (key ? memoryCache.get(key) ?? SPECTRUM_IDLE_STATE : SPECTRUM_IDLE_STATE))

  useEffect(() => {
    if (!key || !source) {
      setState(SPECTRUM_IDLE_STATE)
      return
    }
    const hit = memoryCache.get(key)
    if (hit) {
      setState(hit)
      return
    }
    let cancelled = false
    setState((previous) =>
      previous.status === 'loading' && previous.buckets === buckets ? previous : { status: 'loading', peaks: [], buckets }
    )
    void requestPeaks(key, {
      mediaId: source.id,
      path: source.path,
      sourceInSec: clip.sourceInSec,
      sourceOutSec: clip.sourceOutSec,
      buckets
    }).then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
    // 源区间（拖入出点）与桶数跨档都体现在 key 里，所以只依赖 key/buckets
  }, [buckets, clip.sourceInSec, clip.sourceOutSec, key, source])

  return state
}
