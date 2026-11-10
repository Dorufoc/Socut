import { ACTION_SAFE_RATIO, TITLE_SAFE_RATIO } from '@shared/constants'
import { resolveClipParams } from '@shared/keyframes'
import type { LayoutBox, RenderJobSpec } from '@shared/types'
import { motionAt } from './animation'
import { drawBar, drawRule, drawText, contentAnchorOf, contentBoundsOf, sweepOf, type DrawContext, type WipeSweep } from './layers'
import { drawTextElements } from './textElement'

/**
 * 唯一像素生产者（规格 §4.3 / §11 纪律 6）。
 * 预览与导出都调用本函数：预览只是把结果缩放到显示 Canvas，
 * 任何坐标计算都不感知显示尺寸，因此「所见即所导出」。
 *
 * M6：片段级关键帧在这里生效（不透明度 / 位移 / 缩放 / 旋转）。
 * 没有 `keyframes` 的片段走原路径（不产生额外变换与状态切换），逐像素与旧版一致。
 */

export interface RenderOptions {
  /** 仅预览使用：叠加安全区辅助线，导出路径永远为 false */
  safeArea?: boolean
  /** 仅预览使用：只显示某个片段 */
  isolateClipId?: string | null
}

// 锚点计算已移到 layers（命中测试也要用同一份口径），这里保留 re-export 兼容旧引用。
export { contentAnchorOf }

function drawBox(
  ctx: DrawContext,
  box: LayoutBox,
  sweep: WipeSweep,
  ruleReveal: number,
  textStaggerChars: number,
  alphaMul: number
): void {
  switch (box.kind) {
    case 'text':
      drawText(ctx, box, sweep, textStaggerChars, alphaMul)
      break
    case 'rule':
      drawRule(ctx, box, sweep, ruleReveal, alphaMul)
      break
    case 'bar':
    case 'block':
      drawBar(ctx, box, sweep, alphaMul)
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

  // M7：文本元素先画（在字幕条之下）；没有文本元素时零开销
  if (job.textClips && job.textClips.length > 0) {
    drawTextElements(ctx, job.textClips, globalFrame, job.width, job.height)
  }

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
    // M6：片段内进度 0..1（与帧率无关）；无关键帧时 params.hasAny=false，直接走旧路径
    const span = clip.endFrame - clip.startFrame
    const progress = span > 0 ? (globalFrame - clip.startFrame) / span : 0
    const params = resolveClipParams(clip.keyframes, progress)
    let transformed = false
    if (params.hasAny && (params.offsetXPct !== 0 || params.offsetYPct !== 0 || params.scalePct !== 100 || params.rotationDeg !== 0)) {
      const anchor = contentAnchorOf(clip.boxes)
      if (anchor) {
        ctx.save()
        transformed = true
        // 位移单位 = 画宽/画高的百分比；缩放与旋转绕内容中心
        ctx.translate(
          anchor.cx + (job.width * params.offsetXPct) / 100,
          anchor.cy + (job.height * params.offsetYPct) / 100
        )
        ctx.rotate((params.rotationDeg * Math.PI) / 180)
        const scale = params.scalePct / 100
        ctx.scale(scale, scale)
        ctx.translate(-anchor.cx, -anchor.cy)
      }
    }
    // boxes 已是前序遍历结果 = 规格 §7 的分层绘制顺序
    for (const box of clip.boxes) {
      drawBox(ctx, box, sweep, motion.ruleReveal, motion.textStaggerChars, params.opacity)
    }
    if (transformed) ctx.restore()
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
