/**
 * 三次贝塞尔缓动（CSS `cubic-bezier(x1, y1, x2, y2)` 口径）+ 单调性校验。
 *
 * 为什么需要它：M6 的关键帧允许「每个关键点自带一条缓动曲线」。
 * 内置的 7 种 `EasingKey` 不够表达"先慢后快再稳"这类剪辑师常用的自定义节奏，
 * 而纯线性太生硬。贝塞尔用 4 个数字就能表达，且能直接画出曲线给用户调。
 *
 * 两条纪律（与 `easing.ts` / 规格 §10 第 10 条一致）：
 * 1. **禁过冲**：y 分量不支持 >1 / <0 的回弹（电视字幕条不允许弹跳感），
 *    归一化阶段就把 y 夹到 [0,1]；非单调曲线视为非法，由调用方回退到线性；
 * 2. **x 必须单调**：x1 / x2 夹到 [0,1]（CSS 的硬性要求），否则解 x→t 不唯一。
 *
 * 纯函数、不碰 DOM：预览曲线、导出求值、单测共用同一份实现。
 */

export type BezierTuple = readonly [x1: number, y1: number, x2: number, y2: number]

/** CSS 的 `ease`（订阅常用默认值），给 UI「重置」用。 */
export const DEFAULT_BEZIER: BezierTuple = [0.25, 0.1, 0.25, 1]

const EPS = 1e-9

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value <= 0 ? 0 : value >= 1 ? 1 : value
}

/**
 * 归一化：4 个有限数。
 * - x1 / x2 夹到 [0,1]（CSS 硬性要求，保证 x 单调、解 t 唯一）；
 * - **y1 / y2 必须已在 [0,1]，越界直接拒绝**（回弹/过冲是产品禁区，不做"夹一下再用"的静默降级）。
 * 非法输入返回 null。
 */
export function normalizeBezier(value: unknown): BezierTuple | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const numbers = value.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : Number.NaN))
  if (numbers.some((item) => Number.isNaN(item))) return null
  const [x1, y1, x2, y2] = numbers as [number, number, number, number]
  if (y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1) return null
  return [clampUnit(x1), y1, clampUnit(x2), y2] as const
}

/** 三次贝塞尔单轴分量 B(t)（P0=0、P3=1）。 */
function component(p1: number, p2: number, t: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t
}

/** 导数 B'(t)。 */
function derivative(p1: number, p2: number, t: number): number {
  const mt = 1 - t
  return 3 * mt * mt * p1 + 6 * mt * t * (p2 - p1) + 3 * t * t * (1 - p2)
}

/** 解 x(t) = x 得到参数 t；Newton 优先、失败退二分（与浏览器实现同思路，纯局部求值无缓存）。 */
function solveT(x1: number, x2: number, x: number): number {
  const target = clampUnit(x)
  let t = target
  for (let i = 0; i < 8; i += 1) {
    const current = component(x1, x2, t) - target
    if (Math.abs(current) < 1e-7) return t
    const slope = derivative(x1, x2, t)
    if (Math.abs(slope) < 1e-7) break
    const next = t - current / slope
    if (next < 0 || next > 1) break
    t = next
  }
  let low = 0
  let high = 1
  t = target
  for (let i = 0; i < 40; i += 1) {
    const value = component(x1, x2, t)
    if (Math.abs(value - target) < 1e-7) return t
    if (value < target) low = t
    else high = t
    t = (low + high) / 2
  }
  return t
}

/** 求值：给输入进度 x（0..1），返回缓动后的输出 y（0..1）。 */
export function bezierAt(bezier: BezierTuple, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  return clampUnit(rawYAt(bezier, x))
}

/** 不夹取的原始输出（过冲校验用；正常曲线与 bezierAt 相同）。 */
function rawYAt(bezier: BezierTuple, x: number): number {
  const [x1, y1, x2, y2] = bezier
  const t = solveT(x1, x2, x)
  return component(y1, y2, t)
}

/** 采样成折线（UI 画曲线 / 单测断言单调性用）。 */
export function bezierSamples(bezier: BezierTuple, steps = 32): { x: number; y: number }[] {
  const count = Math.max(2, Math.round(steps))
  const out: { x: number; y: number }[] = []
  for (let i = 0; i <= count; i += 1) {
    const x = i / count
    out.push({ x, y: bezierAt(bezier, x) })
  }
  return out
}

/**
 * 是否"无过冲且单调"：采样 64 点，y 必须在 [0,1] 且单调不减。
 * 与 `easing.isOvershootFree` 同一判据；归一化阶段用它决定是否接受自定义曲线。
 * 注意这里读**未夹取**的原始输出——否则夹取会把过冲抹平、校验永远通过。
 */
export function isBezierOvershootFree(bezier: BezierTuple): boolean {
  let prev = 0
  for (let i = 0; i <= 64; i += 1) {
    const value = rawYAt(bezier, i / 64)
    if (!Number.isFinite(value) || value < -1e-9 || value > 1 + 1e-9) return false
    if (value < prev - 1e-9) return false
    prev = value
  }
  return true
}

/** 归一化 + 合法性校验：非法或过冲曲线返回 null（调用方回退到具名缓动）。 */
export function acceptBezier(value: unknown): BezierTuple | null {
  const normalized = normalizeBezier(value)
  if (!normalized) return null
  return isBezierOvershootFree(normalized) ? normalized : null
}

/** 画图用的 CSS 字符串（给 `<path>` / 轨迹提示复用；不参与求值）。 */
export function bezierToCss(bezier: BezierTuple): string {
  return `cubic-bezier(${bezier.map((item) => Number(item.toFixed(4))).join(', ')})`
}

/** 判断两个贝塞尔是否近似相等（UI 判断"是否还是默认值"用）。 */
export function bezierEquals(a: BezierTuple, b: BezierTuple): boolean {
  return a.every((value, index) => Math.abs(value - b[index]!) < EPS + 1e-6)
}
