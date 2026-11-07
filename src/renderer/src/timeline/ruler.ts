import { frameIntervalSec } from '@shared/fps'
import type { Fps } from '@shared/types'

/** 时间轴刻度：按当前帧率决定主刻度间隔（1s / 0.5s / 0.2s），保证帧边界对齐。 */

export interface Tick {
  sec: number
  label: string
  major: boolean
}

const CANDIDATE_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

/**
 * 主刻度间隔（秒）：保证刻度间距不小于 72px。
 * 直接按比例尺（px/秒）算，与「轨道到底渲染多长」解耦——缩放时刻度密度只跟缩放走。
 */
export function pickStep(pxPerSec: number): number {
  const minStep = 72 / Math.max(1e-6, pxPerSec)
  for (const step of CANDIDATE_STEPS) {
    if (step >= minStep) return step
  }
  return CANDIDATE_STEPS[CANDIDATE_STEPS.length - 1] ?? 3600
}

/** 刻度标签：1 分钟内用 `12s`/`2.50`，超过 1 分钟用 `1:30`（1 小时轨道不出现 6 位数）。 */
function tickLabel(sec: number, isSecond: boolean): string {
  if (!isSecond) return sec.toFixed(2)
  const whole = Math.round(sec)
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * 只生成 `[fromSec, toSec]` 窗口内的刻度：轨道可以渲染到 1 小时，
 * 但 DOM 里永远只有视口附近这几十个节点（整条轨道全量渲染会到上万个绝对定位元素）。
 */
export function buildTicks(fromSec: number, toSec: number, fps: Fps, stepSec: number): Tick[] {
  const ticks: Tick[] = []
  // 用帧数推进（整数运算），避免浮点累加漂移
  const stepFrames = Math.max(1, Math.round((stepSec * fps.num) / fps.den))
  const frameSec = frameIntervalSec(fps)
  const firstFrame = Math.max(0, Math.floor(Math.max(0, fromSec) / frameSec))
  // 对齐到刻度网格：从窗口前第一个整刻度开始，避免滚动时刻度整体跳动
  const startFrame = Math.floor(firstFrame / stepFrames) * stepFrames
  const lastFrame = Math.ceil(Math.max(fromSec, toSec) / frameSec)
  for (let frame = startFrame; frame <= lastFrame; frame += stepFrames) {
    const sec = (frame * fps.den) / fps.num
    if (sec > toSec + frameSec) break
    const isSecond = Math.abs(sec - Math.round(sec)) < 1e-6
    ticks.push({ sec, label: tickLabel(sec, isSecond), major: isSecond })
  }
  return ticks
}

/** 秒 → 轨道像素位置。 */
export function secToPx(sec: number, durationSec: number, widthPx: number): number {
  if (durationSec <= 0) return 0
  return (sec / durationSec) * widthPx
}

/** 像素 → 秒（再吸附到帧边界由调用方完成）。 */
export function pxToSec(px: number, durationSec: number, widthPx: number): number {
  if (widthPx <= 0) return 0
  return Math.max(0, (px / widthPx) * durationSec)
}
