import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MAX_TIMELINE_SEC } from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { canSplitMediaClipAt } from '@shared/mediaClips'
import { collectSnapEdges, snapEdge, snapMove, snapWindowSec } from '@shared/timelineSnap'
import { secondsToTimecode } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import { timelineDurationSec, useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { ClipCard } from './ClipCard'
import { MediaClipCard } from './MediaClipCard'
import { AudioClipCard } from './AudioClipCard'
import { mediaKindOf, normalizeLayer } from '@shared/audioClips'
import { MEDIA_DRAG_MIME } from '../panels/MediaLibraryPanel'
import { buildTicks, pickStep, pxToSec, secToPx } from './ruler'

/**
 * 双轨时间轴（v2 阶段 4）：上行媒体轨、下行字幕条轨，共享尺规与播放头。
 * 尺规与轨道空白处支持按住拖拽刮擦（pointer capture）：按下即定位当前帧，
 * 持续拖动时预览跟随鼠标位置逐帧变化；片段卡片自身的拖拽不受影响。
 * 素材库卡片可拖入媒体轨：拖拽悬停时高亮落点竖线，放下即在吸附位置插入片段。
 * v4：字幕轨改为「窄示意条」——一条卡的摆位就是该字幕在当前画面的入点→出点，
 * 标签只放主标题，条内细游标标出播放头落在区间的哪里（位置关系与全局播放头同源）。
 */

type ScrubElement = HTMLDivElement

/** 稳定的空音频轨引用（避免每次选择器返回新数组） */
const EMPTY_AUDIO_CLIPS: never[] = []

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
  const audioClips = useProjectStore((state) => state.project.audioClips) ?? EMPTY_AUDIO_CLIPS
  const selectedAudioClipId = useProjectStore((state) => state.selectedAudioClipId)
  const selectAudioClip = useProjectStore((state) => state.selectAudioClip)
  const setMediaClipLayer = useProjectStore((state) => state.setMediaClipLayer)
  const setAudioClipLayer = useProjectStore((state) => state.setAudioClipLayer)
  const insertAudioClip = useProjectStore((state) => state.insertAudioClip)
  const moveAudioClip = useProjectStore((state) => state.moveAudioClip)
  const trimAudioClip = useProjectStore((state) => state.trimAudioClip)
  const removeAudioClip = useProjectStore((state) => state.removeAudioClip)
  const compactTimeline = useProjectStore((state) => state.compactTimeline)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const setNotice = useUiStore((state) => state.setNotice)
  const tools = useUiStore((state) => state.timelineTools)
  const toggleTimelineTool = useUiStore((state) => state.toggleTimelineTool)

  const trackRef = useRef<HTMLDivElement | null>(null)
  // 媒体轨：预览轴的坐标基准（与卡片、播放头同一原点）
  const mediaTrackRef = useRef<HTMLDivElement | null>(null)
  const [widthPx, setWidthPx] = useState(800)
  // 刮擦中的尺规/轨道元素与几何：capture 后 pointermove 始终以该矩形换算位置
  const scrubRef = useRef<{ element: ScrubElement; left: number; width: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  // 素材拖入：拖拽悬停的吸附落点（秒），null 表示当前不在媒体轨上拖拽
  const [dropSec, setDropSec] = useState<number | null>(null)
  // 自动吸附命中的目标边缘（秒），画高亮竖线用；null = 当前没有吸附反馈
  const [snapGuideSec, setSnapGuideSec] = useState<number | null>(null)
  // 预览轴：鼠标所在的帧时间（秒），null = 鼠标不在时间轴内
  const [hoverSec, setHoverSec] = useState<number | null>(null)
  const hoverRef = useRef<number | null>(null)

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
    const raw = pxToSec(clientX - rect.left, durationSec, rect.width)
    // 指针坐标缺失/非法时落回 0：不能让 NaN 流进 snapTimeToFrame（那里会抛 RangeError）
    const safe = Number.isFinite(raw) ? raw : 0
    return snapTimeToFrame(Math.min(durationSec, Math.max(0, safe)), project.fps)
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
    if (mediaKindOf(item) === 'audio') {
      setNotice('音频素材请拖到音频轨')
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const atSec = dropSecFrom(event.clientX, rect)
    // 整段放入：从源 0s 起覆盖全长；超出轨道末端的部分由 MAX_TIMELINE_SEC 与落点规则自然截断
    const clip = insertMediaClip({ mediaId, timelineStartSec: atSec, durationSec: item.meta.durationSec, sourceInSec: 0 })
    if (!clip) setNotice(`落点剩余空间不足最短时长（${item.name}）`)
  }

  const onAudioDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    const rect = event.currentTarget.getBoundingClientRect()
    setDropSec(dropSecFrom(event.clientX, rect))
  }

  const onAudioDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDropSec(null)
    const mediaId = event.dataTransfer.getData(MEDIA_DRAG_MIME) || event.dataTransfer.getData('text/plain')
    if (!mediaId) return
    const item = project.media.find((m) => m.id === mediaId)
    if (!item) {
      setNotice('素材已移出池，无法放入')
      return
    }
    if (mediaKindOf(item) !== 'audio') {
      setNotice('视频素材请拖到媒体轨')
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const atSec = dropSecFrom(event.clientX, rect)
    const clip = insertAudioClip({ mediaId, timelineStartSec: atSec, durationSec: item.meta.durationSec })
    if (!clip) setNotice('该音频段太短，无法放入')
  }

  const activeMediaTarget = project.mediaClips.find((c) => c.id === selectedMediaClipId) ?? null
  /** v7：媒体轨的叠放层数（按现有最大层号取，单层时不切分高度） */
  const mediaLayers = Math.max(1, ...project.mediaClips.map((clip) => (clip.layer ?? 0) + 1))
  const activeAudioTarget = audioClips.find((c) => c.id === selectedAudioClipId) ?? null
  /** 音频轨的叠放层数：按现有最大层号取，空轨就是 1 层 */
  const audioLayers = Math.max(1, ...audioClips.map((clip) => normalizeLayer(clip.layer) + 1))
  /** v7 叠层：被选中的片段（媒体优先，否则音频）与它的当前层号 */
  const layerTarget = activeMediaTarget ?? activeAudioTarget
  const layerNow = layerTarget ? (layerTarget.layer ?? 0) : 0
  const MAX_LAYER_UI = 4
  /** 上/下移一层：只改层号，时间不变；0 层不落盘 */
  const shiftLayer = (delta: number): void => {
    if (!layerTarget) return
    const next = layerNow + delta
    if (activeMediaTarget) setMediaClipLayer(activeMediaTarget.id, next)
    else if (activeAudioTarget) setAudioClipLayer(activeAudioTarget.id, next)
  }
  
  const canSplit = canSplitMediaClipAt(project.mediaClips, displayTime, project.fps)

  // ---------------------------------------------------------------- 时间轴工具

  /** 像素阈值换算成秒（随轨道宽度与总时长变化，手感一致） */
  const snapWindow = snapWindowSec(widthPx, durationSec)

  /** 候选边缘：两轨所有片段的首/尾 + 0 点；被拖的那条自己不能当候选 */
  const snapEdges = (excludeId: string): number[] =>
    collectSnapEdges(
      [
        ...project.mediaClips.map((clip) => ({ id: clip.id, start: clip.timelineStartSec, end: clip.timelineEndSec })),
        ...project.clips.map((clip) => ({ id: clip.id, start: clip.startTime, end: clip.endTime }))
      ],
      excludeId
    )

  /** 媒体段整段拖拽：开着吸附时首尾都试一次，命中就画导引线 */
  const handleMediaMove = (id: string, start: number): void => {
    const clip = project.mediaClips.find((item) => item.id === id)
    if (!clip || !tools.magneticSnap) {
      setSnapGuideSec(null)
      moveMediaClip(id, start)
      return
    }
    const length = clip.timelineEndSec - clip.timelineStartSec
    const snapped = snapMove(start, length, snapEdges(id), snapWindow, durationSec)
    setSnapGuideSec(snapped.guideSec)
    moveMediaClip(id, snapped.value)
  }

  /** 媒体段拖入/出点：只有被拖的那条边参与吸附 */
  const handleMediaTrim = (id: string, patch: { timelineStartSec?: number; timelineEndSec?: number }): void => {
    if (!tools.magneticSnap) {
      setSnapGuideSec(null)
      trimMediaClip(id, patch)
      return
    }
    const edges = snapEdges(id)
    const next = { ...patch }
    let guide: number | null = null
    if (patch.timelineStartSec !== undefined) {
      const snapped = snapEdge(patch.timelineStartSec, edges, snapWindow)
      next.timelineStartSec = snapped.value
      guide = snapped.guideSec
    } else if (patch.timelineEndSec !== undefined) {
      const snapped = snapEdge(patch.timelineEndSec, edges, snapWindow)
      next.timelineEndSec = snapped.value
      guide = snapped.guideSec
    }
    setSnapGuideSec(guide)
    trimMediaClip(id, next)
  }

  /** 字幕条拖拽：首尾各自吸附（一般只会动到其中一条边） */
  const handleClipTimes = (id: string, start: number, end: number): void => {
    if (!tools.magneticSnap) {
      setSnapGuideSec(null)
      setClipTimes(id, start, end)
      return
    }
    const edges = snapEdges(id)
    const snappedStart = snapEdge(start, edges, snapWindow)
    const snappedEnd = snapEdge(end, edges, snapWindow)
    setSnapGuideSec(snappedStart.guideSec ?? snappedEnd.guideSec)
    setClipTimes(id, snappedStart.value, snappedEnd.value)
  }

  /** 拖拽收尾：清掉吸附线；主轨对齐开着时把主轨重新摆紧 */
  const commitMediaDrag = (): void => {
    setSnapGuideSec(null)
    if (tools.snapTogether) compactTimeline()
  }

  /** 预览轴：鼠标所在的帧（吸附到帧边界），同一帧不重复写 state。
   *  坐标用媒体轨的矩形（与卡片/播放头同一原点），所以黄线一定落在帧对应的格子上。 */
  const onHoverMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!tools.hoverPreview || event.pointerType !== 'mouse') return
    const track = mediaTrackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return
    const sec = snapTimeToFrame(Math.min(durationSec, Math.max(0, pxToSec(event.clientX - rect.left, durationSec, rect.width))), project.fps)
    if (hoverRef.current === sec) return
    hoverRef.current = sec
    setHoverSec(sec)
  }

  const endHover = (): void => {
    if (hoverRef.current === null) return
    hoverRef.current = null
    setHoverSec(null)
  }

  useEffect(() => {
    // 关掉预览轴时立刻把黄线收起来，不用等鼠标移出
    if (tools.hoverPreview) return
    hoverRef.current = null
    setHoverSec(null)
  }, [tools.hoverPreview])

  const hoverActive = tools.hoverPreview && hoverSec !== null

  /** 两轨都要画的导引线：吸附目标边缘（强调蓝）+ 预览轴（黄）。复用同一个元素实例。 */
  const guides = (
    <>
      {snapGuideSec !== null ? (
        <div className="timeline__snap-line" style={{ left: secToPx(snapGuideSec, durationSec, widthPx) }} />
      ) : null}
      {hoverActive ? (
        <div
          className="timeline__hover-line"
          style={{ left: secToPx(Math.min(hoverSec ?? 0, durationSec), durationSec, widthPx) }}
        >
          <span className="timeline__hover-tag mono">{secondsToTimecode(hoverSec ?? 0, project.fps)}</span>
        </div>
      ) : null}
    </>
  )

  return (
    <div
      className={`timeline${hoverActive ? ' timeline--hover-preview' : ''}`}
      onPointerMove={onHoverMove}
      onPointerLeave={endHover}
      onPointerUp={() => setSnapGuideSec(null)}
    >
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
            title={TEXT.timeline.splitHint}
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
          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={!activeAudioTarget}
            onClick={() => {
              if (activeAudioTarget) removeAudioClip(activeAudioTarget.id)
            }}
          >
            {TEXT.timeline.removeAudioClip}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!layerTarget || layerNow >= MAX_LAYER_UI}
            title={TEXT.timeline.layerUpHint}
            onClick={() => shiftLayer(1)}
          >
            {TEXT.timeline.layerUp}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!layerTarget || layerNow <= 0}
            title={TEXT.timeline.layerDownHint}
            onClick={() => shiftLayer(-1)}
          >
            {TEXT.timeline.layerDown}
          </button>
          <span className="timeline__divider" aria-hidden="true" />
          <button
            type="button"
            className={`btn btn--sm${tools.snapTogether ? ' btn--primary' : ''}`}
            aria-pressed={tools.snapTogether}
            title={TEXT.timeline.snapTogetherHint}
            onClick={() => {
              const next = !tools.snapTogether
              toggleTimelineTool('snapTogether')
              // 打开就立即把主轨摆紧；关闭不做任何回滚（片段就停在当前位置）
              if (next) compactTimeline()
            }}
          >
            {TEXT.timeline.snapTogether}
          </button>
          <button
            type="button"
            className={`btn btn--sm${tools.magneticSnap ? ' btn--primary' : ''}`}
            aria-pressed={tools.magneticSnap}
            title={TEXT.timeline.magneticSnapHint}
            onClick={() => toggleTimelineTool('magneticSnap')}
          >
            {TEXT.timeline.magneticSnap}
          </button>
          <button
            type="button"
            className={`btn btn--sm${tools.hoverPreview ? ' btn--primary' : ''}`}
            aria-pressed={tools.hoverPreview}
            title={TEXT.timeline.hoverPreviewHint}
            onClick={() => toggleTimelineTool('hoverPreview')}
          >
            {TEXT.timeline.hoverPreview}
          </button>
        </div>
        <div className="timeline__meta mono">
          <span className="timeline__timecode">{secondsToTimecode(displayTime, project.fps)}</span>
          <span className="muted">总时长 {durationSec.toFixed(2)}s</span>
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
        ref={mediaTrackRef}
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
            onSelect={(id) => {
              selectMediaClip(id)
              // 选中后把播放头带进这一段：否则预览里根本没有这条画面，
              // 右侧视频编辑器与画面交互层的手柄都无处可挂。
              const target = project.mediaClips.find((item) => item.id === id)
              if (target && (displayTime < target.timelineStartSec || displayTime >= target.timelineEndSec)) {
                seekTo(target.timelineStartSec)
              }
            }}
            onMove={(start) => handleMediaMove(clip.id, start)}
            onTrim={(patch) => handleMediaTrim(clip.id, patch)}
            onCommit={commitMediaDrag}
            onSeek={seekTo}
            layers={mediaLayers}
          />
        ))}
        {dropSec !== null ? (
          <div
            className="timeline__drop-indicator"
            style={{ left: secToPx(dropSec, durationSec, widthPx) }}
            title={dropSec.toFixed(3) + 's'}
          />
        ) : null}
        {guides}
      </div>

      {/* 中行：音频轨（v7.1）—— 只贡献声音，不参与画面合成 */}
      <div
        className={`timeline__track timeline__track--audio${dropSec !== null ? ' timeline__track--dropping' : ''}`}
        onDragOver={onAudioDragOver}
        onDragLeave={() => setDropSec(null)}
        onDrop={onAudioDrop}
        onPointerDown={beginScrub}
        onPointerMove={moveScrub}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
        <span className="timeline__lane-label" aria-hidden="true">
          {TEXT.timeline.audioLane}
        </span>
        {audioClips.length === 0 ? <span className="timeline__empty">{TEXT.timeline.emptyAudio}</span> : null}
        {audioClips.map((clip) => (
          <AudioClipCard
            key={clip.id}
            clip={clip}
            item={project.media.find((m) => m.id === clip.mediaId) ?? null}
            durationSec={durationSec}
            widthPx={widthPx}
            fps={project.fps}
            selected={clip.id === selectedAudioClipId}
            layers={audioLayers}
            onSelect={(id) => {
              selectAudioClip(id)
              const target = audioClips.find((item) => item.id === id)
              if (target && (displayTime < target.timelineStartSec || displayTime >= target.timelineEndSec)) {
                seekTo(target.timelineStartSec)
              }
            }}
            onMove={(start) => moveAudioClip(clip.id, start)}
            onTrim={(patch) => trimAudioClip(clip.id, patch)}
            onSeek={seekTo}
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
            playheadSec={displayTime}
            onSelect={selectClip}
            onChangeTimes={(start, end) => handleClipTimes(clip.id, start, end)}
          />
        ))}
        <div
          className={`timeline__playhead${scrubbing ? ' timeline__playhead--scrubbing' : ''}`}
          style={{ left: secToPx(Math.min(displayTime, durationSec), durationSec, widthPx) }}
        />
        {guides}
      </div>
    </div>
  )
}
