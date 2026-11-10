import { buildProjectPlan, type PlanInput } from '@shared/presetResolver'
import { classifyAspect } from '@shared/aspect'
import { DEFAULT_FONT_ID } from '@shared/constants'
import { clipEndFrame, clipStartFrame, durationSecToFrames } from '@shared/fps'
import { resolveTextStyle } from '@shared/textPresets'
import type {
  AspectMode,
  Fps,
  FrameFormat,
  Project,
  RenderJobSpec,
  ResolvedClip,
  ResolvedTextElement
} from '@shared/types'
import { computeClipBoxes } from './layoutTree'
import { renderFrame } from './renderer'

/** 计划 → RenderJobSpec（渲染层的唯一输入）。预览与导出共用同一条构造路径。 */

export interface BuildJobInput {
  project: Project
  /** 已注册的字体库（内置 + 用户） */
  fontIndex: PlanInput['fontIndex']
  resolution?: { width: number; height: number }
  fps?: Fps
  scope: PlanInput['scope']
  /** 覆盖宽高比分支（默认按参考视频显示比 → 否则按目标分辨率） */
  mode?: AspectMode
  /** 导出帧形式：默认 raw（未压缩 RGBA，避开 PNG 压缩瓶颈） */
  frameFormat?: FrameFormat
  /**
   * 把渲染区间收紧到「首个片段入点 → 末个片段出点」（计划 C7）。
   * 叠加导出必须开：否则开头那段全透明间隙会被白白渲染，
   * 并且 span 平移量会与真实入点对不上（验收第 4 条）。
   */
  restrictToActiveSpan?: boolean
}

export function resolveAspectMode(project: Project, width: number, height: number, override?: AspectMode): AspectMode {
  if (override) return override
  // v2：枚级布局分支——首枚显式指定了 compactMode 的素材说了算（全 auto 时仍按目标分辨率判定）
  const declared = project.media.find((item) => item.compactMode !== 'auto')
  if (declared) return declared.compactMode === 'compact' ? 'compact' : declared.compactMode === 'ultrawide' ? 'ultrawide' : 'standard'
  const ref = project.refVideo
  if (ref) {
    // 有参考视频时以其显示宽高比为准（规格 §6.1；v1 兼容）
    if (ref.compactMode === 'auto') return classifyAspect(ref.meta.displayRatio)
    return ref.compactMode
  }
  return classifyAspect(width / height)
}

export async function buildRenderJob(input: BuildJobInput): Promise<RenderJobSpec> {
  const project = input.project
  const width = input.resolution?.width ?? project.resolution.width
  const height = input.resolution?.height ?? project.resolution.height
  const fps = input.fps ?? project.fps
  const mode = resolveAspectMode(project, width, height, input.mode)

  const plan = buildProjectPlan({
    project,
    resolution: { width, height },
    fps,
    mode,
    scope: input.scope,
    fontIndex: input.fontIndex
  })

  const clips: ResolvedClip[] = []
  for (const clipPlan of plan.clips) {
    const boxes = await computeClipBoxes(clipPlan)
    // M6：关键帧属于"片段"而不是"预设"，从工程里按 id 取（plan 只负责布局与动画）
    const source = project.clips.find((clip) => clip.id === clipPlan.id)
    clips.push({
      id: clipPlan.id,
      presetId: clipPlan.presetId,
      startFrame: clipPlan.startFrame,
      endFrame: clipPlan.endFrame,
      boxes,
      animation: clipPlan.animation,
      selected: true,
      ...(source?.keyframes && source.keyframes.length > 0 ? { keyframes: source.keyframes } : {})
    })
  }

  // M7：文本元素（画在字幕条之下）；字号等按 1080p 声明，渲染层按画高缩放
  const familyById = new Map<string, string>()
  for (const record of input.fontIndex) familyById.set(record.fontId, record.family)
  const fallbackFamily = familyById.get(DEFAULT_FONT_ID) ?? 'Noto Sans SC'
  const textClips: ResolvedTextElement[] = (project.textClips ?? []).map((clip) => {
    const startFrame = clipStartFrame(clip.startTime, fps)
    const endFrame = clipEndFrame(clip.endTime, fps)
    const totalFrames = Math.max(1, endFrame - startFrame)
    const half = Math.max(1, Math.floor(totalFrames / 2))
    const style = resolveTextStyle(clip.presetId, clip.styleOverrides)
    return {
      id: clip.id,
      text: clip.text,
      style,
      fontFamily: familyById.get(style.fontId) ?? fallbackFamily,
      animation: {
        inFrames: Math.min(durationSecToFrames(clip.animation.inDurationSec, fps), half),
        outFrames: Math.min(durationSecToFrames(clip.animation.outDurationSec, fps), half),
        totalFrames,
        easing: clip.animation.easing,
        risePx: clip.animation.risePx
      },
      startFrame,
      endFrame,
      ...(clip.keyframes ? { keyframes: clip.keyframes } : {})
    }
  })

  return {
    width,
    height,
    fps,
    frameFormat: input.frameFormat ?? 'raw',
    startFrame: input.restrictToActiveSpan ? plan.activeStartFrame : plan.startFrame,
    endFrame: input.restrictToActiveSpan ? plan.activeEndFrame : plan.endFrame,
    clips,
    ...(textClips.length > 0 ? { textClips } : {}),
    aspectMode: plan.mode
  }
}

/**
 * 单帧导出 PNG（像素一致性回归测试与逐帧评审用）。
 * 画布标志必须与 NativeStage（导出主路径）一致：否则一个是 GPU 画布、
 * 一个是 willReadFrequently 的软件画布，光栅化结果会有亚像素差异，
 * 像素一致性回归就会报出假阳性（实测字节级不一致）。
 */
export async function renderJobToPngBlob(job: RenderJobSpec, frame: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(job.width, job.height)
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
  if (!ctx) throw new Error('无法创建 2D 上下文')
  renderFrame(ctx, job, frame)
  return canvas.convertToBlob({ type: 'image/png' })
}
