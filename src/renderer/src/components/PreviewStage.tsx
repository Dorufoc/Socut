import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { fpsToString } from '@shared/constants'
import { MEDIA_GRADE_FILTER_ID, curveTableValues, mediaVideoFilter, mediaVideoTransform, needsChannelTable } from '@shared/mediaClipVideo'
import { sourceTimeOf } from '@shared/mediaClips'
import { computeWatermarkGeometry } from '@shared/ffmpegArgs'
import type { RenderJobSpec } from '@shared/types'
import { usePreviewLoop } from '../hooks/usePreviewLoop'
import { containFrameRect, displayToNative, hitTestClips } from '../render/hitTest'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { FontLoadingOverlay } from '../dialog/FontLoadingOverlay'

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

/** 宽高比分支的内部枚举不直接上界面，换成两个字的人话。 */
const MODE_LABEL: Record<string, string> = { standard: '标准', compact: '紧凑', ultrawide: '超宽' }

export interface PreviewStageProps {
  spec: RenderJobSpec | null
  /** 播放头跳转句柄由上层持有（时间轴点击定位用） */
  onHandle?: (handle: { seekTime: (sec: number) => void; seekFrame: (f: number) => void }) => void
}

export function PreviewStage({ spec, onHandle }: PreviewStageProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const playing = useUiStore((state) => state.playing)
  const showSafeArea = useUiStore((state) => state.showSafeArea)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const setDisplayTime = useUiStore((state) => state.setDisplayTime)
  const selectClip = useProjectStore((state) => state.selectClip)
  const mediaClips = useProjectStore((state) => state.project.mediaClips)
  const mediaPool = useProjectStore((state) => state.project.media)
  // @deprecated v1 兼容：冒烟取证脚本直接写 refVideo，没有 mediaClips 时仍按旧路取源
  const legacyRefPath = useProjectStore((state) => state.project.refVideo?.path ?? null)
  const watermark = useProjectStore((state) => state.project.watermark)

  /** 播放头落在哪枚素材上（含源坐标）；段间空隙/空轨为 null。 */
  const mediaSource = useMemo(() => {
    if (mediaClips.length > 0) {
      const at = sourceTimeOf(mediaClips, Math.max(0, displayTime))
      if (!at) return null
      const item = mediaPool.find((m) => m.id === at.clip.mediaId)
      if (!item) return null
      return { mediaId: item.id, path: item.path, sourceSec: at.sourceSec, clip: at.clip }
    }
    if (legacyRefPath) {
      return { mediaId: 'legacy-ref', path: legacyRefPath, sourceSec: Math.max(0, displayTime), clip: null }
    }
    return null
  }, [mediaClips, mediaPool, legacyRefPath, displayTime])

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoState, setVideoState] = useState<RefVideoState>('idle')

  // 源文件变化才重新申请可流式播放地址（主进程校验存在与扩展名后才放行）
  const sourcePath = mediaSource?.path ?? null
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
    onDisplayTime: setDisplayTime
  })

  useEffect(() => {
    onHandle?.({ seekTime: handle.seekTime, seekFrame: handle.seekFrame })
  }, [handle, onHandle])

  // 播放/暂停跟随预览时钟
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady) return
    if (playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [playing, videoReady])

  // 时间对齐：目标始终是「本段源坐标」；暂停时精确吸附，播放中只在漂移超过阈值时纠正
  const sourceSec = mediaSource?.sourceSec ?? null
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady || sourceSec === null) return
    const target = sourceSec
    const drift = Math.abs(video.currentTime - target)
    if (drift <= (playing ? 0.25 : 0.04)) return
    const duration = Number.isFinite(video.duration) ? video.duration : target
    try {
      video.currentTime = Math.min(target, Math.max(0, duration - 0.001))
    } catch {
      // 元数据尚未就绪时忽略，loadedmetadata 会再对齐一次
    }
  }, [sourceSec, playing, videoReady])

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
        {videoUrl ? (
          <video
            ref={videoRef}
            className={`stage__ref-video${videoReady ? ' stage__ref-video--ready' : ''}`}
            src={videoUrl}
            style={videoStyle}
            muted
            playsInline
            preload="auto"
            aria-label="参考视频预览"
            onLoadedMetadata={() => {
              const video = videoRef.current
              if (video) {
                const store = useUiStore.getState()
                const at = sourceTimeOf(useProjectStore.getState().project.mediaClips, Math.max(0, store.displayTimeSec))
                video.currentTime = Math.max(0, at?.sourceSec ?? store.displayTimeSec)
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
    </div>
  )
}
