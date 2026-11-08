import { create } from 'zustand'
import type { JobResult, MediaProxyRequest } from '@shared/types'

/**
 * v10：4K / MXF 预览代理的渲染侧账本（mediaId → 已就绪的代理文件）。
 *
 * 与防抖代理同一纪律：作业进度/取消复用导出任务队列（jobId 前缀 proxy-），
 * 本 store 只回答 PreviewStage 一个问题——这条素材现在该播原片还是播代理？代理在哪？
 *
 * 新鲜度：主进程返回的签名含源 size/mtime；`revalidate` 在素材面板/工程变化时重查一次，
 * 源文件被替换 → 主进程按新指纹找不到代理 → 清账本 → 预览回落原片（MXF 显示不可预览）。
 * 不持久化：重启后磁盘缓存还在，重新点「生成预览代理」会秒回 cached（不起子进程）。
 */

export const MEDIA_PROXY_JOB_PREFIX = 'proxy-'

export interface MediaProxyEntry {
  /** 代理 mp4 绝对路径（socut-media:// 由预览层现取） */
  path: string
  /** 受理那一刻的签名（主进程用同一函数计算） */
  signature: string
  /** 代理对应的原片路径（素材被重新定位时自然失效） */
  sourcePath: string
}

export interface ProxyApplyInput {
  mediaId: string
  /** 素材池里的实际文件（导出永远读它，代理只替换预览源） */
  path: string
  hasAudio?: boolean
  durationSec?: number
}

export interface MediaProxyState {
  entries: Record<string, MediaProxyEntry>
  /** 受理/作业失败的提示（按 mediaId；下次成功受理时清掉） */
  errors: Record<string, string>
  /** 有在跑/排队的代理作业（按 mediaId） */
  busy: Record<string, boolean>
  apply: (input: ProxyApplyInput) => Promise<void>
  /** 源文件/路径变化后重查新鲜度；过期则清账本（预览回落原片） */
  revalidate: (mediaId: string, path: string) => Promise<void>
  /** 素材移出池：清账本 + 可选回收主进程磁盘缓存 */
  clearForMedia: (mediaId: string, removeFiles: boolean) => void
  /** 预览源解析：只有原片路径与记账一致时才返回代理路径，否则 null */
  resolveForPreview: (mediaId: string, path: string) => string | null
  /** jobResult 分发入口（jobEvents 里 proxy- 前缀的作业走这里） */
  handleJobResult: (result: JobResult) => void
}

const PROXY_APPLY_FAILED = '预览代理生成失败'

export const useProxyStore = create<MediaProxyState>((set, get) => ({
  entries: {},
  errors: {},
  busy: {},

  apply: async ({ mediaId, path, hasAudio, durationSec }) => {
    const existing = get().entries[mediaId]
    if (existing && existing.sourcePath === path) return
    const api = window.socut?.media
    if (!api?.proxy) {
      set((state) => ({ errors: { ...state.errors, [mediaId]: '当前环境不支持预览代理' } }))
      return
    }

    set((state) => ({
      busy: { ...state.busy, [mediaId]: true },
      errors: withoutKey(state.errors, mediaId)
    }))

    const request: MediaProxyRequest = {
      mediaId,
      path,
      ...(hasAudio === undefined ? {} : { hasAudio }),
      ...(durationSec === undefined ? {} : { durationSec })
    }
    let outcome: Awaited<ReturnType<typeof api.proxy>>
    try {
      outcome = await api.proxy(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set((state) => ({
        errors: { ...state.errors, [mediaId]: message },
        busy: withoutKey(state.busy, mediaId),
        entries: withoutKey(state.entries, mediaId)
      }))
      return
    }

    const cachedPath = outcome.path
    if (outcome.status === 'cached') {
      if (!cachedPath) {
        set((state) => ({
          errors: { ...state.errors, [mediaId]: PROXY_APPLY_FAILED },
          busy: withoutKey(state.busy, mediaId)
        }))
        return
      }
      set((state) => ({
        entries: {
          ...state.entries,
          [mediaId]: { path: cachedPath, signature: outcome.signature, sourcePath: path }
        },
        errors: withoutKey(state.errors, mediaId),
        busy: withoutKey(state.busy, mediaId)
      }))
      return
    }

    // queued：等 jobResult 回传 outputs[0]；签名/源路径来自本次受理登记。
    pendingJobs.set(outcome.jobId, { mediaId, sourcePath: path, signature: outcome.signature })
    set((state) => ({
      entries: withoutKey(state.entries, mediaId),
      errors: withoutKey(state.errors, mediaId)
    }))
  },

  revalidate: async (mediaId, path) => {
    const entry = get().entries[mediaId]
    if (!entry || entry.sourcePath !== path) return
    let status: Awaited<ReturnType<typeof window.socut.media.proxyStatus>>
    try {
      const api = window.socut?.media
      if (!api?.proxyStatus) return
      status = await api.proxyStatus({ mediaId, path })
    } catch {
      return
    }
    if (!status.fresh || !status.path) {
      set((state) => ({
        entries: withoutKey(state.entries, mediaId),
        busy: withoutKey(state.busy, mediaId)
      }))
      return
    }
    if (status.signature !== entry.signature || status.path !== entry.path) {
      set((state) => ({
        entries: {
          ...state.entries,
          [mediaId]: { path: status.path ?? '', signature: status.signature, sourcePath: path }
        }
      }))
    }
  },

  clearForMedia: (mediaId, removeFiles) => {
    for (const [jobId, job] of pendingJobs) {
      if (job.mediaId === mediaId) pendingJobs.delete(jobId)
    }
    set((state) => ({
      entries: withoutKey(state.entries, mediaId),
      errors: withoutKey(state.errors, mediaId),
      busy: withoutKey(state.busy, mediaId)
    }))
    // 拿不到 IPC（预加载未注入 / 测试环境）也不能抛：一次「移出素材」的点击不该打断事件链
    if (removeFiles) {
      void window.socut?.media?.removeProxy?.(mediaId)?.catch(() => undefined)
    }
  },

  resolveForPreview: (mediaId, path) => {
    const entry = get().entries[mediaId]
    if (!entry || entry.sourcePath !== path) return null
    return entry.path
  },

  handleJobResult: (result) => {
    if (!result.jobId.startsWith(MEDIA_PROXY_JOB_PREFIX)) return
    const pending = pendingJobs.get(result.jobId)
    pendingJobs.delete(result.jobId)
    if (!pending) return
    if (result.ok && result.outputs.length > 0 && result.outputs[0]) {
      set((state) => ({
        entries: {
          ...state.entries,
          [pending.mediaId]: {
            path: result.outputs[0] ?? '',
            signature: pending.signature,
            sourcePath: pending.sourcePath
          }
        },
        errors: withoutKey(state.errors, pending.mediaId),
        busy: withoutKey(state.busy, pending.mediaId)
      }))
      return
    }
    set((state) => ({
      errors: {
        ...state.errors,
        [pending.mediaId]: result.error?.message ?? PROXY_APPLY_FAILED
      },
      busy: withoutKey(state.busy, pending.mediaId)
    }))
  }
}))

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** apply 受理成功后的待完成登记（jobId → 归属素材与受理时签名）；结果事件消费后即删。 */
const pendingJobs = new Map<string, { mediaId: string; sourcePath: string; signature: string }>()
