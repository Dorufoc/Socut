import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MIN_CLIP_DURATION_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { getPreset } from '@shared/presets'
import { TEXT } from '@shared/i18n'
import type { Fps, SubtitleClip } from '@shared/types'
import { secToPx } from './ruler'

/**
 * 时间轴片段卡片：入出点拖拽（规格 §3.1 每片段独立维护标题/副标题/样式参数）。
 * 拖拽过程中的秒值一律吸附到当前预览帧率的帧边界后再写回（规格 §4.4）。
 */

export interface ClipCardProps {
  clip: SubtitleClip
  durationSec: number
  widthPx: number
  fps: Fps
  selected: boolean
  onSelect: (id: string) => void
  onChangeTimes: (startTime: number, endTime: number) => void
}

type Edge = 'in' | 'out' | 'move'

export function ClipCard({
  clip,
  durationSec,
  widthPx,
  fps,
  selected,
  onSelect,
  onChangeTimes
}: ClipCardProps): ReactElement {
  const dragRef = useRef<{ edge: Edge; pointerX: number; start: number; end: number } | null>(null)
  const preset = getPreset(clip.presetId)

  const left = secToPx(clip.startTime, durationSec, widthPx)
  const right = secToPx(clip.endTime, durationSec, widthPx)

  const begin = (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    onSelect(clip.id)
    dragRef.current = { edge, pointerX: event.clientX, start: clip.startTime, end: clip.endTime }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
  }

  const onMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const deltaSec = ((event.clientX - drag.pointerX) / Math.max(1, widthPx)) * durationSec
    if (drag.edge === 'move') {
      const length = drag.end - drag.start
      let start = snapTimeToFrame(Math.max(0, drag.start + deltaSec), fps)
      if (start + length > durationSec) start = snapTimeToFrame(durationSec - length, fps)
      onChangeTimes(start, snapTimeToFrame(start + length, fps))
      return
    }
    if (drag.edge === 'in') {
      const start = snapTimeToFrame(Math.min(drag.end - MIN_CLIP_DURATION_SEC, Math.max(0, drag.start + deltaSec)), fps)
      onChangeTimes(start, drag.end)
      return
    }
    const end = snapTimeToFrame(
      Math.max(drag.start + MIN_CLIP_DURATION_SEC, Math.min(durationSec, drag.end + deltaSec)),
      fps
    )
    onChangeTimes(drag.start, end)
  }

  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      className={`clip-card${selected ? ' clip-card--selected' : ''}`}
      style={{ left, width: Math.max(24, right - left) }}
      onPointerDown={(event) => {
        begin('move')(event)
      }}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      title={`${preset.name} · ${TEXT.timeline.snapHint}`}
    >
      <div className="clip-card__title">{clip.content.title || '（无主标题）'}</div>
      <div className="clip-card__meta mono">
        {preset.name} · {clip.startTime.toFixed(3)}→{clip.endTime.toFixed(3)}s
      </div>
      <div
        className="clip-card__handle clip-card__handle--left"
        onPointerDown={begin('in')}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className="clip-card__handle clip-card__handle--right"
        onPointerDown={begin('out')}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}
