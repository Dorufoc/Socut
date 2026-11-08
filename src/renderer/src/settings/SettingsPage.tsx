import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  gpuKindLabel,
  gpuPreferenceLabel,
  preferredGpuOf,
  videoEncoderLabel,
  type GpuDeviceInfo,
  type GpuDiagnostics,
  type GpuPreference,
  type VideoEncoderMode
} from '@shared/gpu'
import { TEXT } from '@shared/i18n'
import { InfoBar } from '../components/ui/InfoBar'

export interface SettingsPageProps {
  onBack: () => void
  appVersion?: string
}

/** 偏好顺序固定为：自动 / 高性能 / 节能（与 Chromium 开关语义一致）。 */
const PREFERENCE_OPTIONS: readonly GpuPreference[] = ['auto', 'high-performance', 'low-power']
/** 编码模式：自动（优先硬件）/ 仅软件。 */
const ENCODER_OPTIONS: readonly VideoEncoderMode[] = ['auto', 'software']

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * 设置页（v11）：选择预览渲染使用的显卡（Chromium 启动开关，重启生效）
 * 与导出编码模式（硬件 NVENC/QSV/AMF，失败自动回退 libx264）。
 * 数据全部来自主进程的 gpu.diagnostics()，本页只负责呈现与把选择转交主进程。
 */
export function SettingsPage({ onBack, appVersion }: SettingsPageProps): ReactElement {
  const [diagnostics, setDiagnostics] = useState<GpuDiagnostics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preference' | 'encoder' | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const api = window.socut?.gpu
      if (!api) throw new Error(TEXT.settings.error)
      const next = await api.diagnostics()
      setDiagnostics(next)
    } catch (failure) {
      setError(`${TEXT.settings.error}：${describeFailure(failure)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 偏好切换：先乐观更新界面（按钮立即选中），失败则回滚到切换前的快照，
   * 成功则把主进程返回的持久化偏好与「是否需重启」合并回诊断信息。
   */
  const handlePreference = async (next: GpuPreference): Promise<void> => {
    if (!diagnostics || busy || diagnostics.preference === next) return
    const previous = diagnostics
    setDiagnostics({ ...diagnostics, preference: next })
    setBusy('preference')
    setSaveError(null)
    try {
      const api = window.socut?.gpu
      if (!api) throw new Error(TEXT.settings.error)
      const result = await api.setPreference(next)
      setDiagnostics((current) =>
        current
          ? {
              ...current,
              preference: result.settings.gpuPreference,
              restartRequired: result.restartRequired
            }
          : current
      )
    } catch (failure) {
      setDiagnostics(previous)
      setSaveError(`${TEXT.settings.saveError}：${describeFailure(failure)}`)
    } finally {
      setBusy(null)
    }
  }

  /** 编码模式切换：保存后重新拉一次诊断，让「当前编码器」与可用编码器一起刷新。 */
  const handleEncoder = async (mode: VideoEncoderMode): Promise<void> => {
    if (!diagnostics || busy || diagnostics.encoderMode === mode) return
    const previous = diagnostics
    setDiagnostics({ ...diagnostics, encoderMode: mode })
    setBusy('encoder')
    setSaveError(null)
    try {
      const api = window.socut?.gpu
      if (!api) throw new Error(TEXT.settings.error)
      await api.setEncoder(mode)
      const next = await api.diagnostics()
      setDiagnostics(next)
    } catch (failure) {
      setDiagnostics(previous)
      setSaveError(`${TEXT.settings.saveError}：${describeFailure(failure)}`)
    } finally {
      setBusy(null)
    }
  }

  const hasDiscrete = diagnostics?.devices.some((device) => device.kind === 'discrete') ?? false
  const hasIntegrated = diagnostics?.devices.some((device) => device.kind === 'integrated') ?? false
  const preferred = diagnostics ? preferredGpuOf(diagnostics) : null
  const h264Encoders = diagnostics?.hardwareEncoders.filter((encoder) => encoder.codec === 'h264') ?? []

  const preferenceDisabled = (value: GpuPreference): boolean => {
    if (value === 'high-performance') return !hasDiscrete
    if (value === 'low-power') return !hasIntegrated
    return false
  }

  const renderDevice = (device: GpuDeviceInfo): ReactElement => {
    const isActive = device.active || diagnostics?.activeDeviceIndex === device.index
    const isPreferred = preferred?.index === device.index
    return (
      <article key={device.index} className={`gpu-card${isActive ? ' gpu-card--active' : ''}`}>
        <div className="gpu-card__main">
          <h3 className="gpu-card__name">{device.name}</h3>
          {device.vendorName ? <span className="gpu-card__meta">{device.vendorName}</span> : null}
          {device.driverVersion ? <span className="gpu-card__meta">驱动 {device.driverVersion}</span> : null}
        </div>
        <div className="gpu-card__chips">
          <span className="chip">{gpuKindLabel(device.kind)}</span>
          {isActive ? <span className="chip chip--ok">{TEXT.settings.render.active}</span> : null}
          {isPreferred ? <span className="chip chip--accent">{TEXT.settings.render.preferred}</span> : null}
        </div>
      </article>
    )
  }

  return (
    <div className="settings">
      <aside className="settings__sidebar">
        <div className="launcher__brand">
          <span className="launcher__mark" aria-hidden="true">
            <span className="launcher__mark-glyph" />
          </span>
          <span className="launcher__brand-text">
            <span className="launcher__product">Socut</span>
            <span className="launcher__tagline">新闻视频工作台</span>
          </span>
        </div>

        <nav className="settings__nav" aria-label="设置导航">
          <button type="button" className="launcher__nav-item" onClick={onBack}>
            <span className="launcher__nav-label">{TEXT.settings.nav.recent}</span>
          </button>
          <button
            type="button"
            className="launcher__nav-item launcher__nav-item--active"
            aria-current="page"
          >
            <span className="launcher__nav-label">{TEXT.settings.nav.settings}</span>
          </button>
        </nav>

        <div className="launcher__sidebar-footer">
          <span className="launcher__version">{appVersion ? `v${appVersion}` : ''}</span>
        </div>
      </aside>

      <main className="settings__main">
        <header className="settings__header">
          <button type="button" className="btn btn--sm btn--subtle settings__back" onClick={onBack}>
            {TEXT.settings.back}
          </button>
          <div>
            <h1 className="settings__title">{TEXT.settings.title}</h1>
            <p className="settings__subtitle">{TEXT.settings.subtitle}</p>
          </div>
        </header>

        {loading ? <InfoBar tone="info" message={TEXT.settings.loading} /> : null}

        {error ? (
          <InfoBar
            tone="error"
            message={error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void load()}>
                {TEXT.settings.retry}
              </button>
            }
          />
        ) : null}

        {saveError ? (
          <InfoBar
            tone="error"
            message={saveError}
            onDismiss={() => setSaveError(null)}
            dismissLabel="忽略"
          />
        ) : null}

        {diagnostics ? (
          <>
            <section className="settings__section" aria-labelledby="settings-render-title">
              <div className="settings__section-head">
                <h2 className="settings__section-title" id="settings-render-title">
                  {TEXT.settings.render.title}
                </h2>
              </div>

              {diagnostics.softwareRendering ? (
                <InfoBar tone="warning" message={TEXT.settings.render.softwareRendering} />
              ) : null}

              {diagnostics.devices.length === 0 ? (
                <div className="settings__empty">
                  <h3 className="settings__empty-title">{TEXT.settings.render.emptyTitle}</h3>
                  <p className="settings__empty-hint">{TEXT.settings.render.emptyHint}</p>
                </div>
              ) : (
                <>
                  <div className="settings__list">{diagnostics.devices.map(renderDevice)}</div>

                  <div className="settings__row">
                    <span className="settings__row-label">{TEXT.settings.render.preference}</span>
                    <div className="segmented" role="group" aria-label={TEXT.settings.render.preference}>
                      {PREFERENCE_OPTIONS.map((value) => {
                        const selected = diagnostics.preference === value
                        return (
                          <button
                            key={value}
                            type="button"
                            className={`segmented__item${selected ? ' segmented__item--active' : ''}`}
                            aria-pressed={selected}
                            disabled={preferenceDisabled(value) || busy !== null}
                            onClick={() => void handlePreference(value)}
                          >
                            {gpuPreferenceLabel(value)}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <p className="settings__hint">{TEXT.settings.render.hint}</p>
                </>
              )}

              {diagnostics.restartRequired ? (
                <InfoBar tone="warning" message={TEXT.settings.restartNote} />
              ) : null}
            </section>

            <section className="settings__section" aria-labelledby="settings-encoder-title">
              <div className="settings__section-head">
                <h2 className="settings__section-title" id="settings-encoder-title">
                  {TEXT.settings.encoder.title}
                </h2>
              </div>

              <div className="settings__row">
                <span className="settings__row-label">{TEXT.settings.encoder.mode}</span>
                <div className="segmented" role="group" aria-label={TEXT.settings.encoder.mode}>
                  {ENCODER_OPTIONS.map((mode) => {
                    const selected = diagnostics.encoderMode === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        className={`segmented__item${selected ? ' segmented__item--active' : ''}`}
                        aria-pressed={selected}
                        disabled={busy !== null}
                        onClick={() => void handleEncoder(mode)}
                      >
                        {videoEncoderLabel(mode)}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="settings__encoder">
                <span className="settings__encoder-label">{TEXT.settings.encoder.selected}</span>
                <span className="settings__encoder-value">
                  {diagnostics.selectedEncoder
                    ? `${diagnostics.selectedEncoder.name}（${diagnostics.selectedEncoder.vendor}）`
                    : TEXT.settings.encoder.software}
                </span>
              </div>

              {h264Encoders.length > 0 ? (
                <div className="settings__row">
                  <span className="settings__row-label">{TEXT.settings.encoder.available}</span>
                  <div className="gpu-card__chips">
                    {h264Encoders.map((encoder) => (
                      <span key={encoder.name} className="chip mono">
                        {encoder.name}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <p className="settings__hint">{TEXT.settings.encoder.hintHardware}</p>
              <p className="settings__hint">{TEXT.settings.encoder.hintFallback}</p>
            </section>

            <section className="settings__section" aria-labelledby="settings-diagnostics-title">
              <div className="settings__section-head">
                <h2 className="settings__section-title" id="settings-diagnostics-title">
                  {TEXT.settings.diagnostics.title}
                </h2>
              </div>

              <dl className="settings__diagnostics">
                <dt>{TEXT.settings.diagnostics.activeDevice}</dt>
                <dd className="mono">{diagnostics.activeDeviceName || '—'}</dd>
                <dt>{TEXT.settings.diagnostics.appliedPreference}</dt>
                <dd>{gpuPreferenceLabel(diagnostics.appliedPreference)}</dd>
                <dt>{TEXT.settings.diagnostics.hardwareEncoding}</dt>
                <dd className="mono">
                  {diagnostics.hardwareEncodingAvailable
                    ? TEXT.settings.diagnostics.yes
                    : TEXT.settings.diagnostics.no}
                </dd>
              </dl>
            </section>
          </>
        ) : null}
      </main>
    </div>
  )
}
