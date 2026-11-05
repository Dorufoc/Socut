import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { snapTimeToFrame } from '@shared/fps'
import { MIN_AUDIO_CLIP_SEC, normalizeLayer } from '@shared/audioClips'
import { secToPx } from './ruler'
import type { AudioClip, Fps, MediaItem } from '@shared/types'

/**
 * 音频轨上的片段卡（v7.1）。
 *
 * 与媒体段卡同一套拖拽手感（整段平移 / 拖入出点），但**不画缩略图**：
 * 音频没有画面，这里用「时长指示条」——底纹是等距竖条的波形示意，
 * 宽度即片段在时间轴上的占比，长度读数和名称放同一行。
 * 叠放层用 `top/height` 百分比切分，轨道被拖矮时各层等比压缩。
 */

export interface AudioClipCardProps {
  clip: AudioClip
  item: MediaItem | null
  durationSec: number
  widthPx: number
  fps: Fps
  selected: boolean
  /** 该轨道的叠放层数（>=1），用于把卡片高度切成 N 份 */
  layers: number
  onSelect: (id: string) => void
  onMove: (timelineStartSec: number) => void
  onTrim: (patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  onSeek: (timelineSec: number) => void
  onCommit?: () => void
}

type Edge = 'in' | 'out' | 'move'

interface DragState {
  edge: Edge
  pointerX: number
  start: number
  end: number
}

export function AudioClipCard({
  clip,
  item,
  durationSec,
  widthPx,
  fps,
  selected,
  layers,
  onSelect,
  onMove,
  onTrim,
  onSeek,
  onCommit
}: AudioClipCardProps): ReactElement {
  const dragRef = useRef<DragState | null>(null)
  const lane = Math.max(1, layers)
  const layer = Math.min(normalizeLayer(clip.layer), lane - 1)
  const left = secToPx(clip.timelineStartSec, durationSec, widthPx)
  const right = secToPx(clip.timelineEndSec, durationSec, widthPx)
  const name = item?.name ?? '（素材已移出）'

  const begin = (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    onSelect(clip.id)
    dragRef.current = { edge, pointerX: event.clientX, start: clip.timelineStartSec, end: clip.timelineEndSec }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const deltaSec = ((event.clientX - drag.pointerX) / Math.max(1, widthPx)) * durationSec
    if (drag.edge === 'move') {
      onMove(snapTimeToFrame(Math.max(0, drag.start + deltaSec), fps))
      return
    }
    if (drag.edge === 'in') {
      const candidate = snapTimeToFrame(Math.min(drag.end - MIN_AUDIO_CLIP_SEC, Math.max(0, drag.start + deltaSec)), fps)
      if (candidate !== drag.start) onTrim({ timelineStartSec: candidate })
      return
    }
    const candidate = snapTimeToFrame(Math.max(drag.start + MIN_AUDIO_CLIP_SEC, drag.end + deltaSec), fps)
    if (candidate !== drag.end) onTrim({ timelineEndSec: candidate })
  }

  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onCommit?.()
    // 几乎没位移 = 单击：把播放头带到这一段
    if (drag.edge === 'move' && Math.abs(event.clientX - drag.pointerX) <= 3) onSeek(clip.timelineStartSec)
  }

  return (
    <div
      className={`audio-clip-card${selected ? ' audio-clip-card--selected' : ''}${item ? '' : ' audio-clip-card--orphan'}`}
      style={{
        left,
        width: Math.max(24, right - left),
        top: `${(layer * 100) / lane}%`,
        height: `${100 / lane}%`
      }}
      title={`${name} · ${(clip.timelineEndSec - clip.timelineStartSec).toFixed(2)}s`}
      onPointerDown={begin('move')}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span className="audio-clip-card__wave" aria-hidden="true" />
      <span className="audio-clip-card__label">{name}</span>
      <div
        className="audio-clip-card__handle audio-clip-card__handle--in"
        title="入点"
        onPointerDown={begin('in')}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className="audio-clip-card__handle audio-clip-card__handle--out"
        title="出点"
        onPointerDown={begin('out')}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}
