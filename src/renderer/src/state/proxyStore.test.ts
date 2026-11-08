import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobResult, MediaProxyRequest, MediaProxyResult, MediaProxyStatusResult } from '@shared/types'
import { useProxyStore } from './proxyStore'

/**
 * v10（Task 10）：预览代理的渲染侧账本。
 * 锁定：queued → jobResult 成功记账；cached 直接记账；失败进 errors；源路径变化/移出素材时清账本。
 */

const proxyMock = vi.fn<(request: MediaProxyRequest) => Promise<MediaProxyResult>>()
const statusMock = vi.fn<(request: MediaProxyRequest) => Promise<MediaProxyStatusResult>>()
const removeMock = vi.fn<(mediaId: string) => Promise<void>>()

function installApi(): void {
  Object.defineProperty(window, 'socut', {
    configurable: true,
    value: { media: { proxy: proxyMock, proxyStatus: statusMock, removeProxy: removeMock } }
  })
}

function resetStore(): void {
  useProxyStore.setState({ entries: {}, errors: {}, busy: {} })
}

function jobResult(over: Partial<JobResult> & { jobId: string }): JobResult {
  return {
    ok: true,
    outputs: [],
    progress: {
      jobId: over.jobId,
      phase: 'done',
      framesDone: 1,
      framesTotal: 1,
      outTimeUs: 0,
      percent: 1,
      bytesWritten: 0,
      elapsedMs: 0,
      notices: []
    },
    ...over
  }
}

beforeEach(() => {
  resetStore()
  proxyMock.mockReset()
  statusMock.mockReset()
  removeMock.mockReset()
  removeMock.mockResolvedValue(undefined)
  installApi()
})

afterEach(() => {
  resetStore()
  delete (window as { socut?: unknown }).socut
})

describe('proxyStore', () => {
  it('queued → jobResult 成功：记账代理路径与受理时签名', async () => {
    proxyMock.mockResolvedValue({
      status: 'queued',
      jobId: 'proxy-m1',
      path: null,
      signature: 'sig-queued'
    })

    await useProxyStore.getState().apply({ mediaId: 'm1', path: 'D:/media/a.mxf', hasAudio: true })
    expect(proxyMock).toHaveBeenCalledWith({
      mediaId: 'm1',
      path: 'D:/media/a.mxf',
      hasAudio: true
    })
    expect(useProxyStore.getState().busy['m1']).toBe(true)
    expect(useProxyStore.getState().entries['m1']).toBeUndefined()

    useProxyStore.getState().handleJobResult(
      jobResult({ jobId: 'proxy-m1', ok: true, outputs: ['D:/proxies/m1-abc.mp4'] })
    )
    const entry = useProxyStore.getState().entries['m1']
    expect(entry).toEqual({ path: 'D:/proxies/m1-abc.mp4', signature: 'sig-queued', sourcePath: 'D:/media/a.mxf' })
    expect(useProxyStore.getState().busy['m1']).toBeUndefined()
    expect(useProxyStore.getState().resolveForPreview('m1', 'D:/media/a.mxf')).toBe('D:/proxies/m1-abc.mp4')
    // 素材被重新定位（原片路径变了）→ 旧代理不再被采用
    expect(useProxyStore.getState().resolveForPreview('m1', 'D:/media/other.mxf')).toBeNull()
  })

  it('cached：直接记账，不置 busy', async () => {
    proxyMock.mockResolvedValue({
      status: 'cached',
      jobId: 'proxy-m2',
      path: 'D:/proxies/m2-cached.mp4',
      signature: 'sig-cached'
    })

    await useProxyStore.getState().apply({ mediaId: 'm2', path: 'D:/media/b.mp4', durationSec: 10 })

    expect(useProxyStore.getState().entries['m2']).toEqual({
      path: 'D:/proxies/m2-cached.mp4',
      signature: 'sig-cached',
      sourcePath: 'D:/media/b.mp4'
    })
    expect(useProxyStore.getState().busy['m2']).toBeUndefined()
  })

  it('受理失败与作业失败都进 errors；成功受理后清掉旧错误', async () => {
    proxyMock.mockRejectedValueOnce(new Error('源文件不存在'))
    await useProxyStore.getState().apply({ mediaId: 'm3', path: 'D:/media/missing.mxf' })
    expect(useProxyStore.getState().errors['m3']).toBe('源文件不存在')
    expect(useProxyStore.getState().busy['m3']).toBeUndefined()

    proxyMock.mockResolvedValueOnce({ status: 'queued', jobId: 'proxy-m3', path: null, signature: 'sig-3' })
    await useProxyStore.getState().apply({ mediaId: 'm3', path: 'D:/media/missing.mxf' })
    expect(useProxyStore.getState().errors['m3']).toBeUndefined()
    expect(useProxyStore.getState().busy['m3']).toBe(true)

    useProxyStore.getState().handleJobResult(
      jobResult({
        jobId: 'proxy-m3',
        ok: false,
        outputs: [],
        error: { code: 'FFMPEG_EXIT', message: '转码失败', stderrTail: '', fatal: true }
      })
    )
    expect(useProxyStore.getState().errors['m3']).toBe('转码失败')
    expect(useProxyStore.getState().busy['m3']).toBeUndefined()
    expect(useProxyStore.getState().entries['m3']).toBeUndefined()
  })

  it('源文件变化（status 不再 fresh）→ 清账本回落原片', async () => {
    proxyMock.mockResolvedValue({
      status: 'cached',
      jobId: 'proxy-m4',
      path: 'D:/proxies/m4-old.mp4',
      signature: 'sig-old'
    })
    await useProxyStore.getState().apply({ mediaId: 'm4', path: 'D:/media/c.mxf' })
    expect(useProxyStore.getState().entries['m4']).toBeDefined()

    statusMock.mockResolvedValue({ fresh: false, path: null, signature: 'sig-new' })
    await useProxyStore.getState().revalidate('m4', 'D:/media/c.mxf')
    expect(useProxyStore.getState().entries['m4']).toBeUndefined()
    expect(useProxyStore.getState().resolveForPreview('m4', 'D:/media/c.mxf')).toBeNull()
  })

  it('status 仍 fresh 但签名变化 → 更新签名字段', async () => {
    proxyMock.mockResolvedValue({
      status: 'cached',
      jobId: 'proxy-m5',
      path: 'D:/proxies/m5.mp4',
      signature: 'sig-old'
    })
    await useProxyStore.getState().apply({ mediaId: 'm5', path: 'D:/media/d.mp4' })

    statusMock.mockResolvedValue({ fresh: true, path: 'D:/proxies/m5.mp4', signature: 'sig-new' })
    await useProxyStore.getState().revalidate('m5', 'D:/media/d.mp4')
    expect(useProxyStore.getState().entries['m5']?.signature).toBe('sig-new')
  })

  it('clearForMedia：清账本并按需回收磁盘代理', async () => {
    proxyMock.mockResolvedValue({
      status: 'cached',
      jobId: 'proxy-m6',
      path: 'D:/proxies/m6.mp4',
      signature: 'sig-6'
    })
    await useProxyStore.getState().apply({ mediaId: 'm6', path: 'D:/media/e.mp4' })
    expect(useProxyStore.getState().entries['m6']).toBeDefined()

    useProxyStore.getState().clearForMedia('m6', true)
    expect(useProxyStore.getState().entries['m6']).toBeUndefined()
    expect(removeMock).toHaveBeenCalledWith('m6')

    useProxyStore.getState().clearForMedia('m6', false)
    expect(removeMock).toHaveBeenCalledTimes(1)
  })
})
