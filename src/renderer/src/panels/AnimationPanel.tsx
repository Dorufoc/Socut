import type { ReactElement } from 'react'
import { MAX_ANIMATION_SEC } from '@shared/constants'
import { EASING_KEYS, EASING_LABELS } from '@shared/easing'
import { durationSecToFrames, framesToDurationSec } from '@shared/fps'
import { TEXT } from '@shared/i18n'
import type { EasingKey } from '@shared/types'
import { selectedClip, useProjectStore } from '../state/projectStore'
import { useRevealClip } from '../hooks/useRevealClip'

/**
 * 动画节奏面板（规格 §7）。
 * 时长以秒为准存储与编辑，跨帧率观感稳定；面板写入时吸附到当前帧率的帧边界，
 * 因此 1s 默认值在 24/30/60fps 自动展开为 24/30/60 帧，23.976 也能落在 24 帧。
 * 上限不再固定为 30 帧，而是按 MAX_ANIMATION_SEC（秒）随帧率伸缩。
 */

export function AnimationPanel(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const fps = useProjectStore((state) => state.project.fps)
  const updateClip = useProjectStore((state) => state.updateClip)
  const reveal = useRevealClip()
  if (!clip) {
    return <p className="hint">未选择片段。</p>
  }

  /** 节奏类参数写回后把播放头带到「看得见这个节奏」的帧（入场完成后第一帧） */
  const patch = (next: Parameters<typeof updateClip>[1]): void => {
    updateClip(clip.id, next)
    reveal(clip.id)
  }

  // 1 帧对应的秒数：既作为 <input step>，也作为最小值，避免写入不足一帧的时长
  const frameSec = framesToDurationSec(1, fps)
  const inFrames = durationSecToFrames(clip.animation.inDuration, fps)
  const outFrames = durationSecToFrames(clip.animation.outDuration, fps)
  /** 区间限制不占版面，只在 hover 时给（min/max 本身已由 input 强制） */
  const rangeHint = `最短 ${Number(frameSec.toFixed(4))}s · 最长 ${MAX_ANIMATION_SEC}s`

  const setSeconds = (key: 'inDuration' | 'outDuration', sec: number): void => {
    if (!Number.isFinite(sec)) return
    const clamped = Math.max(frameSec, Math.min(MAX_ANIMATION_SEC, sec))
    // 吸附到当前帧率的整帧：秒→帧→秒，UI 与工程文件都保持帧边界一致
    const snapped = framesToDurationSec(durationSecToFrames(clamped, fps), fps)
    patch({ animation: { ...clip.animation, [key]: snapped } })
  }

  const inValue = Number(clip.animation.inDuration.toFixed(4))
  const outValue = Number(clip.animation.outDuration.toFixed(4))

  return (
    <div className="stack">
      <div className="anim-grid">
        <label className="field">
          <span className="field__label">{TEXT.inspector.inDuration}</span>
          <input
            className="input mono"
            type="number"
            min={Number(frameSec.toFixed(4))}
            max={MAX_ANIMATION_SEC}
            step={Number(frameSec.toFixed(4))}
            value={inValue}
            title={rangeHint}
            onChange={(event) => setSeconds('inDuration', Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">{TEXT.inspector.outDuration}</span>
          <input
            className="input mono"
            type="number"
            min={Number(frameSec.toFixed(4))}
            max={MAX_ANIMATION_SEC}
            step={Number(frameSec.toFixed(4))}
            value={outValue}
            title={rangeHint}
            onChange={(event) => setSeconds('outDuration', Number(event.target.value))}
          />
        </label>
      </div>

      {/* 入出场比例一目了然，避免用户把出场调得比入场还短却看不出问题 */}
      <div className="anim-meter" aria-hidden="true">
        <span className="anim-meter__in" style={{ flexGrow: inFrames }} />
        <span className="anim-meter__out" style={{ flexGrow: outFrames }} />
      </div>
      <p className="hint mono">
        入场 {inFrames} 帧 · 出场 {outFrames} 帧
      </p>

      <label className="field">
        <span className="field__label">{TEXT.inspector.easing}</span>
        <select
          className="select"
          value={clip.animation.easing}
          onChange={(event) =>
            patch({ animation: { ...clip.animation, easing: event.target.value as EasingKey } })
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
            patch({
              animation: { ...clip.animation, textRevealFrames: Math.max(1, Number(event.target.value)) }
            })
          }
        />
      </label>

      <label className="switch">
        <input
          type="checkbox"
          checked={clip.styleOverrides.compact === true}
          onChange={(event) => patch({ styleOverrides: { compact: event.target.checked } })}
        />
        <span>强制竖屏紧凑分支</span>
      </label>
    </div>
  )
}
