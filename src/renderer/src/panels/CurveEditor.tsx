import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { CURVE_MAX_POINTS, curveSamples, normalizeCurve, straightCurve } from '@shared/mediaClipVideo'
import type { CurvePoint, MediaClipCurves } from '@shared/types'

/**
 * 自由打点曲线编辑器（亮度 / R / G / B 四条）。
 *
 * 交互（与设计软件一致，不需要说明文字）：
 * - 空白处按下 → 在按下位置新增一个控制点，并直接进入拖拽；
 * - 按住控制点拖动 → 改它的 y（端点 x 锁定在 0 / 1，中间点的 x 夹在左右邻居之间，顺序不会乱）；
 * - 双击中间的控制点 → 删除（端点不可删）；
 * - 「复位」把当前通道打回直线。
 *
 * 坐标系：SVG 视图内的 x 向右、y 向下；数据里的 y 是「输出亮度」，所以显示时要翻过来。
 */

export type CurveChannel = 'master' | 'r' | 'g' | 'b'

const CHANNELS: { key: CurveChannel; label: string; color: string }[] = [
  { key: 'master', label: TEXT.videoEditor.curveMaster, color: '#e8e8ea' },
  { key: 'r', label: 'R', color: '#ff6b6b' },
  { key: 'g', label: 'G', color: '#6ccb8b' },
  { key: 'b', label: 'B', color: '#6ba8ff' }
]

const VIEW = 100

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function activePoints(curves: MediaClipCurves, channel: CurveChannel): CurvePoint[] {
  return curves[channel]
}

export interface CurveEditorProps {
  curves: MediaClipCurves
  onChange: (curves: MediaClipCurves) => void
}

export function CurveEditor({ curves, onChange }: CurveEditorProps): ReactElement {
  const [channel, setChannel] = useState<CurveChannel>('master')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const points = activePoints(curves, channel)
  const color = CHANNELS.find((item) => item.key === channel)?.color ?? '#e8e8ea'

  const write = (next: CurvePoint[]): void => {
    onChange({ ...curves, [channel]: normalizeCurve(next) })
  }

  /** 指针 → 数据坐标（x / y 都是 0..1，y 已翻转） */
  const toValue = (event: { clientX: number; clientY: number }): CurvePoint => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01(1 - (event.clientY - rect.top) / rect.height)
    }
  }

  const movePoint = (index: number, value: CurvePoint): void => {
    const minX = index === 0 ? 0 : points[index - 1]!.x + 0.01
    const maxX = index === points.length - 1 ? 1 : points[index + 1]!.x - 0.01
    const x = index === 0 ? 0 : index === points.length - 1 ? 1 : Math.min(maxX, Math.max(minX, value.x))
    write(points.map((point, i) => (i === index ? { x, y: value.y } : point)))
  }

  const addPoint = (value: CurvePoint): void => {
    if (points.length >= CURVE_MAX_POINTS) return
    const normalized = normalizeCurve([...points, value])
    const index = normalized.findIndex((point) => Math.abs(point.x - value.x) < 1e-3)
    onChange({ ...curves, [channel]: normalized })
    if (index >= 0) setDragIndex(index)
  }

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const target = event.target as SVGElement
    const raw = target.getAttribute('data-point')
    if (raw === null) {
      addPoint(toValue(event))
      event.preventDefault()
      return
    }
    setDragIndex(Number(raw))
    event.preventDefault()
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (dragIndex === null) return
    movePoint(dragIndex, toValue(event))
  }

  const endDrag = (): void => setDragIndex(null)

  const removePoint = (index: number): void => {
    // 端点（x=0 / x=1）不可删，否则曲线会失去定义域
    if (index <= 0 || index >= points.length - 1) return
    write(points.filter((_, i) => i !== index))
  }

  const polyline = useMemo(() => {
    const samples = curveSamples(points, 64)
    return samples.map((y, index) => `${(index / 64) * VIEW},${(1 - y) * VIEW}`).join(' ')
  }, [points])

  return (
    <div className="stack stack--tight">
      <div className="segmented" role="group" aria-label={TEXT.videoEditor.curves}>
        {CHANNELS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`segmented__item${channel === item.key ? ' segmented__item--active' : ''}`}
            aria-pressed={channel === item.key}
            onClick={() => setChannel(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <svg
        ref={svgRef}
        className="curve-editor"
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        role="application"
        aria-label={`${TEXT.videoEditor.curves} · ${CHANNELS.find((item) => item.key === channel)?.label ?? ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerCancel={endDrag}
      >
        {[0.25, 0.5, 0.75].map((tick) => (
          <g key={tick} className="curve-editor__grid">
            <line x1={tick * VIEW} y1="0" x2={tick * VIEW} y2={VIEW} />
            <line x1="0" y1={tick * VIEW} x2={VIEW} y2={tick * VIEW} />
          </g>
        ))}
        <line className="curve-editor__base" x1="0" y1={VIEW} x2={VIEW} y2="0" />
        <polyline className="curve-editor__line" points={polyline} stroke={color} />
        {points.map((point, index) => (
          <circle
            key={`${index}-${point.x}`}
            className={`curve-editor__point${dragIndex === index ? ' curve-editor__point--active' : ''}`}
            data-point={index}
            cx={point.x * VIEW}
            cy={(1 - point.y) * VIEW}
            r={dragIndex === index ? 3.4 : 2.6}
            fill={color}
            onDoubleClick={() => removePoint(index)}
          />
        ))}
      </svg>

      <div className="curve-editor__readout mono">
        {points.map((point, index) => (
          <span key={`${index}-${point.x}`}>
            {index > 0 ? ' · ' : ''}
            {point.x.toFixed(2)},{point.y.toFixed(2)}
          </span>
        ))}
      </div>

      <button
        type="button"
        className="btn btn--sm btn--subtle"
        disabled={points.length === 2 && points[0]!.y === 0 && points[1]!.y === 1}
        onClick={() => onChange({ ...curves, [channel]: straightCurve() })}
      >
        {TEXT.videoEditor.resetCurve}
      </button>
    </div>
  )
}
