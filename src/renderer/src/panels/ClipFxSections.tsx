import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import {
  CLIP_AUDIO_RANGE,
  CLIP_AUDIO_STEP,
  CLIP_SPEED_RANGE,
  clipAudioOf,
  clipSpeedOf
} from '@shared/mediaClipAudio'
import { EFFECT_PACKAGES, effectParamsOf, type ActiveEffect, type EffectPackageId } from '@shared/effectPackages'
import { KEY_DEFAULTS, KEY_RANGE, type KeyMode, type MediaClipKey } from '@shared/keying'
import type { AudioDenoiseLevel, ClipAudio, ClipSpeed, MediaClipVideo, VoiceChangeKind, VoiceEnhanceLevel } from '@shared/types'
import { Slider } from './Slider'

/**
 * 片段音频与变速的两个分区（v9）——视频片段编辑器与音频片段编辑器**共用同一组控件**。
 *
 * 为什么单独成文件：音频段没有画面，视频段有；两边各写一份滑杆，
 * 单位与默认值就会分叉（v6 的画面参数就是靠「只在一处定义」躲过这一刀的）。
 *
 * 控件只写 store，不做任何换算：语义全部来自 `shared/mediaClipAudio`，
 * 预览（增益包络 + `playbackRate`）与导出（`volume`/`afade`/`atempo`/`asetrate`）读同一份。
 */

export interface ClipAudioSectionProps {
  audio: ClipAudio | undefined
  /** 本段在时间轴上的长度（秒）：淡入淡出的可用上限 */
  durationSec: number
  onChange: (patch: Partial<ClipAudio>) => void
}

/** 「音频」分区：音量 0%~200% + 渐入/渐出各 0~5s。 */
export function ClipAudioSection({ audio, durationSec, onChange }: ClipAudioSectionProps): ReactElement {
  const resolved = clipAudioOf(audio)
  // 渐变再长也超不过半个片段：滑杆上限按本段长度收（导出侧同样夹到半段，两处不会读数不一致）
  const fadeMax = Math.max(CLIP_AUDIO_STEP.fade, Math.min(CLIP_AUDIO_RANGE.fade.max, durationSec / 2))
  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.clipAudio.title}</span>
      </div>
      <Slider
        label={TEXT.clipAudio.volume}
        value={resolved.volumePercent}
        min={CLIP_AUDIO_RANGE.volume.min}
        max={CLIP_AUDIO_RANGE.volume.max}
        step={CLIP_AUDIO_STEP.volume}
        unit="%"
        title={TEXT.clipAudio.volumeHint}
        onChange={(value) => onChange({ volumePercent: value })}
      />
      <Slider
        label={TEXT.clipAudio.fadeIn}
        value={resolved.fadeInSec}
        min={CLIP_AUDIO_RANGE.fade.min}
        max={fadeMax}
        step={CLIP_AUDIO_STEP.fade}
        unit="s"
        title={TEXT.clipAudio.fadeInHint}
        onChange={(value) => onChange({ fadeInSec: value })}
      />
      <Slider
        label={TEXT.clipAudio.fadeOut}
        value={resolved.fadeOutSec}
        min={CLIP_AUDIO_RANGE.fade.min}
        max={fadeMax}
        step={CLIP_AUDIO_STEP.fade}
        unit="s"
        title={TEXT.clipAudio.fadeOutHint}
        onChange={(value) => onChange({ fadeOutSec: value })}
      />
      {/* v10：降噪只作用于导出（预览不要求听得出差别），所以下拉本身标注「导出生效」 */}
      <label className="field">
        <span className="field__label">{TEXT.clipAudio.denoise}</span>
        <select
          className="select"
          aria-label={TEXT.clipAudio.denoise}
          title={TEXT.clipAudio.denoiseHint}
          value={resolved.denoise ?? 'off'}
          onChange={(event) => {
            const value = event.target.value
            onChange({
              denoise: value === 'off' ? undefined : (value as AudioDenoiseLevel)
            })
          }}
        >
          <option value="off">{TEXT.clipAudio.denoiseOff}</option>
          <option value="light">{TEXT.clipAudio.denoiseLight}</option>
          <option value="standard">{TEXT.clipAudio.denoiseStandard}</option>
          <option value="strong">{TEXT.clipAudio.denoiseStrong}</option>
          {/* M8：AI 降噪（arnndn + RNNoise 模型）；模型缺失时导出前会给出明确错误 */}
          <option value="ai" title={TEXT.clipAudio.denoiseAiHint}>
            {TEXT.clipAudio.denoiseAi}
          </option>
        </select>
      </label>
      {/* M8：人声增强（还原口播清晰度） */}
      <label className="field">
        <span className="field__label">{TEXT.clipAudio.voiceEnhance}</span>
        <select
          className="select"
          aria-label={TEXT.clipAudio.voiceEnhance}
          title={TEXT.clipAudio.voiceEnhanceHint}
          value={resolved.voiceEnhance ?? 'off'}
          onChange={(event) => {
            const value = event.target.value
            onChange({
              voiceEnhance: value === 'off' ? undefined : (value as VoiceEnhanceLevel)
            })
          }}
        >
          <option value="off">{TEXT.clipAudio.voiceEnhanceOff}</option>
          <option value="light">{TEXT.clipAudio.voiceEnhanceLight}</option>
          <option value="standard">{TEXT.clipAudio.voiceEnhanceStandard}</option>
          <option value="strong">{TEXT.clipAudio.voiceEnhanceStrong}</option>
        </select>
      </label>
      {/* M8：变声（保持时长，不影响与画面同步） */}
      <label className="field">
        <span className="field__label">{TEXT.clipAudio.voiceChange}</span>
        <select
          className="select"
          aria-label={TEXT.clipAudio.voiceChange}
          title={TEXT.clipAudio.voiceChangeHint}
          value={resolved.voiceChange ?? 'off'}
          onChange={(event) => {
            const value = event.target.value
            onChange({
              voiceChange: value === 'off' ? undefined : (value as VoiceChangeKind)
            })
          }}
        >
          <option value="off">{TEXT.clipAudio.voiceChangeOff}</option>
          <option value="chipmunk">{TEXT.clipAudio.voiceChangeChipmunk}</option>
          <option value="robot">{TEXT.clipAudio.voiceChangeRobot}</option>
          <option value="phone">{TEXT.clipAudio.voiceChangePhone}</option>
          <option value="deep">{TEXT.clipAudio.voiceChangeDeep}</option>
        </select>
      </label>
    </section>
  )
}

export interface ClipSpeedSectionProps {
  speed: ClipSpeed | undefined
  onChange: (patch: Partial<ClipSpeed>) => void
}

/** 「变速」分区：0.25x~4.0x + 保持音高开关（默认开）。 */
export function ClipSpeedSection({ speed, onChange }: ClipSpeedSectionProps): ReactElement {
  const resolved = clipSpeedOf(speed)
  const keepPitch = resolved.maintainPitch
  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.clipSpeed.title}</span>
      </div>
      <Slider
        label={TEXT.clipSpeed.rate}
        value={resolved.speed}
        min={CLIP_SPEED_RANGE.min}
        max={CLIP_SPEED_RANGE.max}
        step={CLIP_AUDIO_STEP.speed}
        title={TEXT.clipSpeed.rateHint}
        format={(value) => String(Math.round(value * 100) / 100)}
        unit="x"
        onChange={(value) => onChange({ speed: value })}
      />
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className={`btn btn--sm${keepPitch ? ' btn--primary' : ''}`}
          aria-pressed={keepPitch}
          title={TEXT.clipSpeed.maintainPitchHint}
          onClick={() => onChange({ maintainPitch: !keepPitch })}
        >
          {keepPitch ? TEXT.clipSpeed.on : TEXT.clipSpeed.off}
        </button>
      </div>
    </section>
  )
}
// ---------------------------------------------------------------------------
// M7-E：特效包分区（暗角 / 胶片颗粒 / 故障 / 色差 / 暖色漏光 / 黑白）
// ---------------------------------------------------------------------------

export interface ClipEffectsSectionProps {
  video: MediaClipVideo | undefined
  onChange: (patch: Partial<MediaClipVideo>) => void
}

/**
 * 特效包多选 + 参数滑杆。
 *
 * 落盘口径：只存用户改过的参数（`params` 缺省 = schema 默认值），
 * 勾选/取消直接整份写回 `effects`；归一化在 store 的 `normalizeMediaVideo` 里做。
 */
export function ClipEffectsSection({ video, onChange }: ClipEffectsSectionProps): ReactElement {
  const active = video?.effects ?? []
  const write = (effects: ActiveEffect[]): void => {
    onChange({ effects: effects.length > 0 ? effects : undefined })
  }
  const toggle = (id: EffectPackageId, enabled: boolean): void => {
    if (enabled) write([...active, { id, params: {} }])
    else write(active.filter((effect) => effect.id !== id))
  }
  const updateParam = (id: EffectPackageId, key: string, value: number): void => {
    write(
      active.map((effect) =>
        effect.id === id ? { ...effect, params: { ...effect.params, [key]: value } } : effect
      )
    )
  }

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.clipEffects.title}</span>
      </div>
      <p className="hint">{TEXT.clipEffects.hint}</p>
      {EFFECT_PACKAGES.map((pkg) => {
        const current = active.find((effect) => effect.id === pkg.id)
        const values = current ? effectParamsOf(current) : null
        return (
          <div key={pkg.id} className="effect-pack">
            <label className="switch">
              <input
                type="checkbox"
                aria-label={pkg.label}
                checked={current !== undefined}
                onChange={(event) => toggle(pkg.id, event.target.checked)}
              />
              <span title={pkg.description}>{pkg.label}</span>
            </label>
            {current && values
              ? pkg.params.map((schema) => (
                  <Slider
                    key={schema.key}
                    label={`${pkg.label} · ${schema.label}`}
                    value={values[schema.key] ?? schema.default}
                    min={schema.min}
                    max={schema.max}
                    step={schema.step}
                    unit={schema.unit ?? ''}
                    onChange={(value) => updateParam(pkg.id, schema.key, value)}
                  />
                ))
              : null}
          </div>
        )
      })}
    </section>
  )
}
// ---------------------------------------------------------------------------
// M8：抠像分区（色度键 / 亮度键；导出侧生效）
// ---------------------------------------------------------------------------

export interface ClipKeySectionProps {
  keyValue: MediaClipKey | undefined
  onChange: (key: MediaClipKey | undefined) => void
}

/** 键控参数（关闭 = undefined，整键删除）。 */
export function ClipKeySection({ keyValue, onChange }: ClipKeySectionProps): ReactElement {
  const mode: KeyMode | 'off' = keyValue?.mode ?? 'off'
  const current: MediaClipKey = { ...KEY_DEFAULTS, ...(keyValue ?? {}) }
  const write = (patch: Partial<MediaClipKey>): void => onChange({ ...current, ...patch })

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.clipKey.title}</span>
      </div>
      <p className="hint">{TEXT.clipKey.hint}</p>
      <label className="field">
        <span className="field__label">{TEXT.clipKey.mode}</span>
        <select
          className="select"
          aria-label={TEXT.clipKey.mode}
          value={mode}
          onChange={(event) => {
            const value = event.target.value
            if (value === 'off') onChange(undefined)
            else onChange({ ...current, mode: value === 'luma' ? 'luma' : 'chroma' })
          }}
        >
          <option value="off">{TEXT.clipKey.off}</option>
          <option value="chroma">{TEXT.clipKey.chroma}</option>
          <option value="luma">{TEXT.clipKey.luma}</option>
        </select>
      </label>
      {mode === 'chroma' ? (
        <>
          <label className="field">
            <span className="field__label">{TEXT.clipKey.color}</span>
            <input
              className="input"
              type="color"
              aria-label={TEXT.clipKey.color}
              value={current.color}
              onChange={(event) => write({ color: event.target.value })}
            />
          </label>
          <Slider
            label={TEXT.clipKey.similarity}
            value={current.similarity}
            min={KEY_RANGE.similarity.min}
            max={KEY_RANGE.similarity.max}
            step={0.01}
            unit=""
            onChange={(value) => write({ similarity: value })}
          />
          <Slider
            label={TEXT.clipKey.blend}
            value={current.blend}
            min={KEY_RANGE.blend.min}
            max={KEY_RANGE.blend.max}
            step={0.01}
            onChange={(value) => write({ blend: value })}
          />
          <Slider
            label={TEXT.clipKey.despill}
            value={current.despill}
            min={KEY_RANGE.despill.min}
            max={KEY_RANGE.despill.max}
            step={0.01}
            onChange={(value) => write({ despill: value })}
          />
        </>
      ) : null}
      {mode === 'luma' ? (
        <>
          <Slider
            label={TEXT.clipKey.threshold}
            value={current.threshold}
            min={KEY_RANGE.threshold.min}
            max={KEY_RANGE.threshold.max}
            step={0.01}
            onChange={(value) => write({ threshold: value })}
          />
          <Slider
            label={TEXT.clipKey.tolerance}
            value={current.tolerance}
            min={KEY_RANGE.tolerance.min}
            max={KEY_RANGE.tolerance.max}
            step={0.01}
            onChange={(value) => write({ tolerance: value })}
          />
          <Slider
            label={TEXT.clipKey.softness}
            value={current.softness}
            min={KEY_RANGE.softness.min}
            max={KEY_RANGE.softness.max}
            step={0.01}
            onChange={(value) => write({ softness: value })}
          />
        </>
      ) : null}
    </section>
  )
}