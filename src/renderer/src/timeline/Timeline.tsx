import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import {
  LANE_GUTTER_PX,
  MAX_AUDIO_TRACKS,
  MAX_MEDIA_TRACKS,
  MAX_TRACK_SEC,
  TIMELINE_BASE_PX_PER_SEC,
  TIMELINE_MAX_ZOOM,
  TIMELINE_MIN_ZOOM,
  TRACK_MIN_SEC,
  TRACK_TAIL_SEC
} from '@shared/constants'
import { snapTimeToFrame } from '@shared/fps'
import { collectSnapEdges, snapEdge, snapMove, snapWindowSec } from '@shared/timelineSnap'
import { secondsToTimecode } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import { timelineContentEndSec } from '@shared/presetResolver'
import { clipsOnAudioTrack, clipsOnMediaTrack, isTrackLocked } from '@shared/tracks'
import { TRANSITION_MAP, previousMediaClipOnTrack, resolveTransitionDuration, transitionMediaMetaOf } from '@shared/transitions'
import type { AudioTrack, MediaClip, MediaTrack } from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { useHistoryStore } from '../state/projectHistory'
import { useUiStore } from '../state/uiStore'
import { IconRedo, IconUndo } from '../components/ui/Icon'
import { ClipCard } from './ClipCard'
import { MediaClipCard } from './MediaClipCard'
import { AudioClipCard } from './AudioClipCard'
import { TrackHeader } from './TrackHeader'
import { mediaKindOf } from '@shared/audioClips'
import { MEDIA_DRAG_MIME } from '../panels/MediaLibraryPanel'
import { buildTicks, pickStep, secToPx } from './ruler'
import { laneBoxOf, secAtClientX } from './lane'

/**
 * 时间轴（v3 多轨）：
 * - 行序：媒体轨（数组反向，索引越大越靠上）→ 字幕轨（固定一条）→ 音频轨（同样反向）；
 * - 每条轨道自己的轨道头：重命名 / 静音 / 隐藏 / 锁定 / 上下移 / 删除（字幕轨只有隐藏与锁定）；
 * - 片段拖拽既能横向改时间，也能跨行落到另一条同类轨道（目标轨道由指针 Y 命中）；
 * - 锁定轨道上的片段不开始拖拽/修剪；
 * - 尺规与轨道放进同一个横向滚动容器，比例尺由「内容末尾 + 余量」推导（最多 1 小时），
 *   Ctrl/Cmd + 滚轮以鼠标下的时间点为锚缩放，普通竖向滚轮转成横向滚动；
 * - 蓝线（播放头）上限 = 最后一个媒体/字幕/音频段的末尾（timelineContentEndSec）。
 */

type ScrubElement = HTMLDivElement

/** 稳定的空音频轨引用（避免每次选择器返回新数组） */
const EMPTY_AUDIO_CLIPS: never[] = []

/** 刻度窗口两侧多渲染的像素：滚动时刻度不会贴边出现 */
const TICK_OVERSCAN_PX = 320
/** 距右端不足这个像素就自动延长轨道 */
const AUTO_EXTEND_PX = 240
/** Ctrl+滚轮每档的缩放倍率（剪映式逐格缩放） */
const ZOOM_STEP = 1.15
/** 跨轨命中查询用的属性选择器 */
const MEDIA_ROW_SELECTOR = '.timeline__track--media[data-track-id]'
const AUDIO_ROW_SELECTOR = '.timeline__track--audio[data-track-id]'

export interface TimelineProps {
  seekTo: (sec: number) => void
}

/** 轨道元素里的车道（真正按时间换算 X 的矩形）。 */
function laneOf(trackEl: Element | null): HTMLElement | null {
  return trackEl?.querySelector<HTMLElement>('.timeline__lane') ?? null
}

/**
 * 指针 Y 命中的轨道 id：卡片在拖拽时被 pointer capture 住，
 * 事件仍会带着真实 clientY，所以按每条轨道行的屏幕矩形做一次命中即可。
 * 没有命中（指针在轨道外）时返回 null，调用方保持原轨道。
 */
function trackIdAtClientY(container: Element | null, selector: string, clientY: number): string | null {
  if (!container || !Number.isFinite(clientY)) return null
  const rows = container.querySelectorAll<HTMLElement>(selector)
  for (const row of rows) {
    const rect = row.getBoundingClientRect()
    if (clientY >= rect.top && clientY <= rect.bottom) return row.dataset.trackId ?? null
  }
  return null
}

export function Timeline({ seekTo }: TimelineProps): ReactElement {
  const project = useProjectStore((state) => state.project)
  const selectedClipId = useProjectStore((state) => state.selectedClipId)
  const selectClip = useProjectStore((state) => state.selectClip)
  const setClipTimes = useProjectStore((state) => state.setClipTimes)
  const selectedMediaClipId = useProjectStore((state) => state.selectedMediaClipId)
  const selectMediaClip = useProjectStore((state) => state.selectMediaClip)
  const moveMediaClip = useProjectStore((state) => state.moveMediaClip)
  const trimMediaClip = useProjectStore((state) => state.trimMediaClip)
  const splitTargetAt = useProjectStore((state) => state.splitTargetAt)
  const removeTargetAt = useProjectStore((state) => state.removeTargetAt)
  const insertMediaClip = useProjectStore((state) => state.insertMediaClip)
  const audioClips = useProjectStore((state) => state.project.audioClips) ?? EMPTY_AUDIO_CLIPS
  const selectedAudioClipId = useProjectStore((state) => state.selectedAudioClipId)
  const selectAudioClip = useProjectStore((state) => state.selectAudioClip)
  const insertAudioClip = useProjectStore((state) => state.insertAudioClip)
  const moveAudioClip = useProjectStore((state) => state.moveAudioClip)
  const trimAudioClip = useProjectStore((state) => state.trimAudioClip)
  const compactTimeline = useProjectStore((state) => state.compactTimeline)
  const selectedTrackId = useProjectStore((state) => state.selectedTrackId)
  const selectTrack = useProjectStore((state) => state.selectTrack)
  const addMediaTrack = useProjectStore((state) => state.addMediaTrack)
  const addAudioTrack = useProjectStore((state) => state.addAudioTrack)
  const removeMediaTrack = useProjectStore((state) => state.removeMediaTrack)
  const removeAudioTrack = useProjectStore((state) => state.removeAudioTrack)
  const moveMediaTrack = useProjectStore((state) => state.moveMediaTrack)
  const moveAudioTrack = useProjectStore((state) => state.moveAudioTrack)
  const renameTrack = useProjectStore((state) => state.renameTrack)
  const setTrackMuted = useProjectStore((state) => state.setTrackMuted)
  const setTrackHidden = useProjectStore((state) => state.setTrackHidden)
  const setTrackLocked = useProjectStore((state) => state.setTrackLocked)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const setNotice = useUiStore((state) => state.setNotice)
  const tools = useUiStore((state) => state.timelineTools)
  const toggleTimelineTool = useUiStore((state) => state.toggleTimelineTool)
  const zoom = useUiStore((state) => state.timelineZoom)
  /** P1/P2：项目级撤销。新建与删除字幕条的入口已合并到左侧「字幕」Tab，这里只留撤销/重做 */
  const undoDepth = useHistoryStore((state) => state.past.length)
  const redoDepth = useHistoryStore((state) => state.future.length)
  const undo = useHistoryStore((state) => state.undo)
  const redo = useHistoryStore((state) => state.redo)

  // 尺规的车道：预览轴/落点换算都按它与轨道共用的同一块矩形来算。
  const rulerLaneRef = useRef<HTMLDivElement | null>(null)
  /** 横向滚动容器：滚轮横滚、缩放锚点、自动延长、跨轨命中都挂在它身上 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 视口读数（宽度 + scrollLeft）：刻度按它做窗口化渲染 */
  const [viewport, setViewport] = useState({ width: 0, scrollLeft: 0 })
  /** 在「两屏」之外额外延长的秒数：每滚到一次右端就加一屏 */
  const [extraSec, setExtraSec] = useState(0)
  // 刮擦中的车道元素：capture 后 pointermove 始终以该元素（实时）矩形换算位置
  const scrubLaneRef = useRef<HTMLElement | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  // 素材拖入：当前悬停的轨道与吸附落点（秒），null = 不在任何轨道上拖拽
  const [drop, setDrop] = useState<{ kind: 'media' | 'audio'; trackId: string; sec: number } | null>(null)
  // 自动吸附命中的目标边缘（秒），画高亮竖线用；null = 当前没有吸附反馈
  const [snapGuideSec, setSnapGuideSec] = useState<number | null>(null)
  // 按下时快照的吸附候选边缘：拖拽途中片段自己在动，实时重算会让邻居变成新的磁铁
  const dragEdgesRef = useRef<number[] | null>(null)
  // 缩放锚点：比例尺变更后要把这个时间点放回鼠标下面
  const pendingAnchorRef = useRef<{ sec: number; localX: number } | null>(null)
  // 预览轴：悬停帧存在 uiStore 里（预览画面要跟着它走）；null = 没有悬停或正在播放
  const hoverSec = useUiStore((state) => state.hoverPreviewSec)
  const setHoverPreview = useUiStore((state) => state.setHoverPreview)

  // ---------------------------------------------------------------- 比例尺与轨道长度

  const pxPerSec = TIMELINE_BASE_PX_PER_SEC * zoom
  /** 内容末尾：蓝线能到的最远处（空工程 = 0s） */
  const contentEndSec = timelineContentEndSec(project)
  /** 一屏能装下多少秒（扣掉左侧标签槽） */
  const viewportSec = viewport.width > 0 ? Math.max(0, (viewport.width - LANE_GUTTER_PX) / pxPerSec) : 0
  /**
   * 轨道时长：至少要「两屏」（保证永远有可滚的空白区），再叠加内容末尾与滚出来的额外长度。
   * 上限 1 小时：再长就不是给人找素材用的了。
   */
  const spanSec = Math.min(
    MAX_TRACK_SEC,
    Math.max(TRACK_MIN_SEC, contentEndSec + TRACK_TAIL_SEC, viewportSec * 2 + extraSec)
  )
  /** 轨道内容宽度（px）：卡片布局与指针换算共用同一个值 */
  const widthPx = spanSec * pxPerSec

  const pxPerSecRef = useRef(pxPerSec)
  const spanRef = useRef(spanSec)
  pxPerSecRef.current = pxPerSec
  spanRef.current = spanSec

  const step = pickStep(pxPerSec)
  // 只渲染视口附近的刻度：1 小时轨道全量渲染会产生上万个绝对定位节点
  const tickFromSec = Math.max(0, (viewport.scrollLeft - TICK_OVERSCAN_PX) / pxPerSec)
  const tickToSec = Math.min(spanSec, (viewport.scrollLeft + Math.max(viewport.width, 640) + TICK_OVERSCAN_PX) / pxPerSec)
  const ticks = buildTicks(tickFromSec, tickToSec, project.fps, step)

  // 行序：媒体轨反向（最高索引 = 最上面一行）→ 字幕 → 音频轨反向
  const mediaRows = [...project.mediaTracks].reverse()
  const audioRows = [...project.audioTracks].reverse()

  // 滚动：同步视口读数（刻度窗口）；滚到接近右端时自动延长一屏
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    let raf = 0
    const sync = (): void => {
      raf = 0
      const width = element.clientWidth
      const scrollLeft = element.scrollLeft
      setViewport((current) =>
        current.width === width && Math.abs(current.scrollLeft - scrollLeft) < 24 ? current : { width, scrollLeft }
      )
      // jsdom 里 scrollWidth 恒为 0：只有真的可滚时才判断，避免无限追加
      if (!(element.scrollWidth > width)) return
      if (spanRef.current >= MAX_TRACK_SEC) return
      if (element.scrollWidth - scrollLeft - width >= AUTO_EXTEND_PX) return
      setExtraSec((current) => current + Math.max(TRACK_MIN_SEC, width / Math.max(1, pxPerSecRef.current)))
    }
    const onScroll = (): void => {
      if (raf === 0) raf = requestAnimationFrame(sync)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(onScroll)
    observer.observe(element)
    onScroll()
    return () => {
      element.removeEventListener('scroll', onScroll)
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [])

  // Ctrl/Cmd + 滚轮缩放（锚在鼠标下的时间点）；普通竖向滚轮转成横向滚动
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const zoomNow = useUiStore.getState().timelineZoom
        const raw = event.deltaY < 0 ? zoomNow * ZOOM_STEP : zoomNow / ZOOM_STEP
        const next = Math.min(TIMELINE_MAX_ZOOM, Math.max(TIMELINE_MIN_ZOOM, raw))
        if (Math.abs(next - zoomNow) < 1e-6) return
        const localX = event.clientX - element.getBoundingClientRect().left
        const sec = (element.scrollLeft + localX - LANE_GUTTER_PX) / Math.max(1e-6, pxPerSecRef.current)
        // 指针压在 sticky 标签上时锚点落到 0s，避免负时间
        pendingAnchorRef.current = { sec: Math.max(0, Math.min(spanRef.current, sec)), localX }
        useUiStore.getState().setTimelineZoom(next)
        return
      }
      // 竖向滚轮 → 横向滚动（时间轴惯用手感）；横向滚轮交给浏览器原生处理
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      element.scrollLeft += event.deltaY
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // 缩放提交后（内容宽度已按新比例尺重排）把锚点时间放回鼠标所在的那一列
  useLayoutEffect(() => {
    const element = scrollRef.current
    const anchor = pendingAnchorRef.current
    pendingAnchorRef.current = null
    if (!element || !anchor) return
    const maxScroll = Math.max(0, element.scrollWidth - element.clientWidth)
    // S2 = t * ppS2 - localX + 56：t 这一刻回到指针所在列
    element.scrollLeft = Math.min(maxScroll, Math.max(0, anchor.sec * pxPerSec - anchor.localX + LANE_GUTTER_PX))
    setViewport({ width: element.clientWidth, scrollLeft: element.scrollLeft })
  }, [pxPerSec, widthPx])

  // ---------------------------------------------------------------- 刮擦 / 拖放

  /** 用按下/移动时车道的实时矩形换算秒并吸附帧边界：capture 后离开元素也能继续跟随。 */
  const seekFromScrub = (clientX: number): void => {
    const box = laneBoxOf(scrubLaneRef.current)
    if (!box) return
    // 夹到内容末尾：轨道比内容长，但播放头不允许停在空白区
    const sec = Math.min(contentEndSec, Math.max(0, secAtClientX(clientX, box, spanSec)))
    seekTo(snapTimeToFrame(sec, project.fps))
  }

  const beginScrub = (event: ReactPointerEvent<ScrubElement>): void => {
    // 只响应主键；片段卡片的 pointerdown 已 stopPropagation，不会走到这里
    if (event.button !== 0) return
    const lane = laneOf(event.currentTarget)
    if (!lane) return
    scrubLaneRef.current = lane
    event.currentTarget.setPointerCapture(event.pointerId)
    // 刮擦接管播放头：先暂停，否则时钟会继续前进、覆盖拖拽定位
    if (playing) setPlaying(false)
    setScrubbing(true)
    seekFromScrub(event.clientX)
  }

  const moveScrub = (event: ReactPointerEvent<ScrubElement>): void => {
    if (!scrubLaneRef.current) return
    seekFromScrub(event.clientX)
  }

  const endScrub = (event: ReactPointerEvent<ScrubElement>): void => {
    if (!scrubLaneRef.current) return
    scrubLaneRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setScrubbing(false)
  }

  /** 轨道拖放落点：与刮擦同一套车道换算，落点吸附到帧边界后高亮显示。 */
  const dropSecFrom = (clientX: number, lane: HTMLElement | null): number => {
    const box = laneBoxOf(lane)
    if (!box) return 0
    return snapTimeToFrame(secAtClientX(clientX, box, spanSec), project.fps)
  }

  const onMediaDragOver = (event: ReactDragEvent<HTMLDivElement>, track: MediaTrack): void => {
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDrop({
      kind: 'media',
      trackId: track.id,
      sec: dropSecFrom(event.clientX, laneOf(event.currentTarget))
    })
  }

  const onMediaDragLeave = (trackId: string): void => {
    setDrop((current) => (current && current.trackId === trackId ? null : current))
  }

  const onMediaDrop = (event: ReactDragEvent<HTMLDivElement>, track: MediaTrack): void => {
    event.preventDefault()
    setDrop(null)
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
    if (isTrackLocked(track)) {
      setNotice('该轨道已锁定，无法放入')
      return
    }
    const atSec = dropSecFrom(event.clientX, laneOf(event.currentTarget))
    // 整段放入：从源 0s 起覆盖全长；落点被占时由 store 顺延到后面的空档，不推动任何已有段
    const clip = insertMediaClip({
      mediaId,
      timelineStartSec: atSec,
      durationSec: item.meta.durationSec,
      sourceInSec: 0,
      trackId: track.id
    })
    if (!clip) setNotice(`落点剩余空间不足最短时长（${item.name}）`)
  }

  const onAudioDragOver = (event: ReactDragEvent<HTMLDivElement>, track: AudioTrack): void => {
    if (!event.dataTransfer.types.includes(MEDIA_DRAG_MIME)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDrop({
      kind: 'audio',
      trackId: track.id,
      sec: dropSecFrom(event.clientX, laneOf(event.currentTarget))
    })
  }

  const onAudioDragLeave = (trackId: string): void => {
    setDrop((current) => (current && current.trackId === trackId ? null : current))
  }

  const onAudioDrop = (event: ReactDragEvent<HTMLDivElement>, track: AudioTrack): void => {
    event.preventDefault()
    setDrop(null)
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
    if (isTrackLocked(track)) {
      setNotice('该轨道已锁定，无法放入')
      return
    }
    const atSec = dropSecFrom(event.clientX, laneOf(event.currentTarget))
    const clip = insertAudioClip({
      mediaId,
      timelineStartSec: atSec,
      durationSec: item.meta.durationSec,
      trackId: track.id
    })
    if (!clip) setNotice('该音频段太短，无法放入')
  }

  // ---------------------------------------------------------------- 时间轴工具

  /** 像素阈值换算成秒（随比例尺变化，手感一致） */
  const snapWindow = snapWindowSec(widthPx, spanSec)

  /** 候选边缘：所有媒体轨与字幕轨片段的首/尾 + 0 点；被拖的那条自己不能当候选 */
  const snapEdges = (excludeId: string): number[] =>
    collectSnapEdges(
      [
        ...project.mediaClips.map((clip) => ({ id: clip.id, start: clip.timelineStartSec, end: clip.timelineEndSec })),
        ...project.clips.map((clip) => ({ id: clip.id, start: clip.startTime, end: clip.endTime }))
      ],
      excludeId
    )

  /**
   * 本次拖拽用哪套候选边缘：按下时快照过就用快照。
   * 实时重算会把「刚被让开的邻居」当成新的磁铁，导致整段卡住不动。
   */
  const edgesDuringDrag = (id: string): number[] => dragEdgesRef.current ?? snapEdges(id)

  /** 卡片按下：固定这一次拖拽的吸附候选，直到松手 */
  const beginCardDrag = (id: string): void => {
    dragEdgesRef.current = snapEdges(id)
  }

  const endCardDrag = (): void => {
    dragEdgesRef.current = null
    setSnapGuideSec(null)
  }

  /** 媒体段整段拖拽：纵向命中另一条媒体轨则一起提交 targetTrackId。 */
  const handleMediaMove = (id: string, start: number, clientY: number): void => {
    const clip = project.mediaClips.find((item) => item.id === id)
    if (!clip) return
    const targetTrackId = trackIdAtClientY(scrollRef.current, MEDIA_ROW_SELECTOR, clientY) ?? clip.trackId
    if (!tools.magneticSnap) {
      setSnapGuideSec(null)
      moveMediaClip(id, start, targetTrackId)
      return
    }
    const length = clip.timelineEndSec - clip.timelineStartSec
    const snapped = snapMove(start, length, edgesDuringDrag(id), snapWindow, spanSec)
    setSnapGuideSec(snapped.guideSec)
    moveMediaClip(id, snapped.value, targetTrackId)
  }

  /** 媒体段拖入/出点：只有被拖的那条边参与吸附 */
  const handleMediaTrim = (id: string, patch: { timelineStartSec?: number; timelineEndSec?: number }): void => {
    if (!tools.magneticSnap) {
      setSnapGuideSec(null)
      trimMediaClip(id, patch)
      return
    }
    const edges = edgesDuringDrag(id)
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

  /** 音频段整段拖拽：与媒体段同一套跨轨命中。 */
  const handleAudioMove = (id: string, start: number, clientY: number): void => {
    const clip = audioClips.find((item) => item.id === id)
    if (!clip) return
    const targetTrackId = trackIdAtClientY(scrollRef.current, AUDIO_ROW_SELECTOR, clientY) ?? clip.trackId
    if (!tools.magneticSnap) {
      setSnapGuideSec(null)
      moveAudioClip(id, start, targetTrackId)
      return
    }
    const length = clip.timelineEndSec - clip.timelineStartSec
    const snapped = snapMove(start, length, edgesDuringDrag(id), snapWindow, spanSec)
    setSnapGuideSec(snapped.guideSec)
    moveAudioClip(id, snapped.value, targetTrackId)
  }

  /** 字幕条拖拽：首尾各自吸附（一般只会动到其中一条边） */
  const handleClipTimes = (id: string, start: number, end: number): void => {
    if (!tools.magneticSnap) {
      setSnapGuideSec(null)
      setClipTimes(id, start, end)
      return
    }
    const edges = edgesDuringDrag(id)
    const snappedStart = snapEdge(start, edges, snapWindow)
    const snappedEnd = snapEdge(end, edges, snapWindow)
    setSnapGuideSec(snappedStart.guideSec ?? snappedEnd.guideSec)
    setClipTimes(id, snappedStart.value, snappedEnd.value)
  }

  /**
   * 拖拽收尾：只清吸附线。
   * 这里**不能**调 compactTimeline：主轨对齐会把没被拖的段整体挪位，直接违反「拖拽不动别人」。
   * 对齐仍然保留为工具栏上的显式动作。
   */
  const commitMediaDrag = (): void => {
    endCardDrag()
  }

  /** 预览轴：鼠标所在帧（吸附到帧边界），并且不越过内容末尾。 */
  const onHoverMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 播放中不接管：黄线会与时钟抢画面，用户也看不清自己停在哪一帧
    if (!tools.hoverPreview || playing || event.pointerType !== 'mouse') return
    const box = laneBoxOf(rulerLaneRef.current)
    if (!box) return
    const sec = Math.min(contentEndSec, secAtClientX(event.clientX, box, spanSec))
    setHoverPreview(snapTimeToFrame(sec, project.fps))
  }

  const endHover = (): void => {
    if (hoverSec === null) return
    setHoverPreview(null)
  }

  useEffect(() => {
    // 关掉预览轴或开始播放：立刻把黄线与接管态收起，不用等鼠标移出
    if (tools.hoverPreview && !playing) return
    if (hoverSec === null) return
    setHoverPreview(null)
  }, [tools.hoverPreview, playing, hoverSec, setHoverPreview])

  const hoverActive = tools.hoverPreview && !playing && hoverSec !== null
  /** 预览与拆分都看黄线指的地方；黄线不在时才回到蓝线 */
  const operateSec = hoverActive && hoverSec !== null ? hoverSec : displayTime

  /** 全宽导引线：吸附目标边缘（强调蓝）+ 预览轴（黄）。挂在整块轨道内容上，跨所有行。 */
  const guides = (
    <>
      {snapGuideSec !== null ? (
        <div
          className="timeline__snap-line"
          style={{ left: LANE_GUTTER_PX + secToPx(snapGuideSec, spanSec, widthPx) }}
        />
      ) : null}
      {hoverActive ? (
        <div
          className="timeline__hover-line"
          style={{ left: LANE_GUTTER_PX + secToPx(Math.min(hoverSec ?? 0, spanSec), spanSec, widthPx) }}
        >
          <span className="timeline__hover-tag mono">{secondsToTimecode(hoverSec ?? 0, project.fps)}</span>
        </div>
      ) : null}
    </>
  )

  /** 播放头位置：夹在内容末尾之内（轨道可以更长） */
  const playheadLeft = secToPx(Math.min(displayTime, contentEndSec), spanSec, widthPx)

  const dropIndicator = (sec: number): ReactElement => (
    <div
      className="timeline__drop-indicator"
      style={{ left: secToPx(sec, spanSec, widthPx) }}
      title={sec.toFixed(3) + 's'}
    />
  )

  /** v10：切点转场标记——只画解析成功的（首段/空隙/手柄不足不出现） */
  const transitionMarkerOf = (clip: MediaClip): ReactElement | null => {
    const transition = clip.transitionIn
    if (!transition) return null
    const prev = previousMediaClipOnTrack(project.mediaClips, clip)
    const resolution = resolveTransitionDuration({
      prev,
      clip,
      prevMeta: transitionMediaMetaOf(project, prev),
      clipMeta: transitionMediaMetaOf(project, clip),
      requestedSec: transition.durationSec,
      fps: project.fps
    })
    if (!resolution.ok) return null
    const meta = TRANSITION_MAP[transition.type]
    const secLabel = String(Math.round(resolution.durationSec * 100) / 100)
    return (
      <button
        key={`transition-${clip.id}`}
        type="button"
        className={`timeline__transition-marker${clip.id === selectedMediaClipId ? ' timeline__transition-marker--selected' : ''}`}
        style={{ left: secToPx(clip.timelineStartSec, spanSec, widthPx) }}
        aria-label={TEXT.transition.marker(meta.label, secLabel)}
        title={`${meta.label} · ${secLabel}s`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          selectMediaClip(clip.id)
        }}
      >
        <span aria-hidden="true">◆</span>
        {secLabel}
      </button>
    )
  }

  return (
    <div
      className={`timeline${hoverActive ? ' timeline--hover-preview' : ''}`}
      onPointerMove={onHoverMove}
      onPointerLeave={endHover}
      onPointerUp={() => setSnapGuideSec(null)}
    >
      <div className="timeline__bar">
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            disabled={undoDepth === 0}
            title={TEXT.timeline.undoHint(undoDepth)}
            onClick={undo}
          >
            <IconUndo size={13} />
            {TEXT.timeline.undo}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            disabled={redoDepth === 0}
            title={TEXT.timeline.redoHint(redoDepth)}
            onClick={redo}
          >
            <IconRedo size={13} />
            {TEXT.timeline.redo}
          </button>
          <span className="timeline__divider" aria-hidden="true" />
          {/* 不置灰：保持可点才能把「这里没有可拆/可删的段」说给用户听 */}
          <button
            type="button"
            className="btn btn--sm"
            title={TEXT.timeline.splitHint}
            onClick={() => {
              if (!splitTargetAt(operateSec)) setNotice(TEXT.timeline.noSplitTarget)
            }}
          >
            {TEXT.timeline.splitClip}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            title={TEXT.timeline.removeTargetHint}
            onClick={() => {
              if (!removeTargetAt(displayTime)) setNotice(TEXT.timeline.noRemoveTarget)
            }}
          >
            {TEXT.timeline.removeTarget}
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
          <span className="muted">总时长 {contentEndSec.toFixed(2)}s</span>
          <span className="muted">缩放 {Math.round(zoom * 100)}%</span>
        </div>
      </div>

      <div className="timeline__scroll" ref={scrollRef}>
        <div
          className="timeline__rows"
          style={{ width: LANE_GUTTER_PX + widthPx }}
          data-px-per-sec={pxPerSec}
          data-span-sec={spanSec}
          data-content-end-sec={contentEndSec}
        >
          <div
            className={`timeline__ruler${scrubbing ? ' timeline__ruler--scrubbing' : ''}`}
            onPointerDown={beginScrub}
            onPointerMove={moveScrub}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
          >
            <span className="timeline__lane-label timeline__lane-label--ruler" aria-hidden="true" />
            <div className="timeline__lane" ref={rulerLaneRef} style={{ width: widthPx }}>
              {ticks.map((tick) => (
                <div
                  key={tick.sec}
                  className={`timeline__tick${tick.major ? ' timeline__tick--major' : ''}`}
                  style={{ left: secToPx(tick.sec, spanSec, widthPx) }}
                >
                  {tick.major ? tick.label : ''}
                </div>
              ))}
            </div>
          </div>

          {/* 媒体轨组：新增按钮在组上方；行序为数组反向（索引越大越靠上） */}
          <div className="timeline__group-actions">
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              disabled={project.mediaTracks.length >= MAX_MEDIA_TRACKS}
              title={`媒体轨最多 ${MAX_MEDIA_TRACKS} 条`}
              onClick={() => {
                if (!addMediaTrack()) setNotice(`媒体轨最多 ${MAX_MEDIA_TRACKS} 条`)
              }}
            >
              + 媒体轨
            </button>
            <span className="timeline__group-count mono">
              {project.mediaTracks.length}/{MAX_MEDIA_TRACKS}
            </span>
          </div>

          {mediaRows.map((track) => {
            const trackClips = clipsOnMediaTrack(project.mediaClips, track.id)
            const mediaIndex = project.mediaTracks.findIndex((item) => item.id === track.id)
            return (
              <div
                key={track.id}
                className={`timeline__track timeline__track--media${selectedTrackId === track.id ? ' timeline__track--selected' : ''}${
                  scrubbing ? ' timeline__track--scrubbing' : ''
                }${track.hidden ? ' timeline__track--hidden' : ''}${track.locked ? ' timeline__track--locked' : ''}${
                  drop?.kind === 'media' && drop.trackId === track.id ? ' timeline__track--dropping' : ''
                }`}
                data-track-id={track.id}
                onDragOver={(event) => onMediaDragOver(event, track)}
                onDragLeave={() => onMediaDragLeave(track.id)}
                onDrop={(event) => onMediaDrop(event, track)}
                onPointerDown={beginScrub}
                onPointerMove={moveScrub}
                onPointerUp={endScrub}
                onPointerCancel={endScrub}
              >
                <TrackHeader
                  track={track}
                  kind="media"
                  selected={selectedTrackId === track.id}
                  canMoveUp={mediaIndex < project.mediaTracks.length - 1}
                  canMoveDown={mediaIndex > 0}
                  canDelete={project.mediaTracks.length > 1}
                  onSelect={() => selectTrack(track.id)}
                  onRename={(name) => renameTrack(track.id, name)}
                  onToggleMuted={() => setTrackMuted(track.id, !track.muted)}
                  onToggleHidden={() => setTrackHidden(track.id, !track.hidden)}
                  onToggleLocked={() => setTrackLocked(track.id, !track.locked)}
                  onMoveUp={() => moveMediaTrack(track.id, mediaIndex + 1)}
                  onMoveDown={() => moveMediaTrack(track.id, mediaIndex - 1)}
                  onDelete={() => removeMediaTrack(track.id)}
                />
                <div className="timeline__lane" style={{ width: widthPx }}>
                  {trackClips.length === 0 ? <span className="timeline__empty">{TEXT.timeline.emptyMedia}</span> : null}
                  {trackClips.map((clip) => (
                    <MediaClipCard
                      key={clip.id}
                      clip={clip}
                      trackId={track.id}
                      item={project.media.find((m) => m.id === clip.mediaId) ?? null}
                      durationSec={spanSec}
                      widthPx={widthPx}
                      fps={project.fps}
                      selected={clip.id === selectedMediaClipId}
                      locked={isTrackLocked(track)}
                      onSelect={selectMediaClip}
                      onMove={(start, clientY) => handleMediaMove(clip.id, start, clientY)}
                      onTrim={(patch) => handleMediaTrim(clip.id, patch)}
                      onDragStart={() => beginCardDrag(clip.id)}
                      onCommit={commitMediaDrag}
                    />
                  ))}
                  {trackClips.map(transitionMarkerOf)}
                  {drop?.kind === 'media' && drop.trackId === track.id ? dropIndicator(drop.sec) : null}
                </div>
              </div>
            )
          })}

          {/* 字幕轨：唯一且固定，永远夹在媒体与音频之间；只允许重命名/隐藏/锁定 */}
          <div
            className={`timeline__track timeline__track--subtitle${scrubbing ? ' timeline__track--scrubbing' : ''}${
              selectedTrackId === project.subtitleTrack.id ? ' timeline__track--selected' : ''
            }${project.subtitleTrack.hidden ? ' timeline__track--hidden' : ''}${
              project.subtitleTrack.locked ? ' timeline__track--locked' : ''
            }`}
            data-track-id={project.subtitleTrack.id}
            onPointerDown={beginScrub}
            onPointerMove={moveScrub}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
          >
            <TrackHeader
              track={project.subtitleTrack}
              kind="subtitle"
              selected={selectedTrackId === project.subtitleTrack.id}
              canMoveUp={false}
              canMoveDown={false}
              canDelete={false}
              onSelect={() => selectTrack(project.subtitleTrack.id)}
              onRename={(name) => renameTrack(project.subtitleTrack.id, name)}
              onToggleHidden={() => setTrackHidden(project.subtitleTrack.id, !project.subtitleTrack.hidden)}
              onToggleLocked={() => setTrackLocked(project.subtitleTrack.id, !project.subtitleTrack.locked)}
            />
            <div className="timeline__lane" style={{ width: widthPx }}>
              {project.clips.length === 0 ? <span className="timeline__empty">{TEXT.timeline.empty}</span> : null}
              {project.clips.map((clip) => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  durationSec={spanSec}
                  widthPx={widthPx}
                  fps={project.fps}
                  selected={clip.id === selectedClipId}
                  locked={project.subtitleTrack.locked}
                  playheadSec={displayTime}
                  onSelect={selectClip}
                  onChangeTimes={(start, end) => handleClipTimes(clip.id, start, end)}
                  onDragStart={() => beginCardDrag(clip.id)}
                  onCommit={endCardDrag}
                />
              ))}
            </div>
          </div>

          {/* 音频轨组：新增按钮在组上方；同样反向（数组索引越大越靠上） */}
          <div className="timeline__group-actions">
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              disabled={project.audioTracks.length >= MAX_AUDIO_TRACKS}
              title={`音频轨最多 ${MAX_AUDIO_TRACKS} 条`}
              onClick={() => {
                if (!addAudioTrack()) setNotice(`音频轨最多 ${MAX_AUDIO_TRACKS} 条`)
              }}
            >
              + 音频轨
            </button>
            <span className="timeline__group-count mono">
              {project.audioTracks.length}/{MAX_AUDIO_TRACKS}
            </span>
          </div>

          {audioRows.map((track) => {
            const trackClips = clipsOnAudioTrack(audioClips, track.id)
            const audioIndex = project.audioTracks.findIndex((item) => item.id === track.id)
            return (
              <div
                key={track.id}
                className={`timeline__track timeline__track--audio${selectedTrackId === track.id ? ' timeline__track--selected' : ''}${
                  scrubbing ? ' timeline__track--scrubbing' : ''
                }${track.locked ? ' timeline__track--locked' : ''}${
                  drop?.kind === 'audio' && drop.trackId === track.id ? ' timeline__track--dropping' : ''
                }`}
                data-track-id={track.id}
                onDragOver={(event) => onAudioDragOver(event, track)}
                onDragLeave={() => onAudioDragLeave(track.id)}
                onDrop={(event) => onAudioDrop(event, track)}
                onPointerDown={beginScrub}
                onPointerMove={moveScrub}
                onPointerUp={endScrub}
                onPointerCancel={endScrub}
              >
                <TrackHeader
                  track={track}
                  kind="audio"
                  selected={selectedTrackId === track.id}
                  canMoveUp={audioIndex < project.audioTracks.length - 1}
                  canMoveDown={audioIndex > 0}
                  canDelete={project.audioTracks.length > 1}
                  onSelect={() => selectTrack(track.id)}
                  onRename={(name) => renameTrack(track.id, name)}
                  onToggleMuted={() => setTrackMuted(track.id, !track.muted)}
                  onToggleLocked={() => setTrackLocked(track.id, !track.locked)}
                  onMoveUp={() => moveAudioTrack(track.id, audioIndex + 1)}
                  onMoveDown={() => moveAudioTrack(track.id, audioIndex - 1)}
                  onDelete={() => removeAudioTrack(track.id)}
                />
                <div className="timeline__lane" style={{ width: widthPx }}>
                  {trackClips.length === 0 ? <span className="timeline__empty">{TEXT.timeline.emptyAudio}</span> : null}
                  {trackClips.map((clip) => (
                    <AudioClipCard
                      key={clip.id}
                      clip={clip}
                      trackId={track.id}
                      item={project.media.find((m) => m.id === clip.mediaId) ?? null}
                      durationSec={spanSec}
                      widthPx={widthPx}
                      fps={project.fps}
                      selected={clip.id === selectedAudioClipId}
                      locked={isTrackLocked(track)}
                      onSelect={selectAudioClip}
                      onMove={(start, clientY) => handleAudioMove(clip.id, start, clientY)}
                      onTrim={(patch) => trimAudioClip(clip.id, patch)}
                      onDragStart={() => beginCardDrag(clip.id)}
                      onCommit={endCardDrag}
                    />
                  ))}
                  {drop?.kind === 'audio' && drop.trackId === track.id ? dropIndicator(drop.sec) : null}
                </div>
              </div>
            )
          })}

          {guides}

          {/* 播放头：位置夹在内容末尾之内 */}
          <div
            className={`timeline__playhead timeline__playhead--rows${scrubbing ? ' timeline__playhead--scrubbing' : ''}`}
            style={{ left: LANE_GUTTER_PX + playheadLeft }}
          />
        </div>
      </div>
    </div>
  )
}
