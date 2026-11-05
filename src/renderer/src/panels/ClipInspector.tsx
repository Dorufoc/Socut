import { useState, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { getPreset } from '@shared/presets'
import { styleOverrideCount } from '@shared/clipStyle'
import { secondsToTimecode } from '@shared/timecode'
import { askConfirm } from '../dialog/ask'
import { selectedClip, useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { useRevealClip } from '../hooks/useRevealClip'
import { Expander } from '../components/ui/Expander'
import { PresetPicker } from './PresetPicker'
import { TextPanel } from './TextPanel'
import { ColorPanel } from './ColorPanel'
import { FontPanel } from './FontPanel'
import { AnimationPanel } from './AnimationPanel'

/**
 * 当前字幕条检查器（右侧栏）——选中驱动：时间轴点选或预览里点字幕条都会落到同一个
 * `selectedClipId`，因此这里显示的永远是「你正在看 / 刚点中的那一条」，
 * 所有修改只写回该片段的 `styleOverrides` / `content` / `animation` / `fontId`，
 * 不会影响工程里的其他片段。
 *
 * 基础模式只保留高频入口（当前片段、文字、预设、批量应用）；
 * 配色 / 字体 / 动画收进展开器，且只在高级模式下出现，避免默认界面被低频参数淹没。
 *
 * 底部的「把样式应用到全部字幕条」是唯一会跨片段生效的操作，且**跳过文字内容与入出点**：
 * 用户明确要求「除文字内容之外的所有内容」应用，故 preset / 配色 / 字体 / 字号 / 动画都复制。
 *
 * 紧邻的「恢复预设默认」只作用于本条：清除全部自定义参数、回到当前预设的默认配置，
 * 并把播放头带到能看清结果的帧（与切预设同一口径，因此也有二次确认）。
 */
export function ClipInspector(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const clips = useProjectStore((state) => state.project.clips)
  const fps = useProjectStore((state) => state.project.fps)
  const applyStyleToAll = useProjectStore((state) => state.applyStyleToAll)
  const resetClipStyle = useProjectStore((state) => state.resetClipStyle)
  const setNotice = useUiStore((state) => state.setNotice)
  const uiMode = useUiStore((state) => state.uiMode)
  const setUiMode = useUiStore((state) => state.setUiMode)
  const reveal = useRevealClip()
  const [busy, setBusy] = useState(false)

  const preset = clip ? getPreset(clip.presetId) : null
  const index = clip ? clips.findIndex((item) => item.id === clip.id) + 1 : 0
  const others = Math.max(0, clips.length - 1)
  /** 本条偏离预设默认多少项：驱动「恢复预设默认」的显隐与确认文案 */
  const customizations = clip && preset ? styleOverrideCount(preset, clip.styleOverrides) : 0

  const runResetStyle = async (): Promise<void> => {
    if (!clip || !preset || busy) return
    const ok = await askConfirm(
      TEXT.inspector.resetAllCustomTitle,
      TEXT.inspector.resetAllCustomBody(customizations),
      TEXT.inspector.resetAllCustom
    )
    if (!ok) return
    setBusy(true)
    try {
      resetClipStyle(clip.id)
      reveal(clip.id)
      setNotice(TEXT.inspector.resetAllCustomDone)
    } finally {
      setBusy(false)
    }
  }

  const runApplyAll = async (): Promise<void> => {
    if (!clip || busy) return
    if (others === 0) {
      setNotice(TEXT.inspector.applyAllNoTarget)
      return
    }
    const ok = await askConfirm(
      TEXT.inspector.applyAllConfirmTitle,
      TEXT.inspector.applyAllConfirmBody(others),
      TEXT.inspector.applyAll
    )
    if (!ok) return
    setBusy(true)
    try {
      const count = applyStyleToAll(clip.id)
      setNotice(TEXT.inspector.applyAllDone(count))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inspector">
      <section className="inspector__head">
        <div className="inspector__heading">
          <h2 className="inspector__title">{TEXT.inspector.selectedClip}</h2>
          <span className={`chip ${uiMode === 'advanced' ? 'chip--accent' : ''}`}>
            {uiMode === 'advanced' ? '高级模式' : '基础模式'}
          </span>
        </div>
        {clip && preset ? (
          <>
            <div className="inspector__meta">
              <span className="mono">
                第 {index} / {clips.length} 段 · {preset.name}
              </span>
              <span className="mono muted">
                {secondsToTimecode(clip.startTime, fps)} → {secondsToTimecode(clip.endTime, fps)}
              </span>
            </div>
            <div className="inspector__preview">
              <span className="inspector__preview-title">{clip.content.title || '（无主标题）'}</span>
              {clip.content.subtitle ? <span className="inspector__preview-sub">{clip.content.subtitle}</span> : null}
            </div>
          </>
        ) : (
          <p className="inspector__empty">{TEXT.inspector.noneSelectedHint}</p>
        )}
      </section>

      <TextPanel />
      <PresetPicker />

      {uiMode === 'advanced' ? (
        <>
          <Expander title={TEXT.inspector.color} summary={preset?.name}>
            <ColorPanel />
          </Expander>
          <Expander title={TEXT.inspector.font}>
            <FontPanel />
          </Expander>
          <Expander title={TEXT.inspector.animation}>
            <AnimationPanel />
          </Expander>
        </>
      ) : (
        <button type="button" className="more-styles" onClick={() => setUiMode('advanced')}>
          <span className="more-styles__text">
            <span className="more-styles__title">更多样式设置</span>
            <span className="more-styles__hint">配色 · 字体 · 动画</span>
          </span>
          <span className="more-styles__arrow" aria-hidden="true">
            ›
          </span>
        </button>
      )}

      <section className="inspector__footer">
        <button
          type="button"
          className="btn btn--block"
          disabled={busy}
          title={TEXT.inspector.applyAllHint}
          onClick={() => void runApplyAll()}
        >
          {TEXT.inspector.applyAll}
        </button>
        {clip && customizations > 0 ? (
          <button
            type="button"
            className="btn btn--block btn--subtle"
            disabled={busy}
            title={TEXT.inspector.resetAllCustomHint}
            onClick={() => void runResetStyle()}
          >
            {TEXT.inspector.resetAllCustom}（{customizations}）
          </button>
        ) : null}
      </section>
    </div>
  )
}
