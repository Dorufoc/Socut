import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import type { RenderJobSpec } from '@shared/types'
import { usePreviewLoop } from '../hooks/usePreviewLoop'
import { displayToNative, hitTestClips } from '../render/hitTest'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { FontLoadingOverlay } from '../dialog/FontLoadingOverlay'

/**
 * 预览舞台（规格 §4.3）：
 * 显示 Canvas 只承担等比缩放显示，尺寸与 CSS 缩放都不参与渲染坐标计算，
 * 真正的像素由 NativeStage（目标分辨率 1:1）产出，因此预览与导出像素一致。
 *
 * 参考视频叠加：有参考视频时，下层放一个静音的 <video>（focusnews-media:// 流，
 * 带 Range 支持），上层 Canvas 改画透明底的字幕条，两者按同一「等比装入」矩形对齐，
 * 于是预览看到的就是导出 MP4 的叠加结果。视频解码失败（如 ProRes）时回退棋盘格。
 */

type RefVideoState = 'idle' | 'loading' | 'ready' | 'failed'

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
  const refVideoPath = useProjectStore((state) => state.project.refVideo?.path ?? null)

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoState, setVideoState] = useState<RefVideoState>('idle')

  // 路径 → 可流式播放的自定义协议地址（主进程校验存在与扩展名后才放行）
  useEffect(() => {
    let cancelled = false
    setVideoUrl(null)
    setVideoState(refVideoPath ? 'loading' : 'idle')
    if (!refVideoPath) return
    void window.focusnews.video
      .previewUrl(refVideoPath)
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
  }, [refVideoPath])

  const videoReady = videoState === 'ready'

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

  // 时间对齐：暂停时精确吸附；播放中只在漂移超过阈值时纠正（频繁 seek 会让视频卡顿）
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady) return
    const target = Math.max(0, displayTime)
    const drift = Math.abs(video.currentTime - target)
    if (drift <= (playing ? 0.25 : 0.04)) return
    const duration = Number.isFinite(video.duration) ? video.duration : target
    try {
      video.currentTime = Math.min(target, Math.max(0, duration - 0.001))
    } catch {
      // 元数据尚未就绪时忽略，loadedmetadata 会再对齐一次
    }
  }, [displayTime, playing, videoReady])

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
    <div className="stage__canvas-wrap">
      {videoUrl ? (
        <video
          ref={videoRef}
          className={`stage__ref-video${videoReady ? ' stage__ref-video--ready' : ''}`}
          src={videoUrl}
          muted
          playsInline
          preload="auto"
          aria-label="参考视频预览"
          onLoadedMetadata={() => {
            const video = videoRef.current
            if (video) {
              const state = useUiStore.getState()
              video.currentTime = Math.max(0, state.displayTimeSec)
              if (!state.playing) video.pause()
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

      {spec === null ? <div className="overlay-loading">正在准备渲染引擎…</div> : <FontLoadingOverlay />}

      <div className="stage__badges">
        {spec ? (
          <span className="chip mono">
            {spec.width}×{spec.height} · {spec.fps.num}/{spec.fps.den} · {spec.aspectMode}
          </span>
        ) : null}
        {videoReady ? <span className="chip chip--ok">参考视频叠加</span> : null}
        {videoState === 'failed' ? <span className="chip chip--warn">参考视频无法预览（编码不受支持）</span> : null}
      </div>

      <div className="stage__hint">{TEXT.preview.pickHint}</div>
    </div>
  )
}
