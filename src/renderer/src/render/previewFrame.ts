import { timeToFrameFloor } from '@shared/fps'
import type { Fps } from '@shared/types'

/**
 * 预览这一帧该画哪里（P4 预览轴接管）。
 *
 * 单独成模块而不是写在 `usePreviewLoop` 里：绘制循环本身要 rAF + Canvas，
 * 而「悬停帧只改画哪一帧、不改播放头在哪」这条判据必须能被直接钉住。
 */

export interface PreviewFrameArgs {
  /** 预览循环的内部时钟（相对工程起点的秒） */
  elapsedSec: number
  /** 悬停帧（相对工程起点的秒）；null = 没有悬停，走时钟 */
  overrideSec: number | null
  fps: Fps
  startFrame: number
  endFrame: number
}

export interface PreviewFrameChoice {
  /** 绝对帧号（= startFrame + 相对帧），与导出同一套坐标 */
  frame: number
  /** 是否把这一帧的时间回写给 UI（蓝线、时间码）：悬停期间必须为 false */
  reportDisplay: boolean
}

export function choosePreviewFrame(args: PreviewFrameArgs): PreviewFrameChoice {
  const framesTotal = Math.max(1, args.endFrame - args.startFrame)
  const sourceSec = Math.max(0, args.overrideSec ?? args.elapsedSec)
  const local = Math.min(framesTotal - 1, Math.max(0, timeToFrameFloor(sourceSec, args.fps)))
  return { frame: args.startFrame + local, reportDisplay: args.overrideSec === null }
}
