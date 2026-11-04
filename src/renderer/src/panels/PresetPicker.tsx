import type { ReactElement } from 'react'
import { PRESETS } from '@shared/presets'
import type { PresetId } from '@shared/types'
import { selectedClip, useProjectStore } from '../state/projectStore'

/** 8 套广播级预设选择器（规格 §3.1 / §7，命名只用风格词，不含任何台名或台标）。 */

export function PresetPicker(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const updateClip = useProjectStore((state) => state.updateClip)
  const activeId = clip?.presetId ?? null

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">预设样式</span>
        <span className="group__hint">{PRESETS.length} 套广播级</span>
      </div>
      <div className="presets">
        {PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`preset-card${activeId === preset.id ? ' preset-card--active' : ''}`}
            disabled={!clip}
            aria-pressed={activeId === preset.id}
            title={preset.description}
            onClick={() => {
              if (!clip) return
              updateClip(clip.id, { presetId: preset.id as PresetId })
            }}
          >
            <span className="preset-card__top">
              <span className="preset-card__name">{preset.name}</span>
              <span className="preset-card__swatches">
                {[preset.tokens.primary, preset.tokens.accent, preset.tokens.barBackground].map((color, index) => (
                  <span key={index} className="swatch" style={{ background: color }} />
                ))}
              </span>
            </span>
            <span className="preset-card__desc">{preset.description}</span>
          </button>
        ))}
      </div>
      {clip === null ? <p className="hint">请先在时间轴选择一个片段。</p> : null}
    </section>
  )
}
