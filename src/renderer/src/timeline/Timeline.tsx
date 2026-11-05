import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MAX_TIMELINE_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { canSplitMediaClipAt } from '@shared/mediaClips'
import { secondsToTimecode } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import { timelineDurationSec, useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { ClipCard } from './ClipCard'
import { MediaClipCard } from './MediaClipCard'
import { MEDIA_DRAG_MIME } from '../panels/MediaLibraryPanel'
import { buildTicks, pickStep, pxToSec, secToPx } from './ruler'

/**
 * 双轨时间轴（v2 阶段 4）：上行媒体轨、下行字幕条轨，共享尺规与播放头。
 * 尺规与轨道空白处支持按住拖拽刮擦（pointer capture）：按下即定位当前帧，
 * 持续拖动时预览跟随鼠标位置逐帧变化；片段卡片自身的拖拽不受影响。
 * 素材库卡片可拖入媒体轨：拖拽悬停时高亮落点竖线，放下即在吸附位置插入片段。
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
  const selectedMediaClipId = useProjectStore((state) => state.selectedMediaClipId)
  const selectMediaClip = useProjectStore((state) => state.selectMediaClip)
  const moveMediaClip = useProjectStore((state) => state.moveMediaClip)
  const trimMediaClip = useProjectStore((state) => state.trimMediaClip)
  const removeMediaClip = useProjectStore((state) => state.removeMediaClip)
  const splitAtFrame = useProjectStore((state) => state.splitAtFrame)
  const insertMediaClip = useProjectStore((state) => state.insertMediaClip)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const setNotice = useUiStore((state) => state.setNotice)

  const trackRef = useRef<HTMLDivElement | null>(null)
  const [widthPx, setWidthPx] = useState(800)
  // 刮擦中的尺规/轨道元素与几何：capture 后 pointermove 始终以该矩形换算位置
  const scrubRef = useRef<{ element: ScrubElement; left: number; width: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  // 素材拖入：拖拽悬停的吸附落点（秒），null 表示当前不在媒体轨上拖拽
  const [dropSec, setDropSec] = useState<number | null>(null)

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

  const durationSec = Math.min(MAX_TIMELINE_SEC, Math.max(timelineDurationSec(project) + 1, 5))
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

  /** 媒体轨拖放落点：与刮擦同一套矩形换算，落点吸附到帧边界后高亮显示。 */
  const dropSecFrom = (clientX: number, rect: DOMRect): number => {
    const sec = pxToSec(clientX - rect.left, durationSec, rect.width)
    return snapTimeToFrame(Math.min(durationSec, Math.max(0, sec)), project.fps)
  }

  const onMediaDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const rect = event.currentTarget.getBoundingClientRect()
    setDropSec(dropSecFrom(event.clientX, rect))
  }

  const onMediaDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDropSec(null)
    const mediaId = event.dataTransfer.getData(MEDIA_DRAG_MIME) || event.dataTransfer.getData('text/plain')
    if (!mediaId) return
    const item = project.media.find((m) => m.id === mediaId)
    if (!item) {
      setNotice('素材已移出池，无法放入')
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const atSec = dropSecFrom(event.clientX, rect)
    // 整段放入：从源 0s 起覆盖全长；超出轨道末端的部分由 MAX_TIMELINE_SEC 与落点规则自然截断
    const clip = insertMediaClip({ mediaId, timelineStartSec: atSec, durationSec: item.meta.durationSec, sourceInSec: 0 })
    if (!clip) setNotice(`落点剩余空间不足最短时长（${item.name}）`)
  }

  const activeMediaTarget = project.mediaClips.find((c) => c.id === selectedMediaClipId) ?? null
  // 纯谓词算按钮态：不在渲染期调 store 动作（splitAtFrame 有 set 副作用）
  const canSplit = canSplitMediaClipAt(project.mediaClips, displayTime, project.fps)

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
          <span className="timeline__divider" aria-hidden="true" />
          <button
            type="button"
            className="btn btn--sm"
            disabled={!canSplit}
            title="在播放头处拆分当前媒体片段（Ctrl+B）；两段都须不短于最小时长"
            onClick={() => {
              const rightId = splitAtFrame(displayTime)
              if (!rightId) setNotice('播放头不在可拆分的媒体片段内，或拆出的半段不足最短时长')
            }}
          >
            {TEXT.timeline.splitClip}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={!activeMediaTarget}
            onClick={() => {
              if (activeMediaTarget) removeMediaClip(activeMediaTarget.id)
            }}
          >
            {TEXT.timeline.removeMediaClip}
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

      {/* 上行：媒体轨（素材库卡片拖入落点 + 拖拽排布） */}
      <div
        className={`timeline__track timeline__track--media${scrubbing ? ' timeline__track--scrubbing' : ''}${dropSec !== null ? ' timeline__track--dropping' : ''}`}
        onDragOver={onMediaDragOver}
        onDragLeave={() => setDropSec(null)}
        onDrop={onMediaDrop}
        onPointerDown={beginScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
        <span className="timeline__lane-label" aria-hidden="true">
          媒体
        </span>
        {project.mediaClips.length === 0 ? (
          <span className="timeline__empty">
            {TEXT.timeline.emptyMedia}
          </span>
        ) : null}
        {project.mediaClips.map((clip) => (
          <MediaClipCard
            key={clip.id}
            clip={clip}
            item={project.media.find((m) => m.id === clip.mediaId) ?? null}
            durationSec={durationSec}
            widthPx={widthPx}
            fps={project.fps}
            selected={clip.id === selectedMediaClipId}
            onSelect={selectMediaClip}
            onMove={(start) => moveMediaClip(clip.id, start)}
            onTrim={(patch) => trimMediaClip(clip.id, patch)}
          />
        ))}
        {dropSec !== null ? (
          <div
            className="timeline__drop-indicator"
            style={{ left: secToPx(dropSec, durationSec, widthPx) }}
            title={dropSec.toFixed(3) + 's'}
          />
        ) : null}
      </div>

      {/* 下行：字幕条轨 */}
      <div
        className={`timeline__track${scrubbing ? ' timeline__track--scrubbing' : ''}`}
        ref={trackRef}
        onPointerDown={beginScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
        <span className="timeline__lane-label" aria-hidden="true">
          字幕条
        </span>
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
