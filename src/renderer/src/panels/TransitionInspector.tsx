import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import { durationSecToFrames, frameIntervalSec } from '@shared/fps'
import { TRANSITION_DURATION } from '@shared/constants'
import {
  TRANSITION_MAP,
  previousMediaClipOnTrack,
  resolveTransitionDuration,
  transitionMaxDurationSec,
  transitionMediaMetaOf
} from '@shared/transitions'
import { useProjectStore } from '../state/projectStore'
import { Slider } from './Slider'

/**
 * 右侧「转场」检查器（v11）。
 *
 * 只负责选中转场的参数：类型（只读，样式由左侧 Tab 拖拽/点选决定）、
 * 时长、删除按钮。选中态来自 `selectedTransitionClipId`（= 切点右侧片段）。
 *
 * Delete/退格键的删除在 `useDeleteSelected`（工程 store 的 removeSelected）里统一处理，
 * 面板上的删除按钮走同一条 `setMediaClipTransition(id, null)`，两条路径结果一致。
 */
export function TransitionInspector(): ReactElement {
  const selectedTransitionClipId = useProjectStore((state) => state.selectedTransitionClipId)
  const project = useProjectStore((state) => state.project)
  const setMediaClipTransition = useProjectStore((state) => state.setMediaClipTransition)
  const selectMediaClip = useProjectStore((state) => state.selectMediaClip)

  const clip =
    selectedTransitionClipId === null
      ? null
      : project.mediaClips.find((item) => item.id === selectedTransitionClipId) ?? null
  const transition = clip?.transitionIn

  if (!clip || !transition) {
    return (
      <div className="inspector">
        <p className="inspector__empty">{TEXT.transition.noneSelected}</p>
      </div>
    )
  }

  const prev = previousMediaClipOnTrack(project.mediaClips, clip)
  const handleInput = {
    prev,
    clip,
    prevMeta: transitionMediaMetaOf(project, prev),
    clipMeta: transitionMediaMetaOf(project, clip),
    requestedSec: transition.durationSec,
    fps: project.fps
  }
  const maxSec = Math.min(TRANSITION_DURATION.max, transitionMaxDurationSec(handleInput))
  /**
   * 手柄变化后当前时长可能已经超限：滑杆上限跟着「实际可用值」走，避免拖到无效区；
   * 同时把当前值本身纳入上限，防止「值 > max」的受控 range 输入框显示异常。
   */
  const sliderMax = Math.max(
    TRANSITION_DURATION.min,
    Math.min(maxSec, TRANSITION_DURATION.max),
    Math.min(transition.durationSec, TRANSITION_DURATION.max)
  )
  const resolution = resolveTransitionDuration(handleInput)
  const meta = TRANSITION_MAP[transition.type]
  const frames = durationSecToFrames(transition.durationSec, project.fps, 0)

  const changeDuration = (value: number): void => {
    setMediaClipTransition(clip.id, { type: transition.type, durationSec: value })
  }

  const removeTransition = (): void => {
    setMediaClipTransition(clip.id, null)
    // 删除后把右侧面板交还给片段本身，不留下一个空转场面板
    selectMediaClip(clip.id)
  }

  return (
    <div className="inspector">
      <section className="inspector__head">
        <div className="inspector__heading">
          <h2 className="inspector__title">{TEXT.transition.inspectorTitle}</h2>
          <span className="chip chip--accent">{meta.label}</span>
        </div>
        <div className="inspector__meta">
          <span className="mono">{TEXT.transition.cutPoint(secondsToTimecode(clip.timelineStartSec, project.fps))}</span>
          <span className="mono muted">{TEXT.transition.maxDuration(maxSec.toFixed(2))}</span>
        </div>
      </section>

      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.transition.durationGroup}</span>
          <span className="chip mono">{TEXT.transition.frames(frames)}</span>
        </div>
        <Slider
          label={TEXT.transition.duration}
          value={transition.durationSec}
          min={TRANSITION_DURATION.min}
          max={sliderMax}
          step={frameIntervalSec(project.fps)}
          unit="s"
          format={(value) => value.toFixed(2)}
          title={TEXT.transition.maxDuration(maxSec.toFixed(2))}
          onChange={changeDuration}
        />
        {resolution.ok ? (
          <span className="muted mono">{TEXT.transition.maxDuration(maxSec.toFixed(2))}</span>
        ) : (
          <span className="chip chip--warn">{TEXT.transition.tooShort}</span>
        )}
        <button type="button" className="btn btn--block btn--danger" onClick={removeTransition}>
          {TEXT.transition.remove}
        </button>
      </section>

      <span className="muted">{TEXT.transition.hint}</span>
      <span className="muted">{TEXT.transition.deleteKeyHint}</span>
    </div>
  )
}
