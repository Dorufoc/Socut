import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import type { VoiceAssetStatus } from '@shared/api'
import { InfoBar } from '../components/ui/InfoBar'

/**
 * M11/M8：设置页「语音资产」分区。
 *
 * 三件事，全部离线：
 * 1. 展示 whisper 二进制 / 模型 / RNNoise 模型是否就绪（含候选路径，缺了好照着放文件）；
 * 2. 「选择二进制…」「选择模型…」走系统文件对话框 → 保存到 `userData/whisper.json`；
 * 3. 识别语言（自动 / 中文 / 英文）与「清除配置」（回到候选探测）。
 *
 * 纪律：本组件不联网、不下载，也不拼路径——路径一律由主进程校验存在性后落盘。
 */

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: TEXT.settings.voice.languageAuto },
  { value: 'zh', label: TEXT.settings.voice.languageZh },
  { value: 'en', label: TEXT.settings.voice.languageEn }
] as const

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** 资产状态的一句话结论（缺什么说清缺什么，而不是只说"未就绪"）。 */
export function voiceStatusLabel(status: VoiceAssetStatus): string {
  if (status.ready) return TEXT.settings.voice.ready
  if (!status.binaryPath) return TEXT.settings.voice.missingBinary
  return TEXT.settings.voice.missingModel
}

export function VoiceAssetsSection(): ReactElement {
  const [status, setStatus] = useState<VoiceAssetStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'pick' | 'save' | 'reset' | 'refresh' | null>(null)

  const api = window.socut?.whisper

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      if (!api) throw new Error(TEXT.settings.voice.loading)
      setStatus(await api.status())
    } catch (failure) {
      setError(`${TEXT.settings.voice.title}：${describeFailure(failure)}`)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  /** 挑文件 → 立即保存（用户点了"选择"就是意图，不需要再按一次保存）。 */
  const pick = async (kind: 'binary' | 'model'): Promise<void> => {
    if (!api || busy) return
    setBusy('pick')
    setError(null)
    setNotice(null)
    try {
      const picked = kind === 'binary' ? await api.pickBinary() : await api.pickModel()
      if (!picked) {
        setNotice(TEXT.settings.voice.pickCancelled)
        return
      }
      const next =
        kind === 'binary' ? await api.saveConfig({ binaryPath: picked }) : await api.saveConfig({ modelPath: picked })
      setStatus(next)
      setNotice(TEXT.settings.voice.saved)
    } catch (failure) {
      setError(`${TEXT.settings.saveError}：${describeFailure(failure)}`)
    } finally {
      setBusy(null)
    }
  }

  const changeLanguage = async (value: 'auto' | 'zh' | 'en'): Promise<void> => {
    if (!api || busy || !status) return
    setBusy('save')
    setError(null)
    try {
      setStatus(await api.saveConfig({ language: value === 'auto' ? null : value }))
      setNotice(TEXT.settings.voice.saved)
    } catch (failure) {
      setError(`${TEXT.settings.saveError}：${describeFailure(failure)}`)
    } finally {
      setBusy(null)
    }
  }

  const reset = async (): Promise<void> => {
    if (!api || busy) return
    setBusy('reset')
    setError(null)
    setNotice(null)
    try {
      setStatus(await api.reset())
      setNotice(TEXT.settings.voice.saved)
    } catch (failure) {
      setError(`${TEXT.settings.saveError}：${describeFailure(failure)}`)
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (): Promise<void> => {
    if (busy) return
    setBusy('refresh')
    await load()
    setBusy(null)
  }

  const language = status?.language ?? 'auto'
  const rnnoiseReady = Boolean(status?.rnnoise.path)

  return (
    <section className="settings__section" aria-labelledby="settings-voice-title">
      <div className="settings__section-head">
        <h2 className="settings__section-title" id="settings-voice-title">
          {TEXT.settings.voice.title}
        </h2>
      </div>

      <p className="settings__hint">{TEXT.settings.voice.subtitle}</p>

      {loading ? <InfoBar tone="info" message={TEXT.settings.voice.loading} /> : null}
      {error ? <InfoBar tone="error" message={error} dismissLabel="忽略" onDismiss={() => setError(null)} /> : null}
      {notice ? <InfoBar tone="info" message={notice} dismissLabel="忽略" onDismiss={() => setNotice(null)} /> : null}

      {status ? (
        <>
          <div className="settings__row">
            <span className="settings__row-label">{TEXT.settings.voice.status}</span>
            <div className="gpu-card__chips">
              <span className={`chip${status.ready ? ' chip--ok' : ''}`} data-testid="voice-status">
                {voiceStatusLabel(status)}
              </span>
              <span className={`chip${rnnoiseReady ? ' chip--ok' : ''}`} data-testid="rnnoise-status">
                {rnnoiseReady ? TEXT.settings.voice.rnnoiseReady : TEXT.settings.voice.rnnoiseMissing}
              </span>
            </div>
          </div>

          <dl className="settings__diagnostics">
            <dt>{TEXT.settings.voice.binary}</dt>
            <dd className="mono" data-testid="voice-binary">
              {status.binaryPath ?? TEXT.settings.voice.none}
            </dd>
            <dt>{TEXT.settings.voice.model}</dt>
            <dd className="mono" data-testid="voice-model">
              {status.modelPath ?? TEXT.settings.voice.none}
            </dd>
            <dt>{TEXT.settings.voice.rnnoiseTitle}</dt>
            <dd className="mono" data-testid="voice-rnnoise">
              {status.rnnoise.path ?? TEXT.settings.voice.none}
            </dd>
            <dt>{TEXT.settings.voice.configPath}</dt>
            <dd className="mono">{status.configPath}</dd>
          </dl>

          <div className="settings__row">
            <span className="settings__row-label">{TEXT.settings.voice.language}</span>
            <div className="segmented" role="group" aria-label={TEXT.settings.voice.language}>
              {LANGUAGE_OPTIONS.map((option) => {
                const selected = language === option.value || (option.value === 'auto' && !status.language)
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`segmented__item${selected ? ' segmented__item--active' : ''}`}
                    aria-pressed={selected}
                    disabled={busy !== null}
                    onClick={() => void changeLanguage(option.value)}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="settings__row">
            <span className="settings__row-label">{TEXT.settings.voice.candidates}</span>
            <div className="settings__list">
              {[...status.candidates.binaries, ...status.candidates.models].slice(0, 6).map((candidate) => (
                <span key={candidate} className="chip mono">
                  {candidate}
                </span>
              ))}
            </div>
          </div>

          <div className="settings__actions" role="group" aria-label={TEXT.settings.voice.title}>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy !== null}
              onClick={() => void pick('binary')}
            >
              {TEXT.settings.voice.pickBinary}
            </button>
            <button type="button" className="btn btn--sm" disabled={busy !== null} onClick={() => void pick('model')}>
              {TEXT.settings.voice.pickModel}
            </button>
            <button type="button" className="btn btn--sm btn--subtle" disabled={busy !== null} onClick={() => void refresh()}>
              {TEXT.settings.voice.refresh}
            </button>
            <button type="button" className="btn btn--sm btn--subtle" disabled={busy !== null} onClick={() => void reset()}>
              {TEXT.settings.voice.reset}
            </button>
          </div>

          <p className="settings__hint">{TEXT.settings.voice.fetchHint}</p>
        </>
      ) : null}
    </section>
  )
}
