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
import { KeyframePanel } from './KeyframePanel'
import { TextElementInspector } from './TextElementInspector'
import { MediaClipInspector } from './MediaClipInspector'
import { AudioClipInspector } from './AudioClipInspector'
import { TransitionInspector } from './TransitionInspector'
import { ClipLocateButton } from './ClipLocateButton'
import type { AudioClip } from '@shared/types'

/** 稳定的空音频轨引用（避免选择器每次返回新数组） */
const EMPTY_AUDIO_CLIPS: AudioClip[] = []

/**
 * 右侧检查器的**总入口**：按最后一次点选的类型分流。
 *
 * - 点中媒体轨上的段（`selectionKind === 'media'`）→ 视频片段编辑器；
 * - 点中音频轨上的段（`selectionKind === 'audio'`，v9）→ 音频片段编辑器；
 * - 否则（字幕条 / 什么都没选）→ 原有的字幕检查器，行为、状态与测试完全不变。
 *
 * 三个选中态可以同时存在（各自服务于不同的时间轴操作），所以分流靠「最后点的是哪类」，
 * 而不是靠“哪个 id 非空”——否则选完媒体段再点字幕条就会卡在视频面板上。
 */
export function ClipInspector(): ReactElement {
  const selectionKind = useProjectStore((state) => state.selectionKind)
  const mediaClips = useProjectStore((state) => state.project.mediaClips)
  const audioClips = useProjectStore((state) => state.project.audioClips) ?? EMPTY_AUDIO_CLIPS
  const mediaPool = useProjectStore((state) => state.project.media)
  const fps = useProjectStore((state) => state.project.fps)
  const selectedMediaClipId = useProjectStore((state) => state.selectedMediaClipId)
  const selectedAudioClipId = useProjectStore((state) => state.selectedAudioClipId)

  if (selectionKind === 'audio') {
    const clip = audioClips.find((item) => item.id === selectedAudioClipId) ?? null
    if (!clip) {
      return (
        <div className="inspector">
          <p className="inspector__empty">{TEXT.audioEditor.noneSelected}</p>
        </div>
      )
    }
    const ordered = [...audioClips].sort((a, b) => a.timelineStartSec - b.timelineStartSec)
    const index = ordered.findIndex((item) => item.id === clip.id) + 1
    const name = mediaPool.find((item) => item.id === clip.mediaId)?.name ?? null
    return (
      <>
        <ClipLocateButton startSec={clip.timelineStartSec} endSec={clip.timelineEndSec} />
        <AudioClipInspector clip={clip} mediaName={name} index={index} total={ordered.length} fps={fps} />
      </>
    )
  }

  if (selectionKind !== 'media') {
    // v11：时间轴缝隙上的转场图标选中时，右侧整块换成转场检查器（时长 / 删除）
    if (selectionKind === 'transition') return <TransitionInspector />
    // M7：文本元素选中时换成文本元素编辑器（与包装字幕条是两套体系）
    if (selectionKind === 'text') return <TextElementInspector />
    return <SubtitleClipInspector />
  }

  const clip = mediaClips.find((item) => item.id === selectedMediaClipId) ?? null
  if (!clip) {
    return (
      <div className="inspector">
        <p className="inspector__empty">{TEXT.videoEditor.noneSelected}</p>
      </div>
    )
  }

  // 序号按时间轴顺序给（与媒体轨上从左到右一致）
  const ordered = [...mediaClips].sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const index = ordered.findIndex((item) => item.id === clip.id) + 1
  const name = mediaPool.find((item) => item.id === clip.mediaId)?.name ?? null

  return (
    <>
      <ClipLocateButton startSec={clip.timelineStartSec} endSec={clip.timelineEndSec} />
      <MediaClipInspector clip={clip} mediaName={name} index={index} total={ordered.length} fps={fps} />
    </>
  )
}

/**
 * 字幕检查器（右侧栏）——选中驱动：时间轴点选或预览里点字幕条都会落到同一个 `selectedClipId`，
 * 因此这里显示的永远是「你正在看 / 刚点中的那一条」，修改只写回该片段的
 * `styleOverrides` / `content` / `animation` / `fontId`，不影响其他片段。
 *
 * 基础模式只保留高频入口；配色 / 字体 / 动画收进展开器。底部的
 * 「应用到全部」是唯一跨片段的操作（跳过文字与入出点），「恢复预设默认」只作用于本条。
 */
function SubtitleClipInspector(): ReactElement {
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

      {clip ? <ClipLocateButton startSec={clip.startTime} endSec={clip.endTime} /> : null}

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
          {clip ? (
            <Expander title={TEXT.keyframes.title}>
              <KeyframePanel clip={clip} />
            </Expander>
          ) : null}
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
