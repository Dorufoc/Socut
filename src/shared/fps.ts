import type { Fps, Rational } from './types'

/**
 * 分数帧率与帧↔秒换算（规格 §4.4 / §11：全程整数运算，禁止浮点累加）。
 *
 * 约定：
 * - 第 i 帧的时刻 t = i * den / num 秒；
 * - 片段占用秒区间 [startTime, endTime)，对应帧集合为 [startFrame, endFrame)；
 * - 帧边界判定使用「微秒整数 + 分数交叉相乘」，避免浮点累加误差；
 * - 由于入出点在 UI 提交时已吸附到帧边界，允许 2µs 容差把「几乎正好落在帧边界」
 *   的时刻归到该帧，从而保证跨分辨率/帧率复现同一时间点（误差 < 1 帧）。
 */

const MICRO = 1_000_000n
/** 帧边界容差（微秒） */
const TOL_US = 2

export interface FpsLike {
  num: number
  den: number
}

/** 帧 i 的绝对时刻（秒）。 */
export function frameTimeSec(frame: number, fps: Fps): number {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`非法帧序号: ${frame}`)
  }
  const product = frame * fps.den
  if (!Number.isSafeInteger(product)) {
    // 极端长素材：用 BigInt 保证乘法不丢精度，最终仍转为最接近的 double
    const exact = (BigInt(frame) * BigInt(fps.den) * MICRO) / BigInt(fps.num)
    return Number(exact) / Number(MICRO)
  }
  return product / fps.num
}

/** 帧间隔（秒）。 */
export function frameIntervalSec(fps: Fps): number {
  return fps.den / fps.num
}

/** 帧率比值。 */
export function fpsRatio(fps: Fps): number {
  return fps.num / fps.den
}

function toMicro(t: number): bigint {
  if (!Number.isFinite(t)) throw new RangeError(`非法时间: ${t}`)
  return BigInt(Math.round(t * Number(MICRO)))
}

/**
 * 时刻 t 对应的帧下取整（带帧边界容差）。
 * 语义：满足 frameTimeSec(f) <= t（容差内相等归入 f+? 见下）的最大 f。
 */
export function timeToFrameFloor(t: number, fps: Fps): number {
  const num = BigInt(fps.num)
  const den = BigInt(fps.den) * MICRO
  const scaled = toMicro(t) * num
  const floor = scaled / den
  const rem = scaled - floor * den
  const tol = BigInt(TOL_US) * num
  // 余数接近下一帧边界时（即 t 实际上略微超过边界）归入下一帧
  if (den - rem <= tol) return Number(floor + 1n)
  return Number(floor)
}

/**
 * 不小于时刻 t 的第一帧（向上取整，带帧边界容差）。
 * 这是片段入点/出点 → 帧索引的主函数。
 */
export function timeToFrameAtOrAfter(t: number, fps: Fps): number {
  const num = BigInt(fps.num)
  const den = BigInt(fps.den) * MICRO
  const scaled = toMicro(t) * num
  const floor = scaled / den
  const rem = scaled - floor * den
  const tol = BigInt(TOL_US) * num
  if (rem <= tol) return Number(floor)
  return Number(floor + 1n)
}

/** 四舍五入到最近帧。 */
export function timeToFrameNearest(t: number, fps: Fps): number {
  return timeToFrameFloor(t + frameIntervalSec(fps) / 2, fps)
}

/** 把任意秒值吸附到当前预览帧率的帧边界（存储值仍为秒，规格 §4.4）。 */
export function snapTimeToFrame(t: number, fps: Fps): number {
  return frameTimeSec(timeToFrameNearest(t, fps), fps)
}

/** 片段 [startSec, endSec) 占用的起始帧。 */
export function clipStartFrame(startSec: number, fps: Fps): number {
  return Math.max(0, timeToFrameAtOrAfter(startSec, fps))
}

/** 片段 [startSec, endSec) 的结束帧（不含）。 */
export function clipEndFrame(endSec: number, fps: Fps): number {
  return Math.max(0, timeToFrameAtOrAfter(endSec, fps))
}

/** 片段占用帧数。 */
export function clipFrameCount(startSec: number, endSec: number, fps: Fps): number {
  return Math.max(0, clipEndFrame(endSec, fps) - clipStartFrame(startSec, fps))
}

/**
 * 逐帧跳转（键盘 ← / →）的落点：相对帧夹在 `[0, totalFrames)`。
 *
 * 越界停在端点而不回绕：预览循环到头会自动归零，回绕等于让用户按着方向键时
 * 播放头随机跑；总帧数缺失（空工程）按 1 帧算，至少要能落在第 0 帧。
 */
export function stepLocalFrame(currentLocalFrame: number, deltaFrames: number, totalFrames: number): number {
  const total = Math.max(1, Math.floor(totalFrames))
  const target = Math.floor(currentLocalFrame) + Math.round(deltaFrames)
  return Math.min(total - 1, Math.max(0, target))
}

/** 时间轴总帧数（覆盖 [0, durationSec)）。 */
export function timelineFrameCount(durationSec: number, fps: Fps): number {
  return Math.max(0, timeToFrameAtOrAfter(durationSec, fps))
}

/** 动画时长（秒）→ 帧数（至少 1 帧）。 */
export function durationSecToFrames(sec: number, fps: Fps, min = 1): number {
  return Math.max(min, Math.round((sec * fps.num) / fps.den))
}

/** 动画时长（秒）→ 帧数（可为 0）。 */
export function durationSecToFramesExact(sec: number, fps: Fps): number {
  return Math.max(0, Math.round((sec * fps.num) / fps.den))
}

/** 帧数 → 秒（用于 UI 显示与写回）。 */
export function framesToDurationSec(frames: number, fps: Fps): number {
  return (frames * fps.den) / fps.num
}

/** 解析 "30000/1001" 或 "30" 或 "29.97"。解析失败返回 null。 */
export function parseFps(raw: string | null | undefined): Fps | null {
  if (!raw) return null
  const trimmed = raw.trim()
  const slash = trimmed.indexOf('/')
  if (slash >= 0) {
    const num = Number(trimmed.slice(0, slash))
    const den = Number(trimmed.slice(slash + 1))
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null
    return { num: Math.round(num), den: Math.round(den) }
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) return null
  // 常见非整数帧率的精确分数
  const known: [number, Fps][] = [
    [23.976, { num: 24000, den: 1001 }],
    [29.97, { num: 30000, den: 1001 }],
    [59.94, { num: 60000, den: 1001 }],
    [47.95, { num: 48000, den: 1001 }],
    [24, { num: 24, den: 1 }],
    [25, { num: 25, den: 1 }],
    [30, { num: 30, den: 1 }],
    [50, { num: 50, den: 1 }],
    [60, { num: 60, den: 1 }]
  ]
  for (const [label, fps] of known) {
    if (Math.abs(value - label) < 0.005) return fps
  }
  return { num: Math.round(value * 1000), den: 1000 }
}

export function rationalToNumber(r: Rational | null): number | null {
  if (!r || r.den === 0) return null
  return r.num / r.den
}

/** 判断两个分数是否等价（允许 ±tolerance 相对误差）。 */
export function rationalClose(a: Rational, b: Rational, tolerance = 0.0001): boolean {
  const av = a.num / a.den
  const bv = b.num / b.den
  if (bv === 0) return false
  return Math.abs(av - bv) / Math.abs(bv) <= tolerance
}

/** FFmpeg 命令行使用的分数写法（本机已验证 -framerate 30000/1001 解析为 29.97）。 */
export function fpsToArg(fps: Fps): string {
  return `${fps.num}/${fps.den}`
}

/**
 * 校验时间点跨帧率一致性（用于验收「同工程导出不同帧率入出点误差 < 1 帧」）。
 * 对每个时间点做 fromFps → 帧 → 秒 → toFps → 帧 → 秒 的双向换算，返回最大偏差（秒）。
 */
export function crossFpsMaxDeviationSec(times: number[], fromFps: Fps, toFps: Fps): number {
  let max = 0
  for (const t of times) {
    const f = timeToFrameAtOrAfter(t, fromFps)
    const snapped = frameTimeSec(f, fromFps)
    max = Math.max(max, Math.abs(snapped - t))
    const g = timeToFrameAtOrAfter(snapped, toFps)
    max = Math.max(max, Math.abs(frameTimeSec(g, toFps) - snapped))
  }
  return max
}
