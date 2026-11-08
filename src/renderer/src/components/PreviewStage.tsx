import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { fpsToString } from '@shared/constants'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import { topActiveMediaClip } from '@shared/mediaClips'
import { mediaTrackOrder, visibleMediaTracks } from '@shared/tracks'
import { activeAudioClips, mediaKindOf } from '@shared/audioClips'
import { clipTimelineDurationSec, previewGainAt, previewPlaybackRate, previewPreservesPitch, sourceTimeAt } from '@shared/mediaClipAudio'
import { attachPreviewAudio, elementLevelReader, setElementLevel, setPreservesPitch } from '../audio/previewAudioGraph'
import { setPreviewLevelReader } from '../audio/previewLevel'
import { frameIntervalSec } from '@shared/fps'
import { computeWatermarkGeometry } from '@shared/ffmpegArgs'
import type { AudioClip, MediaClip, MediaItem, RenderJobSpec } from '@shared/types'
import { usePreviewLoop } from '../hooks/usePreviewLoop'
import { containFrameRect, displayToNative, hitTestClips } from '../render/hitTest'
import { selectPreviewCandidates, isClipActiveAt, type PreviewCandidate } from '../render/previewCandidates'
import { previewPerf } from '../render/previewPerf'
import {
  previewTransitionForTrack,
  type PreviewTransitionState
} from '../render/previewTransition'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { stabSignatureFor, useStabPreviewStore } from '../state/stabPreviewStore'
import { useProxyStore } from '../state/proxyStore'
import { FontLoadingOverlay } from '../dialog/FontLoadingOverlay'
import { MediaPreviewLayer, type MediaPreviewHandle } from './MediaPreviewLayer'
import { StageTransformOverlay } from './StageTransformOverlay'

/**
 * 预览舞台（规格 §4.3）：
 * 显示 Canvas 只承担等比缩放显示，尺寸与 CSS 缩放都不参与渲染坐标计算，
 * 真正的像素由 NativeStage（目标分辨率 1:1）产出，因此预览与导出像素一致。
 *
 * 参考视频叠加（v7 多轨）：每一条可见媒体轨各挂一层 `<video>`/`<img>`，按轨道数组顺序
 *（索引 0 = 最底层）渲染——DOM 顺序就是合成顺序，高处轨道直接盖住低处，形成真正的画中画叠层。
 * 隐藏轨整层跳过；段间空隙时该层收起，所有层都无帧才回退棋盘格。
 * 上层 Canvas 改画透明底字幕条，恒在所有媒体层之上，于是预览看到的就是导出 MP4 的叠加结果。
 * 视频解码失败（如 ProRes）时该层回退棋盘格。
 *
 * 水印（Watermark）：同一套装入矩形里再按原生像素定位一张图，位置/尺寸与导出
 * 共用 `computeWatermarkGeometry`（1080P 基准 → 原图 32% → 左上角 30px），
 * 不进 Canvas——Canvas 的像素就是导出的透明字幕层，水印属于合成层且在最顶层，不能烘进去。
 *
 * 画面框（v3 伸缩布局配套）：预览区可以被分隔线拖成任意宽高比，而目标分辨率的比例不变。
 * 因此这里先量容器、算出一个**与目标分辨率同比例的矩形**（`containFrameRect`），把
 * Canvas / 参考视频 / 水印 / 角标 / 提示语全部装进同一个 `.stage__frame` 容器：
 * 五者共用一个原点与一个缩放比，拖动分隔线时它们一起移动、一起缩放，不会谁落在黑边上。
 */

/** 稳定的空音频轨（避免选择器每次返回新数组引起重渲染） */
const EMPTY_AUDIO_CLIPS: AudioClip[] = []

/** 宽高比分支的内部枚举不直接上界面，换成两个字的人话。 */
const MODE_LABEL: Record<string, string> = { standard: '标准', compact: '紧凑', ultrawide: '超宽' }

/**
 * 候选池重算节流（ms）：纯函数每帧调用是廉价的，但 `setState` 太频繁会让舞台
 * 按 10Hz+ 重渲染；签名变化会立即同步，所以 250ms 只影响「同一候选集合内的锚点新鲜度」。
 */
const POOL_SYNC_MS = 250

/**
 * 预览播放头对外的句柄：时间轴点击定位只用 seekTime，
 * 键盘逐帧跳转（←/→）要读当前帧号并知道总帧数，否则算不出落点。
 */
export interface StageSeekHandle {
  seekTime: (sec: number) => void
  /** 绝对帧序号跳转（与 currentFrame 同一坐标） */
  seekFrame: (frame: number) => void
  /** 当前绝对帧号（= spec.startFrame + 预览循环里的相对帧） */
  currentFrame: () => number
  /** 预览总帧数（= endFrame - startFrame；空工程为 0） */
  totalFrames: number
}

export interface PreviewStageProps {
  spec: RenderJobSpec | null
  /** 播放头跳转句柄由上层持有（时间轴点击定位 + 键盘逐帧跳转用） */
  onHandle?: (handle: StageSeekHandle) => void
}

export function PreviewStage({ spec, onHandle }: PreviewStageProps): ReactElement {
  previewPerf.stageRenders += 1
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playing = useUiStore((state) => state.playing)
  const setLiveClipId = useUiStore((state) => state.setLiveClipId)
  const showSafeArea = useUiStore((state) => state.showSafeArea)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  /**
   * P4：预览轴的悬停帧不再订阅——它每帧从 store 现读（`getOverrideSec` + `onTick`），
   * 悬停换帧不触发整树 re-render。
   */
  const setPlayheadSec = useUiStore((state) => state.setPlayheadSec)
  /**
   * 候选池/转场窗口的实时采样锚点：由 rAF 的 `onTick` 以实时时间（或悬停帧）刷新，
   * 不再用 10Hz 的 `displayTimeSec` 判定 —— 否则切点处目标 `<video>` 会晚 100ms 才挂载。
   */
  const [poolAnchorSec, setPoolAnchorSec] = useState(0)
  /** 上次同步时的候选签名：签名一变立刻同步，其余情况按 250ms 节流（4Hz） */
  const poolSignatureRef = useRef('')
  const lastPoolSyncRef = useRef(0)
  const setDisplayTime = useUiStore((state) => state.setDisplayTime)
  const selectClip = useProjectStore((state) => state.selectClip)
  const project = useProjectStore((state) => state.project)
  const mediaClips = project.mediaClips
  const mediaTracks = project.mediaTracks
  const mediaPool = project.media
  // @deprecated v1 兼容：冒烟取证脚本直接写 refVideo，没有 mediaClips 时仍按旧路取源
  const legacyRefPath = useProjectStore((state) => state.project.refVideo?.path ?? null)
  const legacyHasAudio = useProjectStore((state) => state.project.refVideo?.meta.audioCodec != null)
  const watermark = useProjectStore((state) => state.project.watermark)

  const projectFps = useProjectStore((state) => state.project.fps)
  const previewCanvasKind = useUiStore((state) => state.previewCanvasKind)
  const previewFit = useUiStore((state) => state.previewFit)
  const stabApplied = useStabPreviewStore((state) => state.applied)
  const proxyEntries = useProxyStore((state) => state.entries)

  /**
   * 多轨合成：轨道数组顺序 = 绘制顺序（索引 0 在最底），隐藏轨不参与画面。
   * `trackOrder` 用**完整轨道数组**生成，隐藏轨只从片段入参里剔除——
   * 这样轨道之间的相对层级保持稳定，不会因为隐藏某条轨而整体重排。
   */
  const trackOrder = useMemo(() => mediaTrackOrder(mediaTracks), [mediaTracks])
  const visibleTracks = useMemo(() => visibleMediaTracks(mediaTracks), [mediaTracks])
  const visibleClips = useMemo(() => {
    if (mediaTracks.length === 0) return mediaClips
    const ids = new Set(visibleTracks.map((track) => track.id))
    return mediaClips.filter((clip) => ids.has(clip.trackId))
  }, [mediaClips, mediaTracks, visibleTracks])

  /**
   * 时间轴循环总时长（= spec 帧数 × 帧间隔）：播放到末尾会自动回绕，
   * 候选池据此把头部片段提前挂进前瞻窗口。`spec` 未就绪时为 0（不启用回绕前瞻）。
   */
  const loopDurationSec = useMemo(
    () => (spec ? Math.max(0, spec.endFrame - spec.startFrame) * frameIntervalSec(spec.fps) : 0),
    [spec]
  )

  /**
   * 转场预览：每条可见轨道各自算一次（切点/时长/进度与导出计划同一口径）。
   * 同一轨道同时只会有一个有效窗口；多轨可各自独立。
   * 这里只取实时锚点算出的「转场对」，用于候选强制保留与代理选择；
   * 图层内每帧另用 `transitionResolver` 按实时时间现算窗口。
   */
  const transitionByTrack = useMemo(() => {
    const map = new Map<string, PreviewTransitionState>()
    const atSec = Math.max(0, poolAnchorSec)
    for (const track of visibleTracks) {
      const state = previewTransitionForTrack({
        clips: visibleClips,
        atSec,
        project,
        fps: projectFps,
        trackId: track.id
      })
      if (state) map.set(track.id, state)
    }
    return map
  }, [visibleTracks, visibleClips, project, projectFps, poolAnchorSec])

  const transitionIds = useMemo(
    () =>
      [...transitionByTrack.values()].map((state) => ({
        leftId: state.leftClipId,
        rightId: state.rightClipId
      })),
    [transitionByTrack]
  )

  /** 转场两侧的片段不用防抖代理：代理只覆盖原源区间，看不到头/尾手柄。 */
  const transitionClipIds = useMemo(() => {
    const ids = new Set<string>()
    for (const pair of transitionIds) {
      ids.add(pair.leftId)
      ids.add(pair.rightId)
    }
    return ids
  }, [transitionIds])

  /**
   * 预览候选池：当前图层 + 刚结束的兜底段 + 前瞻窗口内的下一段。
   * 转场窗口内两侧强制同时挂载；路径在这里就解析成原片/防抖代理，DOM 层只负责挂载与同步。
   */
  const candidates = useMemo((): PreviewCandidate[] => {
    const out: PreviewCandidate[] = []
    for (const clip of selectPreviewCandidates(
      visibleClips,
      Math.max(0, poolAnchorSec),
      trackOrder,
      transitionIds,
      { loopDurationSec }
    )) {
      const item = mediaPool.find((media) => media.id === clip.mediaId)
      if (!item) continue
      const kind = mediaKindOf(item)
      if (kind === 'audio') continue
      const hasAudio = typeof item.meta.audioCodec === 'string' && item.meta.audioCodec.length > 0
      let sourcePath = item.path
      let useStabProxy = false
      // 转场窗口要读片段头/尾手柄，防抖代理只覆盖原源区间，因此回落到原片
      if (clip.stab?.enabled && !transitionClipIds.has(clip.id)) {
        const applied = stabApplied[clip.id]
        if (applied?.path) {
          const signature = stabSignatureFor({
            clip,
            stab: clip.stab,
            sourcePath: item.path,
            fps: projectFps,
            hasAudio
          })
          if (applied.signature === signature) {
            sourcePath = applied.path
            useStabProxy = true
          }
        }
      }
      /**
       * v10：媒体预览代理（4K / MXF）。优先级：新鲜防抖代理 > 新鲜媒体代理 > 原片。
       * 代理是整片 1:1 转码，源坐标不需要偏移（useStabProxy 仍为 false）；
       * 图像/音频不走代理，转场窗口也不换（手柄需要原片范围，代理同为整片所以无影响，
       * 但保持与防抖同一保守口径）。
       */
      if (!useStabProxy && kind === 'video') {
        const proxyPath = proxyEntries[item.id]
        if (proxyPath && proxyPath.sourcePath === item.path) sourcePath = proxyPath.path
      }
      out.push({ clip, kind, hasAudio, sourcePath, useStabProxy })
    }
    // @deprecated v1 兼容：没有 mediaClips 时，旧 refVideo 也走同一条候选池
    if (out.length === 0 && mediaClips.length === 0 && legacyRefPath) {
      const clip: MediaClip = {
        id: 'legacy-ref',
        mediaId: 'legacy-ref',
        timelineStartSec: 0,
        timelineEndSec: 1e12,
        sourceInSec: 0,
        sourceOutSec: 1e12,
        // 旧兼容段也要落在一条真实轨道上，预览层才能按轨道分组叠放
        trackId: visibleTracks[0]?.id ?? mediaTracks[0]?.id ?? 'track-media-0'
      }
      out.push({ clip, kind: 'video', hasAudio: legacyHasAudio, sourcePath: legacyRefPath, useStabProxy: false })
    }
    return out
  }, [
    visibleClips,
    trackOrder,
    mediaClips,
    mediaTracks,
    visibleTracks,
    mediaPool,
    poolAnchorSec,
    loopDurationSec,
    stabApplied,
    proxyEntries,
    projectFps,
    transitionIds,
    transitionClipIds,
    legacyRefPath,
    legacyHasAudio
  ])

  const [mediaVisibleReady, setMediaVisibleReady] = useState(false)
  /** 同一份可见性同时写进 ref：usePreviewLoop 在同一帧的 blit 里读它 */
  const mediaVisibleRef = useRef(false)
  /** 当前有可见帧的轨道 id 集合：任一轨道可见就关掉棋盘格 */
  const visibleTracksWithFrameRef = useRef(new Set<string>())
  const [failedClipIds, setFailedClipIds] = useState<ReadonlySet<string>>(() => new Set())
  /** 每条轨道当前上报的原声路：顶层轨道胜出（与导出内嵌原声的 topmost-wins 同口径） */
  const [audioRoutes, setAudioRoutes] = useState<
    ReadonlyMap<string, { element: HTMLVideoElement; clip: MediaClip }>
  >(() => new Map())
  /** 每个轨道一层 MediaPreviewLayer；tick 按轨道升序（底层 → 顶层）驱动 */
  const layerRefs = useRef(new Map<string, MediaPreviewHandle>())
  const layerRefCallbacks = useRef(
    new Map<string, (handle: MediaPreviewHandle | null) => void>()
  )

  const handleVisibleChange = useCallback((trackId: string, visible: boolean): void => {
    const set = visibleTracksWithFrameRef.current
    if (visible === set.has(trackId)) return
    if (visible) set.add(trackId)
    else set.delete(trackId)
    const next = set.size > 0
    mediaVisibleRef.current = next
    setMediaVisibleReady(next)
  }, [])

  const handleAudioChange = useCallback(
    (trackId: string, element: HTMLVideoElement | null, clip: MediaClip | null): void => {
      setAudioRoutes((previous) => {
        const current = previous.get(trackId)
        if (!element || !clip) {
          if (!current) return previous
          const next = new Map(previous)
          next.delete(trackId)
          return next
        }
        if (current && current.element === element && current.clip.id === clip.id) return previous
        const next = new Map(previous)
        next.set(trackId, { element, clip })
        return next
      })
    },
    []
  )

  /** 出声轨：所有上报里轨道序号最大的那一路，下层不抢麦 */
  const audioRoute = useMemo(() => {
    let best: { element: HTMLVideoElement; clip: MediaClip } | null = null
    let bestRank = Number.NEGATIVE_INFINITY
    for (const [trackId, route] of audioRoutes) {
      const rank = trackOrder.get(trackId) ?? -1
      if (rank > bestRank) {
        bestRank = rank
        best = route
      }
    }
    return best
  }, [audioRoutes, trackOrder])

  /** 稳定 ref 回调：内联箭头每次渲染都换身份，会 detach/attach 一遍所有层 */
  const layerRefFor = (trackId: string): ((handle: MediaPreviewHandle | null) => void) => {
    let callback = layerRefCallbacks.current.get(trackId)
    if (!callback) {
      callback = (handle) => {
        if (handle) layerRefs.current.set(trackId, handle)
        else layerRefs.current.delete(trackId)
      }
      layerRefCallbacks.current.set(trackId, callback)
    }
    return callback
  }

  /**
   * 实时转场 resolver：每个轨道一个**稳定**函数（按 trackId 缓存），内部读 ref 里的最新
   * 片段/工程，避免每次渲染换身份导致图层重置。图层每帧用它按实时 `atSec` 现算窗口，
   * 进入/退出转场不再等 10Hz 节流值。
   */
  const transitionResolverCallbacks = useRef(
    new Map<string, (atSec: number) => PreviewTransitionState | null>()
  )
  const liveClipsRef = useRef(visibleClips)
  const liveProjectRef = useRef(project)
  const liveFpsRef = useRef(projectFps)
  liveClipsRef.current = visibleClips
  liveProjectRef.current = project
  liveFpsRef.current = projectFps
  const transitionResolverFor = (trackId: string): ((atSec: number) => PreviewTransitionState | null) => {
    let resolver = transitionResolverCallbacks.current.get(trackId)
    if (!resolver) {
      resolver = (atSec) =>
        previewTransitionForTrack({
          clips: liveClipsRef.current,
          atSec: Math.max(0, atSec),
          project: liveProjectRef.current,
          fps: liveFpsRef.current,
          trackId
        })
      transitionResolverCallbacks.current.set(trackId, resolver)
    }
    return resolver
  }

  const handleFailure = useCallback((clipId: string): void => {
    setFailedClipIds((previous) => (previous.has(clipId) ? previous : new Set(previous).add(clipId)))
  }, [])

  useEffect(() => {
    setFailedClipIds(new Set())
  }, [mediaClips])

  /**
   * 画面交互层只在「选中媒体段 + 打开交互开关 + 该段正处在**播放头**下」时出现：
   * 否则手柄会画在一个看不见的画面位置上，拖了也看不到效果。
   * P4：这里故意不用悬停帧取段——黄线只负责“给用户看那一帧”，
   * 拖手柄必须挂在真正选中的那一段上，不然悬停一飘就在改另一段。
   */
  const selectionKind = useProjectStore((state) => state.selectionKind)
  const selectedMediaClipId = useProjectStore((state) => state.selectedMediaClipId)
  const stageInteract = useUiStore((state) => state.stageInteract)
  const audioClips = useProjectStore((state) => state.project.audioClips) ?? EMPTY_AUDIO_CLIPS
  /**
   * 内嵌原声的出声轨：可见、未静音、且当前有 active 视频（带音轨）的**最高轨道**。
   * 只看候选池里的 active 段——hold/前瞻段不参与抢麦，避免切点前先把上一层的声音顶掉。
   */
  const audioOwnerTrackId = useMemo((): string | null => {
    const muted = new Set(mediaTracks.filter((track) => track.muted).map((track) => track.id))
    let owner: string | null = null
    let bestRank = Number.NEGATIVE_INFINITY
    for (const candidate of candidates) {
      if (candidate.kind !== 'video' || !candidate.hasAudio) continue
      if (!isClipActiveAt(candidate.clip, displayTime)) continue
      if (muted.has(candidate.clip.trackId)) continue
      const rank = trackOrder.get(candidate.clip.trackId) ?? -1
      if (rank > bestRank) {
        bestRank = rank
        owner = candidate.clip.trackId
      }
    }
    return owner
  }, [candidates, mediaTracks, displayTime, trackOrder])

  /** 每个可见轨道一层，按轨道升序排列：DOM 顺序就是合成顺序（底层先画、上层后画）。 */
  const layerGroups = useMemo(
    () =>
      visibleTracks
        .map((track) => ({
          trackId: track.id,
          candidates: candidates.filter((candidate) => candidate.clip.trackId === track.id)
        }))
        .filter((group) => group.candidates.length > 0),
    [visibleTracks, candidates]
  )

  const playheadClip = useMemo(
    () => topActiveMediaClip(visibleClips, Math.max(0, displayTime), trackOrder) ?? null,
    [visibleClips, displayTime, trackOrder]
  )
  const overlayClip =
    stageInteract && selectionKind === 'media' && playheadClip && playheadClip.id === selectedMediaClipId
      ? playheadClip
      : null

  /**
   * 画面框：量的是**外层容器**而不是 Canvas 自己——尺寸变化时 Canvas 盒子会被我们写回，
   * 观察它会形成「测量 → 改尺寸 → 再测量」的回环；拖分隔线时还会晚一帧。
   */
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const measure = (): void => setViewport({ width: wrap.clientWidth, height: wrap.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  /** 目标分辨率下的等比装入矩形（相对容器坐标）；尚未测得或 spec 未就绪时为 null，由 CSS 兜底铺满。 */
  const frame = useMemo(() => {
    if (!viewport || !spec) return null
    return containFrameRect(viewport, { width: spec.width, height: spec.height })
  }, [spec, viewport])

  const frameStyle = useMemo((): CSSProperties | undefined => {
    if (!frame) return undefined
    return { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
  }, [frame])

  const [watermarkUrl, setWatermarkUrl] = useState<string | null>(null)
  const watermarkPath = watermark?.enabled ? watermark.path : null
  useEffect(() => {
    let cancelled = false
    setWatermarkUrl(null)
    if (!watermarkPath) return
    void window.focusnews.video
      .previewUrl(watermarkPath)
      .then((url) => {
        if (!cancelled) setWatermarkUrl(url)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [watermarkPath])

  const watermarkStyle = useMemo((): CSSProperties | null => {
    if (!watermark?.enabled || !watermarkUrl || !spec || !frame) return null
    // 画面框与目标分辨率同比例，所以一个 scale 就够；偏移相对画面框原点
    const scale = frame.width / spec.width
    const geom = computeWatermarkGeometry(
      { path: watermark.path, sourceWidth: watermark.sourceWidth, sourceHeight: watermark.sourceHeight },
      { width: spec.width, height: spec.height }
    )
    return {
      left: geom.x * scale,
      top: geom.y * scale,
      width: geom.width * scale,
      height: geom.height * scale
    }
  }, [watermark, watermarkUrl, spec, frame])

  const handle = usePreviewLoop({
    canvasRef,
    spec,
    playing,
    showSafeArea,
    transparent: mediaVisibleReady,
    transparentRef: mediaVisibleRef,
    getOverrideSec: () => useUiStore.getState().hoverPreviewSec,
    onDisplayTime: setDisplayTime,
    onPlayhead: setPlayheadSec,
    onTick: (timelineSec, isPlaying) => {
      // 候选池/转场判据用**实时**锚点（同一帧的 rAF 时间），不再用 10Hz 的 displayTimeSec：
      // 签名变化立即同步，其余情况按 100ms 节流；纯函数规模小，每帧调用可接受。
      const anchor = useUiStore.getState().hoverPreviewSec ?? timelineSec
      const signature = selectPreviewCandidates(
        visibleClips,
        Math.max(0, anchor),
        trackOrder,
        transitionIds,
        { loopDurationSec }
      )
        .map((clip) => clip.id)
        .join('\n')
      const now = performance.now()
      if (signature !== poolSignatureRef.current || now - lastPoolSyncRef.current >= POOL_SYNC_MS) {
        lastPoolSyncRef.current = now
        poolSignatureRef.current = signature
        setPoolAnchorSec(anchor)
      }
      // 悬停时按静态帧预览：媒体层暂停在悬停帧，不跟着播放时钟跑。
      // 悬停态每帧从 store 现读（不再依赖闭包里的订阅值，避免悬停换帧触发渲染）。
      // 按轨道升序逐层 tick（底层 → 顶层），出声轨由 audioEnabled 单独仲裁。
      const play = isPlaying && useUiStore.getState().hoverPreviewSec === null
      for (const track of visibleTracks) layerRefs.current.get(track.id)?.tick(timelineSec, play)
    },
    // 回绕复位：rAF 内直接调各层句柄（按轨道升序），不等 React 渲染；
    // 随后同一帧的 onTick 会在 t=0 上重新选段。
    onLoop: () => {
      for (const track of visibleTracks) layerRefs.current.get(track.id)?.restart()
    }
  })

  useEffect(() => {
    onHandle?.({
      seekTime: handle.seekTime,
      seekFrame: handle.seekFrame,
      currentFrame: handle.currentFrame,
      totalFrames: handle.totalFrames
    })
  }, [handle, onHandle])

  /**
   * 媒体原声只接**当前出声的那一路**：增益图与分析节点都挂在这一路，
   * 时间轴频谱条读到的就是它。切段时图层会先把旧路 gain 归零，再通知新路。
   */
  useEffect(() => {
    if (!audioRoute) {
      setLiveClipId(null)
      setPreviewLevelReader(null)
      return
    }
    const { element, clip } = audioRoute
    attachPreviewAudio(element, 0)
    setLiveClipId(clip.id)
    setPreviewLevelReader(elementLevelReader(element))
    return () => {
      setLiveClipId(null)
      setPreviewLevelReader(null)
    }
  }, [audioRoute, setLiveClipId])

  /**
   * 点击预览选中片段：先按「显示矩形 → 目标分辨率」换算成原生像素，
   * 再交给与绘制同口径的命中测试（只认当前真正可见的像素）。
   * 点空白处不做任何事（避免误取消选中，用户还要在右侧调参数）。
   */
  const pickClipAt = (event: ReactMouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current
    if (!canvas || !spec) return
    const point = displayToNative(
      event,
      canvas.getBoundingClientRect(),
      { width: spec.width, height: spec.height }
    )
    if (!point) return
    const hit = hitTestClips(spec, handle.currentFrame(), point)
    if (hit) selectClip(hit)
  }

  return (
    <div className="stage__canvas-wrap" ref={wrapRef}>
      {/* 画面框：唯一与目标分辨率同比例的矩形，里面所有层共用同一原点与缩放比 */}
      <div
        className={`stage__frame stage__frame--${previewFit === 'cover' ? 'cover' : 'contain'}`}
        style={frameStyle}
      >
        {/* 每层一条可见媒体轨，按轨道升序渲染：DOM 顺序 = 合成顺序，高处轨道盖住低处 */}
        {layerGroups.map((group) => (
          <MediaPreviewLayer
            key={group.trackId}
            ref={layerRefFor(group.trackId)}
            candidates={group.candidates}
            fps={projectFps}
            loopDurationSec={loopDurationSec}
            audioEnabled={group.trackId === audioOwnerTrackId}
            transitionResolver={transitionResolverFor(group.trackId)}
            onVisibleChange={(visible) => handleVisibleChange(group.trackId, visible)}
            onAudioChange={(element, clip) => handleAudioChange(group.trackId, element, clip)}
            onFailure={handleFailure}
          />
        ))}

        <canvas
          ref={canvasRef}
          className="stage__canvas"
          aria-label="字幕条预览"
          style={{ cursor: 'pointer' }}
          onClick={pickClipAt}
          title={TEXT.preview.pickHint}
        />

        {/* 水印合成层：与导出同一套几何换算，叠在字幕条之上（与滤镜链顺序一致） */}
        {watermarkStyle ? (
          <img className="stage__watermark" src={watermarkUrl ?? undefined} alt="" style={watermarkStyle} draggable={false} />
        ) : null}

        {/* 变换交互层：四角缩放 / 画面内平移 / 顶部旋转，与面板滑杆同源 */}
        {overlayClip && frame ? (
          <StageTransformOverlay
            clip={overlayClip}
            video={overlayClip.video ?? defaultMediaVideo()}
            frame={{ width: frame.width, height: frame.height }}
          />
        ) : null}

        <div className="stage__badges">
          {spec ? (
            <span className="chip mono">
              {spec.width}×{spec.height} · {fpsToString(spec.fps)} · {MODE_LABEL[spec.aspectMode] ?? spec.aspectMode}
            </span>
          ) : null}
          {previewCanvasKind ? (
            <span className="chip chip--ok">
              目标画布 {previewCanvasKind === 'portrait' ? '9:16' : previewCanvasKind === 'square' ? '1:1' : '16:9'}
            </span>
          ) : null}
          {mediaVisibleReady ? <span className="chip chip--ok">媒体叠加</span> : null}
          {watermarkStyle ? <span className="chip chip--ok">水印叠加</span> : null}
          {failedClipIds.size > 0 ? <span className="chip chip--warn">参考视频不可预览</span> : null}
        </div>
      </div>

      {spec === null ? <div className="overlay-loading">正在准备渲染引擎…</div> : <FontLoadingOverlay />}
      <AudioBed clips={audioClips} media={mediaPool} atSec={Math.max(0, displayTime)} playing={playing} />
    </div>
  )
}

/** 音频源的解析结果缓存（按 mediaId；换源时由调用方清空不了，靠路径变化自然失效） */
const audioUrlCache = new Map<string, string | null>()

interface AudioBedProps {
  clips: AudioClip[]
  media: MediaItem[]
  atSec: number
  playing: boolean
}

/**
 * 音频轨试听（v7.1 + v9）：播放头处的**每一段**音频各挂一个 `<audio>`，
 * 浏览器会把它们自然混在一起——这就是预览侧「多段音频混合」的实现，
 * 不需要自己搭混音图。
 *
 * 同步策略：暂停时精确 seek；播放时只纠正 >0.35s 的漂移，否则每帧写 currentTime 会卡顿。
 * v9：每段自带音量/渐变/倍速（与媒体段、导出同一套 `shared/mediaClipAudio` 函数）。
 */
function AudioBed({ clips, media, atSec, playing }: AudioBedProps): ReactElement {
  const [urls, setUrls] = useState<Record<string, string | null>>({})
  const refs = useRef(new Map<string, HTMLAudioElement>())

  useEffect(() => {
    let cancelled = false
    const ids = [...new Set(clips.map((clip) => clip.mediaId))]
    if (ids.length === 0) return
    void Promise.all(
      ids.map(async (id) => {
        if (audioUrlCache.has(id)) return [id, audioUrlCache.get(id) ?? null] as const
        const item = media.find((m) => m.id === id)
        // 测试环境没有 preload 注入：拿不到协议地址就当“暂不可试听”，不能抛未处理拒绝
        const api = item ? window.focusnews?.video : null
        const url = api ? await api.previewUrl(item!.path).catch(() => null) : null
        audioUrlCache.set(id, url)
        return [id, url] as const
      })
    ).then((entries) => {
      if (!cancelled) setUrls(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [clips, media])

  const active = activeAudioClips(clips, atSec)

  useEffect(() => {
    for (const clip of active) {
      const element = refs.current.get(clip.id)
      if (!element) continue
      const speed = previewPlaybackRate(clip.speed)
      if (Math.abs(element.playbackRate - speed) > 1e-3) element.playbackRate = speed
      setPreservesPitch(element, previewPreservesPitch(clip.speed))
      const outLen = clipTimelineDurationSec(clip)
      setElementLevel(element, previewGainAt(clip.audio, atSec - clip.timelineStartSec, outLen))
      const target = Math.max(0, sourceTimeAt(clip, atSec))
      if (playing) {
        if (Math.abs(element.currentTime - target) > 0.35) element.currentTime = target
        if (element.paused) void element.play().catch(() => undefined)
      } else {
        element.pause()
        if (Math.abs(element.currentTime - target) > 0.05) element.currentTime = target
      }
    }
    for (const [id, element] of refs.current) {
      if (!active.some((clip) => clip.id === id)) element.pause()
    }
  }, [active, atSec, playing])

  return (
    <>
      {active.map((clip) => (
        <audio
          key={clip.id}
          ref={(element) => {
            if (element) refs.current.set(clip.id, element)
            else refs.current.delete(clip.id)
          }}
          src={urls[clip.mediaId] ?? undefined}
          preload="auto"
          hidden
        />
      ))}
    </>
  )
}
