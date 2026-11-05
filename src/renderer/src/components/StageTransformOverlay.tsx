import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import {
  mediaVideoCenter,
  mediaVideoCorners,
  mediaVideoHalfExtent,
  mediaVideoRotateHandle,
  rotationFromPointers,
  scaleFromPointer,
  snapOffset,
  type StagePoint,
  type StageSize
} from '@shared/mediaClipVideo'
import type { MediaClip, MediaClipVideo } from '@shared/types'
import { useProjectStore } from '../state/projectStore'

/**
 * 预览画面上的变换交互层（v6.1）。
 *
 * 四种操作，全部改的是**同一条媒体段**的同一组字段（面板滑杆随时能看到数字在变）：
 * - 拖四角圆点 = 以画面中心为基准缩放；
 * - 在画面内按住拖 = 平移，命中「居中 / 边对齐」时吸附并画出辅助线；
 * - 拖顶部外伸的圆点 = 旋转（0..360°，绕中心）；
 * - 拖拽过程只 write store，不做任何二次换算（公式全在 shared/mediaClipVideo）。
 *
 * 遮挡策略：只有**画面上覆盖区域**和手柄吃指针，画面外仍能点到字幕条；
 * 画面铺满整帧时如果想点字幕，用面板上的「交互」开关临时关掉这一层。
 */

type DragKind = 'pan' | 'scale' | 'rotate'

interface DragState {
  kind: DragKind
  pointerId: number
  start: StagePoint
  startOffsetX: number
  startOffsetY: number
  startScale: number
  startRotation: number
}

export interface StageTransformOverlayProps {
  clip: MediaClip
  video: MediaClipVideo
  frame: StageSize
}

export function StageTransformOverlay({ clip, video, frame }: StageTransformOverlayProps): ReactElement {
  const updateVideo = useProjectStore((state) => state.updateMediaClipVideo)
  const rootRef = useRef<SVGSVGElement | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [hud, setHud] = useState<string | null>(null)
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null })

  const toLocal = (event: { clientX: number; clientY: number }): StagePoint => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
    // svg 的 viewBox 与 frame 等尺寸，所以这里按比例换算即可（不依赖 preserveAspectRatio）
    return {
      x: ((event.clientX - rect.left) / rect.width) * frame.width,
      y: ((event.clientY - rect.top) / rect.height) * frame.height
    }
  }

  const begin = (kind: DragKind) => (event: ReactPointerEvent<SVGElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    // jsdom / 古老浏览器没有指针捕获：拿不到就退化为普通冒泡（拖拽仍然可用）
    rootRef.current?.setPointerCapture?.(event.pointerId)
    setDrag({
      kind,
      pointerId: event.pointerId,
      start: toLocal(event),
      startOffsetX: video.offsetXPercent,
      startOffsetY: video.offsetYPercent,
      startScale: video.scalePercent,
      startRotation: video.rotationDeg
    })
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const pointer = toLocal(event)
    // 拖拽期间用「按下瞬间的参数」做基准，避免逐帧叠加导致数值漂移
    const base: MediaClipVideo = {
      ...video,
      scalePercent: drag.startScale,
      offsetXPercent: drag.startOffsetX,
      offsetYPercent: drag.startOffsetY,
      rotationDeg: drag.startRotation
    }

    if (drag.kind === 'scale') {
      const scalePercent = scaleFromPointer(base, frame, drag.start, pointer)
      updateVideo(clip.id, { scalePercent })
      setHud(`${scalePercent}%`)
      return
    }

    if (drag.kind === 'rotate') {
      const rotationDeg = rotationFromPointers(base, frame, drag.start, pointer)
      updateVideo(clip.id, { rotationDeg })
      setHud(`${Math.round(rotationDeg)}°`)
      return
    }

    // pan：位移百分比 = 起点 + 指针位移 / 帧尺寸；再各自吸附
    const rawX = drag.startOffsetX + ((pointer.x - drag.start.x) / frame.width) * 100
    const rawY = drag.startOffsetY + ((pointer.y - drag.start.y) / frame.height) * 100
    const snapX = snapOffset(rawX, drag.startScale)
    const snapY = snapOffset(rawY, drag.startScale)
    updateVideo(clip.id, { offsetXPercent: snapX.value, offsetYPercent: snapY.value })
    setGuides({
      // 居中 → 画中线；边对齐 → 画被贴住的那条帧边（位移为正贴左边/上边）
      x: snapX.guide === null ? null : snapX.guide === 'center' ? frame.width / 2 : snapX.value >= 0 ? 0 : frame.width,
      y: snapY.guide === null ? null : snapY.guide === 'center' ? frame.height / 2 : snapY.value >= 0 ? 0 : frame.height
    })
    setHud(`${snapX.value.toFixed(0)}% · ${snapY.value.toFixed(0)}%`)
  }

  const end = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drag || event.pointerId !== drag.pointerId) return
    rootRef.current?.releasePointerCapture?.(event.pointerId)
    setDrag(null)
    setHud(null)
    setGuides({ x: null, y: null })
  }

  const corners = mediaVideoCorners(video, frame)
  const center = mediaVideoCenter(video, frame)
  const handle = mediaVideoRotateHandle(video, frame)
  const half = mediaVideoHalfExtent(video, frame)
  const handleRadius = Math.max(5, frame.width * 0.009)
  // 100% 缩放时四个角正好压在帧边缘：往内收一个半径，否则圆点会被 .stage__frame 裁掉半边
  const clampInside = (point: StagePoint): StagePoint => ({
    x: Math.min(Math.max(point.x, handleRadius), Math.max(handleRadius, frame.width - handleRadius)),
    y: Math.min(Math.max(point.y, handleRadius), Math.max(handleRadius, frame.height - handleRadius))
  })
  const polygon = corners.map((point) => `${point.x},${point.y}`).join(' ')
  const hudY = Math.max(14, center.y - half.y - 12)

  return (
    <svg
      ref={rootRef}
      className={`stage-interact${drag ? ' stage-interact--dragging' : ''}`}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      preserveAspectRatio="none"
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      aria-label={TEXT.videoEditor.interactHint}
      role="group"
    >
      {/* 画面轮廓 + 平移抓手：只有这块吃指针，画面以外仍然可以点字幕条 */}
      <polygon
        className="stage-interact__surface"
        points={polygon}
        onPointerDown={begin('pan')}
        aria-label={TEXT.videoEditor.offsetX}
      />

      {/* 对齐辅助线 */}
      {guides.x === null ? null : <line className="stage-interact__guide" x1={guides.x} y1={0} x2={guides.x} y2={frame.height} />}
      {guides.y === null ? null : <line className="stage-interact__guide" x1={0} y1={guides.y} x2={frame.width} y2={guides.y} />}

      {/* 旋转：上边外伸的短线 + 圆点 */}
      <line
        className="stage-interact__tether"
        x1={(corners[0]!.x + corners[1]!.x) / 2}
        y1={(corners[0]!.y + corners[1]!.y) / 2}
        x2={handle.x}
        y2={handle.y}
      />
      <circle
        className="stage-interact__rotate"
        cx={handle.x}
        cy={handle.y}
        r={Math.max(6, frame.width * 0.012)}
        onPointerDown={begin('rotate')}
        role="button"
        aria-label={TEXT.videoEditor.rotation}
      />

      {/* 四角缩放圆点 */}
      {corners.map((corner, index) => {
        const at = clampInside(corner)
        return (
          <circle
            key={index}
            className="stage-interact__handle"
            cx={at.x}
            cy={at.y}
            r={handleRadius}
            onPointerDown={begin('scale')}
            role="button"
            aria-label={`${TEXT.videoEditor.scale} ${index + 1}`}
          />
        )
      })}

      {/* 中心十字：缩放的基准点，也是“原始中心”的可视锚 */}
      <g className="stage-interact__anchor">
        <line x1={center.x - 5} y1={center.y} x2={center.x + 5} y2={center.y} />
        <line x1={center.x} y1={center.y - 5} x2={center.x} y2={center.y + 5} />
      </g>

      {hud ? (
        <text className="stage-interact__hud" x={center.x} y={hudY} textAnchor="middle">
          {hud}
        </text>
      ) : null}
    </svg>
  )
}
