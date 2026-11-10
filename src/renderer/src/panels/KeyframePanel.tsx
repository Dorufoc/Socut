import { type ChangeEvent, type ReactElement } from 'react'
import { DEFAULT_BEZIER, type BezierTuple } from '@shared/bezier'
import { BezierEditor } from './BezierEditor'
import { EASING_KEYS, EASING_LABELS } from '@shared/easing'
import { TEXT } from '@shared/i18n'
import {
  CLIP_PARAM_IDS,
  CLIP_PARAM_LIMITS,
  clipProgressAt,
  keyframeValueAt,
  removeKeyframePoint,
  upsertKeyframePoint,
  type ClipParamId,
  type KeyframeEasing,
  type KeyframePoint,
  type KeyframeTrack
} from '@shared/keyframes'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { useRevealClip } from '../hooks/useRevealClip'

/**
 * M6：参数关键帧面板（右侧检查器「关键帧」展开器）。
 *
 * 交互口径：
 * - 「在播放头打点」= 用**当前求值**作为新点取值（不会因为打点瞬间参数跳变）；
 *   进度 = 播放头在片段内的百分比，吸附到 0.1%（足够细，也不会因为帧率漂移）。
 * - 点上的缓动只作用于「本点 → 下一点」这一段（与 CSS/关键帧惯例一致）。
 * - 每个参数的轨道是独立的；清空某参数不影响其它参数。
 * - 每次写入都过 store 的归一函数（归一 + 无效值夹取 + 撤销一步 + 自动存档），
 *   UI 不自己做校验，避免"面板能写进非法值"。
 *
 * M6-E：同一套面板也服务**媒体段**——媒体段传 `onCommit`（`setMediaClipKeyframes`）
 * 与 `defaults`（打点初始值取静态 video 参数，而不是通用默认值）。
 */

/** 面板只要求"能被关键帧化的片段"最小形状（字幕条 / 文本元素 / 媒体段通用）。 */
export interface KeyframeTarget {
  id: string
  startTime: number
  endTime: number
  keyframes?: readonly KeyframeTrack[]
}

export interface KeyframePanelProps {
  clip: KeyframeTarget
  /** 提交关键帧（缺省 = 字幕条 `setClipKeyframes`） */
  onCommit?: (id: string, keyframes: KeyframeTrack[] | undefined) => void
  /** 新关键点的初始值（缺省取参数默认值；媒体段传静态 video 值） */
  defaults?: Partial<Record<ClipParamId, number>>
}

function roundPercent(progress: number): number {
  return Math.round(progress * 1000) / 1000
}

export function KeyframePanel({ clip, onCommit, defaults }: KeyframePanelProps): ReactElement {
  const setClipKeyframes = useProjectStore((state) => state.setClipKeyframes)
  const displayTimeSec = useUiStore((state) => state.displayTimeSec)
  const reveal = useRevealClip()
  const tracks = clip.keyframes ?? []
  const progress = roundPercent(clipProgressAt(displayTimeSec, clip.startTime, clip.endTime))

  const commit = (next: readonly KeyframeTrack[]): void => {
    const payload = next.length > 0 ? [...next] : undefined
    if (onCommit) onCommit(clip.id, payload)
    else setClipKeyframes(clip.id, payload)
    reveal(clip.id)
  }

  const trackOf = (param: ClipParamId): KeyframeTrack | undefined =>
    tracks.find((track) => track.param === param)

  const replacePoints = (param: ClipParamId, points: KeyframePoint[]): KeyframeTrack[] =>
    tracks.map((track) => (track.param === param ? { ...track, points } : track))

  const addPoint = (param: ClipParamId): void => {
    const track = trackOf(param)
    const limits = CLIP_PARAM_LIMITS[param]
    // 媒体段没有轨道时用静态 video 值打点（否则"打点即跳到 100%"）
    const value = track ? keyframeValueAt(track, progress) : (defaults?.[param] ?? limits.defaultValue)
    commit(upsertKeyframePoint(tracks, param, { t: progress, value, easing: 'linear' }))
  }

  const clearTrack = (param: ClipParamId): void => {
    commit(tracks.filter((track) => track.param !== param))
  }

  const deletePoint = (param: ClipParamId, index: number): void => {
    commit(removeKeyframePoint(tracks, param, index))
  }

  const editPoint = (param: ClipParamId, index: number, patch: Partial<KeyframePoint>): void => {
    const track = trackOf(param)
    if (!track) return
    const points = track.points.map((point, pointIndex) => (pointIndex === index ? { ...point, ...patch } : point))
    commit(replacePoints(param, points))
  }

  const setEasing = (param: ClipParamId, index: number, easing: KeyframeEasing): void => {
    if (easing === 'custom') {
      editPoint(param, index, { easing: 'custom', bezier: DEFAULT_BEZIER })
      return
    }
    const track = trackOf(param)
    const current = track?.points[index]
    if (!current) return
    // 切回具名缓动时丢掉贝塞尔，避免 JSON 里留下"看起来像自定义"的残余
    const { bezier: _bezier, ...rest } = current
    const points = track.points.map((point, pointIndex) =>
      pointIndex === index ? ({ ...rest, easing } as KeyframePoint) : point
    )
    commit(replacePoints(param, points))
  }

  const setBezierComponent = (param: ClipParamId, index: number, component: number, value: number): void => {
    const track = trackOf(param)
    const current = track?.points[index]
    if (!current) return
    const base: BezierTuple = current.bezier ?? DEFAULT_BEZIER
    const next = [...base] as [number, number, number, number]
    next[component] = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : (base[component] ?? 0)
    editPoint(param, index, { bezier: next as BezierTuple })
  }

  const pointValueInput = (param: ClipParamId, index: number, point: KeyframePoint): ReactElement => {
    const limits = CLIP_PARAM_LIMITS[param]
    return (
      <input
        className="input mono keyframe__value"
        type="number"
        aria-label={`${TEXT.keyframes.labels[param]} ${TEXT.keyframes.value} ${index + 1}`}
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={point.value}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          editPoint(param, index, { value: Number(event.target.value) })
        }
      />
    )
  }

  return (
    <div className="stack keyframe">
      <p className="hint">{TEXT.keyframes.hint}</p>
      <p className="hint mono">{TEXT.keyframes.playhead(Math.round(progress * 100))}</p>

      {CLIP_PARAM_IDS.map((param) => {
        const track = trackOf(param)
        return (
          <section className="keyframe__track" key={param}>
            <div className="keyframe__head">
              <span className="field__label">{TEXT.keyframes.labels[param]}</span>
              <span className="hint mono">
                {track ? TEXT.keyframes.points(track.points.length) : TEXT.keyframes.empty}
              </span>
              <button
                type="button"
                className="btn btn--sm btn--subtle"
                title={TEXT.keyframes.addPoint}
                onClick={() => addPoint(param)}
              >
                ◆ +
              </button>
              {track ? (
                <button
                  type="button"
                  className="btn btn--sm btn--subtle"
                  title={TEXT.keyframes.clearTrack}
                  onClick={() => clearTrack(param)}
                >
                  ×
                </button>
              ) : null}
            </div>

            {track
              ? track.points.map((point, index) => {
                  const custom = point.easing === 'custom'
                  const bezier = point.bezier ?? DEFAULT_BEZIER
                  return (
                    <div className="keyframe__row" key={`${param}-${index}-${point.t}`}>
                      <span className="keyframe__t mono">{Math.round(point.t * 100)}%</span>
                      {pointValueInput(param, index, point)}
                      <select
                        className="select keyframe__easing"
                        aria-label={`${TEXT.keyframes.labels[param]} ${TEXT.keyframes.easing} ${index + 1}`}
                        value={point.easing}
                        onChange={(event) => setEasing(param, index, event.target.value as KeyframeEasing)}
                      >
                        {EASING_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {EASING_LABELS[key]}
                          </option>
                        ))}
                        <option value="custom">{TEXT.keyframes.easingCustom}</option>
                      </select>
                      {custom ? (
                        <BezierEditor
                          value={bezier}
                          onChange={(next) => editPoint(param, index, { bezier: next })}
                        />
                      ) : null}
                      {custom ? (
                        <span className="keyframe__bezier" title={TEXT.keyframes.bezierHint}>
                          {bezier.map((component, componentIndex) => (
                            <input
                              key={componentIndex}
                              className="input mono keyframe__bezier-input"
                              type="number"
                              aria-label={`${TEXT.keyframes.labels[param]} bezier ${componentIndex + 1}`}
                              min={0}
                              max={1}
                              step={0.01}
                              value={component}
                              onChange={(event) =>
                                setBezierComponent(param, index, componentIndex, Number(event.target.value))
                              }
                            />
                          ))}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn--sm btn--subtle"
                        title={TEXT.keyframes.deletePoint}
                        onClick={() => deletePoint(param, index)}
                      >
                        −
                      </button>
                    </div>
                  )
                })
              : null}
          </section>
        )
      })}
    </div>
  )
}
