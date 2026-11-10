import { resolveClipParams, type ResolvedClipParams } from '@shared/keyframes'
import type { LayoutBox, RenderJobSpec } from '@shared/types'
import { motionAt } from './animation'
import { contentAnchorOf, contentBoundsOf, sweepOf, visibleSpanX } from './layers'

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

/** 不透明度低于这个值时视为不可点（几乎全透明的像素谈不上"看得见"）。 */
export const HIT_MIN_OPACITY = 0.02

/**
 * 画布坐标 → 片段局部坐标（关键帧变换的逆变换）。
 *
 * 绘制侧的变换（renderer.ts）是：先平移到 `锚点 + 位移`，再旋转，再缩放，最后平移回 `-锚点`，
 * 即 `p' = A + S·R·(p − anchor)`。命中测试必须在局部坐标里做，否则关键帧把条块挪走/放大后，
 * 用户点到的"看到的位置"与命中的盒会整体错开（M6 遗留问题）。
 * 无关键帧（`hasAny = false`）时原样返回，零开销。
 */
function toLocalPoint(
  point: HitPoint,
  params: ResolvedClipParams,
  anchor: { cx: number; cy: number },
  frame: { width: number; height: number }
): HitPoint | null {
  if (!params.hasAny) return point
  const scale = params.scalePct / 100
  if (!(scale > 1e-6)) return null
  const ax = anchor.cx + (frame.width * params.offsetXPct) / 100
  const ay = anchor.cy + (frame.height * params.offsetYPct) / 100
  const dx = point.x - ax
  const dy = point.y - ay
  if (params.rotationDeg === 0) return { x: anchor.cx + dx / scale, y: anchor.cy + dy / scale }
  const radians = (params.rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // R⁻¹：(x, y) → (x·cos + y·sin, −x·sin + y·cos)
  return {
    x: anchor.cx + (dx * cos + dy * sin) / scale,
    y: anchor.cy + (-dx * sin + dy * cos) / scale
  }
}

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
    // M6：关键帧在这一帧的参数 → 把点反变换回局部坐标（与绘制同一套锚点/顺序）
    const span = clip.endFrame - clip.startFrame
    const progress = span > 0 ? (frame - clip.startFrame) / span : 0
    const params = resolveClipParams(clip.keyframes, progress)
    if (params.hasAny && params.opacity < HIT_MIN_OPACITY) continue
    const local = localPointFor(clip.boxes, params, point, spec)
    if (!local) continue
    // 擦除线与绘制同源：用实际内容包络（自适应宽条不能用 root）
    const sweep = sweepOf(motion, contentBoundsOf(clip.boxes))

    for (let boxIndex = clip.boxes.length - 1; boxIndex >= 0; boxIndex -= 1) {
      const box = clip.boxes[boxIndex]
      if (!box || !HITTABLE_KINDS.has(box.kind)) continue
      if (box.w <= 0 || box.h <= 0) continue
      if (local.y < box.y - slopPx || local.y > box.y + box.h + slopPx) continue
      const rightPx = sweep.rightPx
      // 装饰线自身还有生长比例（ruleReveal）：还没长到的地方同样不该被点到
      const grownRight =
        box.kind === 'rule'
          ? box.x + box.w * Math.max(0, Math.min(1, motion.ruleReveal))
          : box.x + box.w
      const span2 = visibleSpanX(box, sweep.leftPx, Math.min(rightPx, grownRight))
      if (!span2) continue
      if (local.x < span2.left - slopPx || local.x > span2.left + span2.width + slopPx) continue
      return clip.id
    }
  }
  return null
}

/** 局部坐标换算：有关键帧变换时需要锚点；没有锚点（空盒）视为不可命中。 */
function localPointFor(
  boxes: readonly LayoutBox[],
  params: ResolvedClipParams,
  point: HitPoint,
  frame: { width: number; height: number }
): HitPoint | null {
  if (!params.hasAny) return point
  const anchor = contentAnchorOf(boxes)
  if (!anchor) return null
  return toLocalPoint(point, params, anchor, frame)
}

/**
 * 显示坐标 → 原生像素坐标。
 * 前提：传入的 rect 必须是**画面矩形**（`containFrameRect` 的结果，即 Canvas 盒子），
 * 而不是预览容器的盒子——否则容器宽高比不等于目标比例时，黑边会被算进映射里，点选整体偏移。
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

/**
 * 等比装入（contain）矩形：与 `stage.blitTo` 的缩放算法同源（同一取小公式 + 同一居中偏移），
 * 供 DOM 层（参考视频 / 水印图片）对齐原生像素坐标：
 * 预览里看到的画面位置 = 导出画面的位置，不靠 CSS 蒙对。
 */
export function fitContainRect(
  container: { width: number; height: number },
  native: { width: number; height: number }
): { left: number; top: number; width: number; height: number; scale: number } | null {
  if (container.width <= 0 || container.height <= 0) return null
  if (native.width <= 0 || native.height <= 0) return null
  const scale = Math.min(container.width / native.width, container.height / native.height)
  const width = native.width * scale
  const height = native.height * scale
  return { left: (container.width - width) / 2, top: (container.height - height) / 2, width, height, scale }
}

/** 预览画面四周留白（旧 CSS padding 口径，现由 JS 统一给出，只此一处） */
export const STAGE_INSET_PX = 14

/**
 * 画面框（stage frame）：容器内缩 inset 后的可用盒里，按目标分辨率**等比装入**的矩形，
 * 坐标相对容器本身（不是相对可用盒），因此可以直接写进绝对定位元素的 left/top。
 *
 * 为什么必须由 JS 算出一个真实矩形，而不是让 Canvas 铺满容器再由 blitTo 内部留黑边：
 * 预览区被分隔线拖成任意宽高比时，「Canvas 元素盒子」与「画面实际矩形」就不再重合，
 * 于是所有按元素盒子定位的东西（点选命中、视频层、水印、角标）会整体偏到黑边上去。
 * 有了这个矩形，Canvas 盒子 == 画面矩形：blitTo 的等比装入退化为精确填满，
 * DOM 叠加层与原生像素共用同一个原点，`displayToNative` 的线性映射也才成立。
 */
export function containFrameRect(
  container: { width: number; height: number },
  native: { width: number; height: number },
  inset: number = STAGE_INSET_PX
): { left: number; top: number; width: number; height: number; scale: number } | null {
  // 容器还没测得（0 宽高）时给 null 让调用方走 CSS 兜底，而不是绘出一个 1px 的假画面
  if (container.width <= 0 || container.height <= 0) return null
  const fit = fitContainRect(
    { width: Math.max(1, container.width - inset * 2), height: Math.max(1, container.height - inset * 2) },
    native
  )
  if (!fit) return null
  return { ...fit, left: inset + fit.left, top: inset + fit.top }
}
