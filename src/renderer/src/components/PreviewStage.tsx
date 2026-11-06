import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { fpsToString } from '@shared/constants'
import { MEDIA_GRADE_FILTER_ID, curveTableValues, defaultMediaVideo, mediaVideoFilter, mediaVideoTransform, needsChannelTable } from '@shared/mediaClipVideo'
import { frameIntervalSec } from '@shared/fps'
import { sourceTimeOf, topActiveMediaClip } from '@shared/mediaClips'
import { stabProxyTimeOf } from '@shared/mediaStab'
import { activeAudioClips, mediaKindOf } from '@shared/audioClips'
import { clipTimelineDurationSec, previewGainAt, previewPlaybackRate, previewPreservesPitch, sourceTimeAt } from '@shared/mediaClipAudio'
import { attachPreviewAudio, elementLevelReader, setElementLevel, setPreservesPitch } from '../audio/previewAudioGraph'
import { setPreviewLevelReader } from '../audio/previewLevel'
import { computeWatermarkGeometry } from '@shared/ffmpegArgs'
import type { AudioClip, MediaItem, RenderJobSpec } from '@shared/types'
import { usePreviewLoop } from '../hooks/usePreviewLoop'
import { containFrameRect, displayToNative, hitTestClips } from '../render/hitTest'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { stabSignatureFor, useStabPreviewStore } from '../state/stabPreviewStore'
import { FontLoadingOverlay } from '../dialog/FontLoadingOverlay'
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

type RefVideoState = 'idle' | 'loading' | 'ready' | 'failed'

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
  const videoRef = useRef<HTMLVideoElement | null>(null)
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

  /** 预览时间落在哪枚素材上（含源坐标）；多层时取**最上层**，段间空隙/空轨为 null。 */
  const mediaSource = useMemo(() => {
    if (mediaClips.length > 0) {
      const at = topActiveMediaClip(mediaClips, Math.max(0, previewTime))
      if (!at) return null
      const item = mediaPool.find((m) => m.id === at.mediaId)
      if (!item) return null
      return {
        mediaId: item.id,
        path: item.path,
        // v9：时间轴 1s 吃掉 speed 秒源内容（1x 时与旧写法逐字节一致）
        sourceSec: sourceTimeAt(at, Math.max(0, previewTime)),
        clip: at,
        kind: mediaKindOf(item),
        hasAudio: typeof item.meta.audioCodec === 'string' && item.meta.audioCodec.length > 0
      }
    }
    if (legacyRefPath) {
      return {
        mediaId: 'legacy-ref',
        path: legacyRefPath,
        sourceSec: Math.max(0, previewTime),
        clip: null,
        kind: 'video' as const,
        hasAudio: legacyHasAudio
      }
    }
    return null
  }, [mediaClips, mediaPool, legacyRefPath, legacyHasAudio, previewTime])

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoState, setVideoState] = useState<RefVideoState>('idle')

  /**
   * v8.1：防抖预览代理——当前片段有「签名仍新鲜」的已就绪代理时，换播稳定化后的代理文件；
   * 否则（未应用/生成中/参数已改）继续播原片。代理内容 = 源区间 1:1，
   * 目标时间改用 stabProxyTimeOf 换成代理坐标（减法口径只在 shared/mediaStab 里定义）。
   */
  const projectFps = useProjectStore((state) => state.project.fps)
  const stabApplied = useStabPreviewStore((state) => (mediaSource?.clip ? state.applied[mediaSource.clip.id] : undefined))
  const stabProxyPath = useMemo(() => {
    if (!mediaSource?.clip?.stab?.enabled) return null
    const applied = stabApplied
    if (!applied || !applied.path) return null
    const signature = stabSignatureFor({
      clip: mediaSource.clip,
      stab: mediaSource.clip.stab,
      sourcePath: mediaSource.path,
      fps: projectFps,
      hasAudio: mediaSource.hasAudio
    })
    return applied.signature === signature ? applied.path : null
  }, [mediaSource, stabApplied, projectFps])
  const useStabProxy = stabProxyPath !== null

  // 源文件变化才重新申请可流式播放地址（主进程校验存在与扩展名后才放行）
  const sourcePath = (useStabProxy ? stabProxyPath : mediaSource?.path) ?? null
  useEffect(() => {
    let cancelled = false
    setVideoUrl(null)
    setVideoState(sourcePath ? 'loading' : 'idle')
    if (!sourcePath) return
    void window.focusnews.video
      .previewUrl(sourcePath)
      .then((url) => {
        if (cancelled) return
        if (url) setVideoUrl(url)
        else setVideoState('failed')
      })
      .catch(() => {
        if (!cancelled) setVideoState('failed')
      })
    return () => {
      cancelled = true
    }
  }, [sourcePath])

  const videoReady = videoState === 'ready'

  /**
   * 当前播放头所在媒体段的画面编辑（v6）：几何变换走 CSS transform、调色走 CSS filter，
   * 曲线/曝光/冷暖走 SVG 曲线表。语义全部来自 shared/mediaClipVideo，导出层将来接同一条口径。
   */
  const videoEdit = mediaSource?.clip?.video
  const videoStyle = useMemo((): CSSProperties => {
    const transform = mediaVideoTransform(videoEdit)
    const filter = mediaVideoFilter(videoEdit)
    return { ...(transform !== 'none' ? { transform } : {}), ...(filter !== 'none' ? { filter } : {}) }
  }, [videoEdit])

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
    transparent: videoReady,
    overrideSec: hoverPreviewSec,
    onDisplayTime: setDisplayTime
  })

  useEffect(() => {
    onHandle?.({
      seekTime: handle.seekTime,
      seekFrame: handle.seekFrame,
      currentFrame: handle.currentFrame,
      totalFrames: handle.totalFrames
    })
  }, [handle, onHandle])

  // 播放/暂停跟随预览时钟
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady) return
    if (playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [playing, videoReady])

  // 时间对齐：目标始终是「本段源坐标」（播代理时是代理坐标）；暂停时精确吸附，播放中只在漂移超过阈值时纠正
  const sourceSec = mediaSource?.sourceSec ?? null
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady || sourceSec === null) return
    const clip = mediaSource?.clip
    const target =
      useStabProxy && clip?.stab?.enabled
        ? stabProxyTimeOf(sourceSec, clip.sourceInSec, clip.sourceOutSec)
        : sourceSec
    const drift = Math.abs(video.currentTime - target)
    // 播放中只在漂移超过 0.25s 时纠正；暂停时按「半帧」判定——
    // 键盘逐帧跳转的偏移正好是一帧，用固定的 0.04s 会在 25/30fps 下把这一帧当噪声放过，
    // 画面就不动了。小于半帧的残差是解码器自己的量化，再下 seek 也不会更好。
    if (drift <= (playing ? 0.25 : frameIntervalSec(projectFps) / 2)) return
    const duration = Number.isFinite(video.duration) ? video.duration : target
    try {
      video.currentTime = Math.min(target, Math.max(0, duration - 0.001))
    } catch {
      // 元数据尚未就绪时忽略，loadedmetadata 会再对齐一次
    }
  }, [sourceSec, playing, videoReady, useStabProxy, mediaSource, projectFps])

  /**
   * v9：媒体段原声的预览输出（音量 / 渐入渐出 / 变速）。
   *
   * 只在**播放时**出声（暂停就维持静音，跟旧行为一样不会“seek 一下乱响”），
   * 增益走 `shared/mediaClipAudio` 的同一个包络函数，所以面板拉渐变滑杆
   * 听到的斜边与导出 `afade` 的形状、时间轴频谱条的斜角是同一回事。
   */
  const sourceClip = mediaSource?.clip ?? null
  const audible = playing && mediaSource?.kind === 'video' && mediaSource.hasAudio
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!sourceClip) {
      setElementLevel(video, 1)
      return
    }
    const outLen = clipTimelineDurationSec(sourceClip)
    const local = Math.max(0, Math.min(outLen, Math.max(0, displayTime) - sourceClip.timelineStartSec))
    setElementLevel(video, previewGainAt(sourceClip.audio, local, outLen))
  }, [sourceClip, displayTime, audible])

  /** 倍速与音高：`playbackRate` + `preservesPitch`（与导出 `atempo`/`asetrate` 同一开关）。 */
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const speed = sourceClip?.speed
    const rate = previewPlaybackRate(speed)
    if (Math.abs(video.playbackRate - rate) > 1e-3) {
      video.playbackRate = rate
      video.defaultPlaybackRate = rate
    }
    setPreservesPitch(video, previewPreservesPitch(speed))
  }, [sourceClip, videoReady, playing])

  /**
   * 实时频谱：播放时把这一路接进增益图（分析节点顺带给出电平），
   * 并把「现在谁在出声」告知时间轴（只有那一条卡片会起伏）。
   */
  useEffect(() => {
    const video = videoRef.current
    const clipId = audible && sourceClip ? sourceClip.id : null
    if (audible && video) attachPreviewAudio(video)
    setLiveClipId(clipId)
    setPreviewLevelReader(clipId && video ? elementLevelReader(video) : null)
    return () => {
      setLiveClipId(null)
      setPreviewLevelReader(null)
    }
  }, [audible, sourceClip, setLiveClipId])

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
        {/* 曲线 / 曝光 / 冷暖的按通道查找表（与 CSS filter 的 url(#id) 同源） */}
        {videoEdit && needsChannelTable(videoEdit) ? (
          <svg className="stage__filters" aria-hidden="true" focusable="false">
            <defs>
              <filter id={MEDIA_GRADE_FILTER_ID} colorInterpolationFilters="sRGB">
                <feComponentTransfer>
                  <feFuncR type="table" tableValues={curveTableValues(videoEdit, 'r')} />
                  <feFuncG type="table" tableValues={curveTableValues(videoEdit, 'g')} />
                  <feFuncB type="table" tableValues={curveTableValues(videoEdit, 'b')} />
                </feComponentTransfer>
              </filter>
            </defs>
          </svg>
        ) : null}
        {videoUrl && mediaSource?.kind === 'image' ? (
          <img
            className={`stage__ref-video${videoReady ? ' stage__ref-video--ready' : ''}`}
            src={videoUrl}
            style={videoStyle}
            alt=""
            draggable={false}
            onLoad={() => setVideoState('ready')}
            onError={() => setVideoState('failed')}
          />
        ) : null}
        {videoUrl && mediaSource?.kind !== 'image' ? (
          <video
            ref={videoRef}
            className={`stage__ref-video${videoReady ? ' stage__ref-video--ready' : ''}`}
            src={videoUrl}
            style={videoStyle}
            muted={!audible}
            playsInline
            preload="auto"
            aria-label="参考视频预览"
            onLoadedMetadata={() => {
              const video = videoRef.current
              if (video) {
                const store = useUiStore.getState()
                const at = sourceTimeOf(useProjectStore.getState().project.mediaClips, Math.max(0, store.displayTimeSec))
                const sourceSec0 = Math.max(0, at?.sourceSec ?? store.displayTimeSec)
                // 本 <video> 的 src 就是代理（useStabProxy 已经签名校验）时才换成代理坐标
                const clip = mediaSource?.clip
                video.currentTime =
                  useStabProxy && clip?.stab?.enabled
                    ? stabProxyTimeOf(sourceSec0, clip.sourceInSec, clip.sourceOutSec)
                    : sourceSec0
                if (!store.playing) video.pause()
              }
              setVideoState('ready')
            }}
            onError={() => setVideoState('failed')}
          />
        ) : null}

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
          {videoReady ? <span className="chip chip--ok">媒体叠加</span> : null}
          {watermarkStyle ? <span className="chip chip--ok">水印叠加</span> : null}
          {videoState === 'failed' ? <span className="chip chip--warn">参考视频不可预览</span> : null}
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
