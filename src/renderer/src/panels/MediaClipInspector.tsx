import type { ChangeEvent, ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import { MEDIA_VIDEO_RANGE, defaultMediaVideo, isDefaultMediaVideo } from '@shared/mediaClipVideo'
import type { MediaClip, MediaClipVideo } from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { CurveEditor } from './CurveEditor'

/**
 * 右侧「视频片段」编辑器（v6）：选中媒体段时替换字幕检查器。
 *
 * 三段式布局（几何变换 / 画面翻转 / 色彩与光影）：
 * - 每个参数都是**相对默认值的增量**（100% / 0 / false / 直线），全部默认时 `video` 整键删除，
 *   工程里不会留下一堆零值；
 * - 控件只写 store，**不在这里做任何换算**：百分比 / 角度 / -100..100 的语义与预览样式
 *   统一在 `shared/mediaClipVideo` 里定义，导出接同一条滤镜链时不会再出现两套口径；
 * - 预览里的「交互」开关与这里的滑杆是同一组字段：拖手柄与拉滑杆都会实时同步到对方。
 */

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** 数值后缀，如 % / ° */
  unit?: string
  title?: string
  onChange: (value: number) => void
}

function Slider({ label, value, min, max, step = 1, unit = '', title, onChange }: SliderProps): ReactElement {
  return (
    <div className="slider-row">
      <span className="muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        title={title}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
      />
      <span className="mono slider-row__value">
        {Math.round(value * 10) / 10}
        {unit}
      </span>
    </div>
  )
}

export interface MediaClipInspectorProps {
  clip: MediaClip
  /** 素材名；null = 素材已移出池 */
  mediaName: string | null
  /** 本条在媒体轨里的序号（1 起）与总数 */
  index: number
  total: number
  fps: { num: number; den: number }
}

export function MediaClipInspector({ clip, mediaName, index, total, fps }: MediaClipInspectorProps): ReactElement {
  const updateVideo = useProjectStore((state) => state.updateMediaClipVideo)
  const resetVideo = useProjectStore((state) => state.resetMediaClipVideo)
  const stageInteract = useUiStore((state) => state.stageInteract)
  const toggleStageInteract = useUiStore((state) => state.toggleStageInteract)
  const video = clip.video ?? defaultMediaVideo()
  const edited = !isDefaultMediaVideo(clip.video)

  const set = (patch: Partial<MediaClipVideo>): void => updateVideo(clip.id, patch)

  return (
    <div className="inspector">
      <section className="inspector__head">
        <div className="inspector__heading">
          <h2 className="inspector__title">{TEXT.videoEditor.title}</h2>
          {edited ? <span className="chip chip--accent">{TEXT.videoEditor.edited}</span> : null}
        </div>
        <div className="inspector__meta">
          <span className="mono">
            {mediaName ?? TEXT.videoEditor.missingMedia} · {index} / {total}
          </span>
          <span className="mono muted">
            {secondsToTimecode(clip.timelineStartSec, fps)} → {secondsToTimecode(clip.timelineEndSec, fps)}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={`btn btn--sm${stageInteract ? ' btn--primary' : ''}`}
            aria-pressed={stageInteract}
            title={TEXT.videoEditor.interactHint}
            onClick={toggleStageInteract}
          >
            {TEXT.videoEditor.interact}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            disabled={!edited}
            title={TEXT.videoEditor.resetHint}
            onClick={() => resetVideo(clip.id)}
          >
            {TEXT.videoEditor.reset}
          </button>
        </div>
      </section>

      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.videoEditor.geometry}</span>
        </div>
        <Slider
          label={TEXT.videoEditor.scale}
          value={video.scalePercent}
          min={MEDIA_VIDEO_RANGE.scale.min}
          max={MEDIA_VIDEO_RANGE.scale.max}
          unit="%"
          title={TEXT.videoEditor.interactHint}
          onChange={(value) => set({ scalePercent: value })}
        />
        <Slider
          label={TEXT.videoEditor.offsetX}
          value={video.offsetXPercent}
          min={MEDIA_VIDEO_RANGE.offset.min}
          max={MEDIA_VIDEO_RANGE.offset.max}
          unit="%"
          onChange={(value) => set({ offsetXPercent: value })}
        />
        <Slider
          label={TEXT.videoEditor.offsetY}
          value={video.offsetYPercent}
          min={MEDIA_VIDEO_RANGE.offset.min}
          max={MEDIA_VIDEO_RANGE.offset.max}
          unit="%"
          onChange={(value) => set({ offsetYPercent: value })}
        />
        <Slider
          label={TEXT.videoEditor.rotation}
          value={video.rotationDeg}
          min={MEDIA_VIDEO_RANGE.rotation.min}
          max={MEDIA_VIDEO_RANGE.rotation.max}
          unit="°"
          onChange={(value) => set({ rotationDeg: value })}
        />
      </section>

      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.videoEditor.flip}</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={`btn btn--sm${video.flipH ? ' btn--primary' : ''}`}
            aria-pressed={video.flipH}
            onClick={() => set({ flipH: !video.flipH })}
          >
            {TEXT.videoEditor.flipH}
          </button>
          <button
            type="button"
            className={`btn btn--sm${video.flipV ? ' btn--primary' : ''}`}
            aria-pressed={video.flipV}
            onClick={() => set({ flipV: !video.flipV })}
          >
            {TEXT.videoEditor.flipV}
          </button>
        </div>
      </section>

      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.videoEditor.grade}</span>
        </div>

        <div className="facet-label">{TEXT.videoEditor.basics}</div>
        <Slider
          label={TEXT.videoEditor.brightness}
          value={video.brightness}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          onChange={(value) => set({ brightness: value })}
        />
        <Slider
          label={TEXT.videoEditor.exposure}
          value={video.exposure}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          onChange={(value) => set({ exposure: value })}
        />

        <div className="facet-label">{TEXT.videoEditor.colorGroup}</div>
        <Slider
          label={TEXT.videoEditor.contrast}
          value={video.contrast}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          onChange={(value) => set({ contrast: value })}
        />
        <Slider
          label={TEXT.videoEditor.saturation}
          value={video.saturation}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          onChange={(value) => set({ saturation: value })}
        />
        <Slider
          label={TEXT.videoEditor.warmth}
          value={video.warmth}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          onChange={(value) => set({ warmth: value })}
        />
        <Slider
          label={TEXT.videoEditor.vibrance}
          value={video.vibrance}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          title={TEXT.videoEditor.vibranceHint}
          onChange={(value) => set({ vibrance: value })}
        />

        <div className="facet-label">{TEXT.videoEditor.curves}</div>
        <CurveEditor curves={video.curves} onChange={(curves) => set({ curves })} />
      </section>
    </div>
  )
}
