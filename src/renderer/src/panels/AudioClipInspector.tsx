import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import { clipAudioEdited, clipTimelineDurationSec } from '@shared/mediaClipAudio'
import type { AudioClip, ClipAudio, ClipSpeed, Fps } from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { ClipAudioSection, ClipSpeedSection } from './ClipFxSections'

/**
 * 右侧「音频片段」编辑器（v9）：选中音频段时替换字幕/视频检查器。
 *
 * 与视频编辑器**共用同一组分区**（`ClipFxSections`），只少了画面相关的四段：
 * 缩放 / 旋转 / 镜像 / 色彩对一条声音没有意义，所以这里根本不渲染它们，
 * 而不是渲染出来再禁用（需求：音频模式下隐藏画面参数）。
 */
export interface AudioClipInspectorProps {
  clip: AudioClip
  /** 素材名；null = 素材已移出池 */
  mediaName: string | null
  /** 本条在音频轨里的序号（1 起）与总数 */
  index: number
  total: number
  fps: Fps
}

export function AudioClipInspector({ clip, mediaName, index, total, fps }: AudioClipInspectorProps): ReactElement {
  const updateAudio = useProjectStore((state) => state.updateAudioClipAudio)
  const updateSpeed = useProjectStore((state) => state.updateAudioClipSpeed)
  const resetFx = useProjectStore((state) => state.resetAudioClipFx)
  const compactTimeline = useProjectStore((state) => state.compactTimeline)
  const snapTogether = useUiStore((state) => state.timelineTools.snapTogether)
  const edited = clipAudioEdited(clip.audio, clip.speed)

  const setAudio = (patch: Partial<ClipAudio>): void => updateAudio(clip.id, patch)
  const setSpeed = (patch: Partial<ClipSpeed>): void => {
    updateSpeed(clip.id, patch)
    // 变速会改变本段在时间轴上的长度：开着主轨对齐时把媒体主轨重新摆紧
    if (snapTogether) compactTimeline()
  }

  return (
    <div className="inspector">
      <section className="inspector__head">
        <div className="inspector__heading">
          <h2 className="inspector__title">{TEXT.audioEditor.title}</h2>
          {edited ? <span className="chip chip--accent">{TEXT.audioEditor.edited}</span> : null}
        </div>
        <div className="inspector__meta">
          <span className="mono">
            {mediaName ?? TEXT.audioEditor.missingMedia} · {index} / {total}
          </span>
          <span className="mono muted">
            {secondsToTimecode(clip.timelineStartSec, fps)} → {secondsToTimecode(clip.timelineEndSec, fps)}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            disabled={!edited}
            title={TEXT.audioEditor.resetHint}
            onClick={() => resetFx(clip.id)}
          >
            {TEXT.audioEditor.reset}
          </button>
        </div>
      </section>

      <ClipAudioSection audio={clip.audio} durationSec={clipTimelineDurationSec(clip)} onChange={setAudio} />
      <ClipSpeedSection speed={clip.speed} onChange={setSpeed} />
    </div>
  )
}
