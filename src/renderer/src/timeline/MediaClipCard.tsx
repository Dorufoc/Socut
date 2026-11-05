import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import type { Fps, MediaClip, MediaItem } from '@shared/types'
import { secToPx } from './ruler'

/**
 * 媒体轨片段卡片（v2 阶段 4）。
 * 与字幕条卡片的区别：拖入/出点时时间轴与源坐标**同幅度**平移（时长恒等式由 store 保证），
 * 整段拖动遵循「仅重叠才右移后续片段」规则（store.moveMediaClip 内联对齐）。
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
}

type Edge = 'in' | 'out' | 'move'

export function MediaClipCard({
  clip,
  item,
  durationSec,
  widthPx,
  fps,
  selected,
  onSelect,
  onMove,
  onTrim
}: MediaClipCardProps): ReactElement {
  const dragRef = useRef<{ edge: Edge; pointerX: number; start: number; end: number } | null>(null)

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
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      className={`media-clip-card${selected ? ' media-clip-card--selected' : ''}${item ? '' : ' media-clip-card--orphan'}`}
      style={{ left, width: Math.max(24, right - left) }}
      onPointerDown={begin('move')}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      title={`${name} · 源 ${clip.sourceInSec.toFixed(3)}→${clip.sourceOutSec.toFixed(3)}s`}
    >
      {item?.thumbnailUrl ? (
        <img className="media-clip-card__thumb" src={item.thumbnailUrl} alt="" draggable={false} aria-hidden="true" />
      ) : null}
      <div className="media-clip-card__title">{name}</div>
      <div className="media-clip-card__meta mono">
        源 {clip.sourceInSec.toFixed(2)}→{clip.sourceOutSec.toFixed(2)}s
      </div>
      <div
        className="media-clip-card__handle media-clip-card__handle--left"
        onPointerDown={begin('in')}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className="media-clip-card__handle media-clip-card__handle--right"
        onPointerDown={begin('out')}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}
