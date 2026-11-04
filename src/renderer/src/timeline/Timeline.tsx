import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import { MAX_TIMELINE_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { secondsToTimecode } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import { timelineDurationSec, useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { ClipCard } from './ClipCard'
import { buildTicks, pickStep, pxToSec, secToPx } from './ruler'

/** 时间轴：多入出点管理（规格 §3.1），刻度按当前帧率生成，点击定位播放头。 */

export interface TimelineProps {
  seekTo: (sec: number) => void
}

export function Timeline({ seekTo }: TimelineProps): ReactElement {
  const project = useProjectStore((state) => state.project)
  const selectedClipId = useProjectStore((state) => state.selectedClipId)
  const selectClip = useProjectStore((state) => state.selectClip)
  const addClip = useProjectStore((state) => state.addClip)
  const removeClip = useProjectStore((state) => state.removeClip)
  const setClipTimes = useProjectStore((state) => state.setClipTimes)
  const displayTime = useUiStore((state) => state.displayTimeSec)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const [widthPx, setWidthPx] = useState(800)

  useEffect(() => {
    const element = trackRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidthPx(Math.max(120, entry.contentRect.width))
    })
    observer.observe(element)
    setWidthPx(Math.max(120, element.clientWidth))
    return () => observer.disconnect()
  }, [])

  const durationSec = Math.min(
    MAX_TIMELINE_SEC,
    Math.max(project.refVideo?.meta.durationSec ?? 0, timelineDurationSec(project) + 1)
  )
  const step = pickStep(durationSec, widthPx)
  const ticks = buildTicks(durationSec, project.fps, step)

  const seekFromEvent = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const sec = pxToSec(event.clientX - rect.left, durationSec, rect.width)
    seekTo(snapTimeToFrame(sec, project.fps))
  }

  return (
    <div className="timeline">
      <div className="timeline__bar">
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => addClip()}>
            {TEXT.timeline.addClip}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!selectedClipId}
            onClick={() => {
              if (selectedClipId) removeClip(selectedClipId)
            }}
          >
            {TEXT.timeline.removeClip}
          </button>
        </div>
        <div className="timeline__meta mono">
          <span className="timeline__timecode">{secondsToTimecode(displayTime, project.fps)}</span>
          <span className="muted">总时长 {durationSec.toFixed(2)}s</span>
          <span className="muted timeline__snap-hint" title={TEXT.timeline.snapHint}>
            {TEXT.timeline.snapHint}
          </span>
        </div>
      </div>

      <div className="timeline__ruler" onClick={seekFromEvent}>
        {ticks.map((tick) => (
          <div
            key={tick.sec}
            className={`timeline__tick${tick.major ? ' timeline__tick--major' : ''}`}
            style={{ left: secToPx(tick.sec, durationSec, widthPx) }}
          >
            {tick.major ? tick.label : ''}
          </div>
        ))}
      </div>

      <div className="timeline__track" ref={trackRef} onClick={seekFromEvent}>
        {project.clips.length === 0 ? (
          <span className="timeline__empty">
            {TEXT.timeline.empty}
          </span>
        ) : null}
        {project.clips.map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            durationSec={durationSec}
            widthPx={widthPx}
            fps={project.fps}
            selected={clip.id === selectedClipId}
            onSelect={selectClip}
            onChangeTimes={(start, end) => setClipTimes(clip.id, start, end)}
          />
        ))}
        <div
          className="timeline__playhead"
          style={{ left: secToPx(Math.min(displayTime, durationSec), durationSec, widthPx) }}
        />
      </div>
    </div>
  )
}
