/**
 * 时间轴「不推挤」的夹取规则（纯函数，单位秒；帧吸附由调用方负责）。
 *
 * 产品语义（对齐剪映专业版）：一段只能在**它当前所在的空档**里移动或伸缩，
 * 撞到邻居就贴住边界停住，绝不把邻居推开。想换位置必须先腾出空档。
 */

export interface TimelineSpan {
  startSec: number
  endSec: number
}

const EPS = 1e-9

/**
 * 某一段左右两侧的空档边界。
 *
 * 只统计「完全在它左边」和「完全在它右边」的同层邻居：
 * 已经与它重叠的历史数据不会参与夹取，否则用户永远无法把这段拖回合法位置。
 */
export function gapAround(self: TimelineSpan, others: TimelineSpan[]): { startSec: number; endSec: number } {
  let startSec = 0
  let endSec = Number.POSITIVE_INFINITY
  for (const other of others) {
    if (other.endSec <= self.startSec + EPS) startSec = Math.max(startSec, other.endSec)
    else if (other.startSec >= self.endSec - EPS) endSec = Math.min(endSec, other.startSec)
  }
  return { startSec, endSec }
}

/** 平移：保持长度，夹在空档内；空档比片段还窄时贴左边界（不会越界）。 */
export function clampMoveToGap(
  startSec: number,
  lengthSec: number,
  gapStartSec: number,
  gapEndSec: number
): number {
  const latest = Math.max(gapStartSec, gapEndSec - Math.max(0, lengthSec))
  return Math.min(latest, Math.max(gapStartSec, startSec))
}

/** 拖左边界：不越过左侧邻居，也不越过最短时长。 */
export function clampTrimStart(startSec: number, gapStartSec: number, latestStartSec: number): number {
  return Math.min(latestStartSec, Math.max(gapStartSec, startSec))
}

/** 拖右边界：不越过右侧邻居，也不短于最短时长。 */
export function clampTrimEnd(endSec: number, earliestEndSec: number, gapEndSec: number): number {
  return Math.max(earliestEndSec, Math.min(gapEndSec, endSec))
}

/**
 * 新建片段（拖入/粘贴）：从期望起点往后找第一个放得下的空档。
 *
 * 与「推挤」不同，这里只选位置、不改别人：落点被占就顺延到它后面，
 * 直到轨道上限都放不下就返回 null（由调用方提示放不下）。
 */
export function firstFreeStart(
  desiredStartSec: number,
  lengthSec: number,
  occupied: TimelineSpan[],
  maxEndSec: number = Number.POSITIVE_INFINITY
): number | null {
  const sorted = occupied
    .filter((span) => span.endSec - span.startSec > EPS)
    .sort((a, b) => a.startSec - b.startSec)
  let cursor = Math.max(0, desiredStartSec)
  for (const span of sorted) {
    if (span.endSec <= cursor + EPS) continue
    if (cursor + lengthSec <= span.startSec + EPS) break
    cursor = Math.max(cursor, span.endSec)
  }
  return cursor + lengthSec > maxEndSec + EPS ? null : cursor
}
