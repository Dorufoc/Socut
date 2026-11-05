import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MIN_CLIP_DURATION_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { getPreset } from '@shared/presets'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import type { Fps, SubtitleClip } from '@shared/types'
import { secToPx } from './ruler'

/**
 * 时间轴字幕轨的**示意条**（v4）：
 * 不再是一张带多行信息的大卡片，而是一条上下更窄的区间条——它的摆位就是这条字幕
 * 在当前画面里的**入点→出点**区间，条内一条细游标标出播放头落在区间的哪里；
 * 标签只放主标题（副标题、预设名、秒数进 title / aria 读数，不占轨道空间）。
 *
 * 入出点拖拽保留（规格 §3.1）：拖拽过程中的秒值一律吸附到当前预览帧率的帧边界后再写回（规格 §4.4）。
 */

export interface ClipCardProps {
  clip: SubtitleClip
  durationSec: number
  widthPx: number
  fps: Fps
  selected: boolean
  /** 播放头（秒）：用于在示意条上标出当前位置相对出入点的关系 */
  playheadSec: number
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
  playheadSec,
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

  const barWidth = Math.max(24, right - left)
  /** 播放头落在本条区间内：在示意条上画一条细游标，当前位置与出入点的关系一目了然 */
  const onAir = playheadSec >= clip.startTime && playheadSec < clip.endTime
  const cursorLeft = onAir ? Math.max(0, Math.min(barWidth - 2, secToPx(playheadSec, durationSec, widthPx) - left)) : 0
  const readout = TEXT.timeline.stripHint(
    secondsToTimecode(clip.startTime, fps),
    secondsToTimecode(clip.endTime, fps),
    secondsToTimecode(playheadSec, fps)
  )

  return (
    <div
      className={`clip-card${selected ? ' clip-card--selected' : ''}${onAir ? ' clip-card--onair' : ''}`}
      style={{ left, width: barWidth }}
      onPointerDown={(event) => {
        begin('move')(event)
      }}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      title={`${preset.name} · ${readout}`}
      aria-label={`${preset.name} · ${clip.content.title || TEXT.captions.noTitle} · ${readout}`}
    >
      {/* 标签只放主标题：副标题与时间读数进 title，轨道上不再挤成多行 */}
      <span className="clip-card__label">{clip.content.title || TEXT.captions.noTitle}</span>
      {onAir ? <span className="clip-card__cursor" style={{ left: cursorLeft }} aria-hidden="true" /> : null}
      <div
        className="clip-card__handle clip-card__handle--left"
        title={TEXT.timeline.inPoint}
        onPointerDown={begin('in')}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div
        className="clip-card__handle clip-card__handle--right"
        title={TEXT.timeline.outPoint}
        onPointerDown={begin('out')}
        onPointerMove={onMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
    </div>
  )
}
