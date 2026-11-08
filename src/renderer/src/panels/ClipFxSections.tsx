import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import {
  CLIP_AUDIO_RANGE,
  CLIP_AUDIO_STEP,
  CLIP_SPEED_RANGE,
  clipAudioOf,
  clipSpeedOf
} from '@shared/mediaClipAudio'
import type { AudioDenoiseLevel, ClipAudio, ClipSpeed } from '@shared/types'
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
