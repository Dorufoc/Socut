import type { ChangeEvent, ReactElement } from 'react'

/**
 * 检查器里的「标签 + 滑杆 + 数值」一行（v6 起从视频编辑器抽出来共用）。
 *
 * 数值一律放在控件右侧的 mono 标签里（需求：不要靠 tooltip 读数）；
 * `format` 只影响显示，不改写写回 store 的原值。
 */
export interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** 数值后缀，如 % / ° / x */
  unit?: string
  title?: string
  /** 数值格式化（默认四舍五入到 0.1，例如倍速要两位小数） */
  format?: (value: number) => string
  onChange: (value: number) => void
}

export function Slider({ label, value, min, max, step = 1, unit = '', title, format, onChange }: SliderProps): ReactElement {
  const text = format ? format(value) : String(Math.round(value * 10) / 10)
  return (
    <div className="slider-row">
      <span className="muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        title={title}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
      />
      <span className="mono slider-row__value">
        {text}
        {unit}
      </span>
    </div>
  )
}
