import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { acceptBezier, bezierSamples, type BezierTuple } from '@shared/bezier'
import { TEXT } from '@shared/i18n'

/**
 * M6-D：可视化贝塞尔曲线编辑器（可拖拽手柄）。
 *
 * 画的是 cubic-bezier(x1,y1,x2,y2) 从 (0,0) 到 (1,1) 的曲线；两个控制点 p1/p2 可拖。
 * 纪律与 `shared/bezier` 完全一致：
 * - x 夹在 [0,1]（CSS 要求 x 单调）；
 * - y 也夹在 [0,1]（产品禁止过冲，`acceptBezier` 会再校验一次；非法值不写回）；
 * - 拖动过程用本地 draft 渲染，松手时统一 `acceptBezier` 校验后交给 `onChange`。
 *
 * 数值输入框仍在下方保留（精确输入与曲线拖动互补）。
 */

const SIZE = 132
const PAD = 14

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value)

export interface BezierEditorProps {
  value: BezierTuple
  onChange: (next: BezierTuple) => void
}

/** 指针位置 → 归一化曲线坐标（x∈[0,1], y∈[0,1]，y 向上）。抽出来便于测试。 */
export function pointerToBezierPoint(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  const x = (clientX - rect.left) / rect.width
  const y = 1 - (clientY - rect.top) / rect.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: clamp01(x), y: clamp01(y) }
}

function toPx(x: number, y: number): { cx: number; cy: number } {
  const span = SIZE - PAD * 2
  return { cx: PAD + span * x, cy: SIZE - PAD - span * y }
}

export function BezierEditor({ value, onChange }: BezierEditorProps): ReactElement {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<0 | 1 | null>(null)
  const [draft, setDraft] = useState<BezierTuple | null>(null)
  const display = draft ?? value

  const begin = (index: 0 | 1) => (event: ReactPointerEvent<SVGCircleElement>): void => {
    event.stopPropagation()
    // jsdom 的 SVG 元素没有指针捕获；真实浏览器里有（测试环境绕过）
    const capture = event.currentTarget.setPointerCapture
    if (typeof capture === 'function') capture.call(event.currentTarget, event.pointerId)
    dragRef.current = index
    setDraft(value)
  }

  const move = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const index = dragRef.current
    const svg = svgRef.current
    if (index === null || !svg) return
    const point = pointerToBezierPoint(svg.getBoundingClientRect(), event.clientX, event.clientY)
    if (!point) return
    const next: BezierTuple =
      index === 0
        ? [point.x, point.y, display[2], display[3]]
        : [display[0], display[1], point.x, point.y]
    // y 过冲在这里并不会出现（指针已被夹进 [0,1]），但曲线可能不单调 → acceptBezier 兜底
    const accepted = acceptBezier(next)
    setDraft(accepted ?? next)
  }

  const end = (): void => {
    if (dragRef.current === null) return
    dragRef.current = null
    const next = draft
    setDraft(null)
    if (!next) return
    const accepted = acceptBezier(next)
    if (accepted) onChange(accepted)
  }

  const samples = bezierSamples(display, 48)
  const path = samples
    .map((sample, index) => {
      const { cx, cy } = toPx(sample.x, sample.y)
      return `${index === 0 ? 'M' : 'L'}${cx.toFixed(2)} ${cy.toFixed(2)}`
    })
    .join(' ')

  const start = toPx(0, 0)
  const finish = toPx(1, 1)
  const p1 = toPx(display[0], display[1])
  const p2 = toPx(display[2], display[3])

  return (
    <svg
      ref={svgRef}
      className="bezier-editor"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="group"
      aria-label={TEXT.keyframes.bezierEditor}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {/* 网格：4×4，淡线 */}
      {[0.25, 0.5, 0.75].map((step) => {
        const v = toPx(step, 0)
        const h = toPx(0, step)
        return (
          <g key={step} className="bezier-editor__grid">
            <line x1={v.cx} y1={PAD} x2={v.cx} y2={SIZE - PAD} />
            <line x1={PAD} y1={h.cy} x2={SIZE - PAD} y2={h.cy} />
          </g>
        )
      })}
      {/* 手柄连线 */}
      <line className="bezier-editor__handle-line" x1={start.cx} y1={start.cy} x2={p1.cx} y2={p1.cy} />
      <line className="bezier-editor__handle-line" x1={finish.cx} y1={finish.cy} x2={p2.cx} y2={p2.cy} />
      {/* 曲线 */}
      <path className="bezier-editor__curve" d={path} />
      {/* 端点 */}
      <circle className="bezier-editor__anchor" cx={start.cx} cy={start.cy} r={3} />
      <circle className="bezier-editor__anchor" cx={finish.cx} cy={finish.cy} r={3} />
      {/* 控制点 */}
      <circle
        className="bezier-editor__control"
        data-bezier-handle="0"
        cx={p1.cx}
        cy={p1.cy}
        r={5}
        onPointerDown={begin(0)}
      />
      <circle
        className="bezier-editor__control"
        data-bezier-handle="1"
        cx={p2.cx}
        cy={p2.cy}
        r={5}
        onPointerDown={begin(1)}
      />
    </svg>
  )
}
