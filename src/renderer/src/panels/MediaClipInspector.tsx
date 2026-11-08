import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import { durationSecToFrames, frameIntervalSec } from '@shared/fps'
import { TRANSITION_DURATION } from '@shared/constants'
import { MEDIA_VIDEO_RANGE, defaultMediaVideo, isDefaultMediaVideo } from '@shared/mediaClipVideo'
import { clipAudioEdited, clipTimelineDurationSec } from '@shared/mediaClipAudio'
import { STAB_LEVELS, stabProxyTimeOf } from '@shared/mediaStab'
import {
  DEFAULT_TRANSITION_DURATION_SEC,
  TRANSITION_MAP,
  isTransitionAdjacent,
  previousMediaClipOnTrack,
  resolveTransitionDuration,
  transitionMaxDurationSec,
  transitionMediaMetaOf,
  transitionsByFamily,
  type TransitionBlockReason
} from '@shared/transitions'
import type {
  ClipAudio,
  ClipSpeed,
  Fps,
  MediaClip,
  MediaClipStab,
  MediaClipVideo,
  StabLevel,
  TransitionType
} from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { useExportStore } from '../state/exportStore'
import { stabSignatureFor, useStabPreviewStore } from '../state/stabPreviewStore'
import { CurveEditor } from './CurveEditor'
import { Slider } from './Slider'
import { ClipAudioSection, ClipSpeedSection } from './ClipFxSections'

/**
 * 右侧「视频片段」编辑器（v6）：选中媒体段时替换字幕检查器。
 *
 * 六段式布局（几何变换 / 画面翻转 / 色彩与光影 / 音频 / 变速 / 防抖稳定）：
 * - 每个参数都是**相对默认值的增量**（100% / 0 / false / 直线），全部默认时对应整键删除，
 *   工程里不会留下一堆零值；
 * - 控件只写 store，**不在这里做任何换算**：百分比 / 角度 / -100..100 / 音量% / 倍速的语义
 *   统一在 `shared/mediaClipVideo`、`shared/mediaClipAudio`、`shared/mediaStab` 里定义，
 *   预览与导出接同一条滤镜链时不会再出现两套口径；
 * - 预览里的「交互」开关与这里的滑杆是同一组字段：拖手柄与拉滑杆实时同步到对方；
 * - v8 防抖：导出逐段生效；v8.1 预览经下方「应用防抖预览」后台生成稳定化代理，就绪后 PreviewStage 改播代理。
 * - v9 变速会重算本段在时间轴上的长度（源窗口不变），开着「主轨对齐」时顺手把主轨摆紧。
 */

export interface MediaClipInspectorProps {
  clip: MediaClip
  /** 素材名；null = 素材已移出池 */
  mediaName: string | null
  /** 本条在媒体轨里的序号（1 起）与总数 */
  index: number
  total: number
  fps: { num: number; den: number }
}

/** v8：档位按钮的文案表（与 STAB_LEVELS 同序，新增档位只改这里） */
const STAB_LEVEL_LABELS: Record<StabLevel, string> = {
  low: TEXT.stab.levelLow,
  standard: TEXT.stab.levelStandard,
  high: TEXT.stab.levelHigh
}

export function MediaClipInspector({ clip, mediaName, index, total, fps }: MediaClipInspectorProps): ReactElement {
  const updateVideo = useProjectStore((state) => state.updateMediaClipVideo)
  const updateStab = useProjectStore((state) => state.updateMediaClipStab)
  const resetVideo = useProjectStore((state) => state.resetMediaClipVideo)
  const updateAudio = useProjectStore((state) => state.updateMediaClipAudio)
  const updateSpeed = useProjectStore((state) => state.updateMediaClipSpeed)
  const setTransition = useProjectStore((state) => state.setMediaClipTransition)
  const project = useProjectStore((state) => state.project)
  const compactTimeline = useProjectStore((state) => state.compactTimeline)
  const snapTogether = useUiStore((state) => state.timelineTools.snapTogether)
  const stageInteract = useUiStore((state) => state.stageInteract)
  const toggleStageInteract = useUiStore((state) => state.toggleStageInteract)
  const video = clip.video ?? defaultMediaVideo()
  const stab = clip.stab
  const stabOn = stab?.enabled === true
  const edited = !isDefaultMediaVideo(clip.video) || stabOn || clipAudioEdited(clip.audio, clip.speed)

  // v10：入场转场——前段/空隙/手柄不足时只给原因，不渲染可写入口
  const transitionPrev = previousMediaClipOnTrack(project.mediaClips, clip)
  const transitionInput = {
    prev: transitionPrev,
    clip,
    prevMeta: transitionMediaMetaOf(project, transitionPrev),
    clipMeta: transitionMediaMetaOf(project, clip),
    requestedSec: clip.transitionIn?.durationSec ?? DEFAULT_TRANSITION_DURATION_SEC,
    fps
  }
  const transitionResolution = resolveTransitionDuration(transitionInput)
  const transitionFirst = transitionPrev === null
  const transitionHasGap = transitionPrev !== null && !isTransitionAdjacent(transitionPrev, clip, fps)
  const transitionAvailableSec = transitionMaxDurationSec(transitionInput)
  const transitionType = clip.transitionIn?.type
  const transitionDurationSec = clip.transitionIn?.durationSec ?? transitionResolution.durationSec

  const transitionBlockText = (reason: TransitionBlockReason): string => {
    if (reason === 'no-tail') return TEXT.transition.noTail
    if (reason === 'no-head') return TEXT.transition.noHead
    if (reason === 'no-type') return TEXT.transition.noType
    return TEXT.transition.tooShort
  }

  /** 选类型：沿用当前时长（没有时用解析出的默认值；store 会再按手柄夹一次） */
  const chooseTransitionType = (type: TransitionType): void => {
    setTransition(clip.id, {
      type,
      durationSec: clip.transitionIn?.durationSec ?? (transitionResolution.ok ? transitionResolution.durationSec : DEFAULT_TRANSITION_DURATION_SEC)
    })
  }

  /** 改时长：先在面板侧解析（首段/空隙/手柄不足不写），再由 store 归一落盘 */
  const changeTransitionDuration = (raw: string): void => {
    const type = clip.transitionIn?.type
    if (!type) return
    const requested = Number(raw)
    if (!Number.isFinite(requested)) return
    const resolved = resolveTransitionDuration({ ...transitionInput, requestedSec: requested })
    if (!resolved.ok) return
    setTransition(clip.id, { type, durationSec: resolved.durationSec })
  }

  // v8.1：防抖预览代理——当前签名与记账一致才算「已就绪」；参数一动自动回落原片。
  const mediaItem = useProjectStore((state) => state.project.media.find((m) => m.id === clip.mediaId) ?? null)
  const projectFps = useProjectStore((state) => state.project.fps)
  const appliedPreview = useStabPreviewStore((state) => state.applied[clip.id])
  const previewError = useStabPreviewStore((state) => state.errors[clip.id])
  const stabJobId = `stab-${clip.id}`
  const stabJob = useExportStore((state) => state.jobs[stabJobId])
  const stabJobActive =
    stabJob !== undefined && stabJob.phase !== 'done' && stabJob.phase !== 'failed' && stabJob.phase !== 'cancelled'
  const currentStabSignature =
    stabOn && mediaItem
      ? stabSignatureFor({
          clip,
          stab: stab as MediaClipStab,
          sourcePath: mediaItem.path,
          fps: projectFps as Fps,
          hasAudio: typeof mediaItem.meta.audioCodec === 'string' && mediaItem.meta.audioCodec.length > 0
        })
      : ''
  const previewFresh = stabOn && appliedPreview !== undefined && appliedPreview.signature === currentStabSignature
  const previewStale = stabOn && appliedPreview !== undefined && !previewFresh
  const proxyDuration = stabProxyTimeOf(clip.sourceOutSec, clip.sourceInSec, clip.sourceOutSec)

  const set = (patch: Partial<MediaClipVideo>): void => updateVideo(clip.id, patch)
  const setStab = (patch: Partial<MediaClipStab>): void => {
    updateStab(clip.id, patch)
    // 关掉防抖：代理对它不再有语义，连磁盘缓存一起回收
    if (patch.enabled === false) useStabPreviewStore.getState().clearForClip(clip.id, true)
  }
  const applyPreview = (): void => {
    if (!mediaItem || !stab) return
    void useStabPreviewStore
      .getState()
      .apply({
        clip,
        stab: stab as MediaClipStab,
        sourcePath: mediaItem.path,
        fps: projectFps as Fps,
        hasAudio: typeof mediaItem.meta.audioCodec === 'string' && mediaItem.meta.audioCodec.length > 0
      })
      .catch(() => undefined)
  }
  const setAudio = (patch: Partial<ClipAudio>): void => updateAudio(clip.id, patch)
  /** 变速会改变本段在时间轴上的长度：开着主轨对齐时顺手把后面的段摆紧（与拖拽收尾同一规则） */
  const setSpeed = (patch: Partial<ClipSpeed>): void => {
    updateSpeed(clip.id, patch)
    if (snapTogether) compactTimeline()
  }

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
          <span className="group__title">{TEXT.transition.title}</span>
          {transitionType ? (
            <span className="chip chip--accent">{TRANSITION_MAP[transitionType].label}</span>
          ) : null}
        </div>
        {transitionFirst ? (
          <span className="muted">{TEXT.transition.first}</span>
        ) : transitionHasGap ? (
          <span className="muted">{TEXT.transition.gap}</span>
        ) : !transitionResolution.ok ? (
          <>
            <span className="chip chip--warn">{transitionBlockText(transitionResolution.reason)}</span>
            <span className="muted">{TEXT.transition.insufficient(transitionAvailableSec.toFixed(2))}</span>
          </>
        ) : (
          <>
            {transitionsByFamily().map((group) => (
              <div key={group.family} className="transition-family">
                <div className="facet-label">{group.label}</div>
                <div className="transition-grid" role="group" aria-label={group.label}>
                  {group.transitions.map((meta) => (
                    <button
                      key={meta.type}
                      type="button"
                      className={`btn btn--sm${transitionType === meta.type ? ' btn--primary' : ''}`}
                      aria-pressed={transitionType === meta.type}
                      onClick={() => chooseTransitionType(meta.type)}
                    >
                      {meta.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {clip.transitionIn ? (
              <div className="row transition-duration-row">
                <input
                  className="transition-duration"
                  type="number"
                  aria-label={TEXT.transition.duration}
                  min={TRANSITION_DURATION.min}
                  max={TRANSITION_DURATION.max}
                  step={frameIntervalSec(fps)}
                  value={transitionDurationSec}
                  onChange={(event) => changeTransitionDuration(event.target.value)}
                />
                <span className="muted mono">{TEXT.transition.frames(durationSecToFrames(transitionDurationSec, fps, 0))}</span>
                <button
                  type="button"
                  className="btn btn--sm btn--subtle"
                  onClick={() => setTransition(clip.id, null)}
                >
                  {TEXT.transition.remove}
                </button>
              </div>
            ) : null}
          </>
        )}
        <span className="muted">{TEXT.transition.hint}</span>
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

      {/* v9：音频与变速（与音频片段编辑器共用同一组控件） */}
      <ClipAudioSection
        audio={clip.audio}
        durationSec={clipTimelineDurationSec(clip)}
        onChange={setAudio}
      />
      <ClipSpeedSection speed={clip.speed} onChange={setSpeed} />

      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.stab.title}</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={`btn btn--sm${stabOn ? ' btn--primary' : ''}`}
            aria-pressed={stabOn}
            title={TEXT.stab.hint}
            onClick={() => setStab({ enabled: !stabOn })}
          >
            {stabOn ? TEXT.stab.on : TEXT.stab.off}
          </button>
        </div>
        {stabOn ? (
          <>
            <div className="facet-label">{TEXT.stab.levelLabel}</div>
            <div className="row" style={{ gap: 6 }}>
              {STAB_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`btn btn--sm${(stab?.level ?? 'standard') === level ? ' btn--primary' : ''}`}
                  aria-pressed={(stab?.level ?? 'standard') === level}
                  title={TEXT.stab.levelHint}
                  onClick={() => setStab({ level })}
                >
                  {STAB_LEVEL_LABELS[level]}
                </button>
              ))}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className={`btn btn--sm${stab?.tripod === true ? ' btn--primary' : ''}`}
                aria-pressed={stab?.tripod === true}
                title={TEXT.stab.tripodHint}
                onClick={() => setStab({ tripod: !(stab?.tripod === true) })}
              >
                {TEXT.stab.tripod}
              </button>
            </div>
            {/* v8.1：预览代理——后台两段式作业，进度显示在任务队列，就绪后预览直接播代理 */}
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn btn--sm"
                disabled={mediaItem === null || stabJobActive}
                title={mediaItem === null ? TEXT.stab.sourceMissing('') : TEXT.stab.hint}
                onClick={applyPreview}
              >
                {previewFresh ? TEXT.stab.previewApplied : previewStale ? TEXT.stab.previewReapply : TEXT.stab.previewApply}
              </button>
              {stabJobActive ? (
                <button type="button" className="btn btn--sm" title={TEXT.stab.previewCancel} onClick={() => void window.socut.export.cancel(stabJobId)}>
                  ✕
                </button>
              ) : null}
            </div>
            {stabJobActive ? (
              <span className="muted">
                {TEXT.stab.previewApplying} {Math.round((stabJob?.percent ?? 0) * 100)}%
              </span>
            ) : previewFresh ? (
              <span className="muted">{TEXT.stab.previewApplied} · {proxyDuration.toFixed(1)}s</span>
            ) : previewStale ? (
              <span className="muted">{TEXT.stab.previewStale}</span>
            ) : null}
            {previewError ? <span className="chip chip--warn">{previewError}</span> : null}
          </>
        ) : (
          <span className="muted">{TEXT.stab.hint}</span>
        )}
      </section>
    </div>
  )
}
