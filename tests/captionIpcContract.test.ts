import { describe, expect, it, vi } from 'vitest'
import type { CaptionProgressEvent, CaptionTranscribeResult, SocutApi } from '@shared/api'
import { CHANNELS } from '@shared/ipcChannels'

/**
 * M11：preload 自动字幕面的契约（渲染进程只认 `window.socut.caption.*`）。
 *
 * 用假 electron 跑真正的 preload 模块：验证通道名、参数原样转发、进度订阅/退订、
 * 取消按 requestId 走独立通道，且既有 API 面不被破坏。
 */

const electronMock = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {}
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const invoke = vi.fn()
  const send = vi.fn()
  const on = vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
    listeners.set(channel, listener)
  })
  const removeListener = vi.fn((channel: string) => {
    listeners.delete(channel)
  })
  return { exposed, invoke, send, on, removeListener, listeners }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      electronMock.exposed[name] = api
    }
  },
  ipcRenderer: {
    invoke: electronMock.invoke,
    send: electronMock.send,
    on: electronMock.on,
    removeListener: electronMock.removeListener
  }
}))

// 静态 import 即可：vi.mock 会被提升到所有 import 之前（preload 拿到的是上面的假 electron）
import '../src/preload/index'

const api = electronMock.exposed['socut'] as SocutApi

const RESULT: CaptionTranscribeResult = {
  requestId: 'req-1',
  ok: true,
  cues: [{ startSec: 0.2, endSec: 2.4, text: '今日头条' }],
  language: 'zh',
  errorCode: null,
  errorMessage: null
}

describe('preload 自动字幕面', () => {
  it('通道名是唯一真值：caption:transcribe / caption:progress / caption:cancel', () => {
    expect(CHANNELS.captionTranscribe).toBe('caption:transcribe')
    expect(CHANNELS.captionProgress).toBe('caption:progress')
    expect(CHANNELS.captionCancel).toBe('caption:cancel')
  })

  it('暴露 socut.caption 三件套，且既有 API 面仍在（contextBridge 只多不少）', () => {
    expect(api).toBeTruthy()
    expect(typeof api.caption.transcribe).toBe('function')
    expect(typeof api.caption.onProgress).toBe('function')
    expect(typeof api.caption.cancel).toBe('function')
    // 既有面回归：app/project/fonts/video/watermark/gpu/media/export/job/cli 都还在
    expect(typeof api.app.info).toBe('function')
    expect(typeof api.project.open).toBe('function')
    expect(typeof api.export.start).toBe('function')
    expect(typeof api.job.onProgress).toBe('function')
    expect(typeof api.cli.onCommand).toBe('function')
    expect(typeof electronMock.exposed['socut']).toBe('object')
    expect(electronMock.exposed['socut']).toBe(api)
  })

  it('transcribe：走 caption:transcribe，请求原样转发、结果原样返回', async () => {
    electronMock.invoke.mockResolvedValueOnce(RESULT)
    const request = { requestId: 'req-1', mediaPath: 'C:/media/news.mp4', language: 'zh' }

    const result = await api.caption.transcribe(request)

    expect(electronMock.invoke).toHaveBeenCalledWith(CHANNELS.captionTranscribe, request)
    expect(result).toEqual(RESULT)
  })

  it('失败结果不抛异常：errorCode/errorMessage 原样回到渲染侧（面板据此给可执行提示）', async () => {
    electronMock.invoke.mockResolvedValueOnce({
      requestId: 'req-1',
      ok: false,
      cues: [],
      language: null,
      errorCode: 'WHISPER_MODEL_MISSING',
      errorMessage: '未找到 whisper 模型'
    })
    await expect(api.caption.transcribe({ requestId: 'req-1', mediaPath: 'C:/a.mp4' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'WHISPER_MODEL_MISSING'
    })
  })

  it('onProgress：订阅 caption:progress，按 requestId/percent/stage 回调，返回可退订函数', () => {
    const handler = vi.fn<(progress: CaptionProgressEvent) => void>()
    const off = api.caption.onProgress(handler)
    const listener = electronMock.listeners.get(CHANNELS.captionProgress)
    expect(electronMock.on).toHaveBeenCalledWith(CHANNELS.captionProgress, listener)
    expect(typeof off).toBe('function')

    const event: CaptionProgressEvent = { requestId: 'req-1', percent: 42, stage: 'transcribe' }
    listener?.({}, event)
    expect(handler).toHaveBeenCalledWith(event)

    off()
    expect(electronMock.removeListener).toHaveBeenCalledWith(CHANNELS.captionProgress, listener)
  })

  it('cancel：走 caption:cancel 并带上 requestId', async () => {
    electronMock.invoke.mockResolvedValueOnce(false)
    await expect(api.caption.cancel('req-1')).resolves.toBe(false)
    expect(electronMock.invoke).toHaveBeenCalledWith(CHANNELS.captionCancel, 'req-1')
  })
})
