/**
 * 时间轴「车道」坐标换算（拖拽/刮擦/悬停/落点共用）。
 *
 * 关键约束：**卡片画在哪里，指针就按哪里换算**。
 * 卡片、刻度、落点线、播放头都是相对 `.timeline__lane` 的绝对定位元素，
 * 所以指针 → 秒必须用同一块矩形的 left/width；一旦改用轨道本身
 * （`getBoundingClientRect()` 含 1px 边框 + 56px 左标签内边距、且宽度多 58px），
 * 换算出来的秒数就和画出来的位置差一个固定比例，拖到右侧会越拖越偏。
 */

export interface LaneBox {
  left: number
  width: number
}

/** 车道矩形的屏幕几何；元素未挂载或宽度为 0（首帧前）时返回 null。 */
export function laneBoxOf(lane: Element | null): LaneBox | null {
  if (!lane) return null
  const rect = lane.getBoundingClientRect()
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.width) || rect.width <= 0) return null
  return { left: rect.left, width: rect.width }
}

/** 指针 X → 时间轴秒，夹在 `[0, durationSec]`。 */
export function secAtClientX(clientX: number, box: LaneBox, durationSec: number): number {
  if (box.width <= 0 || !(durationSec > 0)) return 0
  const offset = clientX - box.left
  if (!Number.isFinite(offset)) return 0
  return Math.min(durationSec, Math.max(0, (offset / box.width) * durationSec))
}

/** 当前比例尺（px/秒）。轨道总宽 = 时长 × 比例尺，所以两者相除即可。 */
export function pxPerSecOf(durationSec: number, widthPx: number): number {
  if (!(durationSec > 0) || !(widthPx > 0)) return 0
  return widthPx / durationSec
}

/**
 * 从卡片自身实时反推车道矩形（拖拽期间每次移动都重算）。
 *
 * 不能用按下时的快照：轨道一旦横向滚动，车道左缘会跟着 scrollLeft 移动，
 * 快照坐标会让拖拽偏移正好等于滚动距离。卡片是车道的绝对定位子元素，
 * 所以「卡片屏幕左缘 − 卡片 style.left」永远等于车道屏幕左缘。
 */
export function laneBoxFromCard(card: HTMLElement | null, widthPx: number): LaneBox | null {
  if (!card || !(widthPx > 0)) return null
  const rect = card.getBoundingClientRect()
  const styleLeft = Number.parseFloat(card.style.left)
  if (!Number.isFinite(rect.left) || !Number.isFinite(styleLeft)) return null
  return { left: laneOriginOf(rect.left, styleLeft), width: widthPx }
}

/**
 * 由「卡片自身的屏幕左缘 − 卡片在车道内的 left」反推车道原点。
 *
 * 卡片是车道的绝对定位子元素（`left: secToPx(start)`），所以两者相减就是车道原点；
 * 这样卡片组件不必知道车道元素，也保证换算基准与渲染基准来自同一次布局。
 */
export function laneOriginOf(cardLeftPx: number, cardOffsetPx: number): number {
  return cardLeftPx - cardOffsetPx
}
