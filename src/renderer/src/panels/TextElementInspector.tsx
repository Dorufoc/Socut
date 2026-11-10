import type { ChangeEvent, ReactElement } from 'react'
import { EASING_KEYS, EASING_LABELS } from '@shared/easing'
import { TEXT } from '@shared/i18n'
import { TEXT_PRESETS, resolveTextStyle } from '@shared/textPresets'
import { secondsToTimecode } from '@shared/timecode'
import type {
  EasingKey,
  TextElementClip,
  TextElementPresetId,
  TextElementStyle,
  TextElementStyleOverrides
} from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { Slider } from './Slider'

/**
 * M7-D：文本元素检查器（右侧栏，选中文本元素时显示）。
 *
 * 数据流：控件只写 `updateTextClip`（store 里整份候选过 `normalizeTextElementClip` 归一），
 * 面板读**解析后**的样式（预设 + 覆盖合并结果）来显示/拖动滑杆 —— 用户看到的就是画面上的值。
 *
 * 覆盖只存"偏离预设的部分"（`styleOverrides`），所以切预设不会带上旧样式；
 * `plate` 是深层对象，写回时做部分合并（只改透明度不会把预设底色/圆角冲掉）。
 */

function patchStyle(
  clip: TextElementClip,
  patch: TextElementStyleOverrides
): TextElementStyleOverrides {
  return {
    ...clip.styleOverrides,
    ...patch,
    ...(patch.plate
      ? { plate: { ...(clip.styleOverrides.plate ?? {}), ...patch.plate } }
      : {})
  }
}

function ColorInput(props: {
  label: string
  value: string
  onChange: (value: string) => void
}): ReactElement {
  return (
    <label className="field">
      <span className="field__label">{props.label}</span>
      <input
        className="input"
        type="color"
        aria-label={props.label}
        value={props.value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
      />
    </label>
  )
}

export function TextElementInspector(): ReactElement {
  const clip = useProjectStore(
    (state) => (state.project.textClips ?? []).find((item) => item.id === state.selectedTextClipId) ?? null
  )
  const updateTextClip = useProjectStore((state) => state.updateTextClip)
  const removeTextClip = useProjectStore((state) => state.removeTextClip)
  const fps = useProjectStore((state) => state.project.fps)

  if (!clip) {
    return (
      <div className="inspector">
        <p className="inspector__empty">{TEXT.textElement.empty}</p>
      </div>
    )
  }

  const style: TextElementStyle = resolveTextStyle(clip.presetId, clip.styleOverrides)
  const updateStyle = (patch: TextElementStyleOverrides): void =>
    updateTextClip(clip.id, { styleOverrides: patchStyle(clip, patch) })
  const updatePlate = (patch: Partial<TextElementStyle['plate']>): void => updateStyle({ plate: patch })

  return (
    <div className="inspector">
      <section className="inspector__head">
        <div className="inspector__heading">
          <h2 className="inspector__title">{TEXT.textElement.title}</h2>
          <span className="chip">
            {secondsToTimecode(clip.startTime, fps)} → {secondsToTimecode(clip.endTime, fps)}
          </span>
        </div>
        <div className="inspector__preview">
          <span className="inspector__preview-title">{clip.text || '（空文本）'}</span>
        </div>
      </section>

      {/* 内容与预设 */}
      <label className="field">
        <span className="field__label">{TEXT.textElement.text}</span>
        <textarea
          className="input textarea"
          aria-label={TEXT.textElement.text}
          rows={2}
          value={clip.text}
          onChange={(event) => updateTextClip(clip.id, { text: event.target.value })}
        />
      </label>
      <label className="field">
        <span className="field__label">{TEXT.textElement.preset}</span>
        <select
          className="select"
          aria-label={TEXT.textElement.preset}
          value={clip.presetId}
          onChange={(event) =>
            updateTextClip(clip.id, {
              presetId: event.target.value as TextElementPresetId,
              // 切预设 = 回到预设默认（与字幕条切预设同一纪律：清理旧的覆盖）
              styleOverrides: {}
            })
          }
        >
          {TEXT_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>

      {/* 入出点 */}
      <div className="row">
        <label className="field">
          <span className="field__label">{TEXT.textElement.inPoint}</span>
          <input
            className="input mono"
            type="number"
            min={0}
            step={0.1}
            aria-label={TEXT.textElement.inPoint}
            value={Math.round(clip.startTime * 100) / 100}
            onChange={(event) => updateTextClip(clip.id, { startTime: Number(event.target.value) })}
          />
        </label>
        <label className="field">
          <span className="field__label">{TEXT.textElement.outPoint}</span>
          <input
            className="input mono"
            type="number"
            min={0}
            step={0.1}
            aria-label={TEXT.textElement.outPoint}
            value={Math.round(clip.endTime * 100) / 100}
            onChange={(event) => updateTextClip(clip.id, { endTime: Number(event.target.value) })}
          />
        </label>
      </div>

      {/* 样式 */}
      <Slider label={TEXT.textElement.size} value={style.sizePx} min={8} max={400} onChange={(value) => updateStyle({ sizePx: value })} />
      <Slider label={TEXT.textElement.weight} value={style.weight} min={100} max={900} step={100} onChange={(value) => updateStyle({ weight: value })} />
      <Slider
        label={TEXT.textElement.tracking}
        value={style.trackingPx}
        min={-10}
        max={50}
        onChange={(value) => updateStyle({ trackingPx: value })}
      />
      <Slider
        label={TEXT.textElement.lineHeight}
        value={style.lineHeight}
        min={0.8}
        max={3}
        step={0.05}
        onChange={(value) => updateStyle({ lineHeight: value })}
      />
      <ColorInput label={TEXT.textElement.color} value={style.color} onChange={(value) => updateStyle({ color: value })} />
      <div className="field">
        <span className="field__label">{TEXT.textElement.align}</span>
        <div className="segmented" role="group" aria-label={TEXT.textElement.align}>
          {(
            [
              ['left', TEXT.textElement.alignLeft],
              ['center', TEXT.textElement.alignCenter],
              ['right', TEXT.textElement.alignRight]
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`segmented__item${style.align === value ? ' segmented__item--active' : ''}`}
              aria-pressed={style.align === value}
              onClick={() => updateStyle({ align: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 锚点 */}
      <Slider
        label={TEXT.textElement.anchorX}
        value={style.anchorXPct}
        min={0}
        max={100}
        onChange={(value) => updateStyle({ anchorXPct: value })}
      />
      <Slider
        label={TEXT.textElement.anchorY}
        value={style.anchorYPct}
        min={0}
        max={100}
        onChange={(value) => updateStyle({ anchorYPct: value })}
      />

      {/* 背景板 */}
      <label className="switch">
        <input
          type="checkbox"
          checked={style.plate.enabled}
          onChange={(event) => updatePlate({ enabled: event.target.checked })}
        />
        <span>{TEXT.textElement.plateEnabled}</span>
      </label>
      {style.plate.enabled ? (
        <div className="stack">
          <ColorInput label={TEXT.textElement.plateColor} value={style.plate.color} onChange={(value) => updatePlate({ color: value })} />
          <Slider
            label={TEXT.textElement.plateOpacity}
            value={style.plate.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => updatePlate({ opacity: value })}
          />
          <Slider
            label={TEXT.textElement.platePaddingX}
            value={style.plate.paddingXPx}
            min={0}
            max={96}
            onChange={(value) => updatePlate({ paddingXPx: value })}
          />
          <Slider
            label={TEXT.textElement.platePaddingY}
            value={style.plate.paddingYPx}
            min={0}
            max={96}
            onChange={(value) => updatePlate({ paddingYPx: value })}
          />
          <Slider
            label={TEXT.textElement.plateRadius}
            value={style.plate.radiusPx}
            min={0}
            max={120}
            onChange={(value) => updatePlate({ radiusPx: value })}
          />
        </div>
      ) : null}

      {/* 描边 / 阴影 */}
      <Slider
        label={TEXT.textElement.strokeWidth}
        value={style.strokeWidthPx}
        min={0}
        max={24}
        step={0.5}
        onChange={(value) => updateStyle({ strokeWidthPx: value })}
      />
      {style.strokeWidthPx > 0 ? (
        <ColorInput label={TEXT.textElement.strokeColor} value={style.strokeColor} onChange={(value) => updateStyle({ strokeColor: value })} />
      ) : null}
      <Slider
        label={TEXT.textElement.shadowBlur}
        value={style.shadowBlurPx}
        min={0}
        max={64}
        onChange={(value) => updateStyle({ shadowBlurPx: value })}
      />
      {style.shadowBlurPx > 0 ? (
        <>
          <ColorInput label={TEXT.textElement.shadowColor} value={style.shadowColor} onChange={(value) => updateStyle({ shadowColor: value })} />
          <Slider
            label={TEXT.textElement.shadowOffsetX}
            value={style.shadowOffsetXPx}
            min={-64}
            max={64}
            onChange={(value) => updateStyle({ shadowOffsetXPx: value })}
          />
          <Slider
            label={TEXT.textElement.shadowOffsetY}
            value={style.shadowOffsetYPx}
            min={-64}
            max={64}
            onChange={(value) => updateStyle({ shadowOffsetYPx: value })}
          />
        </>
      ) : null}

      {/* 动画 */}
      <Slider
        label={TEXT.textElement.inDuration}
        value={clip.animation.inDurationSec}
        min={0.05}
        max={2}
        step={0.05}
        onChange={(value) => updateTextClip(clip.id, { animation: { ...clip.animation, inDurationSec: value } })}
      />
      <Slider
        label={TEXT.textElement.outDuration}
        value={clip.animation.outDurationSec}
        min={0.05}
        max={2}
        step={0.05}
        onChange={(value) => updateTextClip(clip.id, { animation: { ...clip.animation, outDurationSec: value } })}
      />
      <Slider
        label={TEXT.textElement.rise}
        value={clip.animation.risePx}
        min={0}
        max={200}
        onChange={(value) => updateTextClip(clip.id, { animation: { ...clip.animation, risePx: value } })}
      />
      <label className="field">
        <span className="field__label">{TEXT.keyframes.easing}</span>
        <select
          className="select"
          aria-label={TEXT.keyframes.easing}
          value={clip.animation.easing}
          onChange={(event) =>
            updateTextClip(clip.id, { animation: { ...clip.animation, easing: event.target.value as EasingKey } })
          }
        >
          {EASING_KEYS.map((key) => (
            <option key={key} value={key}>
              {EASING_LABELS[key]}
            </option>
          ))}
        </select>
      </label>

      <section className="inspector__footer">
        <button type="button" className="btn btn--block btn--danger" onClick={() => removeTextClip(clip.id)}>
          {TEXT.textElement.remove}
        </button>
      </section>
    </div>
  )
}
