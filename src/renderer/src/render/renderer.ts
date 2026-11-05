import { ACTION_SAFE_RATIO, TITLE_SAFE_RATIO } from '@shared/constants'
import type { LayoutBox, RenderJobSpec } from '@shared/types'
import { motionAt } from './animation'
import { drawBar, drawRule, drawText, contentBoundsOf, sweepOf, type DrawContext, type WipeSweep } from './layers'

/**
 * 唯一像素生产者（规格 §4.3 / §11 纪律 6）。
 * 预览与导出都调用本函数：预览只是把结果缩放到显示 Canvas，
 * 任何坐标计算都不感知显示尺寸，因此「所见即所导出」。
 */

export interface RenderOptions {
  /** 仅预览使用：叠加安全区辅助线，导出路径永远为 false */
  safeArea?: boolean
  /** 仅预览使用：只显示某个片段 */
  isolateClipId?: string | null
}

function drawBox(ctx: DrawContext, box: LayoutBox, sweep: WipeSweep, ruleReveal: number, textStaggerChars: number): void {
  switch (box.kind) {
    case 'text':
      drawText(ctx, box, sweep, textStaggerChars)
      break
    case 'rule':
      drawRule(ctx, box, sweep, ruleReveal)
      break
    case 'bar':
    case 'block':
      drawBar(ctx, box, sweep)
      break
    default:
      // row / col / spacer：纯布局容器，不落地像素
      break
  }
}

export function renderFrame(
  ctx: DrawContext,
  job: RenderJobSpec,
  globalFrame: number,
  options: RenderOptions = {}
): void {
  // 导出 Canvas 尺寸恒等于目标分辨率，不随 DPR/系统缩放变化（计划 C9）
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, job.width, job.height)

  for (const clip of job.clips) {
    if (!clip.selected) continue
    if (options.isolateClipId && clip.id !== options.isolateClipId) continue
    if (globalFrame < clip.startFrame || globalFrame >= clip.endFrame) continue
    const motion = motionAt(clip.animation, globalFrame - clip.startFrame)
    if (!motion.visible) continue
    // 整条字幕共用一条擦除线：边界取**实际绘制内容**的并集，而不是 root 盒。
    // 条宽现在随文字自适应；若仍用 root（画宽减边距）当擦除跨度，窄条会在入场 20% 时
    // 就已整条显露，看起来像“瞬间弹出”。用内容并集才能让擦除速度与条宽成正比。
    const sweep: WipeSweep = sweepOf(motion, contentBoundsOf(clip.boxes))
    // boxes 已是前序遍历结果 = 规格 §7 的分层绘制顺序
    for (const box of clip.boxes) {
      drawBox(ctx, box, sweep, motion.ruleReveal, motion.textStaggerChars)
    }
  }

  if (options.safeArea) drawSafeArea(ctx, job.width, job.height)
}

/** 动作安全区 / 字幕安全区辅助线（只服务预览）。 */
export function drawSafeArea(ctx: DrawContext, width: number, height: number): void {
  const rect = (ratio: number, color: string, dash: number[]): void => {
    const insetX = ((1 - ratio) / 2) * width
    const insetY = ((1 - ratio) / 2) * height
    ctx.save()
    ctx.setLineDash(dash)
    ctx.lineWidth = Math.max(1, Math.round(height / 540))
    ctx.strokeStyle = color
    ctx.strokeRect(insetX, insetY, width - insetX * 2, height - insetY * 2)
    ctx.restore()
  }
  rect(ACTION_SAFE_RATIO, 'rgba(255, 255, 255, 0.28)', [8, 8])
  rect(TITLE_SAFE_RATIO, 'rgba(255, 200, 0, 0.32)', [4, 6])
}

/** 当前帧的活跃片段（时间轴刻度与 UI 提示用）。 */
export function activeClipIds(job: RenderJobSpec, globalFrame: number): string[] {
  return job.clips
    .filter((clip) => clip.selected && globalFrame >= clip.startFrame && globalFrame < clip.endFrame)
    .map((clip) => clip.id)
}
