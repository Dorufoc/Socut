import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createDefaultProject } from '@shared/projectSchema'
import type { CaptionProgressEvent, CaptionTranscribeRequest, CaptionTranscribeResult, SocutApi } from '@shared/api'
import type { MediaClip, MediaItem, Project, VideoMeta } from '@shared/types'
import { CaptionAutoSection } from './CaptionAutoSection'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * M11：「自动字幕」入口的交互契约。
 *
 * 锁四件事：
 * 1. 没有选中媒体片段 → 按钮禁用 + 常驻提示（不弹假入口）；
 * 2. 点开始 → 先订阅进度再调 transcribe（requestId 配对，别的请求进度不串线），显示百分比与取消；
 * 3. 成功 → cue 经「源时间 → 时间轴」映射后走 addCaptionsFromCues 落时间轴，提示新增条数；
 * 4. 失败 → 展示错误码对应的可执行提示；取消 → 不落库、不报错。
 */

function meta(): VideoMeta {
  return {
    path: 'C:/media/news.mp4',
    containerName: 'mp4',
    width: 1920,
    height: 1080,
    sar: null,
    displayRatio: 1920 / 1080,
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 },
    pixFmt: 'yuv420p',
    colorPrimaries: null,
    colorSpace: null,
    colorTransfer: null,
    colorRange: null,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioChannels: 2,
    durationSec: 30,
    nbFrames: null,
    bitRateKbps: null
  }
}

function mediaItem(): MediaItem {
  return {
    id: 'media-1',
    path: 'C:/media/news.mp4',
    name: 'news.mp4',
    meta: meta(),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
}

/** 片段在时间轴 10→20s，读源 2→12s（1x）；默认选中它。 */
function seed(overrides: Partial<MediaClip> = {}): { project: Project; clip: MediaClip; item: MediaItem } {
  const project = createDefaultProject('自动字幕')
  project.fps = FPS_30
  const item = mediaItem()
  const clip: MediaClip = {
    id: 'mclip-1',
    mediaId: item.id,
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: 10,
    timelineEndSec: 20,
    sourceInSec: 2,
    sourceOutSec: 12,
    ...overrides
  }
  project.media = [item]
  project.mediaClips = [clip]
  useProjectStore.setState({
    project,
    selectedClipId: null,
    selectedMediaClipId: clip.id,
    selectionKind: 'media',
    fonts: [],
    revision: 1
  })
  return { project, clip, item }
}

function okResult(request: CaptionTranscribeRequest, cues: CaptionTranscribeResult['cues'] = []): CaptionTranscribeResult {
  return { requestId: request.requestId, ok: true, cues, language: 'zh', errorCode: null, errorMessage: null }
}

/** 装一个只实现 caption 面的 window.socut，并返回可控的进度发射器。 */
function stubApi(
  impl: (request: CaptionTranscribeRequest) => Promise<CaptionTranscribeResult> = (request) => Promise.resolve(okResult(request))
) {
  const handlers = new Set<(event: CaptionProgressEvent) => void>()
  const transcribe = vi.fn(impl)
  const cancel = vi.fn(async (_requestId: string) => true)
  const onProgress = vi.fn((handler: (event: CaptionProgressEvent) => void) => {
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  })
  ;(window as unknown as { socut: Partial<SocutApi> }).socut = {
    caption: { transcribe, cancel, onProgress }
  } as unknown as SocutApi
  return {
    transcribe,
    cancel,
    onProgress,
    emit: (event: CaptionProgressEvent) => {
      for (const handler of [...handlers]) handler(event)
    },
    progressHandlerCount: () => handlers.size
  }
}

const autoButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: TEXT.captions.autoCaption }) as HTMLButtonElement

afterEach(() => {
  cleanup()
  delete (window as unknown as { socut?: unknown }).socut
  act(() => {
    useProjectStore.setState({
      project: createDefaultProject('空'),
      selectedClipId: null,
      selectedMediaClipId: null,
      selectionKind: 'subtitle',
      fonts: []
    })
    useUiStore.setState({ notice: null, displayTimeSec: 0, playing: false, seekHandler: null })
  })
})

describe('CaptionAutoSection（自动字幕入口）', () => {
  it('未选中媒体片段：按钮禁用，并常驻提示先选片段', () => {
    const project = createDefaultProject('空')
    useProjectStore.setState({ project, selectedMediaClipId: null, fonts: [] })
    render(<CaptionAutoSection />)

    expect(autoButton().disabled).toBe(true)
    expect(screen.getByText(TEXT.captions.autoCaptionNoMedia)).toBeTruthy()
    // 语言选择器不依赖选中态，仍可见（默认中文）
    expect((screen.getByLabelText(TEXT.captions.autoCaptionLanguage) as HTMLSelectElement).value).toBe('zh')
  })

  it('选中媒体片段：按钮可用，提示显示将识别哪个素材', () => {
    const { item } = seed()
    stubApi()
    render(<CaptionAutoSection />)

    expect(autoButton().disabled).toBe(false)
    expect(screen.getByText(TEXT.captions.autoCaptionSelected(item.name))).toBeTruthy()
  })

  it('非 Electron 环境（没有 window.socut.caption）时保持禁用，不抛异常', () => {
    seed()
    render(<CaptionAutoSection />)
    expect(autoButton().disabled).toBe(true)
  })

  it('点开始：先订阅进度再调 transcribe；进度百分比可取消，别的 requestId 不串线', async () => {
    const { item } = seed()
    const pending: { resolve?: (result: CaptionTranscribeResult) => void } = {}
    const api = stubApi(
      (_request: CaptionTranscribeRequest) =>
        new Promise<CaptionTranscribeResult>((resolve) => {
          pending.resolve = resolve
        })
    )
    render(<CaptionAutoSection />)

    await act(async () => {
      fireEvent.click(autoButton())
    })

    const request = api.transcribe.mock.calls[0]![0]
    expect(request.mediaPath).toBe(item.path)
    expect(request.language).toBe('zh')
    expect(api.progressHandlerCount()).toBe(1)
    // 准备阶段：进度条 0%，文案「准备音频…」
    expect(screen.getByText(TEXT.captions.autoCaptionPrepare)).toBeTruthy()

    act(() => {
      api.emit({ requestId: request.requestId, percent: 42, stage: 'transcribe' })
    })
    expect(screen.getByText(TEXT.captions.autoCaptionProgress(42))).toBeTruthy()
    // 别的请求（例如切换片段后残留）的进度不能画到当前进度条上
    act(() => {
      api.emit({ requestId: 'caption-other', percent: 99, stage: 'transcribe' })
    })
    expect(screen.getByText(TEXT.captions.autoCaptionProgress(42))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: TEXT.captions.autoCaptionCancel }))
    expect(api.cancel).toHaveBeenCalledWith(request.requestId)

    await act(async () => {
      pending.resolve?.({
        requestId: request.requestId,
        ok: false,
        cues: [],
        language: null,
        errorCode: 'CANCELLED',
        errorMessage: '转写已取消'
      })
    })

    expect(useUiStore.getState().notice).toBe(TEXT.captions.autoCaptionCancelled)
    expect(useProjectStore.getState().project.clips).toHaveLength(0)
    expect(api.progressHandlerCount()).toBe(0)
    expect(autoButton().disabled).toBe(false)
  })

  it('成功：cue 按片段入点映射到时间轴并落成字幕条，提示新增条数', async () => {
    seed()
    const api = stubApi((request) =>
      Promise.resolve(
        okResult(request, [
          { startSec: 3, endSec: 5, text: '今日头条' },
          { startSec: 5, endSec: 7, text: '省发展改革委发布' }
        ])
      )
    )
    render(<CaptionAutoSection />)

    await act(async () => {
      fireEvent.click(autoButton())
    })

    const clips = useProjectStore.getState().project.clips
    expect(api.transcribe).toHaveBeenCalledTimes(1)
    expect(clips).toHaveLength(2)
    // 片段时间轴 10s 起、源入点 2s：源 3→5 落 11→13，源 5→7 落 13→15
    expect(clips[0]!.startTime).toBeCloseTo(11, 5)
    expect(clips[0]!.endTime).toBeCloseTo(13, 5)
    expect(clips[0]!.content).toEqual({ title: '今日头条', subtitle: '' })
    expect(clips[1]!.startTime).toBeCloseTo(13, 5)
    expect(useUiStore.getState().notice).toBe(TEXT.captions.autoCaptionAdded(2))
    // 结束后进度区让位、按钮恢复可用
    expect(api.progressHandlerCount()).toBe(0)
    expect(autoButton().disabled).toBe(false)
  })

  it('识别结果全在片段窗口外：不落条，提示没有可用语音', async () => {
    seed()
    stubApi((request) => Promise.resolve(okResult(request, [{ startSec: 0, endSec: 1, text: '窗口外' }])))
    render(<CaptionAutoSection />)

    await act(async () => {
      fireEvent.click(autoButton())
    })

    expect(useProjectStore.getState().project.clips).toHaveLength(0)
    expect(useUiStore.getState().notice).toBe(TEXT.captions.autoCaptionEmpty)
  })

  it('缺二进制：展示错误原文 + 「请先导入 whisper 二进制与模型」的可执行提示', async () => {
    seed()
    stubApi((request) =>
      Promise.resolve({
        requestId: request.requestId,
        ok: false,
        cues: [],
        language: null,
        errorCode: 'WHISPER_BINARY_MISSING',
        errorMessage: '未找到 whisper.cpp 可执行文件（候选：…）'
      })
    )
    render(<CaptionAutoSection />)

    await act(async () => {
      fireEvent.click(autoButton())
    })

    const shown = screen.getByText((content) => content.includes(TEXT.captions.autoCaptionImportHint))
    expect(shown.textContent).toContain('未找到 whisper.cpp 可执行文件')
    expect(useUiStore.getState().notice).toContain(TEXT.captions.autoCaptionImportHint)
    expect(useProjectStore.getState().project.clips).toHaveLength(0)
    // 失败后按钮恢复可用（修好资产能直接重试）
    expect(autoButton().disabled).toBe(false)
  })

  it('语言切到英文/自动检测会随请求传给主进程（自动检测时不传 language 键）', async () => {
    seed()
    const api = stubApi()
    render(<CaptionAutoSection />)

    fireEvent.change(screen.getByLabelText(TEXT.captions.autoCaptionLanguage), { target: { value: 'en' } })
    await act(async () => {
      fireEvent.click(autoButton())
    })
    expect(api.transcribe.mock.calls[0]![0].language).toBe('en')

    fireEvent.change(screen.getByLabelText(TEXT.captions.autoCaptionLanguage), { target: { value: 'auto' } })
    await act(async () => {
      fireEvent.click(autoButton())
    })
    expect(api.transcribe.mock.calls[1]![0].language).toBeUndefined()
  })

  it('同一 tick 内连点两次只发起一次转写（防并发跑两份 whisper 进程）', async () => {
    seed()
    const pending: { resolve?: (result: CaptionTranscribeResult) => void } = {}
    const api = stubApi(
      (_request: CaptionTranscribeRequest) =>
        new Promise<CaptionTranscribeResult>((resolve) => {
          pending.resolve = resolve
        })
    )
    render(<CaptionAutoSection />)

    await act(async () => {
      fireEvent.click(autoButton())
      fireEvent.click(autoButton())
    })

    expect(api.transcribe).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending.resolve?.({
        requestId: 'ignored',
        ok: false,
        cues: [],
        language: null,
        errorCode: 'CANCELLED',
        errorMessage: ''
      })
    })
  })

  it('卸载时退订进度（在跑的转写允许自然结束，不在这里取消）', async () => {
    seed()
    const api = stubApi(() => new Promise<CaptionTranscribeResult>(() => undefined))
    const view = render(<CaptionAutoSection />)

    await act(async () => {
      fireEvent.click(autoButton())
    })
    expect(api.progressHandlerCount()).toBe(1)

    view.unmount()
    expect(api.progressHandlerCount()).toBe(0)
    expect(api.cancel).not.toHaveBeenCalled()
  })
})
