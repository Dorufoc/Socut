import type { ChangeEvent, ReactElement } from 'react'

/**
 * 检查器里的「标签 + 滑杆 + 数值」一行（v6 起从视频编辑器抽出来共用）。
 *
 * 数值一律放在控件右侧的 mono 标签里（需求：不要靠 tooltip 读数）；
 * `format` 只影响显示，不改写写回 store 的原值。
 */
export interface SliderKeyframeProps {
  /** 该参数已有轨道（显示"清空"按钮） */
  active: boolean
  /** 播放头处正好有关键点（菱形实心） */
  atPlayhead: boolean
  /** 点击：有则删除、无则以当前值打点 */
  onToggle: () => void
  /** 清空该参数的全部关键帧 */
  onClear: () => void
  labels: { add: string; remove: string; clear: string }
}

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
  /** 媒体段画面滑条：行尾内联关键帧按钮 */
  keyframe?: SliderKeyframeProps
  onChange: (value: number) => void
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  title,
  format,
  keyframe,
  onChange
}: SliderProps): ReactElement {
  const text = format ? format(value) : String(Math.round(value * 10) / 10)
  return (
    <div className={keyframe ? 'slider-row slider-row--keyed' : 'slider-row'}>
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
      {keyframe ? (
        <span className="slider-row__keys">
          {keyframe.active ? (
            <button
              type="button"
              className="keyframe-toggle keyframe-toggle--clear"
              title={keyframe.labels.clear}
              aria-label={`${label}：${keyframe.labels.clear}`}
              onClick={keyframe.onClear}
            >
              ×
            </button>
          ) : null}
          <button
            type="button"
            className={`keyframe-toggle${keyframe.active ? ' is-track' : ''}${
              keyframe.atPlayhead ? ' is-key' : ''
            }`}
            title={keyframe.atPlayhead ? keyframe.labels.remove : keyframe.labels.add}
            aria-label={`${label}：${keyframe.atPlayhead ? keyframe.labels.remove : keyframe.labels.add}`}
            aria-pressed={keyframe.atPlayhead}
            onClick={keyframe.onToggle}
          >
            {keyframe.atPlayhead ? '◆' : '◇'}
          </button>
        </span>
      ) : null}
    </div>
  )
}
