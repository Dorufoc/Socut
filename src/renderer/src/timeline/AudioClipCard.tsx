import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { snapTimeToFrame } from '@shared/fps'
import { MIN_AUDIO_CLIP_SEC } from '@shared/audioClips'
import { secToPx } from './ruler'
import { laneBoxFromCard, secAtClientX } from './lane'
import type { AudioClip, Fps, MediaItem } from '@shared/types'

/**
 * 音频轨上的片段卡（v3 多轨）。
 *
 * 与媒体段卡同一套拖拽手感（整段平移 / 拖入出点），但**不画缩略图**：
 * 音频没有画面，这里用「时长指示条」——底纹是等距竖条的波形示意，
 * 宽度即片段在时间轴上的占比，长度读数和名称放同一行。
 * 卡片直接填满所在轨道行（不再按 layer 切分高度）。
 */

export interface AudioClipCardProps {
  clip: AudioClip
  /** v3：片段所属音频轨（卡片填满整行） */
  trackId: string
  item: MediaItem | null
  durationSec: number
  widthPx: number
  fps: Fps
  selected: boolean
  /** 轨道锁定：不开始拖动/修剪（仍可选中查看） */
  locked?: boolean
  onSelect: (id: string) => void
  /** 第二个参数是指针 Y：上层据此命中另一条轨道实现跨轨拖拽 */
  onMove: (timelineStartSec: number, clientY: number) => void
  onTrim: (patch: { timelineStartSec?: number; timelineEndSec?: number }) => void
  /** 按下时回调：上层在这一刻快照吸附候选边缘，拖拽途中不再重算 */
  onDragStart?: () => void
  onCommit?: () => void
}

type Edge = 'in' | 'out' | 'move'

interface DragState {
  edge: Edge
  /** 按下时指针相对卡片左缘的偏移，整段平移时用它抵消「按住的是卡片中间」 */
  grabOffsetPx: number
  start: number
  end: number
}

export function AudioClipCard({
  clip,
  trackId,
  item,
  durationSec,
  widthPx,
  fps,
  selected,
  locked = false,
  onSelect,
  onMove,
  onTrim,
  onDragStart,
  onCommit
}: AudioClipCardProps): ReactElement {
  const dragRef = useRef<DragState | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const left = secToPx(clip.timelineStartSec, durationSec, widthPx)
  const right = secToPx(clip.timelineEndSec, durationSec, widthPx)
  const name = item?.name ?? '（素材已移出）'

  const begin = (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>): void => {
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    if (rect.width <= 0) return
    onSelect(clip.id)
    // 锁定轨道：只允许选中，不开始拖拽/修剪；仍要吞掉事件，避免触发轨道刮擦
    if (locked) {
      event.stopPropagation()
      return
    }
    dragRef.current = {
      edge,
      grabOffsetPx: event.clientX - rect.left,
      start: clip.timelineStartSec,
      end: clip.timelineEndSec
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
    onDragStart?.()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    // 绝对换算（与媒体段同口径）：指针位置直接映射成秒，不累计位移
    // 每次移动都用卡片当前位置反推车道原点：横向滚动后快照坐标会整体偏一个 scrollLeft
    const box = laneBoxFromCard(cardRef.current, widthPx)
    if (!box) return
    if (drag.edge === 'move') {
      onMove(
        snapTimeToFrame(secAtClientX(event.clientX - drag.grabOffsetPx, box, durationSec), fps),
        event.clientY
      )
      return
    }
    if (drag.edge === 'in') {
      const candidate = snapTimeToFrame(
        Math.min(drag.end - MIN_AUDIO_CLIP_SEC, secAtClientX(event.clientX, box, durationSec)),
        fps
      )
      if (candidate !== drag.start) onTrim({ timelineStartSec: candidate })
      return
    }
    const candidate = snapTimeToFrame(
      Math.max(drag.start + MIN_AUDIO_CLIP_SEC, secAtClientX(event.clientX, box, durationSec)),
      fps
    )
    if (candidate !== drag.end) onTrim({ timelineEndSec: candidate })
  }

  const end = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    // 拖拽收尾：点段落不再顺手把播放头带过来（P5），只管选中与拖拽
    onCommit?.()
  }

  return (
    <div
      ref={cardRef}
      data-clip-id={clip.id}
      data-track-id={trackId}
      className={`audio-clip-card${selected ? ' audio-clip-card--selected' : ''}${item ? '' : ' audio-clip-card--orphan'}${
        locked ? ' audio-clip-card--locked' : ''
      }`}
      style={{
        left,
        width: Math.max(24, right - left)
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
