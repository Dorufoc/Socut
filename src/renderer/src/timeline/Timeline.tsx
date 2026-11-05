import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MAX_TIMELINE_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { secondsToTimecode } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import { timelineDurationSec, useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { ClipCard } from './ClipCard'
import { buildTicks, pickStep, pxToSec, secToPx } from './ruler'

/**
 * 时间轴：多入出点管理（规格 §3.1），刻度按当前帧率生成。
 * 尺规与轨道空白处支持按住拖拽刮擦（pointer capture）：按下即定位当前帧，
 * 持续拖动时预览跟随鼠标位置逐帧变化；片段卡片自身的拖拽不受影响。
 */

type ScrubElement = HTMLDivElement

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
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const [widthPx, setWidthPx] = useState(800)
  // 刮擦中的尺规/轨道元素与几何：capture 后 pointermove 始终以该矩形换算位置
  const scrubRef = useRef<{ element: ScrubElement; left: number; width: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

  useEffect(() => {
    const element = trackRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setWidthPx(Math.max(120, entry.contentRect.width))
      const rect = element.getBoundingClientRect()
      if (scrubRef.current?.element === element) scrubRef.current = { ...scrubRef.current, left: rect.left, width: rect.width }
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

  /** 用按下/移动时的矩形换算秒并吸附帧边界：尺规与轨道同一水平几何，capture 后离开元素也能继续跟随。 */
  const seekFromScrub = (clientX: number): void => {
    const scrub = scrubRef.current
    if (!scrub || scrub.width <= 0) return
    const sec = pxToSec(clientX - scrub.left, durationSec, scrub.width)
    seekTo(snapTimeToFrame(Math.min(durationSec, sec), project.fps))
  }

  const beginScrub = (event: ReactPointerEvent<ScrubElement>): void => {
    // 只响应主键；片段卡片的 pointerdown 已 stopPropagation，不会走到这里
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    scrubRef.current = { element: event.currentTarget, left: rect.left, width: rect.width }
    event.currentTarget.setPointerCapture(event.pointerId)
    // 刮擦接管播放头：先暂停，否则时钟会继续前进、覆盖拖拽定位
    if (playing) setPlaying(false)
    setScrubbing(true)
    seekFromScrub(event.clientX)
  }

  const moveScrub = (event: ReactPointerEvent<ScrubElement>): void => {
    if (!scrubRef.current) return
    seekFromScrub(event.clientX)
  }

  const endScrub = (event: ReactPointerEvent<ScrubElement>): void => {
    if (!scrubRef.current) return
    scrubRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setScrubbing(false)
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

      <div
        className={`timeline__ruler${scrubbing ? ' timeline__ruler--scrubbing' : ''}`}
        onPointerDown={beginScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
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

      <div
        className={`timeline__track${scrubbing ? ' timeline__track--scrubbing' : ''}`}
        ref={trackRef}
        onPointerDown={beginScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
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
          className={`timeline__playhead${scrubbing ? ' timeline__playhead--scrubbing' : ''}`}
          style={{ left: secToPx(Math.min(displayTime, durationSec), durationSec, widthPx) }}
        />
      </div>
    </div>
  )
}
