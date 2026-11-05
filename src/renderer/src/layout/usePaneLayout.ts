import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from 'react'
import { TEXT } from '@shared/i18n'
import {
  DEFAULT_PANE_PX,
  PANE_LIMITS,
  SPLITTER_PX,
  defaultRatios,
  edgeSign,
  formatPaneHud,
  maxLeftPx,
  maxRightPx,
  movePane,
  paneRatios,
  resolvePaneSizes,
  timelineBounds,
  type PaneEdge,
  type PaneMetrics,
  type PaneRatios,
  type PaneSizes
} from '@shared/paneLayout'
import type { SplitterProps } from '../components/ui/Splitter'
import { readPaneRatios, writePaneRatios } from './panePrefs'

/**
 * 三栏 + 下方轨道的伸缩布局控制器。
 *
 * 状态只有两样：容器实测尺寸（ResizeObserver）与三条比例（用户偏好）。
 * 像素每次由「比例 × 实测尺寸」解算，所以窗口缩放、换分辨率都自动跟随。
 *
 * 拖拽走「命令式」路径：pointermove 只写 `.shell` 上的 CSS 变量与分隔线上的读数，
 * 不进 React 状态——预览 Canvas、右侧几十个控件不会跟着逐帧重渲染，手感才跟得住；
 * 抬手时一次性把像素换算回比例落状态并持久化，React 与 DOM 从此同源。
 */

const CSS_VAR_LEFT = '--pane-left'
const CSS_VAR_RIGHT = '--pane-right'
const CSS_VAR_TIMELINE = '--pane-timeline'

const UNMEASURED: PaneMetrics = { width: 0, height: 0, splitter: SPLITTER_PX }

/** 实测尺寸到位前先空着，让样式表里的 `var(--pane-left, 300px)` 兜住首帧。 */
export type ShellStyle = CSSProperties & Partial<Record<'--pane-left' | '--pane-right' | '--pane-timeline', string>>

export interface PaneLayout {
  /** 挂在 `.shell` 上：既是 CSS 变量宿主，也是测量目标 */
  shellRef: RefObject<HTMLDivElement | null>
  shellStyle: ShellStyle
  sizes: PaneSizes
  metrics: PaneMetrics
  /** 容器尚未测得时尺寸为 0，此时不应允许拖拽 */
  ready: boolean
  splitterProps: (edge: PaneEdge) => SplitterProps
  resetLayout: () => void
}

function applySizes(element: HTMLElement | null, sizes: PaneSizes): void {
  if (!element) return
  element.style.setProperty(CSS_VAR_LEFT, `${sizes.left}px`)
  element.style.setProperty(CSS_VAR_RIGHT, `${sizes.right}px`)
  element.style.setProperty(CSS_VAR_TIMELINE, `${sizes.timeline}px`)
}

export function usePaneLayout(): PaneLayout {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [metrics, setMetrics] = useState<PaneMetrics>(UNMEASURED)
  const [ratios, setRatios] = useState<PaneRatios | null>(() => readPaneRatios())

  const sizes = useMemo(() => resolvePaneSizes(ratios ?? defaultRatios(metrics), metrics), [metrics, ratios])
  const ready = metrics.width >= 1 && metrics.height >= 1

  /** 拖拽基准：静止时与 state 同步；拖拽中逐帧改写为「当前实时尺寸」（不触发渲染）。 */
  const sizesRef = useRef<PaneSizes>(sizes)
  const metricsRef = useRef<PaneMetrics>(metrics)
  useEffect(() => {
    sizesRef.current = sizes
    metricsRef.current = metrics
    // 静止态也补写一次：让 DOM 上的变量与 state 永远同源，拖拽路径与渲染路径不会各说一套
    if (ready) applySizes(shellRef.current, sizes)
  }, [metrics, ready, sizes])

  useEffect(() => {
    const element = shellRef.current
    if (!element) return
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      setMetrics((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height, splitter: SPLITTER_PX }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const resolveLive = useCallback((edge: PaneEdge, px: number): PaneSizes => {
    return movePane(edge, px, sizesRef.current, metricsRef.current)
  }, [])

  const hudText = useCallback(
    (edge: PaneEdge, px: number): string =>
      formatPaneHud(edge, resolveLive(edge, px), metricsRef.current, TEXT.layout.labels),
    [resolveLive]
  )

  const onLiveResize = useCallback(
    (edge: PaneEdge, px: number): void => {
      const next = resolveLive(edge, px)
      sizesRef.current = next
      applySizes(shellRef.current, next)
    },
    [resolveLive]
  )

  const onCommit = useCallback(
    (edge: PaneEdge, px: number): void => {
      const currentMetrics = metricsRef.current
      const next = resolveLive(edge, px)
      sizesRef.current = next
      applySizes(shellRef.current, next)
      const committed = paneRatios(next, currentMetrics)
      setRatios(committed)
      writePaneRatios(committed)
    },
    [resolveLive]
  )

  const resetLayout = useCallback((): void => {
    sizesRef.current = resolvePaneSizes(defaultRatios(metricsRef.current), metricsRef.current)
    applySizes(shellRef.current, sizesRef.current)
    setRatios(null)
    writePaneRatios(null)
  }, [])

  const splitterProps = useCallback(
    (edge: PaneEdge): SplitterProps => {
      // 容器未测得时 sizes 全为 0，上下限收敛到同一点：测得尺寸前拖不动，也不会拖出负宽
      const atRest = sizes
      const bounds = timelineBounds(metrics)
      const spec =
        edge === 'left'
          ? {
              orientation: 'vertical' as const,
              label: TEXT.layout.splitterLeft,
              value: atRest.left,
              min: PANE_LIMITS.leftMin,
              max: maxLeftPx(atRest, metrics),
              defaultValue: DEFAULT_PANE_PX.left
            }
          : edge === 'right'
            ? {
                orientation: 'vertical' as const,
                label: TEXT.layout.splitterRight,
                value: atRest.right,
                min: PANE_LIMITS.rightMin,
                max: maxRightPx(atRest, metrics),
                defaultValue: DEFAULT_PANE_PX.right
              }
            : {
                orientation: 'horizontal' as const,
                label: TEXT.layout.splitterTimeline,
                value: atRest.timeline,
                min: bounds.min,
                max: bounds.max,
                defaultValue: DEFAULT_PANE_PX.timeline
              }
      return {
        edge,
        orientation: spec.orientation,
        label: spec.label,
        value: spec.value,
        min: spec.min,
        max: spec.max,
        defaultValue: spec.defaultValue,
        invert: edgeSign(edge) === -1,
        onLiveResize: (px: number) => onLiveResize(edge, px),
        onCommit: (px: number) => onCommit(edge, px),
        hudText: (px: number) => hudText(edge, px)
      }
    },
    [hudText, metrics, onCommit, onLiveResize, sizes]
  )

  const shellStyle = useMemo((): ShellStyle => {
    if (!ready) return {}
    return {
      [CSS_VAR_LEFT]: `${sizes.left}px`,
      [CSS_VAR_RIGHT]: `${sizes.right}px`,
      [CSS_VAR_TIMELINE]: `${sizes.timeline}px`
    } as ShellStyle
  }, [ready, sizes])

  return { shellRef, shellStyle, sizes, metrics, ready, splitterProps, resetLayout }
}
