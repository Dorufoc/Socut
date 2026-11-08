import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { DEFAULT_FPS, fpsToString } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { formatBytes } from '@shared/sizeEstimate'
import type {
  AudioMastering,
  ExportCanvasKind,
  ExportCanvasSelection,
  ExportFit,
  ExportKind,
  ExportQuality,
  ExportResolutionTier,
  JobPhase,
  RenderJobSpec,
  SizeEstimate,
  TransparentCodec
} from '@shared/types'
import { overlayCanvasFor, useExportJob } from '../hooks/useExportJob'
import { useCoverExport } from '../hooks/useCoverExport'
import { useExportStore } from '../state/exportStore'
import { useProjectStore } from '../state/projectStore'
import { gateBlocked, useUiStore } from '../state/uiStore'
import { Expander } from '../components/ui/Expander'
import { InfoBar } from '../components/ui/InfoBar'

/** 导出面板（规格 §2.3 / §3.1 / v10 多画布）。叠加 MP4 支持画布多选与批量。 */

const LAST_DIR_KEY = 'focusnews.lastOutputDir'
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
  const mastering = project.audioMastering ?? 'off'
  const exportScope = useUiStore((state) => state.exportScope)
  const setExportScope = useUiStore((state) => state.setExportScope)
  const setNotice = useUiStore((state) => state.setNotice)
  const previewCanvasKind = useUiStore((state) => state.previewCanvasKind)
  const previewFit = useUiStore((state) => state.previewFit)
  const setPreviewCanvas = useUiStore((state) => state.setPreviewCanvas)
  const setPreviewFit = useUiStore((state) => state.setPreviewFit)
  const { start, cancel } = useExportJob()
  const { exportCover, busy: coverBusy } = useCoverExport()

  const [outputDir, setOutputDir] = useState<string>('')
  const [frameDelivery, setFrameDelivery] = useState<'pipe' | 'pngSequence'>('pipe')
  const [pipeTransport, setPipeTransport] = useState<'raw' | 'png'>('raw')
  const [codec, setCodec] = useState<TransparentCodec>('prores4444')
  const [estimate, setEstimate] = useState<SizeEstimate | null>(null)
  /**
   * 直接管道合成后端（计划 §6）：默认关闭以保持与规格书一致的两阶段写法，
   * 只在「磁盘不足」或「span > 5 分钟」这两种中间 MOV 真的成问题时才允许勾选。
   */
  const [directPipe, setDirectPipe] = useState(false)

  const [canvasChecked, setCanvasChecked] = useState<Record<ExportCanvasKind, boolean>>({
    landscape: true,
    portrait: false,
    square: false
  })
  const [canvasTier, setCanvasTier] = useState<Record<'portrait' | 'square', ExportResolutionTier>>({
    portrait: '1080',
    square: '1080'
  })
  const [canvasFit, setCanvasFit] = useState<Record<'portrait' | 'square', ExportFit>>({
    portrait: 'cover',
    square: 'cover'
  })
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [batchRunning, setBatchRunning] = useState(false)
  const [statuses, setStatuses] = useState<VersionStatus[]>([])
  const cancelledRef = useRef<{ value: boolean }>({ value: false })
  const currentJobIdRef = useRef<string | null>(null)

  const selections = useMemo(
    (): ExportCanvasSelection[] =>
      CANVAS_ORDER.filter((kind) => canvasChecked[kind]).map((kind) =>
        kind === 'landscape'
          ? { kind, fit: 'contain' }
          : { kind, tier: canvasTier[kind], fit: canvasFit[kind] }
      ),
    [canvasChecked, canvasTier, canvasFit]
  )

  const frames = spec ? Math.max(0, spec.endFrame - spec.startFrame) : 0
  const missingMediaIds = useUiStore((state) => state.missingMediaIds)
  const refVideoMissing = useUiStore((state) => state.refVideoMissing)
  // v2：叠加可用性改看媒体轨/素材池（旧 refVideo 路径保留给 v1 兼容）
  const hasBase = project.mediaClips.length > 0 || project.media.length > 0 || Boolean(project.refVideo)
  const mediaMissing = missingMediaIds.length > 0 || refVideoMissing
  const overlayDisabled = !hasBase || frames === 0 || mediaMissing
  const baseDisabled = fontLoading || !ffmpegAvailable || frames === 0 || outputDir.length === 0

  /** span 秒数（直管道合成的可选条件之一：中间 MOV 过大时避免落盘） */
  const spanSec = spec ? ((spec.endFrame - spec.startFrame) * spec.fps.den) / spec.fps.num : 0
  const longSpan = spanSec > 300
  const diskShort = estimate !== null && !estimate.sufficientDisk
  // 没有参考视频就没有“合成”可言，直管道后端也无从谈起
  const directPipeAllowed = !overlayDisabled && (diskShort || longSpan)

  useEffect(() => {
    const saved = localStorage.getItem(LAST_DIR_KEY)
    if (saved) setOutputDir(saved)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!spec || outputDir.length === 0) {
      setEstimate(null)
      return
    }
    const frames = Math.max(0, spec.endFrame - spec.startFrame)
    void window.focusnews.export
      .estimate({ width: spec.width, height: spec.height, fps: spec.fps, frames, outputDir })
      .then((result) => {
        if (!cancelled) setEstimate(result)
      })
      .catch(() => {
        if (!cancelled) setEstimate(null)
      })
    return () => {
      cancelled = true
    }
  }, [spec, outputDir])

  // 不再满足直管道条件时自动取消勾选，避免一个看不开的开关默默改变导出路径
  useEffect(() => {
    if (!directPipeAllowed && directPipe) setDirectPipe(false)
  }, [directPipeAllowed, directPipe])

  // 规格 §6：非 16:9 / HDR / VFR 未确认时不得导出（v2 枚级：逐枚检查素材池，
  // 主进程 hook 里也有一道，这里提前阻断并说明原因）
  const gate = gateBlocked(project.media)

  const run = async (kind: ExportKind): Promise<void> => {
    const base = `${project.name || 'focusnews'}-${kind}-${spec?.width ?? 0}x${spec?.height ?? 0}-${fpsToString(
      spec?.fps ?? DEFAULT_FPS
    )}`
    try {
      await start({
        kind,
        outputDir,
        fileName: kind === 'pngSequence' ? `${base}_png` : `${base}.${kind === 'overlayMp4' ? 'mp4' : 'mov'}`,
        frameDelivery,
        pipeTransport,
        codec,
        directPipe: directPipe && directPipeAllowed
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
        const baseName = `${project.name || 'focusnews'}-overlayMp4-${target.canvas.suffix}-${target.canvas.width}x${target.canvas.height}-${fpsToString(target.fps)}`
        try {
          const jobId = await start({
            kind: 'overlayMp4',
            outputDir,
            fileName: `${baseName}.mp4`,
            frameDelivery,
            pipeTransport,
            codec,
            directPipe: directPipe && directPipeAllowed,
            // 横屏 contain 与旧行为等价：不传画布，保留「跟随素材 + 工程分支」的旧口径
            ...(selection.kind === 'landscape' ? {} : { canvas: selection }),
            quality
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

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.export.tab}</span>
        <span className={`chip ${gate.blocked ? 'chip--warn' : frames > 0 ? 'chip--ok' : ''}`}>
          {gate.blocked ? '门禁未通过' : frames > 0 ? `${frames} 帧` : '等待片段'}
        </span>
      </div>

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

      <div className="dir-picker">
        <span className="dir-picker__label">输出目录</span>
        <span className={`dir-picker__value mono${outputDir ? '' : ' muted'}`} title={outputDir}>
          {outputDir || '未选择'}
        </span>
        <button
          type="button"
          className="btn btn--sm"
          onClick={async () => {
            const dir = await window.focusnews.app.chooseDirectory()
            if (dir) setOutputDir(dir)
          }}
        >
          浏览…
        </button>
      </div>

      <div className="kv">
        <div className="kv__row">
          <span>{TEXT.export.resolution}</span>
          <span className="mono">
            {project.refVideo || project.media.length > 0 ? TEXT.export.followRef : `${spec?.width ?? 0}×${spec?.height ?? 0}`}
          </span>
        </div>
        <div className="kv__row">
          <span>{TEXT.export.fps}</span>
          <span className="mono">
            {project.refVideo || project.media.length > 0 ? TEXT.export.followRef : fpsToString(spec?.fps ?? DEFAULT_FPS)}
          </span>
        </div>
        <div className="kv__row">
          <span>帧数</span>
          <span className="mono">{frames}</span>
        </div>
        {/* 水印只在叠加出口烧进画面，透明字幕条出口不含台标 —— 在发起导出前说清 */}
        {project.watermark?.enabled ? (
          <div className="kv__row">
            <span>水印</span>
            <span className="mono" title={project.watermark.path}>
              {project.watermark.name} · 左上角（仅叠加出口）
            </span>
          </div>
        ) : null}
        {estimate ? (
          <div className="kv__row">
            <span>{TEXT.export.estimate}</span>
            <span className={`mono${estimate.sufficientDisk ? '' : ' text-danger'}`}>
              {formatBytes(estimate.bytes)}
              {estimate.recommendPng ? ' · 建议 PNG' : ''}
              {estimate.sufficientDisk ? '' : ' · 磁盘不足'}
            </span>
          </div>
        ) : null}
      </div>

      <div className="stack stack--tight">
        <span className="field__label">交付画布（叠加 MP4）</span>
        {CANVAS_ORDER.map((kind) => (
          <div key={kind} className="stack stack--tight">
            <label className="switch">
              <input
                type="checkbox"
                aria-label={CANVAS_LABELS[kind]}
                checked={canvasChecked[kind]}
                onChange={(event) =>
                  setCanvasChecked((previous) => ({ ...previous, [kind]: event.target.checked }))
                }
              />
              <span>{CANVAS_LABELS[kind]}</span>
            </label>
            {kind !== 'landscape' && canvasChecked[kind] ? (
              <div className="stack stack--tight">
                <label className="field">
                  <span className="field__label">分辨率</span>
                  <select
                    className="select"
                    aria-label={`${CANVAS_LABELS[kind]}分辨率`}
                    value={canvasTier[kind]}
                    onChange={(event) =>
                      setCanvasTier((previous) => ({
                        ...previous,
                        [kind]: event.target.value as ExportResolutionTier
                      }))
                    }
                  >
                    <option value="1080">1080</option>
                    <option value="720">720</option>
                  </select>
                </label>
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
                    <option value="cover">cover（裁切）</option>
                    <option value="contain">contain（补边）</option>
                  </select>
                </label>
              </div>
            ) : null}
          </div>
        ))}
        {selections.length === 0 ? <p className="hint">至少勾选一个画布</p> : null}

        <label className="field">
          <span className="field__label">画质档</span>
          <select
            className="select"
            value={quality}
            onChange={(event) => setQuality(event.target.value as ExportQuality)}
          >
            <option value="high">高（CRF 18）</option>
            <option value="standard">标准（CRF 23）</option>
            <option value="small">小体积（CRF 28）</option>
          </select>
        </label>

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

        <button
          type="button"
          className="btn btn--primary btn--block"
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
          {selections.length > 1
            ? `开始导出（${selections.length} 个画布）`
            : firstSelection
              ? `开始导出（${CANVAS_LABELS[firstSelection.kind]}）`
              : '开始导出'}
        </button>

        <button
          type="button"
          className="btn btn--block"
          disabled={coverDisabled}
          onClick={() => {
            if (firstSelection) void exportCover({ outputDir, selection: firstSelection })
          }}
        >
          导出封面（{firstSelection ? CANVAS_LABELS[firstSelection.kind] : '当前画布'} · 当前帧）
        </button>

        {batchRunning ? (
          <button type="button" className="btn btn--block" onClick={() => void cancelBatch()}>
            取消全部
          </button>
        ) : null}

        <p className="hint">透明 MOV / PNG 序列只按工程分辨率，画布多选只影响叠加 MP4 与封面。</p>
      </div>

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

      <div className="stack stack--tight">
        <span className="field__label">预览此画布</span>
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
              {fit}
            </button>
          ))}
        </div>
        {previewCanvasKind ? (
          <span className="chip chip--ok">
            预览：{CANVAS_LABELS[previewCanvasKind]} · {previewFit}
          </span>
        ) : null}
      </div>

      <div className="stack stack--tight">
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={baseDisabled || gate.blocked || exportRunning}
          title={gate.blocked ? gate.reason ?? '' : undefined}
          onClick={() => void run('transparentMov')}
        >
          {TEXT.export.startMov}
        </button>
      </div>

      <Expander title="更多导出选项" summary={codec === 'prores4444' ? 'ProRes 4444' : 'qtrle'}>
        <div className="stack">
          <label className="field">
            <span className="field__label">帧交付</span>
            <select
              className="select"
              value={frameDelivery}
              onChange={(event) => setFrameDelivery(event.target.value as 'pipe' | 'pngSequence')}
            >
              <option value="pipe" title="帧直接写入 FFmpeg stdin，不落盘">管道直送</option>
              <option value="pngSequence" title="帧先落盘再编码，用于排查">PNG 序列落盘</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">管道帧形式</span>
            <select
              className="select"
              value={pipeTransport}
              disabled={frameDelivery !== 'pipe'}
              onChange={(event) => setPipeTransport(event.target.value as 'raw' | 'png')}
            >
              <option value="raw" title="默认；1080p30/10s 约 7 秒">未压缩 RGBA</option>
              <option value="png" title="字节少，但每帧多约 30ms 压缩">PNG（带 alpha）</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">透明出口编码</span>
            <select className="select" value={codec} onChange={(event) => setCodec(event.target.value as TransparentCodec)}>
              <option value="prores4444" title="yuva444p10le">ProRes 4444</option>
              <option value="qtrle" title="无损 RGBA，兼容性最好">qtrle 无损</option>
            </select>
          </label>

          {/* 计划 §6：直接管道合成是可选后端，只在中间 MOV 真的成问题时开放勾选 */}
          <label className="switch" title={directPipeAllowed ? '跳过中间 MOV，直接管道交给 FFmpeg' : '默认关闭；磁盘不足或时长超 5 分钟时可勾选'}>
            <input
              type="checkbox"
              checked={directPipe && directPipeAllowed}
              disabled={!directPipeAllowed}
              onChange={(event) => setDirectPipe(event.target.checked)}
            />
            <span>直接管道合成</span>
          </label>

          <button type="button" className="btn btn--block" disabled={baseDisabled || gate.blocked} onClick={() => void run('pngSequence')}>
            {TEXT.export.startPng}
          </button>
        </div>
      </Expander>

      {gate.blocked ? <InfoBar tone="warning" message={gate.reason ?? '门禁未确认'} /> : null}
      {mediaMissing ? <InfoBar tone="error" message={TEXT.refVideoMissing.notice} /> : null}
      {!ffmpegAvailable ? <InfoBar tone="error" message="FFmpeg 不可用，导出已禁用" /> : null}
      {exportScope === 'selected' ? <p className="hint">请先选中一个片段</p> : null}
    </section>
  )
}
