/**
 * 主界面伸缩布局的纯几何（渲染层与测试共用同一口径）。
 *
 * 为什么以「比例」为持久化单位、以「像素」为工作单位：
 * - 比例（fraction）与窗口分辨率无关，换机器/换窗口大小后仍还原成观感一致的布局；
 * - 拖拽、钳制、HUD 读数都要落到像素，像素由 `比例 × 当前容器尺寸` 每次解算得出。
 *
 * 三条分隔线各自治理一个区域（`PaneEdge`）：
 * - `left`：左栏宽（中栏反向跟随）；
 * - `right`：右栏宽（中栏反向跟随）；
 * - `timeline`：下方时间轴高（上方预览区反向跟随）——拖动同一条线即同时改变两区，
 *   这就是需求里的「双向拖拽」：区间总高固定，一方变高另一方必然变矮。
 */

/** 分隔条厚度：CSS 变量 `--splitter-size` 与此必须一致，否则解算出的像素会累积误差。 */
export const SPLITTER_PX = 7

/** 键盘方向键单次的移动量（像素）。 */
export const SPLITTER_KEY_STEP_PX = 12

/** 持久化结构版本：字段口径变化时升版本，旧数据直接忽略而不是猜。 */
export const PANE_PREFS_VERSION = 1

/** 可拖拽区域：左栏宽 / 右栏宽 / 时间轴高。 */
export type PaneEdge = 'left' | 'right' | 'timeline'

/** 布局中的五个矩形（像素，四舍五入后即为写入 CSS 变量的值）。 */
export interface PaneSizes {
  left: number
  center: number
  right: number
  /** 上方预览区（含播放控制条）的高度 */
  stage: number
  /** 下方时间轴高度 */
  timeline: number
}

/** 持久化的比例：`left/right` 相对容器宽，`timeline` 相对容器高。 */
export interface PaneRatios {
  left: number
  right: number
  timeline: number
}

/** 容器实测尺寸（`.shell`：三栏 + 两条竖分隔线 / 预览区 + 一条横分隔线 + 时间轴）。 */
export interface PaneMetrics {
  width: number
  height: number
  splitter: number
}

export interface PaneLimits {
  leftMin: number
  leftMax: number
  rightMin: number
  rightMax: number
  /** 中栏（预览）保底宽：两侧不能把它挤没 */
  centerMin: number
  /** 上区（预览）保底高 */
  stageMin: number
  timelineMin: number
  /** 时间轴绝对上限（超过它即使预览还放得下也不给拖） */
  timelineMax: number
}

/** 冷启动默认尺寸（与历史固定布局一致，避免首帧观感跳变）。 */
export const DEFAULT_PANE_PX: { left: number; right: number; timeline: number } = {
  left: 300,
  right: 344,
  timeline: 232
}

/**
 * 下限取值参考主窗口 `minWidth: 1100 / minHeight: 700`：
 * 最小窗口下 232 + 360 + 268 + 14 = 874 ≤ 1100，220 + 180 + 7 = 407 ≤ 700 − 标题栏 − 状态栏，
 * 因此保底尺寸永远互相兼容，不会挤出重叠。
 */
export const PANE_LIMITS: PaneLimits = {
  leftMin: 232,
  leftMax: 520,
  rightMin: 268,
  rightMax: 560,
  centerMin: 360,
  stageMin: 220,
  timelineMin: 180,
  timelineMax: 560
}

/** 无存档且容器尚未测到尺寸时的参考基准（比例回退用）。 */
export const REFERENCE_METRICS: PaneMetrics = {
  width: 1440,
  height: 700,
  splitter: SPLITTER_PX
}

/** HUD 与无障碍读数用到的区域名（由渲染层传入，保持本模块与文案解耦）。 */
export interface PaneLabels {
  left: string
  center: string
  right: string
  stage: string
  timeline: string
}

function clampNum(value: number, min: number, max: number): number {
  if (!(max >= min)) return min
  return Math.min(max, Math.max(min, value))
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 三栏可用的净宽（扣掉两条竖分隔线）。 */
export function usableWidth(metrics: PaneMetrics): number {
  return Math.max(0, metrics.width - metrics.splitter * 2)
}

/** 上下两区可用的净高（扣掉一条横分隔线）。 */
export function usableHeight(metrics: PaneMetrics): number {
  return Math.max(0, metrics.height - metrics.splitter)
}

/**
 * 拖拽方向系数：鼠标向「正方向」移动时，被治理区域是变大还是变小。
 * `left` 向右拖加宽左栏；`right` 与 `timeline` 恰好相反（向右/向下挤压的是自己）。
 */
export function edgeSign(edge: PaneEdge): 1 | -1 {
  return edge === 'left' ? 1 : -1
}

/** 竖排：左/右栏在保住中栏保底宽之后的各自上限（供分隔线的 min/max 与无障碍读数用）。 */
export function maxLeftPx(sizes: PaneSizes, metrics: PaneMetrics, limits: PaneLimits = PANE_LIMITS): number {
  const cap = usableWidth(metrics) - limits.centerMin - sizes.right
  return Math.max(limits.leftMin, Math.min(limits.leftMax, cap))
}

export function maxRightPx(sizes: PaneSizes, metrics: PaneMetrics, limits: PaneLimits = PANE_LIMITS): number {
  const cap = usableWidth(metrics) - limits.centerMin - sizes.left
  return Math.max(limits.rightMin, Math.min(limits.rightMax, cap))
}

/** 横排：时间轴在上区保底高与自身上限之间的可行区间。 */
export function timelineBounds(metrics: PaneMetrics, limits: PaneLimits = PANE_LIMITS): { min: number; max: number } {
  const max = Math.max(limits.timelineMin, Math.min(limits.timelineMax, usableHeight(metrics) - limits.stageMin))
  return { min: Math.min(limits.timelineMin, max), max }
}

/**
 * 把两栏收进「可用宽 − 中栏保底」的预算里。
 * 先按各自的富余量（当前值减下限）等比例回收，两边都退到下限仍放不下时，
 * 才按下限比例整体缩放——此时中栏让位到 0，也绝不把分隔线画出容器。
 */
function fitColumns(
  left: number,
  right: number,
  usable: number,
  limits: PaneLimits
): { left: number; right: number } {
  const budget = Math.max(0, usable - limits.centerMin)
  if (left + right <= budget) return { left, right }

  const surplus = left + right - budget
  const slackLeft = Math.max(0, left - limits.leftMin)
  const slackRight = Math.max(0, right - limits.rightMin)
  const slack = slackLeft + slackRight
  if (slack >= surplus && slack > 0) {
    return {
      left: left - surplus * (slackLeft / slack),
      right: right - surplus * (slackRight / slack)
    }
  }

  const floorSum = limits.leftMin + limits.rightMin
  const scale = floorSum > 0 ? Math.min(1, usable / floorSum) : 0
  return { left: limits.leftMin * scale, right: limits.rightMin * scale }
}

/** 由已解算好的两侧宽度得出中栏：先四舍五入两栅，中栏吃掉余量，总宽恒等容器（不产生空隙或溢出）。 */
function columns(
  left: number,
  right: number,
  metrics: PaneMetrics
): { left: number; center: number; right: number } {
  const usable = Math.round(usableWidth(metrics))
  const roundedLeft = Math.max(0, Math.round(left))
  const roundedRight = Math.max(0, Math.round(right))
  return {
    left: roundedLeft,
    right: roundedRight,
    center: Math.max(0, usable - roundedLeft - roundedRight)
  }
}

/** 同理：时间轴取整后，上区吃掉余量，两区之和不超出容器高。 */
function rows(timeline: number, metrics: PaneMetrics): { stage: number; timeline: number } {
  const usable = Math.round(usableHeight(metrics))
  const roundedTimeline = Math.min(usable, Math.max(0, Math.round(timeline)))
  return { timeline: roundedTimeline, stage: Math.max(0, usable - roundedTimeline) }
}

/** 由比例解算出五个矩形的像素（容器未测得时返回 0，由调用方决定是否落到默认值）。 */
export function resolvePaneSizes(
  ratios: PaneRatios,
  metrics: PaneMetrics,
  limits: PaneLimits = PANE_LIMITS
): PaneSizes {
  const usable = usableWidth(metrics)
  const leftWant = clampNum(ratios.left * metrics.width, limits.leftMin, limits.leftMax)
  const rightWant = clampNum(ratios.right * metrics.width, limits.rightMin, limits.rightMax)
  const fitted = fitColumns(leftWant, rightWant, usable, limits)
  const bounds = timelineBounds(metrics, limits)
  const timeline = clampNum(ratios.timeline * metrics.height, bounds.min, bounds.max)
  return { ...columns(fitted.left, fitted.right, metrics), ...rows(timeline, metrics) }
}

/** 冷启动（无存档）：默认像素经同一套钳制后转比例，与拖拽路径完全同口径。 */
export function defaultRatios(
  metrics: PaneMetrics,
  limits: PaneLimits = PANE_LIMITS
): PaneRatios {
  if (metrics.width < 1 || metrics.height < 1) return defaultReferenceRatios()
  const bounds = timelineBounds(metrics, limits)
  const fitted = fitColumns(
    clampNum(DEFAULT_PANE_PX.left, limits.leftMin, limits.leftMax),
    clampNum(DEFAULT_PANE_PX.right, limits.rightMin, limits.rightMax),
    usableWidth(metrics),
    limits
  )
  const center = Math.max(0, usableWidth(metrics) - fitted.left - fitted.right)
  return paneRatios(
    {
      left: fitted.left,
      right: fitted.right,
      center,
      timeline: clampNum(DEFAULT_PANE_PX.timeline, bounds.min, bounds.max),
      stage: 0
    },
    metrics
  )
}

/** 比例形式的默认值（仅在容器尺寸不可用时兜底）。 */
export function defaultReferenceRatios(limits: PaneLimits = PANE_LIMITS): PaneRatios {
  return defaultRatios(REFERENCE_METRICS, limits)
}

/** 像素 → 比例（提交拖拽结果时调用；分母不可用时原样返回安全默认）。 */
export function paneRatios(sizes: PaneSizes, metrics: PaneMetrics): PaneRatios {
  const ratios: PaneRatios = {
    left: metrics.width > 0 ? sizes.left / metrics.width : 0,
    right: metrics.width > 0 ? sizes.right / metrics.width : 0,
    timeline: metrics.height > 0 ? sizes.timeline / metrics.height : 0
  }
  return {
    left: roundRatio(ratios.left),
    right: roundRatio(ratios.right),
    timeline: roundRatio(ratios.timeline)
  }
}

function roundRatio(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000
}

/**
 * 拖拽落点：把被治理区域拉到 `desiredPx`，邻居按总预算反向跟随（同一条线改两个区）。
 * 结果一定是合法矩形——即使窗口被拖得比下限还窄，也只会退到「谁都不越界」的分配。
 */
export function movePane(
  edge: PaneEdge,
  desiredPx: number,
  sizes: PaneSizes,
  metrics: PaneMetrics,
  limits: PaneLimits = PANE_LIMITS
): PaneSizes {
  const usable = usableWidth(metrics)
  if (edge === 'left') {
    const left = clampNum(desiredPx, limits.leftMin, maxLeftPx(sizes, metrics, limits))
    const right = Math.min(sizes.right, Math.max(limits.rightMin, usable - limits.centerMin - left))
    const fitted = fitColumns(left, right, usable, limits)
    return { ...sizes, ...columns(fitted.left, fitted.right, metrics) }
  }
  if (edge === 'right') {
    const right = clampNum(desiredPx, limits.rightMin, maxRightPx(sizes, metrics, limits))
    const left = Math.min(sizes.left, Math.max(limits.leftMin, usable - limits.centerMin - right))
    const fitted = fitColumns(left, right, usable, limits)
    return { ...sizes, ...columns(fitted.left, fitted.right, metrics) }
  }
  const bounds = timelineBounds(metrics, limits)
  return { ...sizes, ...rows(clampNum(desiredPx, bounds.min, bounds.max), metrics) }
}

/**
 * 任意 JSON（localStorage 里的历史值 / 手工改坏的文件）→ 合法比例；不可用时 null。
 * 与 `normalizeProject` 同一套容错口径：越界夹到区间，脏字段整条丢弃。
 */
export function normalizePaneRatios(raw: unknown): PaneRatios | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const version = finiteOr(record['version'], PANE_PREFS_VERSION)
  if (Math.round(version) !== PANE_PREFS_VERSION) return null
  const out: number[] = []
  for (const key of ['left', 'right', 'timeline'] as const) {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    if (value < 0 || value > 1) return null
    out.push(roundRatio(value))
  }
  const [left, right, timeline] = out
  if (left === undefined || right === undefined || timeline === undefined) return null
  return { left, right, timeline }
}

/** 序列化：版本 + 三条比例（渲染层持久化的唯一形状）。 */
export function serializePaneRatios(ratios: PaneRatios): string {
  return JSON.stringify({ version: PANE_PREFS_VERSION, ...ratios })
}

/** 单个区域的读数：`素材栏 320px（22%）`。 */
function panePart(label: string, px: number, total: number): string {
  const percent = total > 0 ? Math.round((px / total) * 100) : 0
  return `${label} ${Math.round(px)}px（${percent}%）`
}

/**
 * 拖拽过程中的实时读数：同时显示被治理区域与它的邻居，
 * 用户一眼能确认「这条线改的是哪两块」，而不是只看一个数字猜。
 */
export function formatPaneHud(
  edge: PaneEdge,
  sizes: PaneSizes,
  metrics: PaneMetrics,
  labels: PaneLabels
): string {
  const width = sizes.left + sizes.center + sizes.right
  const height = sizes.stage + sizes.timeline
  if (edge === 'left') {
    return `${panePart(labels.left, sizes.left, width)} · ${panePart(labels.center, sizes.center, width)}`
  }
  if (edge === 'right') {
    return `${panePart(labels.center, sizes.center, width)} · ${panePart(labels.right, sizes.right, width)}`
  }
  return `${panePart(labels.stage, sizes.stage, height)} · ${panePart(labels.timeline, sizes.timeline, height)}`
}
