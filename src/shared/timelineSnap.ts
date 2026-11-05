/**
 * 时间轴「自动吸附」的纯几何（主/渲染/测试共用）。
 *
 * 口径：
 * - 吸附窗口是**像素**定的（`TIMELINE_SNAP_PX`），换算成秒时随「轨道宽度 / 总时长」变化，
 *   所以拉宽/缩窄时间轴时手感一致，不会出现窄轨吸得太远、宽轨吸不住的情况；
 * - 候选边缘 = 每条片段的首/尾 + 时间轴 0 点（被拖的那条自己不能当候选，否则会贴住自己）；
 * - 整段平移时**首尾各试一次**，取位移更小的那个，实现「左边贴住或右边贴住」都行；
 * - 关掉开关时上层根本不会调用这些函数——拖动完全自由，不做任何取整以外的修正。
 */

/** 吸附触发距离（像素） */
export const TIMELINE_SNAP_PX = 10

/** 像素窗口 → 秒（轨道宽度/总时长线性对应；参数非法时返回 0 = 不吸附） */
export function snapWindowSec(widthPx: number, durationSec: number, px = TIMELINE_SNAP_PX): number {
  if (!(widthPx > 0) || !(durationSec > 0) || !(px > 0)) return 0
  return (px / widthPx) * durationSec
}

export interface TimelineEdgeSource {
  id: string
  start: number
  end: number
}

/** 收集候选边缘（升序去重）：所有片段首尾 + 0 点，排除被拖的那条 */
export function collectSnapEdges(sources: TimelineEdgeSource[], excludeId?: string): number[] {
  const edges = new Set<number>([0])
  for (const source of sources) {
    if (excludeId !== undefined && source.id === excludeId) continue
    edges.add(round3(source.start))
    edges.add(round3(source.end))
  }
  return [...edges].sort((a, b) => a - b)
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** 最近的候选边缘；没有落在窗口内的返回 null */
export function nearestEdge(value: number, edges: number[], windowSec: number): number | null {
  if (!(windowSec > 0)) return null
  let best: number | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const edge of edges) {
    const delta = Math.abs(edge - value)
    if (delta <= windowSec && delta < bestDelta) {
      bestDelta = delta
      best = edge
    }
  }
  return best
}

export interface EdgeSnap {
  value: number
  /** 命中的目标边缘（秒），给界面画高亮竖线用；没吸附时为 null */
  guideSec: number | null
}

/** 单边吸附（拖入点 / 拖出点）：值贴到最近边缘 */
export function snapEdge(value: number, edges: number[], windowSec: number): EdgeSnap {
  const edge = nearestEdge(value, edges, windowSec)
  if (edge === null) return { value, guideSec: null }
  return { value: edge, guideSec: edge }
}

export interface MoveSnap extends EdgeSnap {
  /** 起点 */
  value: number
}

/**
 * 整段平移吸附：起点贴某个边缘、终点贴某个边缘各算一次，取位移更小的方案。
 * 结果夹在 [0, maxEndSec - length]，不会把片段推出轨道。
 */
export function snapMove(
  start: number,
  length: number,
  edges: number[],
  windowSec: number,
  maxEndSec: number
): MoveSnap {
  const startEdge = nearestEdge(start, edges, windowSec)
  const endEdge = nearestEdge(start + length, edges, windowSec)
  let candidate = start
  let guideSec: number | null = null

  if (startEdge !== null && endEdge !== null) {
    const startCost = Math.abs(startEdge - start)
    const endCost = Math.abs(endEdge - (start + length))
    if (startCost <= endCost) {
      candidate = startEdge
      guideSec = startEdge
    } else {
      candidate = endEdge - length
      guideSec = endEdge
    }
  } else if (startEdge !== null) {
    candidate = startEdge
    guideSec = startEdge
  } else if (endEdge !== null) {
    candidate = endEdge - length
    guideSec = endEdge
  }

  const upper = Math.max(0, maxEndSec - length)
  return { value: Math.max(0, Math.min(upper, candidate)), guideSec }
}
