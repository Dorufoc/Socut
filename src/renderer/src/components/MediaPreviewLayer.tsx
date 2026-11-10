import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { frameIntervalSec } from '@shared/fps'
import { clipTimelineDurationSec, previewGainAt, previewPlaybackRate, previewPreservesPitch } from '@shared/mediaClipAudio'
import { mediaVideoFilter, mediaVideoTransform, curveTableValues, needsChannelTable } from '@shared/mediaClipVideo'
import { mediaKeyframeCssAt } from '@shared/mediaClipKeyframes'
import { transitionProgressAt } from '@shared/transitions'
import type { Fps, MediaClip } from '@shared/types'
import { attachPreviewAudio, setElementLevel, setPreservesPitch } from '../audio/previewAudioGraph'
import {
  PREVIEW_CUT_DRIFT_SEC,
  PREVIEW_DRIFT_SEC,
  PREVIEW_LOOKAHEAD_SEC,
  PREVIEW_PREROLL_LOCK_SEC,
  PREVIEW_PREROLL_STEER_SEC,
  PREVIEW_ROLL_IN_SEC,
  hasSeamSuccessor,
  isClipActiveAt,
  latestEndedClip,
  previewClipStartSourceTime,
  previewGradeFilterId,
  previewPrerollPlan,
  previewSourceTimeAt,
  previewTransitionSourceTime,
  type PreviewCandidate
} from '../render/previewCandidates'
import { transitionStyles, type PreviewTransitionState } from '../render/previewTransition'
import { maskPreviewObjectUrl, revokeMaskUrl } from '../render/maskCapture'
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
 * 路径解析（`socut-media://`）也在这里做，结果按源路径缓存；IPC 只申请一次。
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
  /**
   * 目标画幅宽高比（M8）：手绘遮罩的光栅化画布要跟着画面框走，
   * 否则归一化笔画在非方形画布上会被 CSS 拉伸成椭圆。缺省按 16:9。
   */
  maskAspect?: number
  /**
   * 本轨道上的全部可见片段（含候选池之外的段）。
   * 用来判断「刚结束的段后面是否紧贴着下一段」——只有这种缝口才允许用最后一帧
   * 兜底；轨道真的结束（末端 / 段后空隙）时必须立即隐藏。缺省时退回候选池内判断。
   */
  trackClips?: readonly MediaClip[]
}

interface PreviewUrlEntry {
  /** null = 无法预览 */
  url: string | null
  fetchedAt: number
}

/** 源路径 → 协议地址 + 获取时刻；null = 已失败。跨挂载复用，避免每次切段重发 IPC。 */
const previewUrlCache = new Map<string, PreviewUrlEntry>()

/**
 * 在飞请求按路径合并成同一个 Promise。
 *
 * 关键点：缓存与请求是模块级的，而 `urls` 是**每个图层实例自己的 state**。
 * 新轨道 / 重新挂载的图层如果只看到「这个路径有人正在取」，不能就此放弃——
 * 必须照样 await 同一个 Promise，再写回自己的 `urls`，否则那一层的 `<video>`
 * 永远没有 src，画面就停在棋盘格或上一段。
 */
const previewUrlRequests = new Map<string, Promise<PreviewUrlEntry>>()

function requestPreviewUrl(path: string): Promise<PreviewUrlEntry> {
  const pending = previewUrlRequests.get(path)
  if (pending) return pending
  const request = (async (): Promise<PreviewUrlEntry> => {
    const api = window.socut?.video
    const url = api ? await api.previewUrl(path).catch(() => null) : null
    const entry: PreviewUrlEntry = { url, fetchedAt: performance.now() }
    previewUrlCache.set(path, entry)
    return entry
  })().finally(() => {
    previewUrlRequests.delete(path)
  })
  previewUrlRequests.set(path, request)
  return request
}

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

/**
 * 预卷中的下一段用「近零」不透明度，而不是 0。
 *
 * Chromium 会把完全透明（opacity: 0）的 `<video>` 当成不可见：不再向合成器提交新帧
 * （实测预卷期间 `totalVideoFrames` 一帧不涨）。切点翻成 1 时才一次性补帧，
 * 补不上的直接记进 `droppedVideoFrames`（实测每次硬切 +3~4 帧），观感就是切点抽一下。
 * 留 0.4% 不透明度：合成器仍按可见处理、持续出帧；画面上只多 1/255 的灰度，看不出来。
 */
const PREROLL_OPACITY = '0.004'

function mediaStyleOf(clip: MediaClip): CSSProperties {
  const transform = mediaVideoTransform(clip.video)
  // 每段用自己的曲线表 id：候选池里可能同时挂着调色不同的几段
  const filter = mediaVideoFilter(clip.video, previewGradeFilterId(clip.id))
  // M6-E：挂了关键帧的段，几何完全由外层包裹层按帧给出；元素自己不能再套静态 transform
  // （否则被关键帧覆盖的参数会与静态值重复应用，位置/缩放会翻倍）。
  const geometryFromKeyframes = clip.keyframes !== undefined && clip.keyframes.length > 0
  return {
    ...(transform !== 'none' && !geometryFromKeyframes ? { transform } : {}),
    ...(filter !== 'none' ? { filter } : {})
  }
}

/** 与 seek 同一口径的 duration 钳制（保留 1ms 余量，避免落在媒体末尾）。 */
function clampSeekTarget(video: HTMLVideoElement, target: number): number {
  const duration = Number.isFinite(video.duration) ? video.duration : target
  return Math.min(Math.max(0, target), Math.max(0, duration - 0.001))
}

/**
 * M8：手绘遮罩的 CSS 样式（透明区被遮掉）。
 *
 * 遮罩 PNG 由 `maskCapture.applyStrokesToContext` 光栅化：白底不透明 = 可见，
 * hide 笔画用 `destination-out` 擦成透明 = 隐藏，所以这里用 `mask-mode: alpha`
 * （PNG 的 alpha 通道承载可见性，和导出侧 `alphamerge` 读的是同一个通道）。
 * 无 URL（没有遮罩 / 还没画好 / 环境不支持画布）时返回 undefined：
 * DOM 上不出现任何 mask 属性 = 与旧版逐像素一致。
 */
function maskStyleOf(url: string | undefined): CSSProperties | undefined {
  if (!url) return undefined
  const value = `url("${url}")`
  return {
    maskImage: value,
    WebkitMaskImage: value,
    maskMode: 'alpha',
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: '0 0',
    WebkitMaskPosition: '0 0'
  }
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
    {
      candidates,
      fps,
      audioEnabled = true,
      loopDurationSec = 0,
      maskAspect,
      trackClips,
      onVisibleChange,
      onAudioChange,
      onFailure,
      transition,
      transitionResolver
    },
    ref
  ) {
    // 首帧就按模块级缓存预置：缓存命中时不需要等一次 effect + re-render 才挂元素
    // （新增轨道 / 切段后重新挂载时，元素能在第一次提交里就带着 src 出现）。
    const [urls, setUrls] = useState<Record<string, string | null>>(() => {
      const seed: Record<string, string | null> = {}
      for (const candidate of candidates) {
        const entry = previewUrlCache.get(candidate.sourcePath)
        if (entry) seed[candidate.sourcePath] = entry.url
      }
      return seed
    })
    const elementsRef = useRef(new Map<string, HTMLVideoElement | HTMLImageElement>())
    /**
     * M8：手绘遮罩的预览图（每个 clipId 一个 blob URL）。
     * 没有 mask 的段不生成、不挂样式 —— 无遮罩时 DOM 与旧版完全一致。
     */
    const [maskUrls, setMaskUrls] = useState<Record<string, string>>({})
    const maskUrlsRef = useRef<Record<string, string>>({})
    /**
     * 每个 clipId 一个**稳定**的 ref 回调：内联箭头函数每次渲染都会换身份，
     * React 会先以 null 再以元素调用一遍，导致候选池每 100ms 被清空重填一次。
     */
    const refCallbacksRef = useRef(
      new Map<string, (element: HTMLVideoElement | HTMLImageElement | null) => void>()
    )
    const readyRef = useRef(new Set<string>())
    /**
     * M6-E：关键帧包裹层。媒体元素自己的 transform/opacity 被"切段可见性 + 转场"占用，
     * 所以关键帧的几何/不透明度写在外层 div 上（与元素相乘），互不打架。
     */
    const keyframeLayerRef = useRef(new Map<string, HTMLDivElement>())
    const keyframeCallbacksRef = useRef(new Map<string, (element: HTMLDivElement | null) => void>())
    const failedRef = useRef(new Set<string>())
    const pendingSeekRef = useRef(new Set<string>())
    /** 已做过「进入活动段首帧强制对齐」的 clipId：再次进入活动段（含回绕）要重新对齐 */
    const alignedRef = useRef(new Set<string>())
    /**
     * 切点从预卷接过来的「合法起点偏差」（秒）：`play()` 起播晚了几十毫秒，
     * 画面内容就比播放头慢同样的量。这个偏差**不能**在切点那一帧用 seek 补
     * （seek 会冻住解码器 = 「第一帧卡一下」），登记下来后只对**增量**漂移纠偏。
     */
    const entryOffsetRef = useRef(new Map<string, number>())
    /** 每元素 seek 合并状态：在飞期间只换目标，避免悬停逐帧拖动把 seek 排成风暴 */
    const seekStateRef = useRef(new Map<string, SeekState>())

    const candidatesRef = useRef(candidates)
    const fpsRef = useRef(fps)
    const audioEnabledRef = useRef(audioEnabled)
    const loopDurationRef = useRef(loopDurationSec)
    /** 本轨道全部片段；调用方没传时退回候选池（静态用例 / 旧用法行为不变） */
    const trackClipsRef = useRef<readonly MediaClip[]>(trackClips ?? [])
    trackClipsRef.current = trackClips && trackClips.length > 0 ? trackClips : candidates.map((item) => item.clip)
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

    /**
     * 遮罩内容签名：笔画/半径/模式/羽化/反向任一变化都要重新光栅化（播放、切段不重画）。
     * 用整份 `mask` 序列化：M8 的反向/羽化也参与，漏掉会出现「改了参数预览却没变」。
     */
    const maskSignature = useMemo(
      () =>
        candidates
          .map((candidate) => `${candidate.clip.id}:${candidate.clip.mask ? JSON.stringify(candidate.clip.mask) : ''}`)
          .join('\n'),
      [candidates]
    )

    /**
     * DOM 渲染顺序必须与「候选池角色」无关（活动 / 前瞻 / 兜底），否则切点前后数组顺序会翻转
     * （`[前段, 后段]` → `[后段, 前段]`），React 就会把 `<video>` 节点在 DOM 里搬动一次。
     *
     * 浏览器把一个媒体元素从文档摘下再插回，会重新走一遍加载算法：`currentTime` 复位到 0，
     * 并先画出**源文件第一帧**。裁切过的片段（入点 ≠ 0）于是每次切段都会「闪一下原素材首帧」
     * 才回到入点；未裁切的片段因为首帧就是正确帧，看不出来。
     *
     * 同一图层只承载一条轨道的候选（轨道内片段不重叠），按时间轴顺序渲染既稳定又不改变
     * 合成语义；转场两层的层级由 `transitionStyles` 显式写 zIndex，与 DOM 顺序无关。
     */
    const orderedCandidates = useMemo(
      () =>
        [...candidates].sort(
          (a, b) =>
            a.clip.timelineStartSec - b.clip.timelineStartSec || a.clip.id.localeCompare(b.clip.id)
        ),
      [candidates]
    )

    /**
     * 把解析结果写回本实例的 `urls`。命中缓存也要写：缓存是模块级、`urls` 是实例级，
     * 新挂载的图层（新增轨道 / 切段后重新挂载）不读缓存就会永远拿不到 src。
     */
    const applyResolvedUrls = (
      entries: ReadonlyArray<readonly [string, string | null]>
    ): void => {
      setUrls((previous) => {
        let next = previous
        for (const [path, url] of entries) {
          if (Object.prototype.hasOwnProperty.call(next, path) && next[path] === url) continue
          if (next === previous) next = { ...previous }
          next[path] = url
        }
        return next
      })
    }

    useEffect(() => {
      const paths = [...new Set(candidates.map((candidate) => candidate.sourcePath))]
      if (paths.length === 0) return

      const now = performance.now()
      const cached: Array<readonly [string, string | null]> = []
      const toFetch: string[] = []
      for (const path of paths) {
        const entry = previewUrlCache.get(path)
        if (!entry) {
          toFetch.push(path)
          continue
        }
        // 缓存命中先上屏（过期也先用旧地址，过期只表示要换版本号，不是不可用）
        cached.push([path, entry.url])
        if (shouldRefreshPreviewUrl(entry, now)) toFetch.push(path)
      }
      if (cached.length > 0) applyResolvedUrls(cached)
      if (toFetch.length === 0) return

      let cancelled = false
      // 在飞路径同样进入 Promise.all：共享同一个请求结果，而不是「别人在取我就不取了」
      void Promise.all(
        toFetch.map(async (path) => {
          const entry = await requestPreviewUrl(path)
          return [path, entry.url] as const
        })
      )
        .then((entries) => {
          if (cancelled) return
          applyResolvedUrls(entries)
          for (const [path, url] of entries) {
            if (url) continue
            // 拿不到协议地址 = 这条源不可预览；没有元素也就不会有 error 事件，这里主动上报
            for (const candidate of candidatesRef.current) {
              if (candidate.sourcePath === path) onFailureRef.current?.(candidate.clip.id)
            }
          }
        })
        .catch(() => undefined)

      return () => {
        cancelled = true
      }
    }, [pathsKey])

    /**
     * M8：遮罩 → CSS mask 用的 blob URL。
     * 内容签名一变就整批重光栅化，旧 URL 在新图就绪后统一 revoke（防泄漏）；
     * 卸载时由下面的 effect 回收最后一批。光栅化是异步的：晚一帧才上遮罩，
     * 期间画面先按无遮罩显示（不闪黑）。
     */
    useEffect(() => {
      const masked = candidates.filter(
        (candidate) => candidate.clip.mask !== undefined && candidate.clip.mask.strokes.length > 0
      )
      const revokeAll = (): void => {
        for (const url of Object.values(maskUrlsRef.current)) revokeMaskUrl(url)
        maskUrlsRef.current = {}
        setMaskUrls({})
      }
      if (masked.length === 0) {
        // 没有遮罩且本来也没有 URL：什么都不做（避免无意义的 re-render）
        if (Object.keys(maskUrlsRef.current).length === 0) return
        revokeAll()
        return
      }
      let cancelled = false
      const aspect =
        typeof maskAspect === 'number' && Number.isFinite(maskAspect) && maskAspect > 0 ? maskAspect : 16 / 9
      void Promise.all(
        masked.map(async (candidate) => [candidate.clip.id, await maskPreviewObjectUrl(candidate.clip.mask!, aspect)] as const)
      )
        .then((entries) => {
          if (cancelled) {
            for (const [, url] of entries) revokeMaskUrl(url)
            return
          }
          const previous = maskUrlsRef.current
          const next: Record<string, string> = {}
          for (const [clipId, url] of entries) if (url) next[clipId] = url
          maskUrlsRef.current = next
          for (const url of Object.values(previous)) revokeMaskUrl(url)
          setMaskUrls(next)
        })
        .catch(() => undefined)
      return () => {
        cancelled = true
      }
    }, [maskSignature, maskAspect])

    /** 卸载：回收最后一批遮罩 blob URL（否则每次切工程都会泄漏若干张位图）。 */
    useEffect(() => {
      return () => {
        for (const url of Object.values(maskUrlsRef.current)) revokeMaskUrl(url)
        maskUrlsRef.current = {}
      }
    }, [])

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

    /**
     * 清掉某元素的一切推导状态。`element` 传入时**立刻**把 opacity 写成 0：
     * 媒体重载（DOM 移动 / src 换版本 / 解码器复位）会把画面退回源片第一帧，
     * 若等下一帧 tick 再隐藏，这一帧里裁切片段就会闪出原素材首帧。
     */
    const resetElement = (
      clipId: string,
      element?: HTMLVideoElement | HTMLImageElement | null
    ): void => {
      readyRef.current.delete(clipId)
      failedRef.current.delete(clipId)
      pendingSeekRef.current.delete(clipId)
      alignedRef.current.delete(clipId)
      entryOffsetRef.current.delete(clipId)
      seekStateRef.current.delete(clipId)
      if (element) {
        element.style.opacity = '0'
        if (element instanceof HTMLVideoElement) element.muted = true
      }
    }

    const failElement = (clipId: string, element?: HTMLVideoElement | HTMLImageElement | null): void => {
      readyRef.current.delete(clipId)
      failedRef.current.add(clipId)
      if (element) element.style.opacity = '0'
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

    /**
     * 只有在「所有 seek 都落地」之后才允许标就绪。
     *
     * 之前只看 `pendingSeekRef`：一次 seek 期间又排进新目标时（合并器把目标写进 `wanted`），
     * `seeked` 会先补发第二次 seek、紧接着又把该段标成就绪 —— 此时元素里还是上一次 seek
     * 的画面（媒体刚加载完时就是源片首帧）。裁切片段就在这一瞬间被翻到最上层。
     */
    const markReadyIfSettled = (clipId: string, video: HTMLVideoElement): void => {
      if (failedRef.current.has(clipId)) return
      if (pendingSeekRef.current.has(clipId)) return
      if (video.seeking) return
      const state = seekStateRef.current.get(clipId)
      if (state && (state.wanted !== null || state.inFlight)) return
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

    /**
     * 是否「真的能出画」：既已就绪、DOM 里也确实挂着一个元素。
     * 候选段离开候选池后元素会卸载，但就绪标记还留着；只看 ready 会把一个
     * 没有元素的段判成可见段（画面上什么都没有，也轮不到兜底段）。
     */
    const isRenderable = (clipId: string): boolean =>
      readyRef.current.has(clipId) && elementsRef.current.has(clipId)

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
          // 换新元素时清掉旧的就绪标记：上一枚元素的解码结果不属于这一枚，
          // 否则切回该段的第一帧可能把还没解码出画面的元素翻到最上层。
          // 同时立刻隐藏（元素刚挂载时还停在源片首帧）。
          resetElement(clipId, element)
        }
        refCallbacksRef.current.set(clipId, callback)
      }
      return callback
    }

    /** 关键帧包裹层的稳定 ref 回调（同上：内联箭头每帧换身份会让 DOM 频繁 detach）。 */
    const keyframeRefCallbackFor = (clipId: string): ((element: HTMLDivElement | null) => void) => {
      let callback = keyframeCallbacksRef.current.get(clipId)
      if (!callback) {
        callback = (element) => {
          if (!element) {
            keyframeLayerRef.current.delete(clipId)
            return
          }
          keyframeLayerRef.current.set(clipId, element)
        }
        keyframeCallbacksRef.current.set(clipId, callback)
      }
      return callback
    }

    /**
     * M6-E：逐帧把关键帧的几何/不透明度写到包裹层（命令式，不走 React state，
     * 与切段可见性/转场的 opacity 相乘，互不覆盖）。
     * 进度用**时间轴**算（`timelineStartSec..timelineEndSec`），与导出滤镜内的 t 同一口径。
     */
    const syncKeyframeStyles = (atSec: number): void => {
      for (const candidate of candidatesRef.current) {
        const layer = keyframeLayerRef.current.get(candidate.clip.id)
        if (!layer) continue
        const clip = candidate.clip
        const tracks = clip.keyframes
        if (!tracks || tracks.length === 0) {
          if (layer.style.transform !== '') layer.style.transform = ''
          if (layer.style.opacity !== '1') layer.style.opacity = '1'
          continue
        }
        const span = clip.timelineEndSec - clip.timelineStartSec
        const progress = span > 1e-9 ? (atSec - clip.timelineStartSec) / span : 0
        const css = mediaKeyframeCssAt(clip.video, tracks, progress)
        const transform = css.transform === 'none' ? '' : css.transform
        if (layer.style.transform !== transform) layer.style.transform = transform
        const opacity = String(Math.round(css.opacity * 1000) / 1000)
        if (layer.style.opacity !== opacity) layer.style.opacity = opacity
      }
    }

    /** 转场增量 + 片段基座样式：只改 DOM style，不触发 React state。 */
    const applyTransitionElementStyle = (      candidate: PreviewCandidate,
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
        // 两侧都提前把音频图挂好：切点那一帧才 createMediaElementSource 会重配音频管线，
        // 正好卡在画面切换上（单层路径靠预卷提前挂图，转场窗口在这里自己兜住）。
        if (audioEnabledRef.current && candidate.hasAudio) attachPreviewAudio(element, 0)
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
      // M6-E：关键帧几何/不透明度每帧同步（转场分支也会用到，所以在分叉前统一做一次）
      syncKeyframeStyles(atSec)
      // 转场窗口用实时 atSec 现算（resolver 优先），不再等 PreviewStage 的节流值；
      // 没有 resolver 时回落到显式 transition prop（静态用例）。
      const resolver = transitionResolverRef.current
      const tr = resolver ? resolver(atSec) : transitionPropRef.current
      if (tr && applyTransition(list, tr, atSec, playing, halfFrame)) return
      restoreTransitionStyles(list)

      // 1. 该显示哪一段：上层 ready 优先；上层没就绪时回落到下层 ready；
      //    都没有时，**只有剪辑缝口**（刚结束这段的终点处紧贴下一段）才保留最后一帧兜底。
      let visible: PreviewCandidate | null = null
      /** 当帧活动但还没就绪的候选（诊断用）：它才是「本该切过去」的目标 */
      let pendingVisibleId: string | null = null
      for (const candidate of list) {
        if (!isClipActiveAt(candidate.clip, atSec)) continue
        if (isRenderable(candidate.clip.id)) visible = candidate
        else pendingVisibleId = candidate.clip.id
      }
      let fallback = false
      if (!visible) {
        // 轨道真正结束（末端 / 段后空隙）时画面必须立刻交还给下层或棋盘格。
        // 之前对所有「刚结束的段」无条件兜底，导致上层叠加视频播完后还会用最后一帧
        // 压住下层，直到候选池 hold 窗口（0.5s）结束才消失。
        const trackClips = trackClipsRef.current
        const ended = latestEndedClip(trackClips, atSec)
        if (ended && hasSeamSuccessor(ended, trackClips) && isRenderable(ended.id)) {
          const bridged = list.find((candidate) => candidate.clip.id === ended.id)
          if (bridged) {
            visible = bridged
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
        const isVisible = candidate.clip.id === visibleId
        /**
         * 预卷中的元素（普通切点的起播窗口 / 回绕前的滚入）：让合成器继续给它出帧。
         * 不限定「起点在未来」——回绕候选的 `timelineStartSec` 在当前圈已经过去了。
         */
        const prerolling = !isVisible && element instanceof HTMLVideoElement && !element.paused
        const next = isVisible ? '1' : prerolling ? PREROLL_OPACITY : '0'
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
        if (!active) {
          alignedRef.current.delete(clipId)
          entryOffsetRef.current.delete(clipId)
        }
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
          // 「已对齐」标记只决定容差口径：切点这一帧要不要 seek。
          const firstEnter = !alignedRef.current.has(clipId)
          if (firstEnter) alignedRef.current.add(clipId)
          if (playing) {
            // 已经在预卷里播放的元素：切点这一帧绝不能 seek。seek 会让解码器停在
            // `seeked` 之前，用户看到的就是「新段第一帧卡一下才继续」。
            const wasPlaying = !element.paused
            if (firstEnter) {
              const offset = element.currentTime - target
              if (wasPlaying && Math.abs(offset) <= PREVIEW_CUT_DRIFT_SEC) {
                // 起播晚了几十毫秒：登记成本段的合法起点偏差，之后只纠增量
                entryOffsetRef.current.set(clipId, offset)
              } else {
                // 冷启动（元素还停着）或偏差大到不是起播延迟：按半帧口径精确对齐
                entryOffsetRef.current.delete(clipId)
                if (Math.abs(offset) > halfFrame) requestSeek(clipId, element, target)
              }
            } else {
              const anchor = entryOffsetRef.current.get(clipId) ?? 0
              if (Math.abs(element.currentTime - (target + anchor)) > PREVIEW_DRIFT_SEC) {
                // 不是起播延迟，而是真的跑偏了（丢帧/卡顿累积）：重新对齐并丢掉旧偏差
                entryOffsetRef.current.delete(clipId)
                requestSeek(clipId, element, target)
              }
            }
            if (element.paused) void element.play().catch(() => undefined)
          } else {
            entryOffsetRef.current.delete(clipId)
            element.pause()
            if (firstEnter || Math.abs(element.currentTime - target) > halfFrame) {
              requestSeek(clipId, element, target)
            }
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

        const loopDuration = loopDurationRef.current
        const wrapStart = candidate.clip.timelineStartSec + loopDuration
        const inWrapLookahead =
          loopDuration > 0 &&
          atSec >= loopDuration - PREVIEW_LOOKAHEAD_SEC - EPS &&
          wrapStart > atSec + EPS &&
          wrapStart <= atSec + PREVIEW_LOOKAHEAD_SEC + EPS
        const upcoming = candidate.clip.timelineStartSec > atSec + EPS

        if (upcoming || inWrapLookahead) {
          // 即将开始：进预卷窗口先暂停摆位，临近切点才静音起播。
          // 回绕候选（本圈末尾、下一圈开头）把 atSec 平移到上一圈，复用同一套预卷/起播规划：
          // 否则它一直停在入点、回绕那一帧才 play()，解码器冷启动会让循环边界抽一下。
          const planAtSec = upcoming ? atSec : atSec - loopDuration
          /** 预卷期已经接上音频图：此时元素不必再 muted，增益 0 就是无声 */
          let prerollAudioReady = false
          if (playing) {
            /**
             * 预卷要**持续**纠偏，不能只摆一次：
             * `play()` 真正开始出帧通常晚于 seek 落地，只摆一次会把这段延迟原样留到切点，
             * 切点那一帧再补 seek 就变成「第一帧卡一下」。窗口内元素不可见，纠偏的 seek
             * 不会被看到；临近切点则停手（LOCK），避免 seek 正好跨在切点上冻住解码器。
             */
            const plan = previewPrerollPlan(
              candidate.clip,
              planAtSec,
              candidate.useStabProxy,
              // 热身窗口按 2 帧给：入点太靠前时只能原地起播，切点处至多超前 2 帧
              halfFrame * 4
            )
            if (plan) {
              // 音频图提前在预卷期挂好、并把音频渲染器跑起来（初始增益 0 = 无声）：
              // 切点才 unmute 或才 createMediaElementSource，都会让 Chromium 重配音频管线
              // 并重对媒体时钟——实测切点会一次性补跳约 2 帧（画面顿一下）。
              if (audioEnabledRef.current && candidate.hasAudio) {
                prerollAudioReady = attachPreviewAudio(element, 0) !== null
              }
              const remaining = candidate.clip.timelineStartSec - planAtSec
              /**
               * 只在起播窗口内真的播放：更早的整段时间元素已经就绪、摆好了入点，
               * 让它一直播会与可见段抢解码/合成资源（切点附近帧率抖动的来源）。
               * `warmup`（入点太靠前、退不到预卷位置）除外：只能原地起播。
               */
              if (plan.warmup || remaining <= PREVIEW_ROLL_IN_SEC + EPS) {
                if (element.paused) void element.play().catch(() => undefined)
                if (remaining <= PREVIEW_PREROLL_LOCK_SEC + EPS) {
                  // 切点前停手：连排队目标也清掉，免得它正好在切点上落地把解码器冻住
                  seekStateFor(clipId).wanted = null
                } else if (
                  // 热身态不能按 target 纠偏（会在 0 附近来回拉锯，反而一直起播不了）
                  !plan.warmup &&
                  Math.abs(element.currentTime - plan.target) > PREVIEW_PREROLL_STEER_SEC
                ) {
                  requestSeek(clipId, element, plan.target)
                }
              } else {
                // 起播窗口之前：保持暂停，只把元素摆到起播位置（暂停态 seek 不占解码/合成）
                if (!element.paused) element.pause()
                if (!plan.warmup && Math.abs(element.currentTime - plan.park) > PREVIEW_PREROLL_STEER_SEC) {
                  requestSeek(clipId, element, plan.park)
                }
              }
            } else if (!upcoming) {
              // 回绕前瞻但还没进预卷窗口：停在入点，等起播窗口
              if (!element.paused) element.pause()
              const start = previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
              if (Math.abs(element.currentTime - start) > halfFrame) {
                requestSeek(clipId, element, start)
              }
            }
          } else {
            element.pause()
            const start = previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
            if (Math.abs(element.currentTime - start) > halfFrame) {
              requestSeek(clipId, element, start)
            }
          }
          element.muted = !prerollAudioReady
          setElementLevel(element, 0)
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
     * 2. 清「已对齐」标记，下一帧进入活动段时重新按播放头对齐；
     * 3. 每个元素送回自己的入点（已在入点容差内的跳过：正在滚入的头部片段不能被 seek 打断）。
     *    **不 pause**：播放状态交给同一帧的 tick 决定。
     *
     * `visibleRef` 刻意保持原值：回绕瞬间上报 false 会让 Canvas 画棋盘格闪一下。
     */
    const restart = (): void => {
      const list = candidatesRef.current
      restoreTransitionStyles(list)
      alignedRef.current.clear()
      entryOffsetRef.current.clear()
      for (const candidate of list) {
        const element = elementsRef.current.get(candidate.clip.id)
        if (!(element instanceof HTMLVideoElement)) continue
        const start = previewClipStartSourceTime(candidate.clip, candidate.useStabProxy)
        // 回绕瞬间正在滚入的头部片段已经贴着入点（roll-in 让 currentTime 略超前）：
        // 这时再 seek 一次会把解码器冻在切点上，等于把刚修好的冷启动又做回来一遍。
        if (Math.abs(element.currentTime - start) <= PREVIEW_CUT_DRIFT_SEC) continue
        requestSeek(candidate.clip.id, element, start)
      }
    }

    useImperativeHandle(ref, () => ({ tick, restart }), [])

    return (
      <>
        {/* 每段自己的曲线查找表：候选池可能同时有调色不同的几段，不能共用全局 id */}
        {orderedCandidates.map((candidate) => {
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
        {orderedCandidates.map((candidate) => {
          const clipId = candidate.clip.id
          const url = urls[candidate.sourcePath]
          if (!url) return null
          // M8：有遮罩才合并 mask 样式；无遮罩时 style 与旧版逐键相同（零回归）
          const maskStyle = maskStyleOf(maskUrls[clipId])
          const style = maskStyle ? { ...mediaStyleOf(candidate.clip), ...maskStyle } : mediaStyleOf(candidate.clip)
          if (candidate.kind === 'image') {
            return (
              <div key={clipId} ref={keyframeRefCallbackFor(clipId)} className="stage__media-keyframes" aria-hidden="true">
                <img
                  ref={refCallbackFor(clipId)}
                  className="stage__ref-video"
                  src={url}
                  style={style}
                  alt=""
                  draggable={false}
                  onLoadStart={(event) => resetElement(clipId, event.currentTarget)}
                  onLoad={() => markReady(clipId)}
                  onError={(event) => failElement(clipId, event.currentTarget)}
                />
              </div>
            )
          }
          return (
            <div key={clipId} ref={keyframeRefCallbackFor(clipId)} className="stage__media-keyframes" aria-hidden="true">
              <video
                ref={refCallbackFor(clipId)}
                className="stage__ref-video"
                data-clip-id={clipId}
                src={url}
                style={style}
                playsInline
                preload="auto"
                aria-label="参考视频预览"
                // 加载被接管 / 媒体被复位（DOM 搬动、src 换版本）：当场隐藏并清状态，
                // 否则重载过程中画出的源片首帧会留在屏幕上最多一帧。
                onLoadStart={(event) => resetElement(clipId, event.currentTarget)}
                onEmptied={(event) => resetElement(clipId, event.currentTarget)}
                onLoadedMetadata={(event) => primeVideo(candidate, event.currentTarget)}
                onLoadedData={(event) => markReadyIfSettled(clipId, event.currentTarget)}
                onCanPlay={(event) => markReadyIfSettled(clipId, event.currentTarget)}
                onSeeked={(event) => {
                  // 顺序不能反：先让合并器应用最新目标（可能再发一次 seek），再判定是否真落地
                  settleSeek(clipId, event.currentTarget)
                  // 目标还在飞时不标就绪（否则会把上一次 seek 的帧当成这一段的画面）
                  pendingSeekRef.current.delete(clipId)
                  markReadyIfSettled(clipId, event.currentTarget)
                }}
                onError={(event) => failElement(clipId, event.currentTarget)}
              />
            </div>
          )
        })}
        {/* 转场色块（黑/白/灰）：在媒体层之上、字幕 Canvas 之下（z-index 见 styles.css） */}
        <div className="stage__transition-flash" ref={flashRef} aria-hidden="true" />
      </>
    )
  }
)
