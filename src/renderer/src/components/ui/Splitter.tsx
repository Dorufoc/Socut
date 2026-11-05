import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { SPLITTER_KEY_STEP_PX, type PaneEdge } from '@shared/paneLayout'

/**
 * 分隔线（WinUI 3 风格的 GridSplitter）。
 *
 * 契约：
 * - 只有 `value/min/max/defaultValue` 这些**像素**是外部口径，组件自己只算「指针位移 → 目标像素」；
 * - 拖拽过程中调用 `onLiveResize`（父级直接写 CSS 变量，不走 React 状态，保证逐帧跟手）；
 * - 抬手 / 键盘微调 / 双击复位才调用 `onCommit`（写状态 + 持久化）；
 * - 实时读数由父级的 `hudText` 生成，和真正生效的几何同源，不会显示与实际不一致的数字。
 *
 * 位移方向：`invert = true` 表示受治理区域与指针方向相反（例如拖动右栏左边界时，
 * 指针右移挤压的是右栏自己）。
 */

export interface SplitterProps {
  edge: PaneEdge
  orientation: 'vertical' | 'horizontal'
  label: string
  /** 受治理区域的当前像素 */
  value: number
  min: number
  max: number
  /** 双击复位的落点 */
  defaultValue: number
  invert: boolean
  /** 键盘单次移动量（Shift 再 ×4） */
  step?: number
  onLiveResize: (px: number) => void
  onCommit: (px: number) => void
  hudText: (px: number) => string
}

interface DragState {
  pointerId: number
  startClient: number
  startPx: number
}

export function Splitter({
  edge,
  orientation,
  label,
  value,
  min,
  max,
  defaultValue,
  invert,
  step = SPLITTER_KEY_STEP_PX,
  onLiveResize,
  onCommit,
  hudText
}: SplitterProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const hudRef = useRef<HTMLSpanElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [dragging, setDragging] = useState(false)

  const lower = Math.min(min, max)
  const upper = Math.max(min, max)

  const clampPx = useCallback(
    (px: number): number => Math.round(Math.min(upper, Math.max(lower, px))),
    [lower, upper]
  )

  const clientOf = useCallback(
    (event: { clientX: number; clientY: number }): number => (orientation === 'vertical' ? event.clientX : event.clientY),
    [orientation]
  )

  /** 指针位移 → 目标像素（方向系数吸收 invert，其余钳制逻辑与纯几何一致）。 */
  const pxOfClient = useCallback(
    (client: number): number => {
      const drag = dragRef.current
      if (!drag) return clampPx(value)
      return clampPx(drag.startPx + (client - drag.startClient) * (invert ? -1 : 1))
    },
    [clampPx, invert, value]
  )

  const paintHud = useCallback(
    (px: number): void => {
      const hud = hudRef.current
      if (hud) hud.textContent = hudText(px)
    },
    [hudText]
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // 只认主键：中键/侧键留给系统滚动
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = { pointerId: event.pointerId, startClient: clientOf(event), startPx: clampPx(value) }
    hostRef.current?.setPointerCapture(event.pointerId)
    event.currentTarget.focus({ preventScroll: true })
    setDragging(true)
    paintHud(clampPx(value))
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const px = pxOfClient(clientOf(event))
    onLiveResize(px)
    paintHud(px)
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const px = pxOfClient(clientOf(event))
    dragRef.current = null
    if (hostRef.current?.hasPointerCapture(event.pointerId)) {
      hostRef.current.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
    onCommit(px)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 方向按「指针往哪儿动」理解：竖线认左右，横线认上下，各自只沿自己的轴
    const lineDelta =
      orientation === 'vertical'
        ? (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0)
        : (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)
    if (lineDelta === 0) return
    event.preventDefault()
    const magnitude = lineDelta * step * (event.shiftKey ? 4 : 1) * (invert ? -1 : 1)
    onCommit(clampPx(value + magnitude))
  }

  const now = clampPx(value)

  return (
    <div
      ref={hostRef}
      className={`splitter splitter--${orientation}${dragging ? ' splitter--active' : ''}`}
      data-edge={edge}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={Math.round(lower)}
      aria-valuemax={Math.round(upper)}
      aria-valuenow={now}
      aria-valuetext={hudText(now)}
      title={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(clampPx(defaultValue))}
    >
      <span className="splitter__grip" aria-hidden="true" />
      <span className="splitter__hud" ref={hudRef} aria-hidden="true" />
      {dragging ? <span className={`splitter__shield splitter__shield--${orientation}`} aria-hidden="true" /> : null}
    </div>
  )
}
