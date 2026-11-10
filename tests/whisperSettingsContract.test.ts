import { describe, expect, it, vi } from 'vitest'
import type { SocutApi, VoiceAssetStatus } from '@shared/api'
import { CHANNELS } from '@shared/ipcChannels'

/**
 * M11/M8：preload「语音资产」面的契约（渲染进程只认 `window.socut.whisper.*`）。
 *
 * 用假 electron 跑真正的 preload 模块：通道名唯一真值、参数原样转发、结果原样返回，
 * 且既有 API 面（caption/gpu/project/export…）不被破坏。
 */

const electronMock = vi.hoisted(() => {
  const exposed: Record<string, unknown> = {}
  const invoke = vi.fn()
  const send = vi.fn()
  return { exposed, invoke, send }
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
    on: vi.fn(),
    removeListener: vi.fn()
  }
}))

// 静态 import 即可：vi.mock 会被提升到所有 import 之前（preload 拿到的是上面的假 electron）
import '../src/preload/index'

const api = electronMock.exposed['socut'] as SocutApi

const STATUS: VoiceAssetStatus = {
  ready: true,
  binaryPath: 'C:/app/resources/whisper/whisper-cli.exe',
  modelPath: 'C:/app/resources/models/whisper/ggml-base.bin',
  language: 'zh',
  configPath: 'C:/Users/u/AppData/Roaming/Socut/whisper.json',
  candidates: {
    binaries: ['C:/app/resources/whisper/whisper-cli.exe'],
    models: ['C:/app/resources/models/whisper/ggml-base.bin']
  },
  rnnoise: { path: 'C:/app/resources/models/rnnoise/std.rnnn', candidates: [] }
}

describe('preload 语音资产面', () => {
  it('通道名是唯一真值：whisper:status / config / pickBinary / pickModel / reset', () => {
    expect(CHANNELS.whisperStatus).toBe('whisper:status')
    expect(CHANNELS.whisperSaveConfig).toBe('whisper:config')
    expect(CHANNELS.whisperPickBinary).toBe('whisper:pickBinary')
    expect(CHANNELS.whisperPickModel).toBe('whisper:pickModel')
    expect(CHANNELS.whisperReset).toBe('whisper:reset')
  })

  it('暴露 socut.whisper 五件套，既有 API 面仍在', () => {
    expect(typeof api.whisper.status).toBe('function')
    expect(typeof api.whisper.saveConfig).toBe('function')
    expect(typeof api.whisper.pickBinary).toBe('function')
    expect(typeof api.whisper.pickModel).toBe('function')
    expect(typeof api.whisper.reset).toBe('function')
    // 既有面回归（M11 自动字幕 + M0 起的老面）
    expect(typeof api.caption.transcribe).toBe('function')
    expect(typeof api.gpu.diagnostics).toBe('function')
    expect(typeof api.project.open).toBe('function')
    expect(typeof api.export.start).toBe('function')
  })

  it('status：走 whisper:status，结果原样返回', async () => {
    electronMock.invoke.mockResolvedValueOnce(STATUS)
    await expect(api.whisper.status()).resolves.toEqual(STATUS)
    expect(electronMock.invoke).toHaveBeenCalledWith(CHANNELS.whisperStatus)
  })

  it('saveConfig：补丁原样转发（含 null 清除语义）', async () => {
    electronMock.invoke.mockResolvedValueOnce(STATUS)
    await api.whisper.saveConfig({ binaryPath: 'D:/tools/whisper-cli.exe', language: null })
    expect(electronMock.invoke).toHaveBeenCalledWith(CHANNELS.whisperSaveConfig, {
      binaryPath: 'D:/tools/whisper-cli.exe',
      language: null
    })
  })

  it('pickBinary / pickModel / reset：各自走独立通道（取消时返回 null）', async () => {
    electronMock.invoke.mockResolvedValueOnce(null)
    await expect(api.whisper.pickBinary()).resolves.toBeNull()
    expect(electronMock.invoke).toHaveBeenLastCalledWith(CHANNELS.whisperPickBinary)

    electronMock.invoke.mockResolvedValueOnce('D:/models/ggml-small.bin')
    await expect(api.whisper.pickModel()).resolves.toBe('D:/models/ggml-small.bin')
    expect(electronMock.invoke).toHaveBeenLastCalledWith(CHANNELS.whisperPickModel)

    electronMock.invoke.mockResolvedValueOnce(STATUS)
    await expect(api.whisper.reset()).resolves.toEqual(STATUS)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(CHANNELS.whisperReset)
  })
})
