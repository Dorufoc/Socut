import type { ReactElement } from 'react'
import { EASING_KEYS, EASING_LABELS } from '@shared/easing'
import { durationSecToFrames, framesToDurationSec } from '@shared/fps'
import { TEXT } from '@shared/i18n'
import type { EasingKey } from '@shared/types'
import { selectedClip, useProjectStore } from '../state/projectStore'

/**
 * 动画节奏面板（规格 §7）。
 * 时长以秒存储（跨帧率观感稳定），UI 以「帧 @ 当前 fps」编辑并吸附（规格 §4.6 / §11）。
 */

export function AnimationPanel(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const fps = useProjectStore((state) => state.project.fps)
  const updateClip = useProjectStore((state) => state.updateClip)
  if (!clip) {
    return <p className="hint">未选择片段。</p>
  }

  const inFrames = durationSecToFrames(clip.animation.inDuration, fps)
  const outFrames = durationSecToFrames(clip.animation.outDuration, fps)
  const ratio = outFrames / Math.max(1, inFrames)

  const setFrames = (key: 'inDuration' | 'outDuration', frames: number): void => {
    updateClip(clip.id, {
      animation: { ...clip.animation, [key]: framesToDurationSec(Math.max(1, frames), fps) }
    })
  }

  return (
    <div className="stack">
      <div className="anim-grid">
        <label className="field">
          <span className="field__label">{TEXT.inspector.inDuration}</span>
          <input
            className="input mono"
            type="number"
            min={1}
            max={30}
            value={inFrames}
            onChange={(event) => setFrames('inDuration', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">{TEXT.inspector.outDuration}</span>
          <input
            className="input mono"
            type="number"
            min={1}
            max={30}
            value={outFrames}
            onChange={(event) => setFrames('outDuration', Number(event.target.value))}
          />
        </label>
      </div>

      {/* 入出场比例一目了然，避免用户把出场调得比入场还短却看不出问题 */}
      <div className="anim-meter" aria-hidden="true">
        <span className="anim-meter__in" style={{ flexGrow: inFrames }} />
        <span className="anim-meter__out" style={{ flexGrow: outFrames }} />
      </div>
      <p className="hint mono">
        入场 {inFrames} 帧（{clip.animation.inDuration.toFixed(3)}s）· 出场 {outFrames} 帧（
        {clip.animation.outDuration.toFixed(3)}s）· 比 {ratio.toFixed(2)}
      </p>

      <label className="field">
        <span className="field__label">{TEXT.inspector.easing}</span>
        <select
          className="select"
          value={clip.animation.easing}
          onChange={(event) =>
            updateClip(clip.id, { animation: { ...clip.animation, easing: event.target.value as EasingKey } })
          }
        >
          {EASING_KEYS.map((key) => (
            <option key={key} value={key}>
              {EASING_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{TEXT.inspector.textReveal}</span>
        <input
          className="input mono"
          type="number"
          min={1}
          max={6}
          value={clip.animation.textRevealFrames}
          onChange={(event) =>
            updateClip(clip.id, {
              animation: { ...clip.animation, textRevealFrames: Math.max(1, Number(event.target.value)) }
            })
          }
        />
      </label>

      <label className="switch">
        <input
          type="checkbox"
          checked={clip.styleOverrides.compact === true}
          onChange={(event) => updateClip(clip.id, { styleOverrides: { compact: event.target.checked } })}
        />
        <span>强制竖屏紧凑分支</span>
      </label>
    </div>
  )
}
