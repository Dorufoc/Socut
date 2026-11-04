import { applyEasing, clamp01 } from '@shared/easing'
import type { ResolvedAnimation } from '@shared/types'

/**
 * 帧序号 → 动画进度（规格 §7 动画电视感）。
 *
 * 动画形态统一为「整体从左到右擦除」：
 * - 入场：所有矩形（主条 / 副条 / 色块 / 装饰线）左边缘固定在原位，
 *   右边界在 inFrames 帧内由左向右推进 —— 即擦除式显影，不做位移、不做淡入；
 * - 出场：左边界向右推进、右边界保持不动 —— 同样是从左到右擦去；
 *   因此出场全程仍然是「单向擦除」，不会出现反向收回或整体淡出；
 * - 文字：逐字渐隐渐现——每个字符有自己的入场/出场进度窗口（`drawText` 按字符索引错峰），
 *   跨度由预设的 `textRevealFrames` 解释为「同时处于过渡的字符数」，
 *   进度与条块擦除同源（`wipeTo` / `wipeFrom`），所以文字不会“抢在条块前面”出现；
 * - 装饰线：可提前 ruleLeadInFrames 入场，但其自身也是左→右生长。
 *
 * 动画只改变裁剪窗口，不改变 Yoga 最终布局（规格 §11 纪律 6）：
 * 条块的 x/y/w/h 在任意帧都与稳态帧完全一致。
 *
 * 说明：preset/timeline 里的 displacement 字段仍保留（旧项目文件可正常打开），
 * 但擦除样式不再消费它 —— 位移与擦除叠加会破坏「单向擦除」的观感。
 */

export interface ClipMotion {
  /** 可见性（false 表示该帧完全不绘制） */
  visible: boolean
  /** 不透明度乘子：擦除样式下恒为 1（显影由裁剪完成，不靠淡入） */
  alpha: number
  /** 擦除窗口左边界（占条宽比例 0~1）：入场恒 0，出场从左向右推进 */
  wipeFrom: number
  /** 擦除窗口右边界（占条宽比例 0~1）：入场从左向右生长，出场恒 1 */
  wipeTo: number
  /** 字幕文字逐字过渡的跨度（同时处于过渡的字符数），由预设 textRevealFrames 解释 */
  textStaggerChars: number
  /** 装饰线自身生长比例 0~1（出场由 wipeFrom 负责收掉） */
  ruleReveal: number
  /** 入场进度 0~1（供 UI 显示节奏） */
  inProgress: number
  outProgress: number
}

const HIDDEN: ClipMotion = {
  visible: false,
  alpha: 0,
  wipeFrom: 0,
  wipeTo: 0,
  textStaggerChars: 1,
  ruleReveal: 0,
  inProgress: 0,
  outProgress: 0
}

export function motionAt(anim: ResolvedAnimation, localFrame: number): ClipMotion {
  if (localFrame < 0 || localFrame >= anim.totalFrames) return HIDDEN

  const inFrames = Math.max(1, anim.inFrames)
  const outFrames = Math.max(1, anim.outFrames)
  const rawIn = clamp01(localFrame / inFrames)
  const inProgress = applyEasing(anim.easing, rawIn)

  const outStart = anim.totalFrames - outFrames
  // +1 让出场在「最后一帧」正好推进到 1（否则末帧会残留一条 1/outFrames 宽的窄条）
  const rawOut = localFrame < outStart ? 0 : clamp01((localFrame - outStart + 1) / outFrames)
  const outProgress = applyEasing(anim.easing, rawOut)

  // 擦除窗口：入场右边界向右生长；出场左边界向右推进（同一个方向，不反向收回）
  const wipeTo = inProgress
  const wipeFrom = outProgress * inProgress

  // 文字：逐字过渡的跨度（多少字同时在变）；真正逐字计算 alpha 在 layers.drawText。
  // 与 wipeTo/wipeFrom 共用同一个进度，文字与条块不会脱节。
  const textStaggerChars = Math.max(1, Math.round(anim.textRevealFrames))

  // 装饰线可比主条提前入场（自身也是左→右生长）
  const ruleFrame = localFrame + anim.ruleLeadInFrames
  const ruleReveal = applyEasing(anim.easing, clamp01(ruleFrame / inFrames))

  return {
    visible: wipeTo - wipeFrom > 0.0015,
    alpha: 1,
    wipeFrom,
    wipeTo,
    textStaggerChars,
    ruleReveal,
    inProgress,
    outProgress
  }
}

/** 关键帧列表（逐帧动画评审表用，规格 §10 第 10 条）：擦除窗口逐帧读数。 */
export function keyFrameReport(
  anim: ResolvedAnimation
): Array<{ frame: number; wipeFrom: number; wipeTo: number }> {
  const rows: Array<{ frame: number; wipeFrom: number; wipeTo: number }> = []
  for (let f = 0; f < anim.totalFrames; f++) {
    const m = motionAt(anim, f)
    rows.push({
      frame: f,
      wipeFrom: round3(m.wipeFrom),
      wipeTo: round3(m.wipeTo)
    })
  }
  return rows
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
