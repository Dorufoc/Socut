import { describe, expect, it } from 'vitest'
import type { CaptionProgressEvent, CaptionTranscribeRequest } from '@shared/api'
import type { WhisperSegment } from '@shared/whisper'
import {
  createCaptionTranscribeService,
  normalizeCaptionTranscribeRequest,
  type CaptionTranscribeDeps
} from '../src/main/captionTranscribe'

/**
 * M11：自动字幕会话层（主进程）。
 *
 * 覆盖 IPC handler 背后的全部决策：参数校验、requestId 会话表、进度归一（prepare → transcribe）、
 * 错误码原样透传、取消（AbortSignal）与 CAPTION_BUSY 防并发。
 * 用「注入 fake transcribe」代替真实 whisper 资产——真资产有 skipIf 用例，这里不该依赖。
 */

const REQUEST: CaptionTranscribeRequest = {
  requestId: 'req-1',
  mediaPath: 'C:/media/news.mp4',
  language: 'zh'
}

const CUE = (startSec: number, endSec: number, text: string): WhisperSegment => ({ startSec, endSec, text })

/** 组装一个可注入的转写实现，并记录它收到的参数。 */
function fakeDeps(
  impl: CaptionTranscribeDeps['transcribe'] = async () => ({ cues: [], language: 'zh' })
): CaptionTranscribeDeps & { readonly calls: Parameters<CaptionTranscribeDeps['transcribe']>[0][] } {
  const calls: Parameters<CaptionTranscribeDeps['transcribe']>[0][] = []
  return {
    calls,
    transcribe: (request) => {
      calls.push(request)
      return impl(request)
    }
  }
}

describe('normalizeCaptionTranscribeRequest', () => {
  it('合法请求：去空白并保留可选字段', () => {
    expect(
      normalizeCaptionTranscribeRequest({
        requestId: ' req-1 ',
        mediaPath: ' C:/media/news.mp4 ',
        language: ' zh ',
        modelPath: ' D:/models/ggml-base.bin '
      })
    ).toEqual({ requestId: 'req-1', mediaPath: 'C:/media/news.mp4', language: 'zh', modelPath: 'D:/models/ggml-base.bin' })
  })

  it('可选字段为空串/非字符串时整键省略（不把空语言传给 whisper）', () => {
    expect(normalizeCaptionTranscribeRequest({ requestId: 'r', mediaPath: 'C:/a.mp4', language: '  ', modelPath: 42 })).toEqual({
      requestId: 'r',
      mediaPath: 'C:/a.mp4'
    })
  })

  it('缺 requestId / mediaPath 或不是对象时返回 null', () => {
    expect(normalizeCaptionTranscribeRequest(null)).toBeNull()
    expect(normalizeCaptionTranscribeRequest('caption')).toBeNull()
    expect(normalizeCaptionTranscribeRequest({ mediaPath: 'C:/a.mp4' })).toBeNull()
    expect(normalizeCaptionTranscribeRequest({ requestId: 'r' })).toBeNull()
    expect(normalizeCaptionTranscribeRequest({ requestId: '   ', mediaPath: 'C:/a.mp4' })).toBeNull()
  })
})

describe('createCaptionTranscribeService', () => {
  it('成功：透传 cue/语言，进度按 prepare(0) → transcribe(X) 归一', async () => {
    const deps = fakeDeps(async (request) => {
      request.onProgress?.(40)
      request.onProgress?.(100)
      return { cues: [CUE(0.2, 2.4, '今日头条'), CUE(2.6, 4.8, '省发展改革委发布')], language: 'zh' }
    })
    const events: CaptionProgressEvent[] = []
    const service = createCaptionTranscribeService(deps)

    const result = await service.transcribe(REQUEST, (event) => events.push(event))

    expect(result).toEqual({
      requestId: 'req-1',
      ok: true,
      cues: [CUE(0.2, 2.4, '今日头条'), CUE(2.6, 4.8, '省发展改革委发布')],
      language: 'zh',
      errorCode: null,
      errorMessage: null
    })
    expect(events).toEqual([
      { requestId: 'req-1', percent: 0, stage: 'prepare' },
      { requestId: 'req-1', percent: 40, stage: 'transcribe' },
      { requestId: 'req-1', percent: 100, stage: 'transcribe' }
    ])
    expect(deps.calls[0]).toMatchObject({ mediaPath: 'C:/media/news.mp4', language: 'zh' })
    expect(deps.calls[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(service.activeCount()).toBe(0)
  })

  it('抽音真实进度：onPrepareProgress 按 prepare 阶段上报，不串成 transcribe', async () => {
    const deps = fakeDeps(async (request) => {
      request.onPrepareProgress?.(0)
      request.onPrepareProgress?.(55)
      request.onPrepareProgress?.(99)
      request.onProgress?.(100)
      return { cues: [] }
    })
    const events: CaptionProgressEvent[] = []
    await createCaptionTranscribeService(deps).transcribe(REQUEST, (event) => events.push(event))
    expect(events).toEqual([
      { requestId: 'req-1', percent: 0, stage: 'prepare' },
      { requestId: 'req-1', percent: 0, stage: 'prepare' },
      { requestId: 'req-1', percent: 55, stage: 'prepare' },
      { requestId: 'req-1', percent: 99, stage: 'prepare' },
      { requestId: 'req-1', percent: 100, stage: 'transcribe' }
    ])
  })

  it('进度百分比夹到 0..100（真 whisper 偶发 >100 / NaN 不把进度条画飞）', async () => {
    const deps = fakeDeps(async (request) => {
      request.onProgress?.(150)
      request.onProgress?.(-3)
      request.onProgress?.(Number.NaN)
      return { cues: [] }
    })
    const events: CaptionProgressEvent[] = []
    await createCaptionTranscribeService(deps).transcribe(REQUEST, (event) => events.push(event))
    expect(events.map((event) => event.percent)).toEqual([0, 100, 0, 0])
  })

  it('不传进度回调也能跑完（CLI/测试场景）', async () => {
    const service = createCaptionTranscribeService(fakeDeps(async () => ({ cues: [] })))
    await expect(service.transcribe(REQUEST)).resolves.toMatchObject({ ok: true })
  })

  it('失败：错误码与可读消息原样透传（WhisperError.code）', async () => {
    const error = Object.assign(new Error('未找到 whisper.cpp 可执行文件（候选：…）'), { code: 'WHISPER_BINARY_MISSING' })
    const service = createCaptionTranscribeService(fakeDeps(async () => Promise.reject(error)))

    const result = await service.transcribe(REQUEST)

    expect(result).toMatchObject({
      requestId: 'req-1',
      ok: false,
      cues: [],
      language: null,
      errorCode: 'WHISPER_BINARY_MISSING',
      errorMessage: '未找到 whisper.cpp 可执行文件（候选：…）'
    })
    expect(service.activeCount()).toBe(0)
  })

  it('普通 Error 兜底 WHISPER_ERROR；非 Error 也给出字符串消息', async () => {
    const service = createCaptionTranscribeService(
      fakeDeps((request) => {
        if (request.mediaPath === 'C:/a.mp4') return Promise.reject(new Error('boom'))
        return Promise.reject('字符串错误')
      })
    )
    await expect(service.transcribe({ requestId: 'r1', mediaPath: 'C:/a.mp4' })).resolves.toMatchObject({
      errorCode: 'WHISPER_ERROR',
      errorMessage: 'boom'
    })
    await expect(service.transcribe({ requestId: 'r2', mediaPath: 'C:/b.mp4' })).resolves.toMatchObject({
      errorCode: 'WHISPER_ERROR',
      errorMessage: '字符串错误'
    })
  })

  it('取消：cancel(requestId) abort 信号，结果统一为 CANCELLED', async () => {
    let rejectRun: ((reason: unknown) => void) | null = null
    const service = createCaptionTranscribeService({
      transcribe: (request) =>
        new Promise((_resolve, reject) => {
          rejectRun = reject
          request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('转写已取消'), { code: 'CANCELLED' })), {
            once: true
          })
        })
    })

    const pending = service.transcribe(REQUEST)
    expect(service.activeCount()).toBe(1)
    expect(service.cancel('req-1')).toBe(true)

    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'CANCELLED', errorMessage: '转写已取消' })
    expect(rejectRun).not.toBeNull()
    expect(service.activeCount()).toBe(0)
  })

  it('取消兜底：下层 abort 后抛的是普通错误，也归一成 CANCELLED', async () => {
    const service = createCaptionTranscribeService({
      transcribe: (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('进程被 kill')), { once: true })
        })
    })
    const pending = service.transcribe(REQUEST)
    service.cancel('req-1')
    await expect(pending).resolves.toMatchObject({ ok: false, errorCode: 'CANCELLED' })
  })

  it('cancel 未知 requestId 返回 false（已结束的会话不会误杀别人）', async () => {
    const service = createCaptionTranscribeService(fakeDeps(async () => ({ cues: [] })))
    await service.transcribe(REQUEST)
    expect(service.cancel('req-1')).toBe(false)
  })

  it('CAPTION_BUSY：同一 requestId 在跑时第二次调用被明确拒绝，不并发起两份进程', async () => {
    const pending: { resolve?: (value: { cues: WhisperSegment[] }) => void } = {}
    let callCount = 0
    const deps = fakeDeps(() => {
      callCount += 1
      // 第一次挂起（模拟长任务），后续调用立即返回，便于验证「结束后可重试」
      if (callCount === 1) {
        return new Promise<{ cues: WhisperSegment[] }>((resolve) => {
          pending.resolve = resolve
        })
      }
      return Promise.resolve({ cues: [] })
    })
    const service = createCaptionTranscribeService(deps)

    const first = service.transcribe(REQUEST)
    await expect(service.transcribe(REQUEST)).resolves.toMatchObject({ ok: false, errorCode: 'CAPTION_BUSY' })
    expect(deps.calls).toHaveLength(1)
    expect(service.activeCount()).toBe(1)

    pending.resolve?.({ cues: [CUE(0, 1, 'x')] })
    await expect(first).resolves.toMatchObject({ ok: true, cues: [CUE(0, 1, 'x')] })
    // 结束后同一 requestId 可以再次使用（面板重试）
    await expect(service.transcribe(REQUEST)).resolves.toMatchObject({ ok: true })
    expect(deps.calls).toHaveLength(2)
  })

  it('媒体/模型路径与语言原样交给下层（可选字段不出现时整键省略）', async () => {
    const deps = fakeDeps(async () => ({ cues: [], language: undefined }))
    const service = createCaptionTranscribeService(deps)
    await service.transcribe({
      requestId: 'r3',
      mediaPath: 'C:/a.mp4',
      language: 'en',
      modelPath: 'D:/m.bin'
    })
    expect(deps.calls[0]).toMatchObject({ language: 'en', modelPath: 'D:/m.bin' })
    await service.transcribe({ requestId: 'r4', mediaPath: 'C:/b.mp4' })
    expect(deps.calls[1]!.language).toBeUndefined()
    expect(deps.calls[1]!.modelPath).toBeUndefined()
  })
})
