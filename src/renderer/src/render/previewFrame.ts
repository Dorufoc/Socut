import { timeToFrameFloor } from '@shared/fps'
import type { Fps, RenderJobSpec } from '@shared/types'

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

/**
 * 一帧预览的完整输入状态（Task 2.3）。
 * 拆成纯函数是为了能直接钉住「哪些变化必须重画原生层、哪些只需重新上屏」——
 * 这是把 60Hz 全量软件光栅化降下来的核心判据，必须可测。
 */
export interface PreviewRenderState {
  frame: number
  spec: RenderJobSpec | null
  cssWidth: number
  cssHeight: number
  dpr: number
  safeArea: boolean
  transparent: boolean
}

export interface PreviewRenderDecision {
  /** 是否重画原生分辨率字幕层（renderFrame） */
  render: boolean
  /** 是否把原生层缩放到显示画布（blitTo） */
  blit: boolean
}

export function decidePreviewRender(
  current: PreviewRenderState,
  last: PreviewRenderState | null,
  force: boolean
): PreviewRenderDecision {
  // 首帧 / 显式强制（规格、安全区、悬停帧、画布挂载、尺寸变化、seek）必须整帧出图
  if (force || last === null) return { render: true, blit: true }

  // 影响原生层像素的输入：帧号、规格引用、安全区辅助线
  const contentChanged =
    current.frame !== last.frame || current.spec !== last.spec || current.safeArea !== last.safeArea

  // 只影响「怎么上屏」的输入：CSS 尺寸、DPR、透明垫底（棋盘格 vs 透出视频）
  // 这些变化不需要重画字幕层，重新 blit 一次即可（同一帧就能用上新透明值）。
  const displayChanged =
    current.cssWidth !== last.cssWidth ||
    current.cssHeight !== last.cssHeight ||
    current.dpr !== last.dpr ||
    current.transparent !== last.transparent

  if (contentChanged) return { render: true, blit: true }
  if (displayChanged) return { render: false, blit: true }
  return { render: false, blit: false }
}
