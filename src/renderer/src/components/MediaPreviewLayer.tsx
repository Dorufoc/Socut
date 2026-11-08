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
import { transitionProgressAt } from '@shared/transitions'
import type { Fps, MediaClip } from '@shared/types'
import { attachPreviewAudio, setElementLevel, setPreservesPitch } from '../audio/previewAudioGraph'
import {
  PREVIEW_DRIFT_SEC,
  PREVIEW_LOOKAHEAD_SEC,
  isClipActiveAt,
  previewClipStartSourceTime,
  previewGradeFilterId,
  previewPrerollTarget,
  previewSourceTimeAt,
  previewTransitionSourceTime,
  type PreviewCandidate
} from '../render/previewCandidates'
import { transitionStyles, type PreviewTransitionState } from '../render/previewTransition'
import { previewPerf } from '../render/previewPerf'

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
  /** 回绕复位：清预卷/对齐标记，把每个元素送回入点（不 pause，交给下一帧 tick 决定播放状态） */
  restart: () => void
}

export interface MediaPreviewLayerProps {
  candidates: PreviewCandidate[]
  fps: Fps
  /**
   * 本层是否为当前内嵌原声的出声层（多轨叠加时只有最上层出声）。
   * 缺省 true：单层 / 旧用法行为不变。
   */
  audioEnabled?: boolean
  /** 当前是否有可显示的媒体帧（决定 Canvas 要不要画棋盘格） */
  onVisibleChange?: (visible: boolean) => void
  /** 当前负责出声的视频元素（null = 没有媒体原声） */
  onAudioChange?: (element: HTMLVideoElement | null, clip: MediaClip | null) => void
  onFailure?: (clipId: string) => void
  /**
   * 转场窗口解析器：每 tick 用**实时** `atSec` 调用，避免转场窗口跟着 10Hz 节流时间晚一拍。
   * 传入时优先使用；`transition` prop 只在没有 resolver 时作为显式覆盖。
   */
  transitionResolver?: (atSec: number) => PreviewTransitionState | null
  /** 显式转场覆盖（静态用例/测试用）；有 resolver 时不再读取 */
  transition?: PreviewTransitionState | null
  /**
   * 时间轴循环总时长（秒，0 = 不循环）。回绕前瞻段在本轮已经「结束」，
   * 需要提前把它对齐到入点，否则回绕瞬间要等一次异步 seek 才出首帧。
   */
  loopDurationSec?: number
}

/** 源路径 → 协议地址 + 获取时刻；null = 已失败。跨挂载复用，避免每次切段重发 IPC。 */
const previewUrlCache = new Map<string, { url: string | null; fetchedAt: number }>()
const pendingPreviewUrls = new Set<string>()

/** 协议地址的时效（毫秒）：源文件被同名替换后旧 URL 仍带长缓存头，会播到旧内容。 */
export const PREVIEW_URL_TTL_MS = 10_000

/** 缓存条目是否该重新解析：无条目 → true；超过 TTL → true。 */
export function shouldRefreshPreviewUrl(
  entry: { fetchedAt: number } | undefined,
  now: number,
  ttlMs = PREVIEW_URL_TTL_MS
): boolean {
  if (!entry) return true
  return now - entry.fetchedAt >= ttlMs
}

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

/** 与 seek 同一口径的 duration 钳制（保留 1ms 余量，避免落在媒体末尾）。 */
function clampSeekTarget(video: HTMLVideoElement, target: number): number {
  const duration = Number.isFinite(video.duration) ? video.duration : target
  return Math.min(Math.max(0, target), Math.max(0, duration - 0.001))
}

/** `requestSeek` 的结果：调用方据此判断是否需要重新等待 seeked（`primeVideo` 的 pending 语义）。 */
type SeekOutcome = 'aligned' | 'queued' | 'requested' | 'failed'

interface SeekState {
  /** 在飞期间被合并的目标（最后一次写入赢） */
  wanted: number | null
  /** 本地标记：已写过 currentTime、还没等到 seeked */
  inFlight: boolean
}

export const MediaPreviewLayer = forwardRef<MediaPreviewHandle, MediaPreviewLayerProps>(
  function MediaPreviewLayer(
    { candidates, fps, audioEnabled = true, loopDurationSec = 0, onVisibleChange, onAudioChange, onFailure, transition, transitionResolver },
    ref
  ) {
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
    /** 已做过「进入活动段首帧强制对齐」的 clipId：再次进入活动段（含回绕）要重新对齐 */
    const alignedRef = useRef(new Set<string>())
    /** 每元素 seek 合并状态：在飞期间只换目标，避免悬停逐帧拖动把 seek 排成风暴 */
    const seekStateRef = useRef(new Map<string, SeekState>())

    const candidatesRef = useRef(candidates)
    const fpsRef = useRef(fps)
    const audioEnabledRef = useRef(audioEnabled)
    const loopDurationRef = useRef(loopDurationSec)
    const onVisibleRef = useRef(onVisibleChange)
    const onAudioRef = useRef(onAudioChange)
    const onFailureRef = useRef(onFailure)
    const visibleRef = useRef(false)
    const audioClipIdRef = useRef<string | null>(null)
    const audioElementRef = useRef<HTMLVideoElement | null>(null)
    /** 转场色块（黑/白/灰）叠加层；只有转场轨道的这一层会写 opacity */
    const flashRef = useRef<HTMLDivElement | null>(null)
    /** 被转场命令式改过 transform/filter/zIndex 的 clipId；退出转场时按基座样式还原 */
    const transitionStyledRef = useRef(new Set<string>())
    const transitionResolverRef = useRef(transitionResolver)
    const transitionPropRef = useRef<PreviewTransitionState | null>(transition ?? null)
    /** 上一次记过 lateSwitches 的目标 clipId：同一个目标只计一次 */
    const lateSwitchRef = useRef<string | null>(null)

    candidatesRef.current = candidates
    fpsRef.current = fps
    audioEnabledRef.current = audioEnabled
    loopDurationRef.current = loopDurationSec
    onVisibleRef.current = onVisibleChange
    onAudioRef.current = onAudioChange
    onFailureRef.current = onFailure
    transitionResolverRef.current = transitionResolver
    transitionPropRef.current = transition ?? null

    const pathsKey = candidates.map((candidate) => candidate.sourcePath).join('\n')

    useEffect(() => {
      const now = performance.now()
      const paths = [...new Set(candidates.map((candidate) => candidate.sourcePath))]
      // 没缓存过的路径直接取；缓存过的按 TTL 判过期（同名替换后要换 URL）。
      // 在飞路径走 `pendingPreviewUrls` 同键合并，避免并发重复 IPC。
      const missing = paths.filter(
        (path) => !pendingPreviewUrls.has(path) && previewUrlCache.get(path) === undefined
      )
      const stale = paths.filter((path) => {
        if (pendingPreviewUrls.has(path)) return false
        const entry = previewUrlCache.get(path)
        return entry !== undefined && shouldRefreshPreviewUrl(entry, now)
      })
      const toFetch = [...missing, ...stale]
      if (toFetch.length === 0) return
      for (const path of toFetch) pendingPreviewUrls.add(path)
      void Promise.all(
        toFetch.map(async (path) => {
          const api = window.focusnews?.video
          const url = api ? await api.previewUrl(path).catch(() => null) : null
          return [path, url] as const
        })
      ).then((entries) => {
        const fetchedAt = performance.now()
        /** URL 真的变了才写回状态：未变时不动 `urls`，避免无谓重载 `<video>` */
        const changed: Array<readonly [string, string | null]> = []
        for (const [path, url] of entries) {
          const previous = previewUrlCache.get(path)
          previewUrlCache.set(path, { url, fetchedAt })
          pendingPreviewUrls.delete(path)
          if (previous?.url === url) continue
          changed.push([path, url])
          if (url) continue
          // 拿不到协议地址 = 这条源不可预览；没有元素也就不会有 error 事件，这里主动上报
          for (const candidate of candidatesRef.current) {
            if (candidate.sourcePath === path) onFailureRef.current?.(candidate.clip.id)
          }
        }
        if (changed.length === 0) return
        setUrls((previous) => {
          const next = { ...previous }
          for (const [path, url] of changed) next[path] = url
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

    const seekStateFor = (clipId: string): SeekState => {
      let state = seekStateRef.current.get(clipId)
      if (!state) {
        state = { wanted: null, inFlight: false }
        seekStateRef.current.set(clipId, state)
      }
      return state
    }

    /**
     * 唯一的 seek 入口（`seekVideo` 的替代）：
     * - 已对齐（|currentTime - target| < 1e-4）→ 清掉排队目标，不动元素；
     * - 元素正在 seek → 只把最新目标写进 `wanted`，等 seeked 后补一次；
     * - 否则立即写 `currentTime`。
     *
     * 悬停逐帧拖动会在一帧内对同一元素发多次 seek，合并后浏览器只处理最后落点。
     */
    const requestSeek = (
      clipId: string,
      video: HTMLVideoElement,
      target: number
    ): SeekOutcome => {
      const state = seekStateFor(clipId)
      const clamped = clampSeekTarget(video, target)
      if (Math.abs(video.currentTime - clamped) < 1e-4) {
        state.wanted = null
        return 'aligned'
      }
      if (video.seeking) {
        state.wanted = clamped
        previewPerf.seekCoalesced += 1
        return 'queued'
      }
      state.wanted = null
      state.inFlight = true
      previewPerf.seekRequests += 1
      try {
        video.currentTime = clamped
      } catch {
        // 元数据尚未就绪：loadedmetadata / seeked 会再对齐
        state.inFlight = false
        return 'failed'
      }
      return 'requested'
    }

    /**
     * 每帧结算一次：没有在飞 seek 时把排队目标补上（jsdom / 不允许 seek 的环境不发 seeked，
     * 靠这里推进）；`video.seeking` 仍为真时直接返回，等真正的 seeked 事件。
     */
    const settleSeek = (clipId: string, video: HTMLVideoElement): void => {
      const state = seekStateRef.current.get(clipId)
      if (!state) return
      if (video.seeking) return
      state.inFlight = false
      const wanted = state.wanted
      if (wanted === null) return
      state.wanted = null
      requestSeek(clipId, video, wanted)
    }

    const resetElement = (clipId: string): void => {
      readyRef.current.delete(clipId)
      failedRef.current.delete(clipId)
      pendingSeekRef.current.delete(clipId)
      prerolledRef.current.delete(clipId)
      alignedRef.current.delete(clipId)
      seekStateRef.current.delete(clipId)
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
      // 首次 seek 完成前不算就绪：pending 语义不变，只是写入走合并器
      const outcome = requestSeek(clipId, video, target)
      if (outcome === 'aligned' || outcome === 'failed') pendingSeekRef.current.delete(clipId)
      else pendingSeekRef.current.add(clipId)
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

    /** 转场增量 + 片段基座样式：只改 DOM style，不触发 React state。 */
    const applyTransitionElementStyle = (
      candidate: PreviewCandidate,
      element: HTMLVideoElement | HTMLImageElement,
      style: CSSProperties
    ): void => {
      const base = mediaStyleOf(candidate.clip)
      const baseTransform =
        typeof base.transform === 'string' && base.transform !== 'none' ? base.transform : ''
      const transitionTransform =
        typeof style.transform === 'string' && style.transform !== 'none' ? style.transform : ''
      const baseFilter =
        typeof base.filter === 'string' && base.filter !== 'none' ? base.filter : ''
      const transitionFilter =
        typeof style.filter === 'string' && style.filter !== 'none' ? style.filter : ''
      element.style.transform = [baseTransform, transitionTransform].filter(Boolean).join(' ')
      element.style.filter = [baseFilter, transitionFilter].filter(Boolean).join(' ')
      element.style.zIndex = style.zIndex === undefined ? '' : String(style.zIndex)
      element.style.opacity = String(style.opacity ?? 1)
      transitionStyledRef.current.add(candidate.clip.id)
    }

    /** 退出转场 / 转场未就绪：把 transform/filter/zIndex 还原到片段基座。 */
    const restoreTransitionStyles = (list: PreviewCandidate[]): void => {
      for (const clipId of transitionStyledRef.current) {
        const candidate = list.find((item) => item.clip.id === clipId)
        const element = elementsRef.current.get(clipId)
        if (!candidate || !element) {
          transitionStyledRef.current.delete(clipId)
          continue
        }
        const base = mediaStyleOf(candidate.clip)
        element.style.transform =
          typeof base.transform === 'string' && base.transform !== 'none' ? base.transform : ''
        element.style.filter =
          typeof base.filter === 'string' && base.filter !== 'none' ? base.filter : ''
        element.style.zIndex = ''
        transitionStyledRef.current.delete(clipId)
      }
      if (flashRef.current) flashRef.current.style.opacity = '0'
    }

    /**
     * 转场窗口：两层同时可见，按族写 opacity / translate / scale / blur / 色块。
     * 任一层还没 ready 时返回 false，交给现有单层逻辑兜底（宁可近似中断，也不黑屏）。
     * 音频仍按切点硬切：只有切点这一侧的视频元素解除静音。
     */
    const applyTransition = (
      list: PreviewCandidate[],
      tr: PreviewTransitionState,
      atSec: number,
      playing: boolean,
      halfFrame: number
    ): boolean => {
      // 播放中显示时间可能晚一拍；用窗口再兜一层，窗口外交给单层逻辑
      if (atSec < tr.startSec - EPS || atSec > tr.endSec + EPS) return false

      const left = list.find((candidate) => candidate.clip.id === tr.leftClipId)
      const right = list.find((candidate) => candidate.clip.id === tr.rightClipId)
      if (!left || !right) return false
      const leftElement = elementsRef.current.get(left.clip.id)
      const rightElement = elementsRef.current.get(right.clip.id)
      if (!leftElement || !rightElement) return false
      if (!readyRef.current.has(left.clip.id) || !readyRef.current.has(right.clip.id)) return false

      const styles = transitionStyles(
        tr.type,
        transitionProgressAt(atSec, tr.cutSec, tr.durationSec)
      )
      applyTransitionElementStyle(left, leftElement, styles.left)
      applyTransitionElementStyle(right, rightElement, styles.right)
      if (flashRef.current) {
        flashRef.current.style.background = styles.flash?.color ?? '#000'
        flashRef.current.style.opacity = String(styles.flash?.opacity ?? 0)
      }
      publishVisible(true)

      // 硬切只在切点选一侧：切点前左侧出声、切点后右侧出声；另一侧始终静音。
      const audioSide = atSec < tr.cutSec ? left : right
      const audioCandidate =
        audioEnabledRef.current && audioSide.kind === 'video' && audioSide.hasAudio
          ? audioSide
          : null
      const audioElement = audioCandidate
        ? ((elementsRef.current.get(audioCandidate.clip.id) as HTMLVideoElement | undefined) ?? null)
        : null
      publishAudio(audioElement, audioCandidate?.clip ?? null)

      for (const candidate of [left, right]) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (!element || !(element instanceof HTMLVideoElement)) continue
        const rate = previewPlaybackRate(candidate.clip.speed)
        if (Math.abs(element.playbackRate - rate) > 1e-3) {
          element.playbackRate = rate
          element.defaultPlaybackRate = rate
        }
        setPreservesPitch(element, previewPreservesPitch(candidate.clip.speed))

        // 头部手柄允许 atSec 早于片段起点：用转场专用源坐标，负本地时间继续往前读。
        const target = previewTransitionSourceTime(candidate.clip, atSec)
        if (playing) {
          if (element.paused) void element.play().catch(() => undefined)
          if (Math.abs(element.currentTime - target) > PREVIEW_DRIFT_SEC) {
            requestSeek(candidate.clip.id, element, target)
          }
        } else {
          element.pause()
          if (Math.abs(element.currentTime - target) > halfFrame) {
            requestSeek(candidate.clip.id, element, target)
          }
        }

        const audible = playing && candidate === audioCandidate
        element.muted = !audible
        if (audible) {
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
      }
      return true
    }

    const tick = (atSec: number, playing: boolean): void => {
      previewPerf.layerTicks += 1
      const list = candidatesRef.current
      if (list.length === 0) {
        restoreTransitionStyles(list)
        publishVisible(false)
        publishAudio(null, null)
        return
      }

      const halfFrame = frameIntervalSec(fpsRef.current) / 2
      // 每帧先结算一次合并器：把在飞期间排队的 seek 目标补上。
      // jsdom / 不发 seeked 的环境靠这一步推进；真的在 seek 时这里直接跳过。
      for (const candidate of list) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (element instanceof HTMLVideoElement) settleSeek(candidate.clip.id, element)
      }
      // 转场窗口用实时 atSec 现算（resolver 优先），不再等 PreviewStage 的节流值；
      // 没有 resolver 时回落到显式 transition prop（静态用例）。
      const resolver = transitionResolverRef.current
      const tr = resolver ? resolver(atSec) : transitionPropRef.current
      if (tr && applyTransition(list, tr, atSec, playing, halfFrame)) return
      restoreTransitionStyles(list)

      // 1. 该显示哪一段：上层 ready 优先；上层没就绪时回落到下层 ready；
      //    都没有就保留刚结束那一段的最后一帧（切点兜底）。
      let visible: PreviewCandidate | null = null
      /** 当帧活动但还没就绪的候选（诊断用）：它才是「本该切过去」的目标 */
      let pendingVisibleId: string | null = null
      for (const candidate of list) {
        if (!isClipActiveAt(candidate.clip, atSec)) continue
        if (readyRef.current.has(candidate.clip.id)) visible = candidate
        else pendingVisibleId = candidate.clip.id
      }
      let fallback = false
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
            fallback = true
          }
        }
      }

      // 诊断 lateSwitches：画面还停在上一段（兜底）且当帧有 active 未就绪的段 → 记一次迟到切换。
      // 同一目标只计一次；切到目标后（visible 不再是兜底）或换目标时清空。
      if (fallback && pendingVisibleId !== null) {
        if (lateSwitchRef.current !== pendingVisibleId) {
          lateSwitchRef.current = pendingVisibleId
          previewPerf.lateSwitches += 1
        }
      } else {
        lateSwitchRef.current = null
      }

      const visibleId = visible?.clip.id ?? null
      for (const candidate of list) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (!element) continue
        const next = candidate.clip.id === visibleId ? '1' : '0'
        if (element.style.opacity !== next) element.style.opacity = next
      }
      publishVisible(visibleId !== null)

      // 2. 谁负责出声：只有被 PreviewStage 选为出声层时，才取本层最上层的 active 视频；
      //    多轨叠加时其余层保持静音，避免同一时刻几路内嵌原声一起响。
      let audioCandidate: PreviewCandidate | null = null
      if (audioEnabledRef.current) {
        for (const candidate of list) {
          if (isClipActiveAt(candidate.clip, atSec) && candidate.kind === 'video' && candidate.hasAudio) {
            audioCandidate = candidate
          }
        }
      }
      const audioElement = audioCandidate
        ? ((elementsRef.current.get(audioCandidate.clip.id) as HTMLVideoElement | undefined) ?? null)
        : null
      publishAudio(audioElement, audioCandidate?.clip ?? null)

      // 3. 时间 / 倍速 / 音量
      for (const candidate of list) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (!element || !(element instanceof HTMLVideoElement)) continue
        const clipId = candidate.clip.id
        const active = isClipActiveAt(candidate.clip, atSec)
        // 非活动段退出「已对齐」状态：下次进入活动段（含回绕）要重新强制对齐首帧
        if (!active) alignedRef.current.delete(clipId)
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
          // 首帧强制对齐：预卷点 / 暂停点可能停在别处，刚进入活动段的第一帧必须落在播放头；
          // 之后才回到漂移判定，避免每帧都 seek。
          const firstEnter = !alignedRef.current.has(clipId)
          if (firstEnter) alignedRef.current.add(clipId)
          if (playing) {
            if (element.paused) void element.play().catch(() => undefined)
            if (!firstEnter && Math.abs(element.currentTime - target) > PREVIEW_DRIFT_SEC) {
              requestSeek(clipId, element, target)
            }
          } else {
            element.pause()
            if (!firstEnter && Math.abs(element.currentTime - target) > halfFrame) {
              requestSeek(clipId, element, target)
            }
          }
          if (firstEnter) requestSeek(clipId, element, target)
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
              requestSeek(clipId, element, prerollTarget)
              if (element.paused) void element.play().catch(() => undefined)
            }
          } else {
            element.pause()
            // 暂停期间清掉预卷标记：恢复播放时要重新预卷，否则会停在旧预卷点等切点
            prerolledRef.current.delete(clipId)
            const start = previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
            if (Math.abs(element.currentTime - start) > halfFrame) {
              requestSeek(clipId, element, start)
            }
          }
          element.muted = true
          setElementLevel(element, 0)
          continue
        }

        // 回绕前瞻预对齐：头部片段在本轮已经「结束」，回绕后才能进入活动段。
        // 提前送回入点，回绕瞬间直接出首帧，不用等一次异步 seek。
        const loopDuration = loopDurationRef.current
        const wrapStart = candidate.clip.timelineStartSec + loopDuration
        const inWrapLookahead =
          loopDuration > 0 &&
          atSec >= loopDuration - PREVIEW_LOOKAHEAD_SEC - EPS &&
          wrapStart > atSec + EPS &&
          wrapStart <= atSec + PREVIEW_LOOKAHEAD_SEC + EPS
        if (inWrapLookahead) {
          element.pause()
          element.muted = true
          setElementLevel(element, 0)
          const start = previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
          if (Math.abs(element.currentTime - start) > halfFrame) {
            requestSeek(clipId, element, start)
          }
          continue
        }

        // 已经结束：停在最后一帧，等下一次进入窗口再重新对齐
        element.pause()
        element.muted = true
        setElementLevel(element, 0)
      }
    }

    /**
     * 回绕复位（由 `usePreviewLoop` 的 `onLoop` 在 rAF 内直接调用，不依赖 React 渲染）：
     * 1. 还原被转场改写的 style 与色块，回到「单层、无转场」基线；
     * 2. 清预卷/已对齐标记，下一帧进入活动段时重新强制对齐；
     * 3. 每个元素送回自己的入点。**不 pause**：播放状态交给同一帧的 tick 决定。
     *
     * `visibleRef` 刻意保持原值：回绕瞬间上报 false 会让 Canvas 画棋盘格闪一下。
     */
    const restart = (): void => {
      const list = candidatesRef.current
      restoreTransitionStyles(list)
      prerolledRef.current.clear()
      alignedRef.current.clear()
      for (const candidate of list) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (!(element instanceof HTMLVideoElement)) continue
        requestSeek(
          candidate.clip.id,
          element,
          previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
        )
      }
    }

    useImperativeHandle(ref, () => ({ tick, restart }), [])

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
              onSeeked={(event) => {
                // 顺序不能反：先让合并器应用最新目标（可能再发一次 seek），再把该段标成就绪
                settleSeek(candidate.clip.id, event.currentTarget)
                if (pendingSeekRef.current.delete(candidate.clip.id)) markReady(candidate.clip.id)
              }}
              onError={() => failElement(candidate.clip.id)}
            />
          )
        })}
        {/* 转场色块（黑/白/灰）：在媒体层之上、字幕 Canvas 之下（z-index 见 styles.css） */}
        <div className="stage__transition-flash" ref={flashRef} aria-hidden="true" />
      </>
    )
  }
)
