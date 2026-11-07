import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultMediaStab } from '@shared/mediaStab'
import { DEFAULT_MEDIA_TRACK_ID } from '@shared/constants'
import type { JobResult, MediaClip, StabPreviewRequest, StabPreviewResult } from '@shared/types'
import { stabSignatureFor, useStabPreviewStore } from './stabPreviewStore'

/**
 * v8.1 防抖预览代理的渲染侧账本：
 * - cached 立即记账；queued 只在 jobResult 成功后记账；
 * - 签名是唯一的失效判据（参数一改自动回落原片）；
 * - clearForClip 之后迟到的结果不许再写回账本（片段已经没了）。
 */

const clip: MediaClip = {
  id: 'mclip-1',
  mediaId: 'm1',
  trackId: DEFAULT_MEDIA_TRACK_ID,
  timelineStartSec: 0,
  timelineEndSec: 4,
  sourceInSec: 2,
  sourceOutSec: 6
}
const stab = { ...defaultMediaStab(), enabled: true }
const fps = { num: 30, den: 1 }

function input(over: Partial<{ clip: MediaClip; sourcePath: string }> = {}) {
  return {
    clip: over.clip ?? clip,
    stab,
    sourcePath: over.sourcePath ?? 'D:/media/a.mp4',
    fps,
    hasAudio: true
  }
}

const stubBridge = (
  stabPreview: (request: StabPreviewRequest) => Promise<StabPreviewResult>,
  remove = vi.fn().mockResolvedValue(undefined)
): void => {
  ;(window as unknown as { focusnews: unknown }).focusnews = {
    video: { stabPreview, stabPreviewRemove: remove },
    export: { cancel: vi.fn().mockResolvedValue(undefined) }
  }
}

const queuedResult: StabPreviewResult = { status: 'queued', jobId: 'stab-mclip-1', path: null, signature: 'sig' }

function jobResult(over: Partial<JobResult>): JobResult {
  return {
    jobId: 'stab-mclip-1',
    ok: true,
    outputs: ['C:/userData/stab-preview/stab-mclip-1-abcd.mp4'],
    progress: {
      jobId: 'stab-mclip-1',
      phase: 'done',
      framesDone: 2,
      framesTotal: 2,
      outTimeUs: 4e6,
      percent: 1,
      bytesWritten: 0,
      elapsedMs: 10,
      notices: []
    },
    ...over
  }
}

beforeEach(() => {
  useStabPreviewStore.setState({ applied: {}, errors: {} })
})

describe('stabPreviewStore.apply', () => {
  it('cached：立即记账，路径与签名可用', async () => {
    stubBridge(async () => ({ status: 'cached', jobId: 'stab-mclip-1', path: 'C:/x/proxy.mp4', signature: 'sig' }))
    await useStabPreviewStore.getState().apply(input())
    const applied = useStabPreviewStore.getState().applied['mclip-1']
    expect(applied?.path).toBe('C:/x/proxy.mp4')
    expect(applied?.signature).toBe(stabSignatureFor(input()))
  })

  it('queued：受理时不记账，jobResult 成功后按应用时的签名记账', async () => {
    stubBridge(async () => queuedResult)
    await useStabPreviewStore.getState().apply(input())
    expect(useStabPreviewStore.getState().applied['mclip-1']).toBeUndefined()
    useStabPreviewStore.getState().handleJobResult(jobResult({}))
    const applied = useStabPreviewStore.getState().applied['mclip-1']
    expect(applied?.path).toBe('C:/userData/stab-preview/stab-mclip-1-abcd.mp4')
    expect(applied?.signature).toBe(stabSignatureFor(input()))
  })

  it('受理即失效旧记账：queued 之后原签名不再匹配，PreviewStage 会回落原片', async () => {
    stubBridge(async () => ({ status: 'cached', jobId: 'j', path: 'C:/x/old.mp4', signature: 'sig' }))
    await useStabPreviewStore.getState().apply(input())
    stubBridge(async () => queuedResult)
    await useStabPreviewStore.getState().apply(input({ clip: { ...clip, sourceOutSec: 7 } }))
    expect(useStabPreviewStore.getState().applied['mclip-1']).toBeUndefined()
  })

  it('同签名重复应用是 no-op（不许起第二份作业）', async () => {
    const spy = vi.fn(async () => queuedResult)
    stubBridge(spy)
    await useStabPreviewStore.getState().apply(input())
    // queued 后记账为空、签名未落账 → 第二次仍会调 bridge，但主进程按 jobId 复用；
    // 已就绪且签名新鲜时才是真 no-op：
    useStabPreviewStore.getState().handleJobResult(jobResult({}))
    const callsBefore = spy.mock.calls.length
    await useStabPreviewStore.getState().apply(input())
    expect(spy.mock.calls.length).toBe(callsBefore)
  })

  it('bridge 抛错：记账清空 + errors 显示消息', async () => {
    stubBridge(async () => {
      throw new Error('源文件不存在或不可读：D:/media/a.mp4')
    })
    await useStabPreviewStore.getState().apply(input())
    expect(useStabPreviewStore.getState().applied['mclip-1']).toBeUndefined()
    expect(useStabPreviewStore.getState().errors['mclip-1']).toContain('源文件不存在')
  })

  it('作业失败：不记账，errors 带主进程消息', async () => {
    stubBridge(async () => queuedResult)
    await useStabPreviewStore.getState().apply(input())
    useStabPreviewStore.getState().handleJobResult(
      jobResult({ ok: false, outputs: [], error: { code: 'STAB_PREVIEW_FAILED', message: '代理转码失败', stderrTail: '', fatal: true } })
    )
    expect(useStabPreviewStore.getState().applied['mclip-1']).toBeUndefined()
    expect(useStabPreviewStore.getState().errors['mclip-1']).toBe('代理转码失败')
  })
})

describe('stabPreviewStore.clearForClip', () => {
  it('清账本与错误；removeFiles 时回收磁盘缓存', () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    stubBridge(async () => queuedResult, remove)
    useStabPreviewStore.setState({ applied: { 'mclip-1': { path: 'C:/x', signature: 's' } }, errors: { other: 'e' } })
    useStabPreviewStore.getState().clearForClip('mclip-1', true)
    expect(useStabPreviewStore.getState().applied['mclip-1']).toBeUndefined()
    expect(useStabPreviewStore.getState().errors['other']).toBe('e')
    expect(remove).toHaveBeenCalledWith('mclip-1')
  })

  it('删除片段后迟到的成功结果不许写回账本', async () => {
    stubBridge(async () => queuedResult)
    await useStabPreviewStore.getState().apply(input())
    useStabPreviewStore.getState().clearForClip('mclip-1', true)
    useStabPreviewStore.getState().handleJobResult(jobResult({}))
    expect(useStabPreviewStore.getState().applied['mclip-1']).toBeUndefined()
  })

  it('无关 jobId 的结果事件被忽略（导出任务不许串台）', () => {
    stubBridge(async () => queuedResult)
    useStabPreviewStore.getState().handleJobResult(jobResult({ jobId: 'job-123' }))
    expect(Object.keys(useStabPreviewStore.getState().applied)).toHaveLength(0)
  })
})
