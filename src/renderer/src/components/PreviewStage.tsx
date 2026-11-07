import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { fpsToString } from '@shared/constants'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import { topActiveMediaClip } from '@shared/mediaClips'
import { activeAudioClips, mediaKindOf } from '@shared/audioClips'
import { clipTimelineDurationSec, previewGainAt, previewPlaybackRate, previewPreservesPitch, sourceTimeAt } from '@shared/mediaClipAudio'
import { attachPreviewAudio, elementLevelReader, setElementLevel, setPreservesPitch } from '../audio/previewAudioGraph'
import { setPreviewLevelReader } from '../audio/previewLevel'
import { computeWatermarkGeometry } from '@shared/ffmpegArgs'
import type { AudioClip, MediaClip, MediaItem, RenderJobSpec } from '@shared/types'
import { usePreviewLoop } from '../hooks/usePreviewLoop'
import { containFrameRect, displayToNative, hitTestClips } from '../render/hitTest'
import { selectPreviewCandidates, type PreviewCandidate } from '../render/previewCandidates'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { stabSignatureFor, useStabPreviewStore } from '../state/stabPreviewStore'
import { FontLoadingOverlay } from '../dialog/FontLoadingOverlay'
import { MediaPreviewLayer, type MediaPreviewHandle } from './MediaPreviewLayer'
import { StageTransformOverlay } from './StageTransformOverlay'

/**
 * 预览舞台（规格 §4.3）：
 * 显示 Canvas 只承担等比缩放显示，尺寸与 CSS 缩放都不参与渲染坐标计算，
 * 真正的像素由 NativeStage（目标分辨率 1:1）产出，因此预览与导出像素一致。
 *
 * 参考视频叠加（v2 双轨）：播放头落在哪枚 mediaClip 上，<video> 就换成它的源文件
 *（focusnews-media:// 流，带 Range 支持），currentTime 按 sourceTimeOf 换算；
 * 落在段间空隙则回到棋盘格。上层 Canvas 改画透明底字幕条，两者按同一「等比装入」
 * 矩形对齐，于是预览看到的就是导出 MP4 的叠加结果。视频解码失败（如 ProRes）时回退棋盘格。
 *
 * 水印（Watermark）：同一套装入矩形里再按原生像素定位一张图，位置/尺寸与导出
 * 共用 `computeWatermarkGeometry`（1080P 基准 → 原图 32% → 左上角 30px），
 * 不进 Canvas——Canvas 的像素就是导出的透明字幕层，水印属于合成层，不能烘进去。
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const layerRef = useRef<MediaPreviewHandle | null>(null)
  const playing = useUiStore((state) => state.playing)
  const setLiveClipId = useUiStore((state) => state.setLiveClipId)
  const showSafeArea = useUiStore((state) => state.showSafeArea)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  /** P4：预览轴的悬停帧。非空时画面（Canvas 层与参考视频）改跟这一帧，蓝线/时间码仍走 displayTime */
  const hoverPreviewSec = useUiStore((state) => state.hoverPreviewSec)
  const previewTime = hoverPreviewSec ?? displayTime
  const setDisplayTime = useUiStore((state) => state.setDisplayTime)
  const selectClip = useProjectStore((state) => state.selectClip)
  const mediaClips = useProjectStore((state) => state.project.mediaClips)
  const mediaPool = useProjectStore((state) => state.project.media)
  // @deprecated v1 兼容：冒烟取证脚本直接写 refVideo，没有 mediaClips 时仍按旧路取源
  const legacyRefPath = useProjectStore((state) => state.project.refVideo?.path ?? null)
  const legacyHasAudio = useProjectStore((state) => state.project.refVideo?.meta.audioCodec != null)
  const watermark = useProjectStore((state) => state.project.watermark)

  const projectFps = useProjectStore((state) => state.project.fps)
  const stabApplied = useStabPreviewStore((state) => state.applied)

  /**
   * 预览候选池：当前图层 + 刚结束的兜底段 + 前瞻窗口内的下一段。
   * 路径在这里就解析成原片/防抖代理，DOM 层只负责挂载与同步。
   */
  const candidates = useMemo((): PreviewCandidate[] => {
    const out: PreviewCandidate[] = []
    for (const clip of selectPreviewCandidates(mediaClips, Math.max(0, previewTime))) {
      const item = mediaPool.find((media) => media.id === clip.mediaId)
      if (!item) continue
      const kind = mediaKindOf(item)
      if (kind === 'audio') continue
      const hasAudio = typeof item.meta.audioCodec === 'string' && item.meta.audioCodec.length > 0
      let sourcePath = item.path
      let useStabProxy = false
      if (clip.stab?.enabled) {
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
        sourceOutSec: 1e12
      }
      out.push({ clip, kind: 'video', hasAudio: legacyHasAudio, sourcePath: legacyRefPath, useStabProxy: false })
    }
    return out
  }, [mediaClips, mediaPool, previewTime, stabApplied, projectFps, legacyRefPath, legacyHasAudio])

  const [mediaVisibleReady, setMediaVisibleReady] = useState(false)
  /** 同一份可见性同时写进 ref：usePreviewLoop 在同一帧的 blit 里读它 */
  const mediaVisibleRef = useRef(false)
  const [failedClipIds, setFailedClipIds] = useState<ReadonlySet<string>>(() => new Set())
  const [audioRoute, setAudioRoute] = useState<{ element: HTMLVideoElement; clip: MediaClip } | null>(null)

  const handleVisibleChange = useCallback((visible: boolean): void => {
    mediaVisibleRef.current = visible
    setMediaVisibleReady(visible)
  }, [])

  const handleAudioChange = useCallback((element: HTMLVideoElement | null, clip: MediaClip | null): void => {
    setAudioRoute(element && clip ? { element, clip } : null)
  }, [])

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
  const playheadClip = useMemo(() => topActiveMediaClip(mediaClips, Math.max(0, displayTime)) ?? null, [mediaClips, displayTime])
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
    overrideSec: hoverPreviewSec,
    onDisplayTime: setDisplayTime,
    onTick: (timelineSec, isPlaying) => {
      // 悬停时按静态帧预览：媒体层暂停在悬停帧，不跟着播放时钟跑
      layerRef.current?.tick(timelineSec, isPlaying && hoverPreviewSec === null)
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
      <div className="stage__frame" style={frameStyle}>
        <MediaPreviewLayer
          ref={layerRef}
          candidates={candidates}
          fps={projectFps}
          onVisibleChange={handleVisibleChange}
          onAudioChange={handleAudioChange}
          onFailure={handleFailure}
        />

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
