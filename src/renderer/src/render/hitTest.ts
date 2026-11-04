import type { RenderJobSpec } from '@shared/types'
import { motionAt } from './animation'
import { sweepOf, visibleSpanX } from './layers'

/**
 * 预览命中测试（「在预览区域点击字幕条即选中该片段」）。
 *
 * 三条硬要求：
 * - 只认**当下真正可见**的像素：片段区间外、擦除尚未盖到的部分都不算命中，
 *   否则用户会点到一块透明的区域却被选中；
 * - 与绘制用同一份擦除线（`sweepOf`），保证「看到的位置 = 点得到的位置」；
 * - 纯函数、坐标全部是原生分辨率像素，与显示层 DPR / CSS 缩放无关（规格 §4.3）。
 *
 * 叠放顺序与绘制一致：后画的片段在上层，命中时从后往前找。
 */

export interface HitPoint {
  x: number
  y: number
}

/** 命中容差（原生像素）：细装饰线与小字也点得中，1 像素线不至于点不到 */
export const HIT_SLOP_PX = 2

const HITTABLE_KINDS = new Set(['bar', 'block', 'rule', 'text'])

export function hitTestClips(
  spec: RenderJobSpec,
  frame: number,
  point: HitPoint,
  slopPx: number = HIT_SLOP_PX
): string | null {
  for (let clipIndex = spec.clips.length - 1; clipIndex >= 0; clipIndex -= 1) {
    const clip = spec.clips[clipIndex]
    if (!clip || !clip.selected) continue
    if (frame < clip.startFrame || frame >= clip.endFrame) continue
    const motion = motionAt(clip.animation, frame - clip.startFrame)
    if (!motion.visible) continue
    const root = clip.boxes[0]
    if (!root) continue
    const sweep = sweepOf(motion, root)

    for (let boxIndex = clip.boxes.length - 1; boxIndex >= 0; boxIndex -= 1) {
      const box = clip.boxes[boxIndex]
      if (!box || !HITTABLE_KINDS.has(box.kind)) continue
      if (box.w <= 0 || box.h <= 0) continue
      if (point.y < box.y - slopPx || point.y > box.y + box.h + slopPx) continue
      const rightPx = sweep.rightPx
      // 装饰线自身还有生长比例（ruleReveal）：还没长到的地方同样不该被点到
      const grownRight =
        box.kind === 'rule'
          ? box.x + box.w * Math.max(0, Math.min(1, motion.ruleReveal))
          : box.x + box.w
      const span = visibleSpanX(box, sweep.leftPx, Math.min(rightPx, grownRight))
      if (!span) continue
      if (point.x < span.left - slopPx || point.x > span.left + span.width + slopPx) continue
      return clip.id
    }
  }
  return null
}

/**
 * 显示坐标 → 原生像素坐标。
 * 显示 Canvas 只做等比缩放（`stage.blitTo`），所以这里用「显示矩形 → 目标分辨率」的线性映射，
 * 不读 devicePixelRatio：DPR 只影响显示层，原生坐标由目标分辨率决定（规格 §4.3 / 纪律 6）。
 */
export function displayToNative(
  point: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  native: { width: number; height: number }
): HitPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const x = ((point.clientX - rect.left) / rect.width) * native.width
  const y = ((point.clientY - rect.top) / rect.height) * native.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}
