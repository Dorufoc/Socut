import { frameIntervalSec } from '@shared/fps'
import type { Fps } from '@shared/types'

/** 时间轴刻度：按当前帧率决定主刻度间隔（1s / 0.5s / 0.2s），保证帧边界对齐。 */

export interface Tick {
  sec: number
  label: string
  major: boolean
}

const CANDIDATE_STEPS = [0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60]

export function pickStep(durationSec: number, widthPx: number): number {
  // 目标：刻度间距不小于 72px
  const minStep = (durationSec * 72) / Math.max(1, widthPx)
  for (const step of CANDIDATE_STEPS) {
    if (step >= minStep) return step
  }
  return CANDIDATE_STEPS[CANDIDATE_STEPS.length - 1] ?? 60
}

export function buildTicks(durationSec: number, fps: Fps, stepSec: number): Tick[] {
  const ticks: Tick[] = []
  // 用帧数推进（整数运算），避免浮点累加漂移
  const stepFrames = Math.max(1, Math.round((stepSec * fps.num) / fps.den))
  const totalFrames = Math.ceil(durationSec / frameIntervalSec(fps))
  for (let frame = 0; frame <= totalFrames; frame += stepFrames) {
    const sec = (frame * fps.den) / fps.num
    if (sec > durationSec + frameIntervalSec(fps)) break
    const isSecond = Math.abs(sec - Math.round(sec)) < 1e-6
    ticks.push({ sec, label: isSecond ? `${Math.round(sec)}s` : sec.toFixed(2), major: isSecond })
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
