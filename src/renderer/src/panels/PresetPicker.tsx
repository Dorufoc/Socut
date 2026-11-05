import { useState, type ReactElement } from 'react'
import { PRESETS, getPreset } from '@shared/presets'
import { styleOverrideCount } from '@shared/clipStyle'
import { TEXT } from '@shared/i18n'
import type { PresetId } from '@shared/types'
import { askConfirm } from '../dialog/ask'
import { selectedClip, useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { useRevealClip } from '../hooks/useRevealClip'

/**
 * 8 套广播级预设选择器（规格 §3.1 / §7，命名只用风格词，不含任何台名或台标）。
 *
 * 点击预设的语义（用户明确要求）：**即时应用该预设，并把本条的全部自定义参数
 * 还原到该预设的默认配置**（配色 / 透明度 / 渐变 / 字号缩放 / 紧凑 / 字体 / 动画节奏），
 * 重置发生在 store 里（`updateClip` 见到 `presetId` 就走 `clipWithPresetDefaults`），
 * 面板这边只负责把播放头带到能看清结果的帧上。文字内容与入出点始终不动。
 *
 * 唯一的例外保护：重复点击「当前已选中的预设」也意味着清除已有自定义，
 * 这属于破坏性操作，按项目纪律先二次确认（与「把样式应用到全部」同一口径）。
 */
export function PresetPicker(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const updateClip = useProjectStore((state) => state.updateClip)
  const setNotice = useUiStore((state) => state.setNotice)
  const reveal = useRevealClip()
  const [busy, setBusy] = useState(false)

  const activeId = clip?.presetId ?? null
  const customizations = clip ? styleOverrideCount(getPreset(clip.presetId), clip.styleOverrides) : 0

  const pick = async (presetId: PresetId): Promise<void> => {
    if (!clip || busy) return
    if (presetId === clip.presetId && customizations > 0) {
      const ok = await askConfirm(
        TEXT.inspector.presetSameTitle,
        TEXT.inspector.presetSameBody(customizations),
        TEXT.inspector.resetAllCustom
      )
      if (!ok) return
      setBusy(true)
      try {
        updateClip(clip.id, { presetId })
        reveal(clip.id)
        setNotice(TEXT.inspector.resetAllCustomDone)
      } finally {
        setBusy(false)
      }
      return
    }
    updateClip(clip.id, { presetId })
    reveal(clip.id)
  }

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.inspector.preset}</span>
        <span className="group__hint">{TEXT.inspector.presetCount(PRESETS.length)}</span>
      </div>
      <div className="presets">
        {PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`preset-card${activeId === preset.id ? ' preset-card--active' : ''}`}
            disabled={!clip || busy}
            aria-pressed={activeId === preset.id}
            title={preset.description}
            onClick={() => void pick(preset.id as PresetId)}
          >
            <span className="preset-card__top">
              <span className="preset-card__name">{preset.name}</span>
              <span className="preset-card__swatches">
                {[preset.tokens.primary, preset.tokens.accent, preset.tokens.barBackground].map((color, index) => (
                  <span key={index} className="swatch" style={{ background: color }} />
                ))}
              </span>
            </span>
          </button>
        ))}
      </div>
      {clip === null ? (
        <p className="hint">{TEXT.inspector.noneSelected}</p>
      ) : customizations > 0 ? (
        <span className="chip chip--warn">{TEXT.inspector.customized(customizations)}</span>
      ) : null}
    </section>
  )
}
