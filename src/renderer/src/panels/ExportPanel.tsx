import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  DEFAULT_AUDIO_BITRATE_KBPS,
  DEFAULT_EXPORT_RESOLUTION,
  DEFAULT_FPS,
  DEFAULT_VIDEO_BITRATE_TIER,
  DEFAULT_VIDEO_CODEC,
  EXPORT_AUDIO_BITRATE_PRESETS
} from '@shared/constants'
import { resolveExportCanvas, videoBitrateKbpsOf, type ResolvedExportCanvas } from '@shared/exportPresets'
import { sanitizeFileName } from '@shared/fileName'
import { framesToDurationSec } from '@shared/fps'
import { TEXT } from '@shared/i18n'
import { formatBytes } from '@shared/sizeEstimate'
import { formatDuration } from '@shared/timecode'
import type {
  AudioMastering,
  ExportBitrateTier,
  ExportCanvasKind,
  ExportCanvasSelection,
  ExportFit,
  ExportKind,
  ExportResolutionChoice,
  Fps,
  JobPhase,
  RenderJobSpec,
  SizeEstimate,
  TransparentCodec,
  VideoCodec
} from '@shared/types'
import { overlayCanvasFor, useExportJob } from '../hooks/useExportJob'
import { useCoverExport } from '../hooks/useCoverExport'
import { useExportStore } from '../state/exportStore'
import { useProjectStore } from '../state/projectStore'
import { gateBlocked, useUiStore } from '../state/uiStore'
import { Expander } from '../components/ui/Expander'
import { InfoBar } from '../components/ui/InfoBar'

/** 导出面板（剪映专业版式分区）：导出位置 → 范围 → 画布 → 画质 → 音量 → 摘要 → 导出。 */

const LAST_DIR_KEY = 'socut.lastOutputDir'
const CANVAS_ORDER: ExportCanvasKind[] = ['landscape', 'portrait', 'square']
const CANVAS_LABELS: Record<ExportCanvasKind, string> = {
  landscape: '横屏 16:9',
  portrait: '竖屏 9:16',
  square: '方形 1:1'
}
const PREVIEW_LABELS: Record<ExportCanvasKind, string> = {
  landscape: '16:9',
  portrait: '9:16',
  square: '1:1'
}
const FIT_LABELS: Record<ExportFit, string> = {
  cover: '裁切填满',
  contain: '完整显示'
}
type AudioPreset = '128' | '192' | '256' | '320' | 'custom'
const RESOLUTION_OPTIONS: { value: ExportResolutionChoice; label: string }[] = [
  { value: '480', label: TEXT.export.resolution480 },
  { value: '720', label: TEXT.export.resolution720 },
  { value: '1080', label: TEXT.export.resolution1080 },
  { value: '1440', label: TEXT.export.resolution2k },
  { value: '2160', label: TEXT.export.resolution4k }
]
const BITRATE_OPTIONS: { value: ExportBitrateTier; label: string }[] = [
  { value: 'low', label: TEXT.export.bitrateLow },
  { value: 'standard', label: TEXT.export.bitrateStandard },
  { value: 'high', label: TEXT.export.bitrateHigh },
  { value: 'custom', label: TEXT.export.bitrateCustom }
]
const CODEC_OPTIONS: { value: VideoCodec; label: string }[] = [
  { value: 'avc', label: TEXT.export.codecAvc },
  { value: 'hevc', label: TEXT.export.codecHevc },
  { value: 'av1', label: TEXT.export.codecAv1 }
]
const TRANSPARENT_SUMMARY = '透明 MOV · PNG 序列'
const TERMINAL: JobPhase[] = ['done', 'failed', 'cancelled']
type StatusPhase = JobPhase | 'pending'
const STATUS_LABELS: Record<StatusPhase, string> = {
  pending: '待开始',
  queued: TEXT.export.queued,
  preparing: TEXT.export.preparing,
  rendering: TEXT.export.rendering,
  muxing: TEXT.export.muxing,
  verifying: TEXT.export.verifying,
  done: TEXT.export.done,
  failed: TEXT.export.failed,
  cancelled: TEXT.export.cancelled
}

interface VersionStatus {
  key: ExportCanvasKind
  label: string
  phase: StatusPhase
}

function formatFps(fps: Fps): string {
  return String(Math.round((fps.num / fps.den) * 100) / 100)
}

function waitForTerminal(jobId: string): Promise<JobPhase> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined
    const check = (): void => {
      const job = useExportStore.getState().jobs[jobId]
      if (job && TERMINAL.includes(job.phase)) {
        unsubscribe()
        resolve(job.phase)
      }
    }
    unsubscribe = useExportStore.subscribe(check)
    check()
  })
}

export interface ExportPanelProps {
  spec: RenderJobSpec | null
  fontLoading: boolean
  ffmpegAvailable: boolean
}

export function ExportPanel({ spec, fontLoading, ffmpegAvailable }: ExportPanelProps): ReactElement {
  const project = useProjectStore((state) => state.project)
  const setAudioMastering = useProjectStore((state) => state.setAudioMastering)
  const setGraphicsZ = useProjectStore((state) => state.setGraphicsZ)
  const mastering = project.audioMastering ?? 'off'
  const uiMode = useUiStore((state) => state.uiMode)
  const exportScope = useUiStore((state) => state.exportScope)
  const setExportScope = useUiStore((state) => state.setExportScope)
  const setNotice = useUiStore((state) => state.setNotice)
  const previewCanvasKind = useUiStore((state) => state.previewCanvasKind)
  const previewFit = useUiStore((state) => state.previewFit)
  const setPreviewCanvas = useUiStore((state) => state.setPreviewCanvas)
  const setPreviewFit = useUiStore((state) => state.setPreviewFit)
  const { start, cancel } = useExportJob()
  const { exportCover, busy: coverBusy } = useCoverExport()

  const [fileName, setFileName] = useState<string>(() => project.name || 'socut')
  const [outputDir, setOutputDir] = useState<string>('')
  const [pipeTransport, setPipeTransport] = useState<'raw' | 'png'>('raw')
  const [codec, setCodec] = useState<TransparentCodec>('prores4444')
  const [estimate, setEstimate] = useState<SizeEstimate | null>(null)

  const [canvasChecked, setCanvasChecked] = useState<Record<ExportCanvasKind, boolean>>({
    landscape: true,
    portrait: false,
    square: false
  })
  const [canvasFit, setCanvasFit] = useState<Record<'portrait' | 'square', ExportFit>>({
    portrait: 'cover',
    square: 'cover'
  })
  const [resolution, setResolution] = useState<ExportResolutionChoice>(DEFAULT_EXPORT_RESOLUTION)
  const [bitrateTier, setBitrateTier] = useState<ExportBitrateTier>(DEFAULT_VIDEO_BITRATE_TIER)
  const [customBitrate, setCustomBitrate] = useState<number>(2000)
  const [videoCodec, setVideoCodec] = useState<VideoCodec>(DEFAULT_VIDEO_CODEC)
  // M9：高级编码参数（缺省 = 旧行为：CRF 按画质档 / 8bit / limited range）
  const [crfInput, setCrfInput] = useState<string>('')
  const [bitDepth, setBitDepth] = useState<8 | 10>(8)
  const [colorRange, setColorRange] = useState<'limited' | 'full'>('limited')
  const [audioPreset, setAudioPreset] = useState<AudioPreset>('192')
  const [customAudio, setCustomAudio] = useState<number>(DEFAULT_AUDIO_BITRATE_KBPS)
  const [batchRunning, setBatchRunning] = useState(false)
  const [statuses, setStatuses] = useState<VersionStatus[]>([])
  const cancelledRef = useRef<{ value: boolean }>({ value: false })
  const currentJobIdRef = useRef<string | null>(null)

  const selections = useMemo(
    (): ExportCanvasSelection[] =>
      CANVAS_ORDER.filter((kind) => canvasChecked[kind]).map((kind) => ({
        kind,
        resolution,
        fit: kind === 'landscape' ? 'contain' : canvasFit[kind]
      })),
    [canvasChecked, canvasFit, resolution]
  )

  const frames = spec ? Math.max(0, spec.endFrame - spec.startFrame) : 0
  const durationSec = spec ? framesToDurationSec(frames, spec.fps) : 0
  const missingMediaIds = useUiStore((state) => state.missingMediaIds)
  const refVideoMissing = useUiStore((state) => state.refVideoMissing)
  // v2：叠加可用性改看媒体轨/素材池（旧 refVideo 路径保留给 v1 兼容）
  const hasBase = project.mediaClips.length > 0 || project.media.length > 0 || Boolean(project.refVideo)
  const mediaMissing = missingMediaIds.length > 0 || refVideoMissing
  const overlayDisabled = !hasBase || frames === 0 || mediaMissing
  const baseDisabled = fontLoading || !ffmpegAvailable || frames === 0 || outputDir.length === 0

  const selectionFor = (kind: ExportCanvasKind): ExportCanvasSelection =>
    kind === 'landscape'
      ? { kind, resolution, fit: 'contain' }
      : { kind, resolution, fit: canvasFit[kind] }

  /** 解析单个画布：有叠加基座时跟随素材，无基座时按工程分辨率兜底（仅用于文字读数）。 */
  const resolveTarget = (selection: ExportCanvasSelection): { canvas: ResolvedExportCanvas; fps: Fps } => {
    const target = overlayCanvasFor(project, selection)
    if (target) return target
    return {
      canvas: resolveExportCanvas({
        selection,
        primaryMeta: null,
        projectResolution: project.resolution
      }),
      fps: spec?.fps ?? DEFAULT_FPS
    }
  }

  /** 当前选择在该画布上的实际视频码率（自定义为绝对 kbps）。 */
  const bitrateFor = (selection: ExportCanvasSelection): number =>
    videoBitrateKbpsOf(bitrateTier, customBitrate, resolveTarget(selection).canvas)

  /**
   * 音频码率：多视频混音后不存在可继承的“原始码率”，因此始终按配置值重编码为 AAC。
   */
  const audioKbps: number =
    audioPreset === 'custom'
      ? Number.isFinite(customAudio)
        ? Math.max(16, Math.min(512, Math.round(customAudio)))
        : DEFAULT_AUDIO_BITRATE_KBPS
      : Number(audioPreset)

  const canvasMetaText = (kind: ExportCanvasKind): string => {
    // 有基座时跟随素材，无基座时按工程分辨率兜底；选具体档位时两条路径都按短边缩放。
    const canvas = resolveTarget(selectionFor(kind)).canvas
    return `${canvas.width}×${canvas.height}`
  }

  useEffect(() => {
    const saved = localStorage.getItem(LAST_DIR_KEY)
    if (saved) setOutputDir(saved)
  }, [])

  /** 预估按叠加出口口径（H.264），多画布逐个求和；磁盘以最紧的一个为准。 */
  useEffect(() => {
    let cancelled = false
    const targets = selections.flatMap((selection) => {
      const target = overlayCanvasFor(project, selection)
      return target ? [{ selection, target }] : []
    })
    if (!spec || outputDir.length === 0 || targets.length === 0) {
      setEstimate(null)
      return
    }
    const targetFrames = Math.max(0, spec.endFrame - spec.startFrame)
    void Promise.all(
      targets.map(({ target }) =>
        window.socut.export.estimate({
          width: target.canvas.width,
          height: target.canvas.height,
          fps: target.fps,
          frames: targetFrames,
          outputDir,
          kind: 'overlayMp4',
          videoBitrateKbps: videoBitrateKbpsOf(bitrateTier, customBitrate, target.canvas),
          audioBitrateKbps: audioKbps
        })
      )
    )
      .then((results) => {
        if (cancelled) return
        const first = results[0]
        setEstimate({
          bytes: results.reduce((sum, result) => sum + result.bytes, 0),
          sufficientDisk: results.every((result) => result.sufficientDisk),
          recommendPng: false,
          ...(first?.freeBytes !== undefined ? { freeBytes: first.freeBytes } : {})
        })
      })
      .catch(() => {
        if (!cancelled) setEstimate(null)
      })
    return () => {
      cancelled = true
    }
  }, [spec, outputDir, selections, project, bitrateTier, customBitrate, audioKbps])

  // 规格 §6：非 16:9 / HDR / VFR 未确认时不得导出（v2 枚级：逐枚检查素材池，
  // 主进程 hook 里也有一道，这里提前阻断并说明原因）
  const gate = gateBlocked(project.media)

  const currentBaseName = (): string => sanitizeFileName(fileName.trim() || project.name || 'socut')

  const run = async (kind: ExportKind): Promise<void> => {
    const baseName = currentBaseName()
    try {
      await start({
        kind,
        outputDir,
        fileName: kind === 'pngSequence' ? `${baseName}-png` : `${baseName}-透明`,
        pipeTransport,
        codec
      })
      localStorage.setItem(LAST_DIR_KEY, outputDir)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    }
  }

  const setStatusPhase = (index: number, phase: StatusPhase): void => {
    setStatuses((previous) =>
      previous.map((status, itemIndex) => (itemIndex === index ? { ...status, phase } : status))
    )
  }

  const markRemainingCancelled = (from: number): void => {
    setStatuses((previous) =>
      previous.map((status, index) => (index >= from ? { ...status, phase: 'cancelled' } : status))
    )
  }

  const runOverlay = async (): Promise<void> => {
    if (batchRunning || selections.length === 0) return
    const baseName = currentBaseName()
    const cancelled = { value: false }
    cancelledRef.current = cancelled
    setBatchRunning(true)
    setStatuses(
      selections.map((selection) => ({
        key: selection.kind,
        label: CANVAS_LABELS[selection.kind],
        phase: 'pending'
      }))
    )
    try {
      for (const [index, selection] of selections.entries()) {
        if (cancelled.value) {
          markRemainingCancelled(index)
          break
        }
        const target = overlayCanvasFor(project, selection)
        if (!target) {
          setStatusPhase(index, 'failed')
          setNotice('叠加导出需要先把素材放入媒体轨')
          continue
        }
        const outputName = selections.length > 1 ? `${baseName}-${target.canvas.suffix}.mp4` : `${baseName}.mp4`
        try {
          const jobId = await start({
            kind: 'overlayMp4',
            outputDir,
            fileName: outputName,
            pipeTransport,
            codec,
            // 分辨率是渲染目标而非素材属性：所有画布都下传，主进程据此缩放。
            canvas: selection,
            videoCodec,
            videoBitrateKbps: bitrateFor(selection),
            audioBitrateKbps: audioKbps,
            // M9：高级编码参数（缺省不落键 → argv 与旧版逐字节一致）
            ...(crfInput.trim() !== '' && Number.isFinite(Number(crfInput)) ? { crf: Number(crfInput) } : {}),
            ...(videoCodec !== 'avc' && bitDepth === 10 ? { bitDepth: 10 as const } : {}),
            ...(colorRange === 'full' ? { colorRange: 'full' as const } : {})
          })
          currentJobIdRef.current = jobId
          const phase = await waitForTerminal(jobId)
          currentJobIdRef.current = null
          setStatusPhase(index, phase)
          if (phase === 'failed' || phase === 'cancelled') {
            setNotice(`${CANVAS_LABELS[selection.kind]}导出${phase === 'failed' ? '失败' : '已取消'}`)
          }
        } catch (error) {
          currentJobIdRef.current = null
          setStatusPhase(index, 'failed')
          setNotice(error instanceof Error ? error.message : String(error))
        }
        if (cancelled.value) {
          markRemainingCancelled(index + 1)
          break
        }
      }
      localStorage.setItem(LAST_DIR_KEY, outputDir)
    } finally {
      setBatchRunning(false)
      currentJobIdRef.current = null
    }
  }

  const cancelBatch = async (): Promise<void> => {
    cancelledRef.current.value = true
    const jobId = currentJobIdRef.current
    if (jobId) await cancel(jobId)
  }

  const exportRunning = batchRunning || coverBusy
  const canExport =
    !baseDisabled && !overlayDisabled && !gate.blocked && selections.length > 0 && !exportRunning
  const coverDisabled = baseDisabled || overlayDisabled || gate.blocked || selections.length === 0 || exportRunning
  const firstSelection = selections[0]
  const firstTarget = firstSelection ? resolveTarget(firstSelection) : null

  const summaryLine1 =
    selections.length > 1
      ? `${selections.length} 个画布 · ${selections.map((selection) => PREVIEW_LABELS[selection.kind]).join(' / ')}`
      : firstSelection && firstTarget
        ? `${CANVAS_LABELS[firstSelection.kind]} · ${firstTarget.canvas.width}×${firstTarget.canvas.height} · ${formatFps(firstTarget.fps)} fps`
        : '未选择画布'
  const estimatePart =
    outputDir.length > 0 && estimate
      ? ` · 预计 ${formatBytes(estimate.bytes)} · ${estimate.sufficientDisk ? '磁盘充足' : '磁盘不足'}`
      : ' · 选择导出目录后显示预计体积'
  const codecLabel = videoCodec === 'hevc' ? 'HEVC' : 'AVC'
  const summaryBitrate = firstSelection ? bitrateFor(firstSelection) : 2000
  const summaryLine2 = `${codecLabel} · ${summaryBitrate} kbps · 音频 ${audioKbps} kbps · 时长 ${formatDuration(durationSec)}${estimatePart}`
  const bitrateHintText =
    selections.length === 1 && firstSelection
      ? TEXT.export.bitrateHint(bitrateFor(firstSelection))
      : selections.length > 1
        ? `当前码率：${selections
            .map((selection) => `${PREVIEW_LABELS[selection.kind]} ${bitrateFor(selection)} kbps`)
            .join(' · ')}`
        : '当前码率：—'

  const primaryLabel = selections.length > 1 ? `导出 ${selections.length} 个画布` : '导出'

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.export.tab}</span>
        <span className={`chip ${gate.blocked ? 'chip--warn' : frames > 0 ? 'chip--ok' : ''}`}>
          {gate.blocked ? '门禁未通过' : frames > 0 ? `时长 ${formatDuration(durationSec)}` : '等待片段'}
        </span>
      </div>

      {/* 导出位置 */}
      <div className="export-dir">
        <label className="field">
          <span className="field__label">{TEXT.export.fileName}</span>
          <input
            className="input"
            aria-label={TEXT.export.fileName}
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
          />
        </label>
        <div className="dir-picker">
          <span className="dir-picker__label">{TEXT.export.outputDir}</span>
          <span className={`dir-picker__value mono${outputDir ? '' : ' muted'}`} title={outputDir}>
            {outputDir || '未选择'}
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={async () => {
              const dir = await window.socut.app.chooseDirectory()
              if (dir) setOutputDir(dir)
            }}
          >
            更改…
          </button>
        </div>
      </div>

      {/* 导出范围 */}
      <div className="segmented" role="group" aria-label={TEXT.export.scope}>
        <button
          type="button"
          className={`segmented__item${exportScope === 'timeline' ? ' segmented__item--active' : ''}`}
          aria-pressed={exportScope === 'timeline'}
          onClick={() => setExportScope('timeline')}
        >
          {TEXT.export.scopeTimeline}
        </button>
        <button
          type="button"
          className={`segmented__item${exportScope === 'selected' ? ' segmented__item--active' : ''}`}
          aria-pressed={exportScope === 'selected'}
          onClick={() => setExportScope('selected')}
        >
          {TEXT.export.scopeSelected}
        </button>
      </div>

      {/* 导出画布 */}
      <div className="stack stack--tight">
        <div className="field__label">
          <span>{TEXT.export.canvas}</span>
          <span className="field__meta">{TEXT.export.canvasHint}</span>
        </div>
        {CANVAS_ORDER.map((kind) => {
          const checked = canvasChecked[kind]
          return (
            <div key={kind} className={`canvas-row${checked ? ' canvas-row--checked' : ''}`}>
              <label className="canvas-row__main">
                <input
                  type="checkbox"
                  aria-label={CANVAS_LABELS[kind]}
                  checked={checked}
                  onChange={(event) =>
                    setCanvasChecked((previous) => ({ ...previous, [kind]: event.target.checked }))
                  }
                />
                <span className={`canvas-row__icon canvas-row__icon--${kind}`} aria-hidden="true" />
                <span className="canvas-row__text">
                  <span className="canvas-row__label">{CANVAS_LABELS[kind]}</span>
                  <span className="canvas-row__meta mono">{canvasMetaText(kind)}</span>
                </span>
              </label>
              {kind !== 'landscape' && checked ? (
                <div className="canvas-row__settings">
                  <label className="field">
                    <span className="field__label">适配</span>
                    <select
                      className="select"
                      aria-label={`${CANVAS_LABELS[kind]}适配`}
                      value={canvasFit[kind]}
                      onChange={(event) =>
                        setCanvasFit((previous) => ({ ...previous, [kind]: event.target.value as ExportFit }))
                      }
                    >
                      <option value="cover">裁切填满</option>
                      <option value="contain">完整显示</option>
                    </select>
                  </label>
                </div>
              ) : null}
            </div>
          )
        })}
        {selections.length === 0 ? <p className="hint">至少勾选一个画布</p> : null}
      </div>

      {/* 分辨率 */}
      <label className="field">
        <span className="field__label">{TEXT.export.resolution}</span>
        <select
          className="select"
          aria-label={TEXT.export.resolution}
          value={resolution}
          onChange={(event) => setResolution(event.target.value as ExportResolutionChoice)}
        >
          {RESOLUTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="hint">按短边定义；竖屏 / 方图保持各自宽高比。</span>
      </label>

      {/* 码率 */}
      <div className="field">
        <span className="field__label">{TEXT.export.bitrate}</span>
        <div className="segmented" role="group" aria-label={TEXT.export.bitrate}>
          {BITRATE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`segmented__item${bitrateTier === option.value ? ' segmented__item--active' : ''}`}
              aria-pressed={bitrateTier === option.value}
              onClick={() => setBitrateTier(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {bitrateTier === 'custom' ? (
          <div className="export-custom">
            <input
              className="input"
              type="number"
              min={100}
              max={100000}
              step={100}
              aria-label={TEXT.export.bitrateCustomLabel}
              value={customBitrate}
              onChange={(event) => setCustomBitrate(Number(event.target.value))}
            />
            <span className="export-custom__unit">kbps</span>
          </div>
        ) : null}
        <span className="hint">{bitrateHintText}</span>
      </div>

      {/* 编码格式 */}
      <div className="field">
        <span className="field__label">{TEXT.export.codec}</span>
        <div className="segmented" role="group" aria-label={TEXT.export.codec}>
          {CODEC_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`segmented__item${videoCodec === option.value ? ' segmented__item--active' : ''}`}
              aria-pressed={videoCodec === option.value}
              onClick={() => setVideoCodec(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="hint">{TEXT.export.codecHint}</span>
      </div>

      {/* M9：高级编码参数（CRF 直给 / 位深 / 色彩范围） */}
      {uiMode === 'advanced' ? (
        <div className="stack">
          <label className="field">
            <span className="field__label">{TEXT.export.crfLabel}</span>
            <input
              className="input mono"
              type="number"
              min={0}
              max={51}
              step={1}
              aria-label={TEXT.export.crfLabel}
              placeholder="自动"
              value={crfInput}
              onChange={(event) => setCrfInput(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">{TEXT.export.bitDepthLabel}</span>
            <select
              className="select"
              aria-label={TEXT.export.bitDepthLabel}
              value={bitDepth}
              disabled={videoCodec === 'avc'}
              onChange={(event) => setBitDepth(Number(event.target.value) === 10 ? 10 : 8)}
            >
              <option value={8}>{TEXT.export.bitDepth8}</option>
              <option value={10}>{TEXT.export.bitDepth10}</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">{TEXT.export.colorRangeLabel}</span>
            <select
              className="select"
              aria-label={TEXT.export.colorRangeLabel}
              value={colorRange}
              onChange={(event) => setColorRange(event.target.value === 'full' ? 'full' : 'limited')}
            >
              <option value="limited">{TEXT.export.colorRangeLimited}</option>
              <option value="full">{TEXT.export.colorRangeFull}</option>
            </select>
          </label>
          {/* M7-E：图形层 z 档（项目级；belowMedia 会把字幕/文本垫到媒体层下面） */}
          <label className="field">
            <span className="field__label">{TEXT.export.graphicsZLabel}</span>
            <select
              className="select"
              aria-label={TEXT.export.graphicsZLabel}
              value={project.graphicsZ ?? 'aboveMedia'}
              onChange={(event) => setGraphicsZ(event.target.value === 'belowMedia' ? 'belowMedia' : undefined)}
            >
              <option value="aboveMedia">{TEXT.export.graphicsZAbove}</option>
              <option value="belowMedia">{TEXT.export.graphicsZBelow}</option>
            </select>
          </label>
        </div>
      ) : null}

      {/* 音频码率 */}
      <label className="field">
        <span className="field__label">{TEXT.export.audioBitrate}</span>
        <select
          className="select"
          aria-label={TEXT.export.audioBitrate}
          value={audioPreset}
          onChange={(event) => setAudioPreset(event.target.value as AudioPreset)}
        >
          {EXPORT_AUDIO_BITRATE_PRESETS.map((kbps) => (
            <option key={kbps} value={String(kbps)}>
              {kbps}
            </option>
          ))}
          <option value="custom">自定义</option>
        </select>
        {audioPreset === 'custom' ? (
          <div className="export-custom">
            <input
              className="input"
              type="number"
              min={16}
              max={512}
              step={16}
              aria-label={TEXT.export.audioBitrateCustom}
              value={customAudio}
              onChange={(event) => setCustomAudio(Number(event.target.value))}
            />
            <span className="export-custom__unit">kbps</span>
          </div>
        ) : null}
        <span className="hint">{TEXT.export.audioBitrateHint}</span>
      </label>

      {/* 音量标准化 */}
      <label className="field">
        <span className="field__label">{TEXT.export.mastering}</span>
        <select
          className="select"
          aria-label={TEXT.export.mastering}
          title={TEXT.export.masteringHint}
          value={mastering}
          onChange={(event) => setAudioMastering(event.target.value as AudioMastering)}
        >
          <option value="off">{TEXT.export.masteringOff}</option>
          <option value="social">{TEXT.export.masteringSocial}</option>
          <option value="broadcast">{TEXT.export.masteringBroadcast}</option>
        </select>
        <span className="hint">{TEXT.export.masteringHint}</span>
      </label>

      {/* 导出摘要 */}
      <div className="export-summary" aria-label={TEXT.export.summary}>
        <div className="export-summary__line export-summary__line--strong">{summaryLine1}</div>
        <div className="export-summary__line">{summaryLine2}</div>
        {project.watermark?.enabled ? (
          <div className="export-summary__line export-summary__line--muted">台标：{project.watermark.name}（仅成片）</div>
        ) : null}
      </div>

      <button
        type="button"
        className="btn btn--primary btn--block export-cta"
        disabled={!canExport}
        title={
          gate.blocked
            ? gate.reason ?? ''
            : mediaMissing
              ? TEXT.refVideoMissing.notice
              : overlayDisabled
                ? '叠加导出需要先把素材放入媒体轨'
                : undefined
        }
        onClick={() => void runOverlay()}
      >
        {primaryLabel}
      </button>

      <button
        type="button"
        className="btn btn--block"
        disabled={coverDisabled}
        onClick={() => {
          if (firstSelection) {
            void exportCover({ outputDir, selection: firstSelection, baseName: currentBaseName() })
          }
        }}
      >
        导出封面（当前帧）
      </button>

      {batchRunning ? (
        <button type="button" className="btn btn--block" onClick={() => void cancelBatch()}>
          取消全部
        </button>
      ) : null}

      {statuses.length > 0 ? (
        <div className="kv" aria-label="批量导出状态">
          {statuses.map((status) => (
            <div className="kv__row" key={status.key}>
              <span>{status.label}</span>
              <span className={`mono${status.phase === 'failed' ? ' text-danger' : ''}`}>
                {STATUS_LABELS[status.phase]}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* 更多导出选项（透明素材 / 高级排障） */}
      <Expander title={TEXT.export.moreOptions} summary={TRANSPARENT_SUMMARY}>
        <div className="stack">
          <p className="hint">{TEXT.export.transparentHint}</p>

          <label className="field">
            <span className="field__label">{TEXT.export.transparentFormat}</span>
            <select
              className="select"
              aria-label={TEXT.export.transparentFormat}
              value={codec}
              onChange={(event) => setCodec(event.target.value as TransparentCodec)}
            >
              <option value="prores4444">ProRes 4444（高质量）</option>
              <option value="qtrle">qtrle（无损）</option>
            </select>
          </label>

          <button
            type="button"
            className="btn btn--block"
            disabled={baseDisabled || gate.blocked}
            onClick={() => void run('transparentMov')}
          >
            导出透明 MOV
          </button>

          <button
            type="button"
            className="btn btn--block"
            disabled={baseDisabled || gate.blocked}
            onClick={() => void run('pngSequence')}
          >
            导出 PNG 序列
          </button>

          {uiMode === 'advanced' ? (
            <>
              <label className="field">
                <span className="field__label">{TEXT.export.pipeTransport}</span>
                <select
                  className="select"
                  aria-label={TEXT.export.pipeTransport}
                  value={pipeTransport}
                  onChange={(event) => setPipeTransport(event.target.value as 'raw' | 'png')}
                >
                  <option value="raw">{TEXT.export.pipeAuto}</option>
                  <option value="png">{TEXT.export.pipePng}</option>
                </select>
                <span className="hint">{TEXT.export.pipeHint}</span>
              </label>

              <div className="kv">
                <div className="kv__row">
                  <span>编码</span>
                  <span className="mono">{codecLabel}</span>
                </div>
                <div className="kv__row">
                  <span>帧数</span>
                  <span className="mono">{frames}</span>
                </div>
                {selections.map((selection) => {
                  const target = resolveTarget(selection)
                  return (
                    <div className="kv__row" key={selection.kind}>
                      <span>{CANVAS_LABELS[selection.kind]}</span>
                      <span className="mono">
                        {target.canvas.width}×{target.canvas.height} · {FIT_LABELS[target.canvas.fit]}
                      </span>
                    </div>
                  )
                })}
              </div>
            </>
          ) : null}
        </div>
      </Expander>

      {/* 预览导出画布（默认收起） */}
      <Expander
        title={TEXT.export.previewCanvas}
        summary={
          previewCanvasKind
            ? `${CANVAS_LABELS[previewCanvasKind]} · ${FIT_LABELS[previewFit]}`
            : '工程画布'
        }
      >
        <div className="stack stack--tight">
          <div className="segmented" role="group" aria-label="预览画布">
            <button
              type="button"
              className={`segmented__item${previewCanvasKind === null ? ' segmented__item--active' : ''}`}
              aria-pressed={previewCanvasKind === null}
              onClick={() => {
                setPreviewCanvas(null)
                setPreviewFit('contain')
              }}
            >
              工程画布
            </button>
            {(['portrait', 'square'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className={`segmented__item${previewCanvasKind === kind ? ' segmented__item--active' : ''}`}
                aria-pressed={previewCanvasKind === kind}
                onClick={() => {
                  setPreviewCanvas(kind)
                  setPreviewFit('cover')
                }}
              >
                {PREVIEW_LABELS[kind]}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="预览适配">
            {(['contain', 'cover'] as const).map((fit) => (
              <button
                key={fit}
                type="button"
                className={`segmented__item${previewFit === fit ? ' segmented__item--active' : ''}`}
                aria-pressed={previewFit === fit}
                onClick={() => setPreviewFit(fit)}
              >
                {FIT_LABELS[fit]}
              </button>
            ))}
          </div>
          {previewCanvasKind ? (
            <span className="chip chip--ok">
              预览：{CANVAS_LABELS[previewCanvasKind]} · {FIT_LABELS[previewFit]}
            </span>
          ) : null}
        </div>
      </Expander>

      {gate.blocked ? <InfoBar tone="warning" message={gate.reason ?? '门禁未确认'} /> : null}
      {mediaMissing ? <InfoBar tone="error" message={TEXT.refVideoMissing.notice} /> : null}
      {!ffmpegAvailable ? <InfoBar tone="error" message="FFmpeg 不可用，导出已禁用" /> : null}
      {exportScope === 'selected' ? <p className="hint">请先选中一个片段</p> : null}
    </section>
  )
}
