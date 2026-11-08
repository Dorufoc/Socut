import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { BRAND_FONT_IMPORT_HINTS, FONT_SCALE_MAX, FONT_SCALE_MIN } from '@shared/constants'
import { fontScaleDelta } from '@shared/clipStyle'
import { getPreset } from '@shared/presets'
import { selectedClip, useProjectStore } from '../state/projectStore'
import { useRevealClip } from '../hooks/useRevealClip'
import { Expander } from '../components/ui/Expander'

/** 字体面板（规格 §4.5）：内置 + 用户导入，片段保存 fontId 而非字体名。 */

export function FontPanel(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const fonts = useProjectStore((state) => state.fonts)
  const updateClip = useProjectStore((state) => state.updateClip)
  const setFonts = useProjectStore((state) => state.setFonts)
  const reveal = useRevealClip()

  const preset = clip ? getPreset(clip.presetId) : null
  const fixedRoles = preset
    ? (['title', 'subtitle'] as const).filter((role) => preset.fonts[role].builtinKey !== 'auto')
    : []

  const scaleOf = (role: 'title' | 'subtitle'): number => clip?.styleOverrides.fontScale?.[role] ?? 1

  /**
   * 片段级字号缩放：只写本片段，缩放后仍过硬上限（见 presetResolver.clampScale）。
   * 写的是差集：回到 100% 的角色从覆盖里删键，不给下一个预设留陈旧缩放。
   */
  const setScale = (role: 'title' | 'subtitle', value: number): void => {
    if (!clip) return
    updateClip(clip.id, {
      styleOverrides: { fontScale: fontScaleDelta(clip.styleOverrides.fontScale, role, value) }
    })
    reveal(clip.id)
  }

  const builtin = fonts.filter((f) => f.source === 'builtin')
  const user = fonts.filter((f) => f.source === 'user')

  const group = (title: string, list: typeof fonts): ReactElement => (
    <div className="stack stack--tight">
      <div className="facet-label">{title}</div>
      {list.length === 0 ? <span className="hint">（无）</span> : null}
      {list.map((record) => (
        <div className="list-row" key={record.fontId}>
          <span className="list-row__name mono">{record.displayName}</span>
          <span className="list-row__meta">{record.weight}</span>
          {record.source === 'user' ? (
            <button
              type="button"
              className="btn btn--sm btn--danger"
              title={TEXT.fonts.remove}
              aria-label={`${TEXT.fonts.remove} ${record.displayName}`}
              onClick={async () => {
                await window.socut.fonts.remove(record.fontId)
                setFonts(await window.socut.fonts.list())
              }}
            >
              ✕
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )

  return (
    <div className="stack">
      <label className="field">
        <span className="field__label">片段字体</span>
        <select
          className="select"
          value={clip?.fontId ?? ''}
          disabled={!clip}
          onChange={(event) => {
            if (!clip) return
            updateClip(clip.id, { fontId: event.target.value })
            reveal(clip.id)
          }}
        >
          <option value="">请选择</option>
          {fonts.map((record) => (
            <option key={record.fontId} value={record.fontId}>
              {record.displayName}（{record.source === 'builtin' ? '内置' : '导入'} · {record.weight}）
            </option>
          ))}
        </select>
      </label>
      {fixedRoles.length > 0 ? (
        <p className="hint">{TEXT.inspector.fontFixedByPreset(fixedRoles.join(' / '))}</p>
      ) : null}

      {(['title', 'subtitle'] as const).map((role) => (
        <div className="slider-row" key={role}>
          <span className="muted">{role === 'title' ? TEXT.inspector.fontSizeTitle : TEXT.inspector.fontSizeSubtitle}</span>
          <input
            type="range"
            min={Math.round(FONT_SCALE_MIN * 100)}
            max={Math.round(FONT_SCALE_MAX * 100)}
            step={5}
            value={Math.round(scaleOf(role) * 100)}
            disabled={!clip}
            title={TEXT.inspector.fontScaleHint}
            aria-label={role === 'title' ? TEXT.inspector.fontSizeTitle : TEXT.inspector.fontSizeSubtitle}
            onChange={(event) => setScale(role, Number(event.target.value) / 100)}
          />
          <span className="mono slider-row__value">{Math.round(scaleOf(role) * 100)}%</span>
        </div>
      ))}
      {clip && (scaleOf('title') !== 1 || scaleOf('subtitle') !== 1) ? (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            if (!clip) return
            // 空集合 = 删键（见 projectStore.mergeOverrides），不留 fontScale:{1,1} 这种噪声
            updateClip(clip.id, { styleOverrides: { fontScale: {} } })
            reveal(clip.id)
          }}
        >
          字号恢复 100%
        </button>
      ) : null}

      <Expander title="字体库管理" summary={`${fonts.length} 个可用`}>
        <div className="stack">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const result = await window.socut.fonts.import()
              if (!result) return
              setFonts(await window.socut.fonts.list())
            }}
          >
            {TEXT.fonts.import}
          </button>
          {group(TEXT.fonts.builtin, builtin)}
          {group(TEXT.fonts.user, user)}
        </div>
      </Expander>

      {/* 品牌字体：协议未允许随包再分发的，只告知合规导入路径，不代用户拉取字体文件 */}
      <Expander title="可商用品牌字体" summary={`${BRAND_FONT_IMPORT_HINTS.length} 家需自行导入`}>
        <div className="stack stack--tight">
          {BRAND_FONT_IMPORT_HINTS.map((hint) => (
            <div className="hint" key={hint.family}>
              <div>
                {hint.family}：{hint.reason}
              </div>
              <div className="mono" style={{ wordBreak: 'break-all' }}>
                {hint.officialPage}
              </div>
            </div>
          ))}
          <div className="hint">下载后点上方「导入字体」即可。</div>
        </div>
      </Expander>
    </div>
  )
}
