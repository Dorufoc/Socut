import { create } from 'zustand'
import { stabPreviewSignature } from '@shared/mediaStab'
import type { Fps, JobResult, MediaClip, MediaClipStab, StabPreviewRequest } from '@shared/types'

/**
 * v8.1：防抖预览代理的渲染侧账本（clipId → 已就绪的代理文件）。
 *
 * 只记「应用成功」这一个事实：作业进度/取消全部复用导出任务队列（exportStore + ProgressPanel，
 * jobId 前缀 stab-），本 store 只负责回答 PreviewStage 两个问题——
 * 这个片段现在该播原片还是播代理？代理在哪？
 *
 * 新鲜度用签名判定（区间/帧率/档位/三脚架/源路径）：Inspector 每次渲染都拿当前参数重算，
 * 与记账值不一致 → 自动回落原片并提示「重新应用」，不需要显式失效事件。
 * 不持久化：重启后磁盘缓存还在，重顶点「应用」会秒回 cached（不起子进程）。
 */

export const STAB_JOB_ID_PREFIX = 'stab-'

export interface StabPreviewClipState {
  /** 代理 mp4 绝对路径（focusnews-media:// 由 PreviewStage 现取） */
  path: string
  /** 应用那一刻的签名（PreviewStage/Inspector 据此判新鲜度） */
  signature: string
}

/** 发起一次应用所需的最小片段信息（Inspector 从 clip + 素材池现取，store 不反向依赖工程）。 */
export interface StabApplyInput {
  clip: MediaClip
  stab: MediaClipStab
  sourcePath: string
  fps: Fps
  hasAudio: boolean
}

export interface StabPreviewState {
  applied: Record<string, StabPreviewClipState>
  /** 受理/作业失败的提示（按 clipId；下次成功应用或重新受理时清掉） */
  errors: Record<string, string>
  apply: (input: StabApplyInput) => Promise<void>
  /** 关闭防抖/删除片段：清账本 + 可选回收主进程磁盘缓存（fire-and-forget，绝不起导出级联） */
  clearForClip: (clipId: string, removeFiles: boolean) => void
  /** jobResult 分发入口（jobEvents 里 stab- 前缀的作业走这里） */
  handleJobResult: (result: JobResult) => void
}

/** 与主进程同一函数同一参数：签名一致才有意义，两边都必须从 shared/mediaStab 取。 */
export function stabSignatureFor(input: StabApplyInput): string {
  return stabPreviewSignature({
    sourcePath: input.sourcePath,
    sourceInSec: input.clip.sourceInSec,
    sourceOutSec: input.clip.sourceOutSec,
    fps: input.fps,
    stab: input.stab
  })
}

export function stabJobIdFor(clipId: string): string {
  return STAB_JOB_ID_PREFIX + clipId.replace(/[^\w-]/g, '_').slice(0, 64)
}

export const useStabPreviewStore = create<StabPreviewState>((set, get) => ({
  applied: {},
  errors: {},

  apply: async ({ clip, stab, sourcePath, fps, hasAudio }) => {
    const signature = stabSignatureFor({ clip, stab, sourcePath, fps, hasAudio })
    if (get().applied[clip.id]?.signature === signature) return
    const request: StabPreviewRequest = {
      clipId: clip.id,
      sourcePath,
      sourceInSec: clip.sourceInSec,
      sourceOutSec: clip.sourceOutSec,
      fps,
      stab,
      hasAudio
    }
    let outcome: Awaited<ReturnType<typeof window.focusnews.video.stabPreview>>
    try {
      outcome = await window.focusnews.video.stabPreview(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        errors: { ...state.errors, [clip.id]: message },
        applied: withoutKey(state.applied, clip.id)
      }))
      return
    }
    if (outcome.status === 'cached') {
      set((state) => ({
        applied: { ...state.applied, [clip.id]: { path: outcome.path ?? '', signature } },
        errors: withoutKey(state.errors, clip.id)
      }))
      return
    }
    // queued：旧记账作废（参数可能已变），完成时由 handleJobResult 用这里的登记重新记账
    pendingJobs.set(outcome.jobId, { clipId: clip.id, signature })
    set((state) => ({
      errors: withoutKey(state.errors, clip.id),
      applied: withoutKey(state.applied, clip.id)
    }))
  },

  clearForClip: (clipId, removeFiles) => {
    for (const [jobId, job] of pendingJobs) {
      if (job.clipId === clipId) pendingJobs.delete(jobId)
    }
    set((state) => ({
      applied: withoutKey(state.applied, clipId),
      errors: withoutKey(state.errors, clipId)
    }))
    // 回收磁盘缓存：拿不到 IPC（预加载未注入 / 测试环境）也不能抛，
    // 否则一次「关掉防抖」的点击会把渲染进程的事件处理链整个打断
    if (removeFiles) void window.focusnews?.video?.stabPreviewRemove?.(clipId)?.catch(() => undefined)
  },

  handleJobResult: (result) => {
    if (!result.jobId.startsWith(STAB_JOB_ID_PREFIX)) return
    const pending = pendingJobs.get(result.jobId)
    pendingJobs.delete(result.jobId)
    if (!pending) return
    if (result.ok && result.outputs.length > 0) {
      set((state) => ({
        applied: {
          ...state.applied,
          [pending.clipId]: { path: result.outputs[0] ?? '', signature: pending.signature }
        },
        errors: withoutKey(state.errors, pending.clipId)
      }))
      return
    }
    set((state) => ({
      errors: { ...state.errors, [pending.clipId]: result.error?.message ?? STAB_APPLY_FAILED }
    }))
  }
}))

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** apply 受理成功后的待完成登记（jobId → 归属 clip 与应用时签名）；结果事件消费后即删。 */
const pendingJobs = new Map<string, { clipId: string; signature: string }>()

const STAB_APPLY_FAILED = '防抖预览生成失败'
