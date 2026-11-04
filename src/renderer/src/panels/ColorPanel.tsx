import type { ReactElement } from 'react'
import { COLOR_TOKEN_KEYS, isValidColor, mergeTokens, parseColor } from '@shared/colors'
import { TEXT } from '@shared/i18n'
import { getPreset } from '@shared/presets'
import type { ColorTokenKey, ColorTokens, GradientSpec } from '@shared/types'
import { selectedClip, useProjectStore } from '../state/projectStore'
import { Expander } from '../components/ui/Expander'

/**
 * 配色面板（规格 §7：用户自定义作用于令牌层）。
 * 纯色与双色线性渐变均可用；方框背景色与透明度可调。
 * 本组件只负责内容，外层标题由检查器的 Expander 提供。
 */

const TOKEN_LABEL: Record<ColorTokenKey, string> = {
  primary: TEXT.inspector.tokens.primary,
  accent: TEXT.inspector.tokens.accent,
  text: TEXT.inspector.tokens.text,
  secondaryText: TEXT.inspector.tokens.secondaryText,
  barBackground: TEXT.inspector.tokens.barBackground
}

function toHexInput(value: string): string {
  const parsed = parseColor(value)
  if (!parsed) return '#000000'
  const hex = (v: number): string => Math.round(v).toString(16).padStart(2, '0')
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`
}

function GradientEditor({
  label,
  value,
  onChange
}: {
  label: string
  value: GradientSpec | undefined
  onChange: (next: GradientSpec) => void
}): ReactElement {
  const spec: GradientSpec = value ?? { enabled: false, from: '#ffffff', to: '#9ec7ff', angleDeg: 90 }
  return (
    <div className="stack stack--tight">
      <label className="switch">
        <input type="checkbox" checked={spec.enabled} onChange={(event) => onChange({ ...spec, enabled: event.target.checked })} />
        <span>{label}</span>
      </label>
      <div className={`color-row${spec.enabled ? '' : ' color-row--disabled'}`}>
        <span className="muted">{TEXT.inspector.gradientFrom}</span>
        <input
          type="color"
          className="swatch-input"
          value={toHexInput(spec.from)}
          disabled={!spec.enabled}
          onChange={(event) => onChange({ ...spec, from: event.target.value })}
        />
        <input
          className="input mono"
          value={spec.from}
          disabled={!spec.enabled}
          onChange={(event) => onChange({ ...spec, from: event.target.value })}
        />
      </div>
      <div className={`color-row${spec.enabled ? '' : ' color-row--disabled'}`}>
        <span className="muted">{TEXT.inspector.gradientTo}</span>
        <input
          type="color"
          className="swatch-input"
          value={toHexInput(spec.to)}
          disabled={!spec.enabled}
          onChange={(event) => onChange({ ...spec, to: event.target.value })}
        />
        <input
          className="input mono"
          value={spec.to}
          disabled={!spec.enabled}
          onChange={(event) => onChange({ ...spec, to: event.target.value })}
        />
      </div>
      <div className="slider-row">
        <span className="muted">{TEXT.inspector.gradientAngle}</span>
        <input
          type="range"
          min={0}
          max={360}
          step={15}
          value={spec.angleDeg}
          disabled={!spec.enabled}
          onChange={(event) => onChange({ ...spec, angleDeg: Number(event.target.value) })}
        />
        <span className="mono slider-row__value">{spec.angleDeg}°</span>
      </div>
    </div>
  )
}

export function ColorPanel(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const updateClip = useProjectStore((state) => state.updateClip)
  const preset = clip ? getPreset(clip.presetId) : null
  if (!clip || !preset) {
    return <p className="hint">未选择片段。</p>
  }
  const effective = mergeTokens(preset.tokens, clip.styleOverrides.tokens)
  const opacity = Math.round((clip.styleOverrides.barOpacity ?? 1) * 100)

  /** 令牌层覆盖：只改单个键，其余保持预设声明值 */
  const patchToken = (key: ColorTokenKey, value: string): void => {
    const tokens = { ...effective, [key]: value } as ColorTokens
    updateClip(clip.id, { styleOverrides: { tokens } })
  }

  return (
    <div className="stack">
      <div className="token-list">
        {COLOR_TOKEN_KEYS.map((key) => (
          <div className="color-row" key={key}>
            <span className="muted">{TOKEN_LABEL[key]}</span>
            <input
              type="color"
              className="swatch-input"
              value={toHexInput(effective[key])}
              aria-label={TOKEN_LABEL[key]}
              onChange={(event) => patchToken(key, event.target.value)}
            />
            <input
              className="input mono"
              value={effective[key]}
              aria-label={`${TOKEN_LABEL[key]} 色值`}
              onChange={(event) => {
                const next = event.target.value
                if (isValidColor(next)) patchToken(key, next)
              }}
            />
          </div>
        ))}
      </div>

      <div className="slider-row">
        <span className="muted">{TEXT.inspector.barOpacity}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          aria-label={TEXT.inspector.barOpacity}
          onChange={(event) => updateClip(clip.id, { styleOverrides: { barOpacity: Number(event.target.value) / 100 } })}
        />
        <span className="mono slider-row__value">{opacity}%</span>
      </div>

      <Expander title={TEXT.inspector.gradient} summary={clip.styleOverrides.titleGradient?.enabled ? '已启用' : '未启用'}>
        <div className="stack">
          <GradientEditor
            label={`${TEXT.inspector.gradient} · ${TEXT.inspector.title}`}
            value={clip.styleOverrides.titleGradient}
            onChange={(next) => updateClip(clip.id, { styleOverrides: { titleGradient: next } })}
          />
          <GradientEditor
            label={`${TEXT.inspector.gradient} · ${TEXT.inspector.subtitle}`}
            value={clip.styleOverrides.subtitleGradient}
            onChange={(next) => updateClip(clip.id, { styleOverrides: { subtitleGradient: next } })}
          />
        </div>
      </Expander>

      <button
        type="button"
        className="btn btn--sm"
        onClick={() => updateClip(clip.id, { styleOverrides: { tokens: preset.tokens, barOpacity: 1 } })}
      >
        {TEXT.inspector.resetTokens}
      </button>
    </div>
  )
}
