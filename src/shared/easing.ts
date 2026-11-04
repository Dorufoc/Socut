import type { EasingKey } from './types'

/**
 * 动画缓动（规格 §7：电视感、克制缓动，禁止回弹/弹跳）。
 * 所有函数定义域 [0,1]，值域 [0,1]，单调不减 —— 不允许出现 >1 的过冲。
 */
export type EasingFn = (t: number) => number

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t)

export const EASINGS: Record<EasingKey, EasingFn> = {
  linear: (t) => t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10)
}

export const EASING_LABELS: Record<EasingKey, string> = {
  linear: '线性',
  outQuad: '缓出（二次）',
  outCubic: '缓出（三次）',
  outQuart: '缓出（四次）',
  outQuint: '缓出（五次）',
  outExpo: '急缓出（指数）',
  smootherstep: '平滑起止'
}

export const EASING_KEYS = Object.keys(EASINGS) as EasingKey[]

export function applyEasing(key: EasingKey, t: number): number {
  const fn = EASINGS[key] ?? EASINGS.outCubic
  return fn(clamp01(t))
}

/**
 * 校验曲线无过冲（validatePreset 使用）：采样 64 点，值域必须在 [0,1] 且单调不减。
 * 这是「动画无网页式弹跳」的机器可验证部分（规格 §10 第 10 条）。
 */
export function isOvershootFree(key: EasingKey): boolean {
  const fn = EASINGS[key]
  if (!fn) return false
  let prev = 0
  for (let i = 0; i <= 64; i++) {
    const v = fn(i / 64)
    if (!Number.isFinite(v) || v < -1e-9 || v > 1 + 1e-9) return false
    if (v < prev - 1e-9) return false
    prev = v
  }
  return true
}

export { clamp01 }
