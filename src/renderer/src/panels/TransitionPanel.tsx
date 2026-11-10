import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { TEXT } from '@shared/i18n'
import {
  DEFAULT_TRANSITION_DURATION_SEC,
  TRANSITION_MAP,
  transitionsByFamily,
  type TransitionMeta
} from '@shared/transitions'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 左侧「转场」Tab（v11）。
 *
 * 交互契约（用户明确要求）：
 * - 转场**不再**是「点片段后在片段检查器里选类型」，而是一个独立的样式面板；
 * - 长按（280ms）样式卡进入拖拽，指针移动时面板只负责跟随的幽灵元素；
 *   时间轴负责把「指针下的合法切点」写进 `uiStore.transitionDropClipId`，
 *   松手时读它落库（Timeline 拥有几何，面板不重复算坐标）；
 * - 拖到空隙/轨道外等非法位置：不写工程，只给一条提示；
 * - 已经选中某个转场时，**单击**样式卡 = 直接替换该切点上的类型（保持时长）；
 *   没选中时单击只提示怎么用，避免用户以为「点一下就对某个片段生效」。
 *
 * 长按判定与拖拽阈值都导出成常量，测试用假时钟即可完整覆盖这段生命周期。
 */

/** 长按进入拖拽的毫秒数（短于它只算普通点击） */
export const TRANSITION_LONG_PRESS_MS = 280
/** 长按前的允许抖动（px）：手指/鼠标轻微晃动不算拖拽，仍可正常点击 */
export const TRANSITION_DRAG_TOLERANCE_PX = 8
/** 时间轴缝隙命中区的选择器（Timeline 渲染，面板松手时用它复核落点） */
export const TRANSITION_JUNCTION_SELECTOR = '[data-transition-junction]'

export interface JunctionHitTest {
  clipId: string | null
}

/** jsdom 没有 `elementFromPoint`：先探测再绑定，避免在测试环境里直接抛 TypeError。 */
function defaultElementFromPoint(): ((x: number, y: number) => Element | null) | undefined {
  if (typeof document === 'undefined') return undefined
  const fromPoint = (document as Document & { elementFromPoint?: (x: number, y: number) => Element | null })
    .elementFromPoint
  if (typeof fromPoint !== 'function') return undefined
  return fromPoint.bind(document)
}

/**
 * 松手位置 → 缝隙所属右侧片段 id。
 * 抽成纯函数（可注入 elementFromPoint）便于测试；真实浏览器里拖拽期间缝隙命中区
 * 由 CSS 打开 `pointer-events`，所以 ghost（pointer-events: none）不会挡住命中。
 */
export function junctionClipIdAtPoint(
  clientX: number,
  clientY: number,
  elementFromPoint: ((x: number, y: number) => Element | null) | undefined = defaultElementFromPoint()
): JunctionHitTest {
  if (!elementFromPoint) return { clipId: null }
  const element = elementFromPoint(clientX, clientY)
  const junction = element?.closest?.(TRANSITION_JUNCTION_SELECTOR) ?? null
  const clipId = junction instanceof HTMLElement ? (junction.dataset.clipId ?? null) : null
  return { clipId: clipId && clipId.length > 0 ? clipId : null }
}

interface PressState {
  meta: TransitionMeta
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  timer: number | null
}

interface DragListeners {
  move: (event: PointerEvent) => void
  up: (event: PointerEvent) => void
  cancel: () => void
}

export function TransitionPanel(): ReactElement {
  const transitionCount = useProjectStore(
    (state) => state.project.mediaClips.filter((clip) => clip.transitionIn !== undefined).length
  )
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [pressedType, setPressedType] = useState<string | null>(null)
  const pressRef = useRef<PressState | null>(null)
  const armedRef = useRef(false)
  const listenersRef = useRef<DragListeners | null>(null)
  /** 拖拽松手会补发一次 click：用它吞掉，避免「拖完又触发一次点击替换」 */
  const suppressClickRef = useRef(false)

  const cleanupListeners = useCallback((): void => {
    const listeners = listenersRef.current
    if (!listeners) return
    window.removeEventListener('pointermove', listeners.move)
    window.removeEventListener('pointerup', listeners.up)
    window.removeEventListener('pointercancel', listeners.cancel)
    listenersRef.current = null
  }, [])

  /** 清掉一次长按（定时器 + 监听 + 幽灵 + store 拖拽态），但不写工程。 */
  const abortPress = useCallback((): void => {
    const press = pressRef.current
    pressRef.current = null
    armedRef.current = false
    if (press?.timer !== null && press?.timer !== undefined) window.clearTimeout(press.timer)
    cleanupListeners()
    setGhost(null)
    setDragging(false)
    setPressedType(null)
    if (useUiStore.getState().transitionDrag !== null) useUiStore.getState().endTransitionDrag()
  }, [cleanupListeners])

  /** 松手：armed = 真的进入过长按拖拽（否则就是普通点击，什么都不做）。 */
  const finishPress = useCallback(
    (armed: boolean, clientX: number, clientY: number): void => {
      const press = pressRef.current
      pressRef.current = null
      armedRef.current = false
      if (press?.timer !== null && press?.timer !== undefined) window.clearTimeout(press.timer)
      cleanupListeners()
      setGhost(null)
      setDragging(false)
      setPressedType(null)
      if (!armed || !press) return
      // 吞掉紧随其后的 click（长按拖拽不应再被当成「点样式替换」）
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)

      const ui = useUiStore.getState()
      // 优先按松手位置现场复核（指针最后一次移动与抬起可能不在同一像素）
      const { clipId } = junctionClipIdAtPoint(clientX, clientY)
      const targetClipId = clipId ?? ui.transitionDropClipId
      ui.endTransitionDrag()
      if (!targetClipId) {
        ui.setNotice(TEXT.transition.dropInvalid)
        return
      }
      const store = useProjectStore.getState()
      // 缝隙上已有转场时沿用它的时长：拖新样式过来只换效果，不重置用户调好的时长
      const existing = store.project.mediaClips.find((item) => item.id === targetClipId)?.transitionIn
      const applied = store.setMediaClipTransition(targetClipId, {
        type: press.meta.type,
        durationSec: existing?.durationSec ?? DEFAULT_TRANSITION_DURATION_SEC
      })
      if (!applied) {
        ui.setNotice(TEXT.transition.rejected)
        return
      }
      store.selectTransition(targetClipId)
      ui.setNotice(TEXT.transition.added(TRANSITION_MAP[press.meta.type].label))
    },
    [cleanupListeners]
  )

  const beginPress = (event: ReactPointerEvent<HTMLButtonElement>, meta: TransitionMeta): void => {
    if (event.button !== 0) return
    abortPress()
    const press: PressState = {
      meta,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      timer: null
    }
    pressRef.current = press
    setPressedType(meta.type)

    const onMove = (move: PointerEvent): void => {
      const current = pressRef.current
      if (!current || move.pointerId !== current.pointerId) return
      current.lastX = move.clientX
      current.lastY = move.clientY
      if (!armedRef.current) {
        // 长按还没成立就移动超阈值：按普通滚动/点击处理，不进入拖拽
        const dx = move.clientX - current.startX
        const dy = move.clientY - current.startY
        if (Math.hypot(dx, dy) > TRANSITION_DRAG_TOLERANCE_PX) abortPress()
        return
      }
      move.preventDefault()
      setGhost({ x: move.clientX, y: move.clientY, label: current.meta.label })
    }
    const onUp = (up: PointerEvent): void => {
      if (up.pointerId !== pressRef.current?.pointerId) return
      finishPress(armedRef.current, up.clientX, up.clientY)
    }
    const onCancel = (): void => abortPress()
    listenersRef.current = { move: onMove, up: onUp, cancel: onCancel }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)

    press.timer = window.setTimeout(() => {
      const current = pressRef.current
      if (!current) return
      armedRef.current = true
      setDragging(true)
      useUiStore.getState().beginTransitionDrag({ type: current.meta.type, label: current.meta.label })
      setGhost({ x: current.lastX, y: current.lastY, label: current.meta.label })
    }, TRANSITION_LONG_PRESS_MS)
  }

  /** 普通单击：已选中转场 → 原地替换类型；否则提示用法。 */
  const handleStyleClick = (meta: TransitionMeta): void => {
    if (suppressClickRef.current) return
    const state = useProjectStore.getState()
    const clipId = state.selectedTransitionClipId
    const clip = clipId ? state.project.mediaClips.find((item) => item.id === clipId) ?? null : null
    if (clip?.transitionIn) {
      const applied = state.setMediaClipTransition(clip.id, {
        type: meta.type,
        durationSec: clip.transitionIn.durationSec
      })
      if (applied) useUiStore.getState().setNotice(TEXT.transition.replaced(meta.label))
      return
    }
    useUiStore.getState().setNotice(TEXT.transition.dragFirst)
  }

  // 卸载时收拾残留：定时器、window 监听、幽灵与 uiStore 里的拖拽态
  useEffect(() => {
    return () => {
      const press = pressRef.current
      if (press?.timer !== null && press?.timer !== undefined) window.clearTimeout(press.timer)
      cleanupListeners()
      if (useUiStore.getState().transitionDrag !== null) useUiStore.getState().endTransitionDrag()
    }
  }, [cleanupListeners])

  return (
    <div className={`transition-panel${dragging ? ' transition-panel--dragging' : ''}`}>
      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.transition.panelTitle}</span>
          <span className="chip chip--accent">{transitionCount > 0 ? transitionCount : '0'}</span>
        </div>
        <span className="muted">{TEXT.transition.panelHint}</span>
        <span className="muted transition-panel__count">{TEXT.transition.panelCount(transitionCount)}</span>

        {transitionsByFamily().map((group) => (
          <div key={group.family} className="transition-panel__group">
            <div className="facet-label">{group.label}</div>
            <div className="transition-panel__grid" role="group" aria-label={group.label}>
              {group.transitions.map((meta) => (
                <button
                  key={meta.type}
                  type="button"
                  className={`transition-style${pressedType === meta.type ? ' transition-style--pressed' : ''}`}
                  data-transition-type={meta.type}
                  aria-label={meta.label}
                  title={`${meta.label}：长按拖到两个片段之间的缝隙`}
                  onPointerDown={(event) => beginPress(event, meta)}
                  onClick={() => handleStyleClick(meta)}
                >
                  <span className="transition-style__glyph" aria-hidden="true">
                    ⇄
                  </span>
                  <span className="transition-style__label">{meta.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}

        <span className="muted transition-panel__hint">{TEXT.transition.deleteKeyHint}</span>
      </section>

      {ghost
        ? createPortal(
            <div
              className="transition-drag-ghost"
              style={{ left: `${ghost.x}px`, top: `${ghost.y}px` }}
              aria-hidden="true"
            >
              <span aria-hidden="true">⇄</span>
              {ghost.label}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
