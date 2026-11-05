import { useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_FPS, RESOLUTION_PRESETS, fpsToString } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { formatBytes } from '@shared/sizeEstimate'
import type { ExportKind, RenderJobSpec, SizeEstimate, TransparentCodec } from '@shared/types'
import { useExportJob } from '../hooks/useExportJob'
import { useProjectStore } from '../state/projectStore'
import { gateBlocked, useUiStore } from '../state/uiStore'
import { Expander } from '../components/ui/Expander'
import { InfoBar } from '../components/ui/InfoBar'

/** 导出面板（规格 §2.3 / §3.1）。叠加导出的分辨率/帧率只读显示为「跟随参考视频」。 */

const LAST_DIR_KEY = 'focusnews.lastOutputDir'

export interface ExportPanelProps {
  spec: RenderJobSpec | null
  fontLoading: boolean
  ffmpegAvailable: boolean
}

export function ExportPanel({ spec, fontLoading, ffmpegAvailable }: ExportPanelProps): ReactElement {
  const project = useProjectStore((state) => state.project)
  const exportScope = useUiStore((state) => state.exportScope)
  const setExportScope = useUiStore((state) => state.setExportScope)
  const setNotice = useUiStore((state) => state.setNotice)
  const uiMode = useUiStore((state) => state.uiMode)
  const { start } = useExportJob()

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
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={baseDisabled || gate.blocked}
          title={gate.blocked ? gate.reason ?? '' : undefined}
          onClick={() => void run('transparentMov')}
        >
          {TEXT.export.startMov}
        </button>
        <button
          type="button"
          className="btn btn--block"
          disabled={baseDisabled || overlayDisabled || gate.blocked}
          title={
            gate.blocked
              ? gate.reason ?? ''
              : mediaMissing
                ? TEXT.refVideoMissing.notice
                : overlayDisabled
                  ? '叠加导出需要先把素材放入媒体轨'
                  : undefined
          }
          onClick={() => void run('overlayMp4')}
        >
          {TEXT.export.startMp4}
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
              <option value="pipe">管道直送 stdin（主路径）</option>
              <option value="pngSequence">PNG 序列落盘（回退 / 便于排查）</option>
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
              <option value="raw">未压缩 RGBA（默认，1080p30/10s 约 7 秒）</option>
              <option value="png">带 alpha 的 PNG（字节少，但每帧多 ~30ms 压缩）</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">透明出口编码</span>
            <select className="select" value={codec} onChange={(event) => setCodec(event.target.value as TransparentCodec)}>
              <option value="prores4444">ProRes 4444（yuva444p10le）</option>
              <option value="qtrle">qtrle 无损 RGBA（兼容模式）</option>
            </select>
          </label>

          {/* 计划 §6：直接管道合成是可选后端，只在中间 MOV 真的成问题时开放勾选 */}
          <label className="switch" title={directPipeAllowed ? '' : '仅在磁盘不足或 span > 5 分钟时可勾选'}>
            <input
              type="checkbox"
              checked={directPipe && directPipeAllowed}
              disabled={!directPipeAllowed}
              onChange={(event) => setDirectPipe(event.target.checked)}
            />
            <span>直接管道合成（不落中间 MOV）</span>
          </label>
          <span className="hint">
            {directPipeAllowed
              ? diskShort
                ? '已开启条件：目标盘空间不足预估 ×1.5'
                : '已开启条件：span 超过 5 分钟'
              : '默认关闭（两阶段法）；磁盘不足或 span > 5 分钟时可勾选'}
          </span>

          <button type="button" className="btn btn--block" disabled={baseDisabled || gate.blocked} onClick={() => void run('pngSequence')}>
            {TEXT.export.startPng}
          </button>

          {uiMode === 'advanced' ? (
            <div className="hint">
              分辨率档：{RESOLUTION_PRESETS.map((preset) => preset.label).join(' / ')}
            </div>
          ) : null}
        </div>
      </Expander>

      {gate.blocked ? (
        <InfoBar tone="warning" message={`门禁：${gate.reason}（规格 §6：未确认不可继续）`} />
      ) : null}
      {mediaMissing ? <InfoBar tone="error" message={TEXT.refVideoMissing.notice} /> : null}
      {!ffmpegAvailable ? <InfoBar tone="error" message="FFmpeg 不可用，导出已禁用" /> : null}
      {exportScope === 'selected' ? <p className="hint">请先在时间轴选中一个片段。</p> : null}
    </section>
  )
}
