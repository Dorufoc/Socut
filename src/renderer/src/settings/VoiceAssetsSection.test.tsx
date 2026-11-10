import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import type { SocutApi, VoiceAssetPatch, VoiceAssetStatus } from '@shared/api'
import { VoiceAssetsSection, voiceStatusLabel } from './VoiceAssetsSection'

/**
 * M11/M8：设置页「语音资产」分区。
 *
 * 锁四件事：
 * 1. 状态展示：缺二进制 / 缺模型 / 就绪三种文案，路径与 RNNoise 状态都显示；
 * 2. 「选择二进制/模型」= 弹框 + 立即保存（用户取消则只提示"已取消"，不落配置）；
 * 3. 语言切换把 'auto' 换成 null 存盘（主进程按 null 清除该项，回到自动检测）；
 * 4. 失败（路径不存在等）显示可读错误，不清空当前状态。
 */

function status(overrides: Partial<VoiceAssetStatus> = {}): VoiceAssetStatus {
  return {
    ready: false,
    binaryPath: null,
    modelPath: null,
    language: null,
    configPath: 'C:/Users/u/AppData/Roaming/Socut/whisper.json',
    candidates: { binaries: ['C:/app/resources/whisper/whisper-cli.exe'], models: [] },
    rnnoise: { path: null, candidates: [] },
    ...overrides
  }
}

const READY = status({
  ready: true,
  binaryPath: 'C:/app/resources/whisper/whisper-cli.exe',
  modelPath: 'C:/app/resources/models/whisper/ggml-base.bin',
  language: 'zh',
  rnnoise: { path: 'C:/app/resources/models/rnnoise/std.rnnn', candidates: [] }
})

function stubApi(initial: VoiceAssetStatus = READY) {
  let current = initial
  const calls: VoiceAssetPatch[] = []
  const api = {
    status: vi.fn(async () => current),
    saveConfig: vi.fn(async (patch: VoiceAssetPatch) => {
      calls.push(patch)
      current = {
        ...current,
        ...(patch.binaryPath !== undefined && patch.binaryPath !== null ? { binaryPath: patch.binaryPath } : {}),
        ...(patch.modelPath !== undefined && patch.modelPath !== null ? { modelPath: patch.modelPath } : {}),
        ...(patch.language !== undefined ? { language: patch.language } : {})
      }
      return current
    }),
    pickBinary: vi.fn<() => Promise<string | null>>(async () => 'D:/tools/whisper-cli.exe'),
    pickModel: vi.fn<() => Promise<string | null>>(async () => 'D:/models/ggml-small.bin'),
    reset: vi.fn(async () => {
      current = status()
      return current
    })
  }
  ;(window as unknown as { socut: Partial<SocutApi> }).socut = { whisper: api } as unknown as SocutApi
  return { api, calls }
}

afterEach(() => {
  cleanup()
  delete (window as unknown as { socut?: unknown }).socut
})

describe('VoiceAssetsSection', () => {
  it('就绪时显示二进制/模型/RNNoise 路径与"就绪"芯片', async () => {
    stubApi()
    render(<VoiceAssetsSection />)

    await waitFor(() => expect(screen.getByTestId('voice-status').textContent).toBe(TEXT.settings.voice.ready))
    expect(screen.getByTestId('voice-binary').textContent).toContain('whisper-cli.exe')
    expect(screen.getByTestId('voice-model').textContent).toContain('ggml-base.bin')
    expect(screen.getByTestId('rnnoise-status').textContent).toBe(TEXT.settings.voice.rnnoiseReady)
    expect(screen.getByTestId('voice-rnnoise').textContent).toContain('std.rnnn')
    // 语言中文被选中
    const zh = screen.getByRole('button', { name: TEXT.settings.voice.languageZh })
    expect(zh.getAttribute('aria-pressed')).toBe('true')
  })

  it('缺二进制 / 缺模型的文案能区分（不是笼统"未就绪"）', () => {
    expect(voiceStatusLabel(status())).toBe(TEXT.settings.voice.missingBinary)
    expect(voiceStatusLabel(status({ binaryPath: 'C:/w.exe' }))).toBe(TEXT.settings.voice.missingModel)
    expect(voiceStatusLabel(READY)).toBe(TEXT.settings.voice.ready)
  })

  it('选择二进制：弹框后立即保存 binaryPath，并刷新状态', async () => {
    const { api, calls } = stubApi(status())
    // 首次 pickBinary 返回新路径
    render(<VoiceAssetsSection />)
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: TEXT.settings.voice.pickBinary }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledTimes(1))
    expect(api.pickBinary).toHaveBeenCalledTimes(1)
    expect(calls[0]).toEqual({ binaryPath: 'D:/tools/whisper-cli.exe' })
    expect(screen.getByTestId('voice-binary').textContent).toContain('whisper-cli.exe')
  })

  it('选择模型：取消时只提示"已取消"，不写配置', async () => {
    const { api } = stubApi(status())
    api.pickModel.mockResolvedValueOnce(null)
    render(<VoiceAssetsSection />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: TEXT.settings.voice.pickModel }))
    await waitFor(() => expect(screen.getByText(TEXT.settings.voice.pickCancelled)).toBeTruthy())
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('语言切到自动：保存 language: null（主进程据此清除该项）', async () => {
    const { api, calls } = stubApi(READY)
    render(<VoiceAssetsSection />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: TEXT.settings.voice.languageAuto }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledTimes(1))
    expect(calls[0]).toEqual({ language: null })
  })

  it('保存失败（路径不存在）：显示可读错误，不把界面状态清空', async () => {
    const { api } = stubApi(status())
    api.saveConfig.mockRejectedValueOnce(new Error('whisper 可执行文件不存在：D:/nope.exe'))
    render(<VoiceAssetsSection />)
    await waitFor(() => expect(api.status).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: TEXT.settings.voice.pickBinary }))
    await waitFor(() => expect(screen.getByText(/whisper 可执行文件不存在/)).toBeTruthy())
    expect(screen.getByTestId('voice-status')).toBeTruthy()
  })

  it('清除配置：回到候选探测（状态重查）', async () => {
    const { api } = stubApi(READY)
    render(<VoiceAssetsSection />)
    await waitFor(() => expect(screen.getByTestId('voice-status').textContent).toBe(TEXT.settings.voice.ready))

    fireEvent.click(screen.getByRole('button', { name: TEXT.settings.voice.reset }))
    await waitFor(() => expect(api.reset).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('voice-status').textContent).toBe(TEXT.settings.voice.missingBinary))
  })
})
