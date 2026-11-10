import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MIN_CLIP_DURATION_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { TEXT } from '@shared/i18n'
import { getTextPreset } from '@shared/textPresets'
import { secondsToTimecode } from '@shared/timecode'
import type { Fps, TextElementClip } from '@shared/types'
import { laneBoxFromCard, secAtClientX } from './lane'
import { secToPx } from './ruler'

/**
 * M7-D：时间轴「文本」轨上的区间条。
 *
 * 与字幕条 `ClipCard` 同一套交互（拖动整条 / 拖两端改入出点 / 吸附帧边界），
 * 区别只在数据是 `TextElementClip`（free 排版文本），标签显示预设名 + 文字。
 */

export interface TextClipCardProps {
  clip: TextElementClip
  durationSec: number
  widthPx: number
  fps: Fps
  selected: boolean
  playheadSec: number
  onSelect: (id: string) => void
  onChangeTimes: (startTime: number, endTime: number) => void
  onDragStart?: () => void
  onCommit?: () => void
}

type Edge = 'in' | 'out' | 'move'

interface DragState {
  edge: Edge
  grabOffsetPx: number
  start: number
  end: number
}

export function TextClipCard({
  clip,
  durationSec,
  widthPx,
  fps,
  selected,
  playheadSec,
  onSelect,
  onChangeTimes,
  onDragStart,
  onCommit
}: TextClipCardProps): ReactElement {
  const dragRef = useRef<DragState | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const preset = getTextPreset(clip.presetId)

  const left = secToPx(clip.startTime, durationSec, widthPx)
  const right = secToPx(clip.endTime, durationSec, widthPx)

  const begin = (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    if (rect.width <= 0) return
    onSelect(clip.id)
    dragRef.current = {
      edge,
      grabOffsetPx: event.clientX - rect.left,
      start: clip.startTime,
      end: clip.endTime
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
    onDragStart?.()
  }

  const onMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const box = laneBoxFromCard(cardRef.current, widthPx)
    if (!box) return
    if (drag.edge === 'move') {
      const length = drag.end - drag.start
      const grabSec = secAtClientX(event.clientX - drag.grabOffsetPx, box, durationSec)
      const start = snapTimeToFrame(Math.min(grabSec, Math.max(0, durationSec - length)), fps)
      onChangeTimes(start, snapTimeToFrame(start + length, fps))
      return
    }
    if (drag.edge === 'in') {
      const start = snapTimeToFrame(Math.min(drag.end - MIN_CLIP_DURATION_SEC, secAtClientX(event.clientX, box, durationSec)), fps)
      onChangeTimes(Math.max(0, start), drag.end)
      return
    }
    const end = snapTimeToFrame(Math.max(drag.start + MIN_CLIP_DURATION_SEC, secAtClientX(event.clientX, box, durationSec)), fps)
    onChangeTimes(drag.start, end)
  }

  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onCommit?.()
  }

  const barWidth = Math.max(24, right - left)
  const onAir = playheadSec >= clip.startTime && playheadSec < clip.endTime
  const display = clip.text.length > 14 ? `${clip.text.slice(0, 14)}…` : clip.text
  const readout = TEXT.timeline.stripHint(
    secondsToTimecode(clip.startTime, fps),
    secondsToTimecode(clip.endTime, fps),
    secondsToTimecode(playheadSec, fps)
  )

  return (
    <div
      ref={cardRef}
      data-text-clip-id={clip.id}
      className={`clip-card clip-card--text${selected ? ' clip-card--selected' : ''}${onAir ? ' clip-card--onair' : ''}`}
      style={{ left, width: barWidth }}
      onPointerDown={begin('move')}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      title={`${preset.name} · ${readout}`}
      aria-label={`${preset.name} · ${display || '（空文本）'} · ${readout}`}
    >
      <span className="clip-card__label">{display || '（空文本）'}</span>
      <div className="clip-card__handle clip-card__handle--left" title={TEXT.timeline.inPoint} onPointerDown={begin('in')} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} />
      <div className="clip-card__handle clip-card__handle--right" title={TEXT.timeline.outPoint} onPointerDown={begin('out')} onPointerMove={onMove} onPointerUp={end} onPointerCancel={end} />
    </div>
  )
}
