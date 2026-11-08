import { useEffect, useState } from 'react'
import { fpsToRatio } from '@shared/constants'
import {
  STRIP_MAX_CONCURRENT,
  STRIP_IDLE_STATE,
  stripCacheKey,
  stripDurationSec,
  stripFrameCount,
  type StripRequestInput,
  type StripState
} from '@shared/mediaStrip'
import type { Fps, MediaClip, MediaItem } from '@shared/types'

/**
 * 时间帧预览条（Thumbnail Strip）的渲染层取数与缓存。
 *
 * 三层防重复计算（需求：已生成的缩略图必须被缓存，避免重复抽帧）：
 * 1. **会话内存缓存**：`key → 结果`（含失败结果），命中连 IPC 都不发；
 *    key 里带素材路径 + 源区间 + 格数，改入出点/换源/跨密度档才会失效。
 * 2. **并发闸门**：同时最多 `STRIP_MAX_CONCURRENT` 个抽帧任务在跑，其余排队——
 *    一次导入或一次窗口缩放会有几十条卡片同时请求，不加闸会把 CPU 打满并拖慢预览。
 * 3. **同键合并**：排队期间同一个 key 的重复请求共享同一次调用（主进程还有一层同样的合并）。
 *
 * 真正的长图缓存在主进程磁盘（userData/strips），跨会话复用；这里不重复存一份二进制
 * （IndexedDB 存 JPEG 只是把磁盘缓存搬到另一个地方，还要额外背 IPC 序列化成本）。
 */

/** 会话级结果缓存（含失败）：key → 状态 */
const memoryCache = new Map<string, StripState>()

/** 正在跑/排队的请求：key → 同一个 Promise（同键合并） */
const inflight = new Map<string, Promise<StripState>>()

let running = 0
const queue: Array<() => void> = []

function acquireSlot(): Promise<void> {
  if (running < STRIP_MAX_CONCURRENT) {
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
  const next = queue.shift()
  next?.()
}

async function requestStrip(key: string, input: StripRequestInput): Promise<StripState> {
  const existing = inflight.get(key)
  if (existing) return existing

  const task = (async (): Promise<StripState> => {
    await acquireSlot()
    try {
      const result = await window.socut.media.strip({
        mediaId: input.mediaId,
        path: input.path,
        sourceInSec: input.sourceInSec,
        sourceOutSec: input.sourceOutSec,
        frames: input.frames
      })
      const state: StripState = result.url
        ? { status: 'ready', url: result.url, frames: result.frames }
        : { status: 'failed', url: null, frames: result.frames }
      memoryCache.set(key, state)
      return state
    } catch {
      // 异常与「抽不出帧」同样处理：占位符 + 不重复轰炸主进程
      const state: StripState = { status: 'failed', url: null, frames: input.frames }
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

/** 清空会话缓存（测试与「重新探测」用；磁盘缓存不受影响）。 */
export function resetStripCache(): void {
  memoryCache.clear()
  inflight.clear()
  queue.length = 0
  running = 0
}

export interface MediaStripInput {
  clip: MediaClip
  item: MediaItem | null
  /** 卡片可用的像素宽（轨道内容宽）：密度由它决定 */
  widthPx: number
  fps: Fps
}

/**
 * 一条媒体片段的预览条状态。
 * 帧数由「卡片像素宽 ÷ 目标每帧宽」决定，并夹到该区间真实存在的帧数内；
 * 只有跨密度档位才换 key（重新抽帧），逐像素拖宽不会连环请求。
 */
export function useMediaStrip(input: MediaStripInput): StripState {
  const { clip, item, widthPx, fps } = input
  const durationSec = stripDurationSec(clip)
  const framesAvailable = Math.floor(durationSec * fpsToRatio(fps))
  const frames = stripFrameCount(widthPx, durationSec, framesAvailable)
  const key = item ? stripCacheKey({ mediaId: item.id, path: item.path, sourceInSec: clip.sourceInSec, sourceOutSec: clip.sourceOutSec, frames }) : ''

  const [state, setState] = useState<StripState>(() => (key ? memoryCache.get(key) ?? STRIP_IDLE_STATE : STRIP_IDLE_STATE))

  useEffect(() => {
    if (!item || !key || durationSec <= 0) {
      setState(STRIP_IDLE_STATE)
      return
    }
    const hit = memoryCache.get(key)
    if (hit) {
      setState(hit)
      return
    }
    let cancelled = false
    setState((previous) => (previous.status === 'loading' && previous.frames === frames ? previous : { status: 'loading', url: null, frames }))
    void requestStrip(key, {
      mediaId: item.id,
      path: item.path,
      sourceInSec: clip.sourceInSec,
      sourceOutSec: clip.sourceOutSec,
      frames
    }).then((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
    }
    // clip.source* 变化（拖入出点）与 frames 跨档都要重抽，这些都已经在 key 里
  }, [clip.sourceInSec, clip.sourceOutSec, durationSec, frames, item, key])

  return state
}
