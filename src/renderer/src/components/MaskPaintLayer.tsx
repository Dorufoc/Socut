import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { MASK_MAX_POINTS_PER_STROKE } from '@shared/projectSchema'
import { TEXT } from '@shared/i18n'
import type { MaskStroke } from '@shared/types'
import { maskLineWidthPx, maskPointDistance, maskPointToPixels, normalizeMaskPoint } from '../render/maskCapture'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * M8：预览画面上的手绘遮罩画笔层。
 *
 * 放在 `.stage__frame` 里、与媒体层同坐标（inset 0），只在画笔模式渲染：
 * 1. pointerdown 落笔、pointermove 采点（归一化 0..1，按距离抽稀防爆点）、
 *    pointerup 提交——**一次 pointerup = 一次 store 写入 = 一个撤销步**；
 * 2. 提交时把这一笔 append 到该段已有 strokes 后面，再整体交给
 *    `setMediaClipMask`（归一化/上限/同值去重都在 store/schema 里，这里不重复实现）；
 * 3. 拖动期间用 SVG 画半透明预览（hide 黑 / restore 白），松手即清空草稿；
 * 4. 本层 z-index 高于字幕 Canvas 与画面交互层，所以画笔模式下点选/拖拽手柄被挡住。
 */

/** 采点最小间距（归一化）：小于它视为同一像素，避免一笔画出一屏点。 */
export const MASK_POINT_MIN_DISTANCE = 0.0025

export interface MaskPaintLayerProps {
  /** 正在画的媒体段 id */
  clipId: string
  mode: MaskStroke['mode']
  /** 笔刷半径（画面宽度百分比） */
  radiusPct: number
  /** 画面框像素尺寸（只用于线宽换算与实时预览坐标系；数据本身与像素无关） */
  width: number
  height: number
  /** 退出画笔（Esc）→ 由 PreviewStage 复位 uiStore */
  onExit?: () => void
}

/** 单点落笔也要显示成圆点（与 maskCapture 的 arc 口径一致）。 */
function draftColor(mode: MaskStroke['mode']): string {
  // 半透明预览：hide 黑（要抹掉的地方）/ restore 白（擦回来的地方）
  return mode === 'hide' ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.62)'
}

export function MaskPaintLayer({ clipId, mode, radiusPct, width, height, onExit }: MaskPaintLayerProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const drawingRef = useRef(false)
  const pointsRef = useRef<Array<{ x: number; y: number }>>([])
  const [draft, setDraft] = useState<Array<{ x: number; y: number }>>([])

  /** 取画面框的 client 坐标：jsdom / 未布局时退回组件自己的尺寸（原点 0,0）。 */
  const rectOf = (): { left: number; top: number; width: number; height: number } => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (rect && rect.width > 0 && rect.height > 0) {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    }
    return { left: 0, top: 0, width, height }
  }

  const pointOf = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } | null =>
    normalizeMaskPoint(event.clientX, event.clientY, rectOf())

  const stopDrawing = (): void => {
    drawingRef.current = false
    pointsRef.current = []
    setDraft([])
  }

  const finishStroke = useCallback(() => {
    const points = pointsRef.current
    if (!drawingRef.current && points.length === 0) return
    drawingRef.current = false
    pointsRef.current = []
    setDraft([])
    if (points.length === 0) return
    // 一次 pointerup = 一次 store 写入（一次 revision）；append 到已有笔画之后
    const store = useProjectStore.getState()
    const clip = store.project.mediaClips.find((item) => item.id === clipId)
    if (!clip) return
    const strokes = [...(clip.mask?.strokes ?? []), { mode, radiusPct, points }]
    // 新笔画必须继承该段已有的羽化/反向设置（否则画第二笔会把「反向遮罩」悄悄丢回白底）
    const featherPct = clip.mask?.featherPct ?? 0
    store.setMediaClipMask(clipId, {
      strokes,
      ...(featherPct > 0 ? { featherPct } : {}),
      ...(clip.mask?.invert === true ? { invert: true } : {})
    })
  }, [clipId, mode, radiusPct])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const point = pointOf(event)
    if (!point) return
    event.preventDefault()
    drawingRef.current = true
    pointsRef.current = [point]
    setDraft([point])
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // 某些环境（jsdom / 旧浏览器）没有指针捕获：拖动仍能靠 move 事件继续
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drawingRef.current) return
    const point = pointOf(event)
    if (!point) return
    const points = pointsRef.current
    if (points.length >= MASK_MAX_POINTS_PER_STROKE) return
    const last = points[points.length - 1]
    if (last && maskPointDistance(last, point) < MASK_POINT_MIN_DISTANCE) return
    points.push(point)
    setDraft([...points])
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drawingRef.current) return
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // 同上：没有捕获就不需要释放
    }
    finishStroke()
  }

  const onPointerCancel = (): void => {
    // 取消（触屏被系统打断等）：丢弃这一笔，不写工程
    stopDrawing()
  }

  // Esc 退出画笔（与检查器里的「退出画笔」同一入口）；[ / ] 调笔刷大小（不打断正在画的这一笔）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        stopDrawing()
        onExit?.()
        return
      }
      // M8：键盘调笔刷（与检查器滑杆同一个 clamp；步进 1% 画面宽）
      if (event.key !== '[' && event.key !== ']') return
      event.preventDefault()
      const ui = useUiStore.getState()
      const radiusPct = ui.maskPaint.radiusPct + (event.key === ']' ? 1 : -1)
      ui.setMaskBrush({ radiusPct })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  // 切段/换模式时丢掉未提交草稿（只清本地状态，不写工程）
  useEffect(() => {
    stopDrawing()
  }, [clipId, mode, radiusPct])

  const lineWidth = maskLineWidthPx(radiusPct, width)
  const color = draftColor(mode)
  const draftPixels = draft.map((point) => maskPointToPixels(point, width, height))

  return (
    <div
      ref={rootRef}
      className="stage__mask-paint"
      style={{ touchAction: 'none' }}
      data-mask-clip={clipId}
      aria-label={TEXT.mask.paintHint}
      title={TEXT.mask.paintHint}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <svg width={width} height={height} viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`} aria-hidden="true">
        {draftPixels.length === 1 ? (
          <circle cx={draftPixels[0]!.x} cy={draftPixels[0]!.y} r={lineWidth / 2} fill={color} />
        ) : draftPixels.length > 1 ? (
          <polyline
            points={draftPixels.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={lineWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </svg>
      <span className="stage__mask-paint__hint">{TEXT.mask.paintHint}</span>
    </div>
  )
}
