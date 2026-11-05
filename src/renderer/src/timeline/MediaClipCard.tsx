import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { isStripTap, stripTimeAtFraction, stripFallbackLabel } from '@shared/mediaStrip'
import { clipTimelineDurationSec } from '@shared/mediaClipAudio'
import { spectrumBarHeights } from '@shared/audioPeaks'
import { secondsToTimecode } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import type { Fps, MediaClip, MediaItem } from '@shared/types'
import { secToPx } from './ruler'
import { useMediaStrip } from './useMediaStrips'
import { useMediaSpectrum } from './useMediaPeaks'
import { useSpectrumLive } from './useSpectrumLive'

/**
 * 媒体轨片段卡片（v2 阶段 4）+ 时间帧预览条（v5）。
 *
 * 与字幕条卡片的区别：拖入/出点时时间轴与源坐标**同幅度**平移（时长恒等式由 store 保证），
 * 整段拖动遵循「仅重叠才右移后续片段」规则（store.moveMediaClip 内联对齐）。
 *
 * 预览条（Thumbnail Strip）：
 * - 卡片底图换成主进程一次抽帧拼好的**长图**（横向无缝，覆盖整个源区间），
 *   由 CSS 拉满卡片宽度 → 每格覆盖的时间 = 片段时长 / 格数；
 * - 悬停显示指针处的时间读数（源坐标），点击该处即 seek 到对应的时间轴帧；
 * - **不影响原有交互**：拖拽判定仍是 pointerdown/pointermove/pointerup 那一条路径，
 *   只有「按下与抬起之间几乎没移动」（≤ STRIP_CLICK_SLOP_PX）才当作"点一格"，
 *   拖入出点、整段平移、手柄区域的行为与之前完全一致；
 * - 读数与位置用**命令式**更新（不走 React 状态），指针移动不会逐帧重渲染整条时间轴。
 *
 * 频谱条（v9）：卡片**底部 1/3** 是一条音频幅度条（等分柱 + 蓝→青渐变）。
 * - 数据由主进程一次 FFmpeg 取样得到（见 shared/audioPeaks），素材无音轨 / 图像素材 / 取样失败 → 不画；
 * - 柱高 = 提取到的幅度 × 当前音量 × 淡入淡出包络，所以面板上拉音量、拖渐变都能立刻在条上读出来；
 * - 播放时由 `useSpectrumLive` 写一个 CSS 变量做实时起伏（不走 React 状态）；
 * - `pointer-events: none` + 只占底部三分之一，不遮挡预览条读数、不入出点手柄，更不进字幕轨。
 */

export interface MediaClipCardProps {
  clip: MediaClip
  item: MediaItem | null
  durationSec: number
  widthPx: number
  fps: Fps
  selected: boolean
  onSelect: (id: string) => void
  onMove: (timelineStartSec: number) => void
  onTrim: (patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  /** 点击预览条某处：seek 到该时间轴位置（吸附到帧边界后交给上层） */
  onSeek: (timelineSec: number) => void
  /** 一次拖拽结束时回调（上层用它做「主轨对齐」重排；不传则什么都不做） */
  onCommit?: () => void
  /** v7：本条轨道的叠放层数（>1 时按层号切分高度，叠层可见） */
  layers?: number
}

type Edge = 'in' | 'out' | 'move'

interface DragState {
  edge: Edge
  pointerX: number
  start: number
  end: number
}

export function MediaClipCard({
  clip,
  item,
  durationSec,
  widthPx,
  fps,
  selected,
  onSelect,
  onMove,
  onTrim,
  onSeek,
  onCommit,
  layers = 1
}: MediaClipCardProps): ReactElement {
  const dragRef = useRef<DragState | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hintRef = useRef<HTMLSpanElement | null>(null)
  const spectrumRef = useRef<HTMLDivElement | null>(null)
  const [hovering, setHovering] = useState(false)

  const strip = useMediaStrip({ clip, item, widthPx, fps })
  const spectrum = useMediaSpectrum({ clip, item, widthPx })
  // 柱高把音频参数算进去：拖动音量/渐变滑杆时条子当场变形（预览即反馈）
  const bars = spectrumBarHeights(spectrum.peaks, clip.audio, clipTimelineDurationSec(clip))
  useSpectrumLive(spectrumRef, clip.id, bars.length > 0)

  const left = secToPx(clip.timelineStartSec, durationSec, widthPx)
  const right = secToPx(clip.timelineEndSec, durationSec, widthPx)
  const name = item?.name ?? '（素材已移出）'

  /** 指针位置 → 时间（源坐标给 tooltip，时间轴坐标给 seek） */
  const timeAt = (clientX: number): { sourceSec: number; timelineSec: number } | null => {
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return null
    return stripTimeAtFraction({
      fraction: (clientX - rect.left) / rect.width,
      sourceInSec: clip.sourceInSec,
      sourceOutSec: clip.sourceOutSec,
      timelineStartSec: clip.timelineStartSec,
      fps
    })
  }

  /** 命令式刷新读数：位置贴指针，文本给「时间轴 + 源」两个坐标 */
  const paintHint = (clientX: number): void => {
    const hint = hintRef.current
    const card = cardRef.current
    if (!hint || !card) return
    const at = timeAt(clientX)
    if (!at) {
      hint.textContent = ''
      return
    }
    const rect = card.getBoundingClientRect()
    const innerWidth = Math.max(1, rect.width)
    hint.textContent = `${secondsToTimecode(at.timelineSec, fps)} · 源 ${secondsToTimecode(at.sourceSec, fps)}`
    hint.style.left = `${Math.min(Math.max(0, clientX - rect.left - innerWidth * 0.22), Math.max(0, innerWidth - 96))}px`
  }

  const begin = (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    onSelect(clip.id)
    dragRef.current = { edge, pointerX: event.clientX, start: clip.timelineStartSec, end: clip.timelineEndSec }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) {
      // 只是悬停：刷新读数，不触发任何状态写入
      if (event.pointerType !== 'mouse' || event.buttons !== 0) return
      paintHint(event.clientX)
      return
    }
    // 拖拽中：读数没有意义（位置正在变），收起
    setHovering((previous) => (previous ? false : previous))
    const deltaSec = ((event.clientX - drag.pointerX) / Math.max(1, widthPx)) * durationSec
    if (drag.edge === 'move') {
      const length = drag.end - drag.start
      let start = snapTimeToFrame(Math.max(0, drag.start + deltaSec), fps)
      if (start + length > durationSec) start = snapTimeToFrame(durationSec - length, fps)
      onMove(start)
      return
    }
    if (drag.edge === 'in') {
      const candidate = snapTimeToFrame(Math.min(drag.end - MIN_MEDIA_CLIP_SEC, Math.max(0, drag.start + deltaSec)), fps)
      if (candidate !== drag.start) onTrim({ timelineStartSec: candidate })
      return
    }
    const candidate = snapTimeToFrame(
      Math.max(drag.start + MIN_MEDIA_CLIP_SEC, Math.min(durationSec, drag.end + deltaSec)),
      fps
    )
    if (candidate !== drag.end) onTrim({ timelineEndSec: candidate })
  }

  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // 拖拽收尾：先让上层把「主轨对齐」重排跑完，再判是否算一次点击
    onCommit?.()
    // 只有「整段那一按」且几乎没位移，才当作点一格跳转；手柄区域走不到这里
    if (drag.edge !== 'move' || !isStripTap(event.clientX - drag.pointerX)) return
    const at = timeAt(event.clientX)
    if (at) onSeek(at.timelineSec)
  }

  const stripReady = strip.status === 'ready' && strip.url !== null
  const fallbackLabel = stripFallbackLabel({ mediaMissing: item === null, status: strip.status })

  return (
    <div
      ref={cardRef}
      className={`media-clip-card${selected ? ' media-clip-card--selected' : ''}${item ? '' : ' media-clip-card--orphan'}${
        stripReady ? ' media-clip-card--strip' : ''
      }${layers > 1 ? ' media-clip-card--layered' : ''}${bars.length > 0 ? ' media-clip-card--spectrum' : ''}`}
      style={{
        left,
        width: Math.max(24, right - left),
        // v7 多层：单层时完全交给 CSS（与旧行为一致），多层时按层号切分高度
        ...(layers > 1
          ? {
              top: `${((clip.layer ?? 0) * 100) / layers}%`,
              height: `calc(${100 / layers}% - 4px)`
            }
          : {})
      }}
      onPointerDown={begin('move')}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return
        setHovering(true)
        paintHint(event.clientX)
      }}
      onPointerLeave={() => setHovering(false)}
      title={`${name} · 源 ${clip.sourceInSec.toFixed(2)}→${clip.sourceOutSec.toFixed(2)}s`}
    >
      {stripReady ? (
        <img className="media-clip-card__strip" src={strip.url ?? undefined} alt="" draggable={false} aria-hidden="true" />
      ) : (
        <>
          {/* 预览条还没好时，单帧缩略图可以垫个底；但占位说明一定显示，
              不能让用户误以为这一条已经是完整预览 */}
          {item?.thumbnailUrl ? (
            <img
              className="media-clip-card__thumb"
              src={item.thumbnailUrl}
              alt=""
              draggable={false}
              aria-hidden="true"
            />
          ) : null}
          <div className="media-clip-card__fallback">
            <span className="media-clip-card__fallback-glyph" aria-hidden="true">
              ▦
            </span>
            <span className="media-clip-card__fallback-text">{fallbackLabel}</span>
          </div>
        </>
      )}
      {/* 文字压在半透明衬底上，预览条再花也不影响读素材名与源入出点 */}
      <div className="media-clip-card__label">
        <div className="media-clip-card__title">{name}</div>
        <div className="media-clip-card__meta mono">
          源 {clip.sourceInSec.toFixed(2)}→{clip.sourceOutSec.toFixed(2)}s
        </div>
      </div>
      <span
        ref={hintRef}
        className={`media-clip-card__hint${hovering && stripReady ? ' media-clip-card__hint--visible' : ''}`}
        aria-hidden="true"
      />
      {/* 频谱条：底部 1/3，不碰手柄区与文字行（见文件头纪律说明） */}
      {bars.length > 0 ? (
        <div ref={spectrumRef} className="media-clip-card__spectrum" data-bars={bars.length} aria-hidden="true">
          {bars.map((height, index) => (
            <span key={index} className="media-clip-card__spectrum-bar" style={{ height: `${Math.max(4, Math.round(height * 100))}%` }} />
          ))}
        </div>
      ) : null}
      <div
        className="media-clip-card__handle media-clip-card__handle--left"
        title={TEXT.timeline.inPoint}
        onPointerDown={begin('in')}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className="media-clip-card__handle media-clip-card__handle--right"
        title={TEXT.timeline.outPoint}
        onPointerDown={begin('out')}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}
