import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { frameIntervalSec } from '@shared/fps'
import { clipTimelineDurationSec, previewGainAt, previewPlaybackRate, previewPreservesPitch } from '@shared/mediaClipAudio'
import { mediaVideoFilter, mediaVideoTransform, curveTableValues, needsChannelTable } from '@shared/mediaClipVideo'
import type { Fps, MediaClip } from '@shared/types'
import { attachPreviewAudio, setElementLevel, setPreservesPitch } from '../audio/previewAudioGraph'
import {
  PREVIEW_DRIFT_SEC,
  isClipActiveAt,
  previewClipStartSourceTime,
  previewGradeFilterId,
  previewPrerollTarget,
  previewSourceTimeAt,
  type PreviewCandidate
} from '../render/previewCandidates'

/**
 * 媒体预览层（v10）：候选池的 DOM 实现。
 *
 * 每个候选段一个 `<video>` / `<img>`，全部提前挂载并预 seek；`tick()` 由
 * `usePreviewLoop` 的 rAF 驱动，只做三件事：
 * 1. 选出当前该显示的那一个候选（上层优先，未就绪回落到上一段）；
 * 2. 命令式翻转 opacity（**不走 React state**，切点不能等一次 re-render）；
 * 3. 同步时间 / 倍速 / 音量包络，并在切点前静音预卷。
 *
 * 路径解析（`focusnews-media://`）也在这里做，结果按源路径缓存；IPC 只申请一次。
 */

export interface MediaPreviewHandle {
  tick: (atSec: number, playing: boolean) => void
}

export interface MediaPreviewLayerProps {
  candidates: PreviewCandidate[]
  fps: Fps
  /** 当前是否有可显示的媒体帧（决定 Canvas 要不要画棋盘格） */
  onVisibleChange?: (visible: boolean) => void
  /** 当前负责出声的视频元素（null = 没有媒体原声） */
  onAudioChange?: (element: HTMLVideoElement | null, clip: MediaClip | null) => void
  onFailure?: (clipId: string) => void
}

/** 源路径 → 协议地址；null = 已失败，不再重试。跨挂载复用，避免每次切段重发 IPC。 */
const previewUrlCache = new Map<string, string | null>()
const pendingPreviewUrls = new Set<string>()

const EPS = 1e-9

function mediaStyleOf(clip: MediaClip): CSSProperties {
  const transform = mediaVideoTransform(clip.video)
  // 每段用自己的曲线表 id：候选池里可能同时挂着调色不同的几段
  const filter = mediaVideoFilter(clip.video, previewGradeFilterId(clip.id))
  return {
    ...(transform !== 'none' ? { transform } : {}),
    ...(filter !== 'none' ? { filter } : {})
  }
}

function seekVideo(video: HTMLVideoElement, target: number): void {
  const duration = Number.isFinite(video.duration) ? video.duration : target
  const clamped = Math.min(Math.max(0, target), Math.max(0, duration - 0.001))
  if (Math.abs(video.currentTime - clamped) < 1e-4) return
  try {
    video.currentTime = clamped
  } catch {
    // 元数据尚未就绪：loadedmetadata / seeked 会再对齐
  }
}

export const MediaPreviewLayer = forwardRef<MediaPreviewHandle, MediaPreviewLayerProps>(
  function MediaPreviewLayer({ candidates, fps, onVisibleChange, onAudioChange, onFailure }, ref) {
    const [urls, setUrls] = useState<Record<string, string | null>>({})
    const elementsRef = useRef(new Map<string, HTMLVideoElement | HTMLImageElement>())
    /**
     * 每个 clipId 一个**稳定**的 ref 回调：内联箭头函数每次渲染都会换身份，
     * React 会先以 null 再以元素调用一遍，导致候选池每 100ms 被清空重填一次。
     */
    const refCallbacksRef = useRef(
      new Map<string, (element: HTMLVideoElement | HTMLImageElement | null) => void>()
    )
    const readyRef = useRef(new Set<string>())
    const failedRef = useRef(new Set<string>())
    const pendingSeekRef = useRef(new Set<string>())
    const prerolledRef = useRef(new Set<string>())

    const candidatesRef = useRef(candidates)
    const fpsRef = useRef(fps)
    const onVisibleRef = useRef(onVisibleChange)
    const onAudioRef = useRef(onAudioChange)
    const onFailureRef = useRef(onFailure)
    const visibleRef = useRef(false)
    const audioClipIdRef = useRef<string | null>(null)
    const audioElementRef = useRef<HTMLVideoElement | null>(null)

    candidatesRef.current = candidates
    fpsRef.current = fps
    onVisibleRef.current = onVisibleChange
    onAudioRef.current = onAudioChange
    onFailureRef.current = onFailure

    const pathsKey = candidates.map((candidate) => candidate.sourcePath).join('\n')

    useEffect(() => {
      const missing = [...new Set(candidates.map((candidate) => candidate.sourcePath))].filter(
        (path) => !previewUrlCache.has(path) && !pendingPreviewUrls.has(path)
      )
      if (missing.length === 0) return
      for (const path of missing) pendingPreviewUrls.add(path)
      void Promise.all(
        missing.map(async (path) => {
          const api = window.focusnews?.video
          const url = api ? await api.previewUrl(path).catch(() => null) : null
          return [path, url] as const
        })
      ).then((entries) => {
        for (const [path, url] of entries) {
          previewUrlCache.set(path, url)
          pendingPreviewUrls.delete(path)
          if (url) continue
          // 拿不到协议地址 = 这条源不可预览；没有元素也就不会有 error 事件，这里主动上报
          for (const candidate of candidatesRef.current) {
            if (candidate.sourcePath === path) onFailureRef.current?.(candidate.clip.id)
          }
        }
        setUrls((previous) => {
          const next = { ...previous }
          for (const [path, url] of entries) next[path] = url
          return next
        })
      })
    }, [pathsKey])

    useEffect(() => {
      return () => {
        if (visibleRef.current) {
          visibleRef.current = false
          onVisibleRef.current?.(false)
        }
        if (audioClipIdRef.current !== null) {
          audioClipIdRef.current = null
          audioElementRef.current = null
          onAudioRef.current?.(null, null)
        }
      }
    }, [])

    const resetElement = (clipId: string): void => {
      readyRef.current.delete(clipId)
      failedRef.current.delete(clipId)
      pendingSeekRef.current.delete(clipId)
      prerolledRef.current.delete(clipId)
    }

    const failElement = (clipId: string): void => {
      readyRef.current.delete(clipId)
      failedRef.current.add(clipId)
      onFailureRef.current?.(clipId)
    }

    const markReady = (clipId: string): void => {
      if (failedRef.current.has(clipId)) return
      readyRef.current.add(clipId)
    }

    const primeVideo = (candidate: PreviewCandidate, video: HTMLVideoElement): void => {
      const clipId = candidate.clip.id
      readyRef.current.delete(clipId)
      failedRef.current.delete(clipId)
      prerolledRef.current.delete(clipId)
      const target = previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
      if (Math.abs(video.currentTime - target) < 1e-4) {
        pendingSeekRef.current.delete(clipId)
      } else {
        pendingSeekRef.current.add(clipId)
        try {
          video.currentTime = target
        } catch {
          pendingSeekRef.current.delete(clipId)
        }
      }
      const rate = previewPlaybackRate(candidate.clip.speed)
      video.playbackRate = rate
      video.defaultPlaybackRate = rate
      setPreservesPitch(video, previewPreservesPitch(candidate.clip.speed))
      video.pause()
    }

    const markReadyIfDecoded = (clipId: string, video: HTMLVideoElement): void => {
      if (pendingSeekRef.current.has(clipId)) return
      if (video.readyState >= 2) markReady(clipId)
    }

    const publishVisible = (visible: boolean): void => {
      if (visibleRef.current === visible) return
      visibleRef.current = visible
      onVisibleRef.current?.(visible)
    }

    const publishAudio = (element: HTMLVideoElement | null, clip: MediaClip | null): void => {
      const clipId = clip?.id ?? null
      if (audioClipIdRef.current === clipId && audioElementRef.current === element) return
      audioClipIdRef.current = clipId
      audioElementRef.current = element
      onAudioRef.current?.(element, clip)
    }

    /** 同一 clipId 永远返回同一个 ref 回调，避免 React 每次渲染都 detach/attach 一遍。 */
    const refCallbackFor = (
      clipId: string
    ): ((element: HTMLVideoElement | HTMLImageElement | null) => void) => {
      let callback = refCallbacksRef.current.get(clipId)
      if (!callback) {
        callback = (element) => {
          if (!element) {
            elementsRef.current.delete(clipId)
            return
          }
          elementsRef.current.set(clipId, element)
          // 新元素先静音，等 tick 判定它该出声时再解除；避免挂载瞬间漏音
          if (element instanceof HTMLVideoElement) element.muted = true
        }
        refCallbacksRef.current.set(clipId, callback)
      }
      return callback
    }

    const tick = (atSec: number, playing: boolean): void => {
      const list = candidatesRef.current
      if (list.length === 0) {
        publishVisible(false)
        publishAudio(null, null)
        return
      }

      // 1. 该显示哪一段：上层 ready 优先；上层没就绪时回落到下层 ready；
      //    都没有就保留刚结束那一段的最后一帧（切点兜底）。
      let visible: PreviewCandidate | null = null
      for (const candidate of list) {
        if (isClipActiveAt(candidate.clip, atSec) && readyRef.current.has(candidate.clip.id)) {
          visible = candidate
        }
      }
      if (!visible) {
        let bestEnd = Number.NEGATIVE_INFINITY
        for (const candidate of list) {
          if (
            candidate.clip.timelineEndSec <= atSec + EPS &&
            candidate.clip.timelineEndSec > bestEnd &&
            readyRef.current.has(candidate.clip.id)
          ) {
            bestEnd = candidate.clip.timelineEndSec
            visible = candidate
          }
        }
      }

      const visibleId = visible?.clip.id ?? null
      for (const candidate of list) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (!element) continue
        const next = candidate.clip.id === visibleId ? '1' : '0'
        if (element.style.opacity !== next) element.style.opacity = next
      }
      publishVisible(visibleId !== null)

      // 2. 谁负责出声：最上层的 active 视频（与画面可见性同一优先级）
      let audioCandidate: PreviewCandidate | null = null
      for (const candidate of list) {
        if (isClipActiveAt(candidate.clip, atSec) && candidate.kind === 'video' && candidate.hasAudio) {
          audioCandidate = candidate
        }
      }
      const audioElement = audioCandidate
        ? ((elementsRef.current.get(audioCandidate.clip.id) as HTMLVideoElement | undefined) ?? null)
        : null
      publishAudio(audioElement, audioCandidate?.clip ?? null)

      // 3. 时间 / 倍速 / 音量
      const halfFrame = frameIntervalSec(fpsRef.current) / 2
      for (const candidate of list) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (!element || !(element instanceof HTMLVideoElement)) continue
        const clipId = candidate.clip.id
        const active = isClipActiveAt(candidate.clip, atSec)
        const ready = readyRef.current.has(clipId)
        if (!ready) {
          element.pause()
          setElementLevel(element, 0)
          continue
        }

        const rate = previewPlaybackRate(candidate.clip.speed)
        if (Math.abs(element.playbackRate - rate) > 1e-3) {
          element.playbackRate = rate
          element.defaultPlaybackRate = rate
        }
        setPreservesPitch(element, previewPreservesPitch(candidate.clip.speed))

        if (active) {
          const target = previewSourceTimeAt(candidate.clip, atSec, candidate.useStabProxy)
          if (playing) {
            if (element.paused) void element.play().catch(() => undefined)
            if (Math.abs(element.currentTime - target) > PREVIEW_DRIFT_SEC) seekVideo(element, target)
          } else {
            element.pause()
            if (Math.abs(element.currentTime - target) > halfFrame) seekVideo(element, target)
          }
          const audible = playing && candidate === audioCandidate
          element.muted = !audible
          if (audible) {
            // 先以 0 挂图再设目标：即使这是第一次出声，也不会从默认 1.0 直接跳到 2.0
            attachPreviewAudio(element, 0)
            setElementLevel(
              element,
              previewGainAt(
                candidate.clip.audio,
                Math.max(0, atSec - candidate.clip.timelineStartSec),
                clipTimelineDurationSec(candidate.clip)
              )
            )
          } else {
            setElementLevel(element, 0)
          }
          continue
        }

        if (candidate.clip.timelineStartSec > atSec + EPS) {
          // 即将开始：进入预卷窗口就静音起播，切点正好落在入点
          if (playing) {
            const prerollTarget = previewPrerollTarget(candidate.clip, atSec, candidate.useStabProxy)
            if (prerollTarget !== null && !prerolledRef.current.has(clipId)) {
              prerolledRef.current.add(clipId)
              seekVideo(element, prerollTarget)
              if (element.paused) void element.play().catch(() => undefined)
            }
          } else {
            element.pause()
            // 暂停期间清掉预卷标记：恢复播放时要重新预卷，否则会停在旧预卷点等切点
            prerolledRef.current.delete(clipId)
            const start = previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
            if (Math.abs(element.currentTime - start) > halfFrame) seekVideo(element, start)
          }
          element.muted = true
          setElementLevel(element, 0)
          continue
        }

        // 已经结束：停在最后一帧，等下一次进入窗口再重新对齐
        element.pause()
        element.muted = true
        setElementLevel(element, 0)
      }
    }

    useImperativeHandle(ref, () => ({ tick }), [])

    return (
      <>
        {/* 每段自己的曲线查找表：候选池可能同时有调色不同的几段，不能共用全局 id */}
        {candidates.map((candidate) => {
          const video = candidate.clip.video
          if (!video || !needsChannelTable(video)) return null
          return (
            <svg
              key={`grade-${candidate.clip.id}`}
              className="stage__filters"
              aria-hidden="true"
              focusable="false"
            >
              <defs>
                <filter id={previewGradeFilterId(candidate.clip.id)} colorInterpolationFilters="sRGB">
                  <feComponentTransfer>
                    <feFuncR type="table" tableValues={curveTableValues(video, 'r')} />
                    <feFuncG type="table" tableValues={curveTableValues(video, 'g')} />
                    <feFuncB type="table" tableValues={curveTableValues(video, 'b')} />
                  </feComponentTransfer>
                </filter>
              </defs>
            </svg>
          )
        })}
        {candidates.map((candidate) => {
          const url = urls[candidate.sourcePath]
          if (!url) return null
          const style = mediaStyleOf(candidate.clip)
          if (candidate.kind === 'image') {
            return (
              <img
                key={candidate.clip.id}
                ref={refCallbackFor(candidate.clip.id)}
                className="stage__ref-video"
                src={url}
                style={style}
                alt=""
                draggable={false}
                onLoadStart={() => resetElement(candidate.clip.id)}
                onLoad={() => markReady(candidate.clip.id)}
                onError={() => failElement(candidate.clip.id)}
              />
            )
          }
          return (
            <video
              key={candidate.clip.id}
              ref={refCallbackFor(candidate.clip.id)}
              className="stage__ref-video"
              src={url}
              style={style}
              playsInline
              preload="auto"
              aria-label="参考视频预览"
              onLoadStart={() => resetElement(candidate.clip.id)}
              onLoadedMetadata={(event) => primeVideo(candidate, event.currentTarget)}
              onLoadedData={(event) => markReadyIfDecoded(candidate.clip.id, event.currentTarget)}
              onCanPlay={(event) => markReadyIfDecoded(candidate.clip.id, event.currentTarget)}
              onSeeked={() => {
                if (pendingSeekRef.current.delete(candidate.clip.id)) markReady(candidate.clip.id)
              }}
              onError={() => failElement(candidate.clip.id)}
            />
          )
        })}
      </>
    )
  }
)
