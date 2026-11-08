import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createDefaultProject } from '@shared/projectSchema'
import type { JobResult, RenderJobSpec, SizeEstimate, VideoMeta } from '@shared/types'
import { ExportPanel } from './ExportPanel'
import { useExportStore } from '../state/exportStore'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  exportCover: vi.fn()
}))

vi.mock('../hooks/useExportJob', () => ({
  useExportJob: () => ({ start: mocks.start, retryLast: vi.fn(), cancel: mocks.cancel }),
  overlayCanvasFor: (_project: unknown, selection: { kind: string; fit?: string }) => {
    const sizes: Record<string, { width: number; height: number; suffix: string; mode: string }> = {
      landscape: { width: 1920, height: 1080, suffix: '16x9', mode: 'standard' },
      portrait: { width: 1080, height: 1920, suffix: '9x16', mode: 'compact' },
      square: { width: 1080, height: 1080, suffix: '1x1', mode: 'compact' }
    }
    const size = sizes[selection.kind]!
    return {
      canvas: {
        kind: selection.kind,
        width: size.width,
        height: size.height,
        fit: selection.fit ?? 'contain',
        mode: size.mode,
        suffix: size.suffix,
        label: selection.kind
      },
      fps: FPS_30
    }
  }
}))

vi.mock('../hooks/useCoverExport', () => ({
  useCoverExport: () => ({ exportCover: mocks.exportCover, busy: false })
}))

const META: VideoMeta = {
  path: 'C:/media/a.mp4',
  containerName: 'mov,mp4,m4a,3gp,2b2,gif,webm',
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
  durationSec: 10,
  nbFrames: null,
  bitRateKbps: null
}

const SPEC: RenderJobSpec = {
  width: 1920,
  height: 1080,
  fps: FPS_30,
  frameFormat: 'raw',
  startFrame: 0,
  endFrame: 100,
  clips: [],
  aspectMode: 'standard'
}

function seedProject(): void {
  const project = createDefaultProject('导出测试')
  project.media = [
    {
      id: 'm1',
      path: META.path,
      name: 'a.mp4',
      meta: META,
      non169Ack: true,
      hdrAck: true,
      vfrPolicy: 'none',
      compactMode: 'auto',
      thumbnailUrl: '',
      importedAt: '2026-01-01T00:00:00.000Z'
    }
  ]
  useProjectStore.setState({ project, fonts: [], revision: 0 })
}

function stubApi(): void {
  const estimate = vi.fn(async (): Promise<SizeEstimate> => ({
    bytes: 1024,
    recommendPng: false,
    sufficientDisk: true,
    freeBytes: 100000
  }))
  ;(window as unknown as { focusnews: unknown }).focusnews = {
    app: { chooseDirectory: vi.fn(async () => null) },
    export: { estimate },
    video: { exists: vi.fn(async () => true) }
  }
}

function doneResult(jobId: string): JobResult {
  return {
    jobId,
    ok: true,
    outputs: [],
    progress: {
      jobId,
      phase: 'done',
      framesDone: 100,
      framesTotal: 100,
      outTimeUs: 0,
      percent: 1,
      bytesWritten: 0,
      elapsedMs: 0,
      notices: []
    }
  }
}

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

beforeEach(() => {
  localStorage.setItem('focusnews.lastOutputDir', 'D:/out')
  seedProject()
  stubApi()
  mocks.start.mockReset()
  mocks.cancel.mockReset()
  mocks.exportCover.mockReset()
  useExportStore.setState({ jobs: {}, order: [], lastResult: null, lastInput: null, busy: false })
  useUiStore.setState({
    missingMediaIds: [],
    refVideoMissing: false,
    previewCanvasKind: null,
    previewFit: 'contain',
    exportScope: 'timeline',
    notice: null
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  useProjectStore.setState({ project: createDefaultProject('空'), fonts: [], revision: 0 })
  useUiStore.setState({ missingMediaIds: [], refVideoMissing: false, notice: null })
  delete (window as unknown as { focusnews?: unknown }).focusnews
})

describe('多画布导出', () => {
  it('默认只勾 16:9；单一导出仍走旧的叠加语义（无画布归一、high）', async () => {
    let count = 0
    mocks.start.mockImplementation(async () => {
      const jobId = `job-${++count}`
      setTimeout(() => useExportStore.getState().setResult(doneResult(jobId)), 0)
      return jobId
    })
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)

    expect((screen.getByRole('checkbox', { name: '横屏 16:9' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: '竖屏 9:16' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: '方形 1:1' }) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /开始导出/ }))
    await flush()

    expect(mocks.start).toHaveBeenCalledTimes(1)
    const input = mocks.start.mock.calls[0]![0]
    expect(input).toMatchObject({ kind: 'overlayMp4', quality: 'high' })
    expect(input.canvas).toBeUndefined()
    expect(input.fileName).toContain('-overlayMp4-16x9-1920x1080-30/1')
    expect(screen.getByText('完成')).toBeTruthy()
  })

  it('勾选 9:16 与 1:1 后串行导出三次，文件名带后缀与目标尺寸', async () => {
    let count = 0
    mocks.start.mockImplementation(async () => {
      const jobId = `job-${++count}`
      setTimeout(() => useExportStore.getState().setResult(doneResult(jobId)), 0)
      return jobId
    })
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)

    fireEvent.click(screen.getByRole('checkbox', { name: '竖屏 9:16' }))
    expect(screen.getByLabelText('竖屏 9:16分辨率')).toBeTruthy()
    expect(screen.getByLabelText('竖屏 9:16适配')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '方形 1:1' }))

    fireEvent.click(screen.getByRole('button', { name: /开始导出（3 个画布）/ }))
    await flush(60)

    expect(mocks.start).toHaveBeenCalledTimes(3)
    const inputs = mocks.start.mock.calls.map((call) => call[0])
    expect(inputs.map((input) => input.canvas?.kind ?? 'landscape')).toEqual(['landscape', 'portrait', 'square'])
    expect(inputs[1]!.canvas).toEqual({ kind: 'portrait', tier: '1080', fit: 'cover' })
    expect(inputs[2]!.canvas).toEqual({ kind: 'square', tier: '1080', fit: 'cover' })
    expect(inputs[1]!.fileName).toContain('-overlayMp4-9x16-1080x1920-30/1')
    expect(inputs[2]!.fileName).toContain('-overlayMp4-1x1-1080x1080-30/1')
  })

  it('取消全部先置批处理标志，再取消当前 job；后续版本不再启动', async () => {
    mocks.start.mockResolvedValue('job-1')
    mocks.cancel.mockResolvedValue(undefined)
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)

    fireEvent.click(screen.getByRole('checkbox', { name: '竖屏 9:16' }))
    fireEvent.click(screen.getByRole('button', { name: /开始导出/ }))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: '取消全部' }))
    await flush()
    expect(mocks.cancel).toHaveBeenCalledWith('job-1')

    act(() => {
      useExportStore.getState().setResult({
        jobId: 'job-1',
        ok: false,
        outputs: [],
        error: { code: 'CANCELLED', message: '任务已取消', stderrTail: '', fatal: false },
        progress: {
          ...doneResult('job-1').progress,
          phase: 'cancelled',
          percent: 0
        }
      })
    })
    await flush()

    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('已取消').length).toBeGreaterThan(0)
  })

  it('导出封面使用第一个勾选的画布', async () => {
    mocks.exportCover.mockResolvedValue({ ok: true, path: 'D:/out/cover.png' })
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)

    fireEvent.click(screen.getByRole('button', { name: /导出封面/ }))
    await flush()

    expect(mocks.exportCover).toHaveBeenCalledWith({
      outputDir: 'D:/out',
      selection: { kind: 'landscape', fit: 'contain' }
    })
  })

  it('没有输出目录 / 素材缺失 / 一个画布都没勾时禁用', async () => {
    localStorage.clear()
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)
    expect((screen.getByRole('button', { name: /开始导出/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /导出封面/ }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    localStorage.setItem('focusnews.lastOutputDir', 'D:/out')
    useUiStore.getState().setMissingMediaIds(['m1'])
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)
    expect((screen.getByRole('button', { name: /开始导出/ }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()

    useUiStore.getState().setMissingMediaIds([])
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)
    fireEvent.click(screen.getByRole('checkbox', { name: '横屏 16:9' }))
    expect((screen.getByRole('button', { name: /开始导出/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('至少勾选一个画布')).toBeTruthy()
  })
})

describe('预览此画布', () => {
  it('切到 9:16 会写入 UI store；工程画布清除覆盖', () => {
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)

    fireEvent.click(screen.getByRole('button', { name: '9:16' }))
    expect(useUiStore.getState().previewCanvasKind).toBe('portrait')
    expect(useUiStore.getState().previewFit).toBe('cover')
    expect(screen.getByText('预览：竖屏 9:16 · cover')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '工程画布' }))
    expect(useUiStore.getState().previewCanvasKind).toBeNull()
    expect(useUiStore.getState().previewFit).toBe('contain')
  })
})

describe('响度标准化（v10）', () => {
  it('默认关闭；选社交/广播写回工程，选回关闭删除键', () => {
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)

    const mastering = screen.getByLabelText(TEXT.export.mastering) as HTMLSelectElement
    expect(mastering.value).toBe('off')
    expect(screen.getByText(TEXT.export.masteringHint)).toBeTruthy()

    fireEvent.change(mastering, { target: { value: 'social' } })
    expect(useProjectStore.getState().project.audioMastering).toBe('social')
    expect((screen.getByLabelText(TEXT.export.mastering) as HTMLSelectElement).value).toBe('social')

    fireEvent.change(mastering, { target: { value: 'broadcast' } })
    expect(useProjectStore.getState().project.audioMastering).toBe('broadcast')

    fireEvent.change(mastering, { target: { value: 'off' } })
    expect('audioMastering' in useProjectStore.getState().project).toBe(false)
  })

  it('单次写入只推一次 revision', () => {
    render(<ExportPanel spec={SPEC} fontLoading={false} ffmpegAvailable />)
    const before = useProjectStore.getState().revision
    fireEvent.change(screen.getByLabelText(TEXT.export.mastering), { target: { value: 'broadcast' } })
    expect(useProjectStore.getState().revision).toBe(before + 1)
  })
})
