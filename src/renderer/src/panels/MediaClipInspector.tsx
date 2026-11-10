import { useEffect, useState, type ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import { MEDIA_VIDEO_RANGE, defaultMediaVideo, isDefaultMediaVideo } from '@shared/mediaClipVideo'
import { clipAudioEdited, clipTimelineDurationSec } from '@shared/mediaClipAudio'
import { STAB_LEVELS, stabProxyTimeOf } from '@shared/mediaStab'
import type {
  ClipAudio,
  ClipSpeed,
  Fps,
  MediaClip,
  MediaClipStab,
  MediaClipVideo,
  StabLevel
} from '@shared/types'
import { useProjectStore } from '../state/projectStore'
import { MASK_BRUSH_RANGE, useUiStore } from '../state/uiStore'
import { useExportStore } from '../state/exportStore'
import { waitForResult } from '../state/jobEvents'
import { stabSignatureFor, useStabPreviewStore } from '../state/stabPreviewStore'
import { CurveEditor } from './CurveEditor'
import { Slider, type SliderKeyframeProps } from './Slider'
import { ClipAudioSection, ClipEffectsSection, ClipKeySection, ClipSpeedSection } from './ClipFxSections'
import {
  clipProgressAt,
  keyframeValueAt,
  removeKeyframePoint,
  upsertKeyframePoint,
  type ClipParamId,
  type KeyframeTrack
} from '@shared/keyframes'

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
  const updateKey = useProjectStore((state) => state.setClipKey)
  const updateStab = useProjectStore((state) => state.updateMediaClipStab)
  const resetVideo = useProjectStore((state) => state.resetMediaClipVideo)
  const updateAudio = useProjectStore((state) => state.updateMediaClipAudio)
  const updateSpeed = useProjectStore((state) => state.updateMediaClipSpeed)
  const setMediaClipKeyframes = useProjectStore((state) => state.setMediaClipKeyframes)
  const setMediaClipMask = useProjectStore((state) => state.setMediaClipMask)
  const setMediaClipMatte = useProjectStore((state) => state.setMediaClipMatte)
  const compactTimeline = useProjectStore((state) => state.compactTimeline)
  const snapTogether = useUiStore((state) => state.timelineTools.snapTogether)
  const stageInteract = useUiStore((state) => state.stageInteract)
  const toggleStageInteract = useUiStore((state) => state.toggleStageInteract)
  // M8：手绘遮罩——画笔会话在 uiStore（预览层要读同一份状态），这里只负责入口与参数
  const maskPaint = useUiStore((state) => state.maskPaint)
  const beginMaskPaint = useUiStore((state) => state.beginMaskPaint)
  const endMaskPaint = useUiStore((state) => state.endMaskPaint)
  const setMaskBrush = useUiStore((state) => state.setMaskBrush)
  const setNotice = useUiStore((state) => state.setNotice)
  const maskStrokes = clip.mask?.strokes ?? []
  const paintingMask = maskPaint.clipId === clip.id
  const video = clip.video ?? defaultMediaVideo()
  const stab = clip.stab
  const stabOn = stab?.enabled === true
  const edited =
    !isDefaultMediaVideo(clip.video) ||
    (clip.keyframes?.length ?? 0) > 0 ||
    stabOn ||
    clipAudioEdited(clip.audio, clip.speed)

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

  // ---- 画面滑条内联关键帧（几何 + 调色，全部参数同一套交互） ----
  // 播放头 → 片段内进度（0..1），与预览/导出的求值口径一致；圆到 0.1% 让"同一位置"可判定。
  const displayTimeSec = useUiStore((state) => state.displayTimeSec)
  const progress =
    Math.round(clipProgressAt(displayTimeSec, clip.timelineStartSec, clip.timelineEndSec) * 1000) / 1000
  const keyframeTracks = clip.keyframes
  /** 判定"播放头处正好有这个点"的容差（0.1%） */
  const KEY_AT_PLAYHEAD_EPS = 1e-3

  const trackOf = (param: ClipParamId): KeyframeTrack | undefined =>
    keyframeTracks?.find((track) => track.param === param)

  /** 滑条读数：有轨道时显示该帧求值，否则显示静态值（拖动即在播放头写/改关键点）。 */
  const sliderValue = (param: ClipParamId, staticValue: number): number => {
    const track = trackOf(param)
    return track ? keyframeValueAt(track, progress) : staticValue
  }

  const commitPoint = (param: ClipParamId, value: number): void => {
    setMediaClipKeyframes(
      clip.id,
      upsertKeyframePoint(keyframeTracks, param, { t: progress, value, easing: 'linear' })
    )
  }

  /** 滑条写回：有轨道 → 在播放头打/改关键点；无轨道 → 仍写静态字段（旧行为）。 */
  const sliderChange =
    (param: ClipParamId, applyStatic: (value: number) => void) =>
    (value: number): void => {
      if (trackOf(param)) commitPoint(param, value)
      else applyStatic(value)
    }

  const toggleKeyframe = (param: ClipParamId, staticValue: number): void => {
    const track = trackOf(param)
    const index = track?.points.findIndex((point) => Math.abs(point.t - progress) < KEY_AT_PLAYHEAD_EPS) ?? -1
    if (track && index >= 0) {
      setMediaClipKeyframes(clip.id, removeKeyframePoint(keyframeTracks, param, index))
      return
    }
    // 已有轨道但当前不在点上：以该帧求值打点，避免"打点即跳变"
    commitPoint(param, track ? keyframeValueAt(track, progress) : staticValue)
  }

  const clearKeyframeTrack = (param: ClipParamId): void => {
    const next = keyframeTracks?.filter((track) => track.param !== param)
    setMediaClipKeyframes(clip.id, next && next.length > 0 ? next : undefined)
  }

  const keyframeOf = (param: ClipParamId, staticValue: number): SliderKeyframeProps => {
    const track = trackOf(param)
    return {
      active: track !== undefined && track.points.length > 0,
      atPlayhead:
        track?.points.some((point) => Math.abs(point.t - progress) < KEY_AT_PLAYHEAD_EPS) ?? false,
      onToggle: () => toggleKeyframe(param, staticValue),
      onClear: () => clearKeyframeTrack(param),
      labels: {
        add: TEXT.keyframes.addPoint,
        remove: TEXT.keyframes.deletePoint,
        clear: TEXT.keyframes.clearTrack
      }
    }
  }

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

  /**
   * M8：进入/退出遮罩画笔。
   * 进入时先暂停并把播放头跳到本段中点——画笔层只在「这段真的显示在预览里」时出现，
   * 否则用户会对着别的画面涂、却写进这一段的数据。
   */
  const toggleMaskPaint = (): void => {
    if (paintingMask) {
      endMaskPaint()
      return
    }
    const ui = useUiStore.getState()
    ui.setPlaying(false)
    ui.seekHandler?.((clip.timelineStartSec + clip.timelineEndSec) / 2)
    beginMaskPaint(clip.id)
    setNotice(TEXT.mask.enterHint)
  }

  /** 清空遮罩：整键删除（store 归一后工程 JSON 里不会留空 strokes）。 */
  const clearMask = (): void => {
    setMediaClipMask(clip.id, undefined)
    setNotice(TEXT.mask.clearHint)
  }

  /** M8-P0：外部 matte 文件名（只用于展示；真实路径由 clip.mattePath 保存）。 */
  const matteName = clip.mattePath ? (clip.mattePath.split(/[\\/]/).pop() ?? clip.mattePath) : ''

  /**
   * M8-P0：导入外部 matte（图片或视频）。
   * 预览不渲染外部 matte（与降噪/防抖同一口径：导出侧生效），所以这里必须给明确提示，
   * 避免用户以为预览会跟着变。
   */
  const importMatte = async (): Promise<void> => {
    try {
      const picked = await window.socut.media.pickMatte()
      if (!picked) return
      setMediaClipMatte(clip.id, { path: picked.path, kind: picked.kind })
      setNotice(TEXT.matte.applied(picked.name))
    } catch (error) {
      setNotice(TEXT.matte.pickFailed(error instanceof Error ? error.message : String(error)))
    }
  }

  const removeMatte = (): void => {
    setMediaClipMatte(clip.id, undefined)
    setNotice(TEXT.matte.removed)
  }

  // ---- M8-P1：AI 人像抠像（主进程 ONNX 推理，进度走 export job 事件；仅导出生效） ----
  const [aiStatus, setAiStatus] = useState<{
    ready: boolean
    runtimeOk: boolean
    modelOk: boolean
    reason: string
  } | null>(null)
  const aiJobId = `matte-${clip.id}`
  const aiJob = useExportStore((state) => state.jobs[aiJobId])
  const aiRunning =
    aiJob !== undefined &&
    aiJob.phase !== 'done' &&
    aiJob.phase !== 'failed' &&
    aiJob.phase !== 'cancelled'
  // 老版本 preload / 测试桩可能没有 aiMatte 通道：缺 API 时按「运行时未就绪」降级，不能抛异常
  const aiApi = window.socut?.aiMatte
  useEffect(() => {
    let alive = true
    if (!aiApi) {
      setAiStatus({
        ready: false,
        runtimeOk: false,
        modelOk: false,
        reason: TEXT.aiMatte.installHint
      })
      return () => {
        alive = false
      }
    }
    void aiApi
      .status()
      .then((status) => {
        if (!alive) return
        setAiStatus({
          ready: status.ready,
          runtimeOk: status.runtime.ok,
          modelOk: status.model.ok,
          reason: status.runtime.reason ?? status.model.reason ?? ''
        })
      })
      .catch((error: unknown) => {
        if (alive) {
          setAiStatus({
            ready: false,
            runtimeOk: false,
            modelOk: false,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      alive = false
    }
  }, [clip.id, aiApi])

  const generateAiMatte = async (): Promise<void> => {
    if (!mediaItem) return
    if (!aiApi) {
      setNotice(TEXT.aiMatte.failed(TEXT.aiMatte.runtimeMissing))
      return
    }
    try {
      const queued = await aiApi.generate({
        clipId: clip.id,
        sourcePath: mediaItem.path,
        sourceInSec: clip.sourceInSec,
        sourceOutSec: clip.sourceOutSec,
        fps: projectFps as Fps,
        sourceWidth: mediaItem.meta.width,
        sourceHeight: mediaItem.meta.height
      })
      let mattePath = queued.path
      if (queued.status === 'cached' && mattePath) {
        setMediaClipMatte(clip.id, { path: mattePath, kind: 'video' })
        setNotice(TEXT.aiMatte.cached)
        return
      }
      const result = await waitForResult(queued.jobId)
      if (!result.ok || !result.outputPath) {
        throw new Error(result.error?.message ?? 'AI 抠像失败')
      }
      mattePath = result.outputPath
      setMediaClipMatte(clip.id, { path: mattePath, kind: 'video' })
      setNotice(TEXT.aiMatte.done)
    } catch (error) {
      setNotice(TEXT.aiMatte.failed(error instanceof Error ? error.message : String(error)))
    }
  }

  // 切到别的片段 / 关闭检查器时退出画笔：避免画笔层继续画在一个已经被切走的段上
  useEffect(() => {
    return () => {
      const ui = useUiStore.getState()
      if (ui.maskPaint.clipId !== null) ui.endMaskPaint()
    }
  }, [clip.id])

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
          value={sliderValue('scalePct', video.scalePercent)}
          min={MEDIA_VIDEO_RANGE.scale.min}
          max={MEDIA_VIDEO_RANGE.scale.max}
          unit="%"
          title={TEXT.videoEditor.interactHint}
          keyframe={keyframeOf('scalePct', video.scalePercent)}
          onChange={sliderChange('scalePct', (value) => set({ scalePercent: value }))}
        />
        <Slider
          label={TEXT.videoEditor.offsetX}
          value={sliderValue('offsetXPct', video.offsetXPercent)}
          min={MEDIA_VIDEO_RANGE.offset.min}
          max={MEDIA_VIDEO_RANGE.offset.max}
          unit="%"
          keyframe={keyframeOf('offsetXPct', video.offsetXPercent)}
          onChange={sliderChange('offsetXPct', (value) => set({ offsetXPercent: value }))}
        />
        <Slider
          label={TEXT.videoEditor.offsetY}
          value={sliderValue('offsetYPct', video.offsetYPercent)}
          min={MEDIA_VIDEO_RANGE.offset.min}
          max={MEDIA_VIDEO_RANGE.offset.max}
          unit="%"
          keyframe={keyframeOf('offsetYPct', video.offsetYPercent)}
          onChange={sliderChange('offsetYPct', (value) => set({ offsetYPercent: value }))}
        />
        <Slider
          label={TEXT.videoEditor.rotation}
          value={sliderValue('rotationDeg', video.rotationDeg)}
          min={MEDIA_VIDEO_RANGE.rotation.min}
          max={MEDIA_VIDEO_RANGE.rotation.max}
          unit="°"
          keyframe={keyframeOf('rotationDeg', video.rotationDeg)}
          onChange={sliderChange('rotationDeg', (value) => set({ rotationDeg: value }))}
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
          value={sliderValue('brightness', video.brightness)}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          keyframe={keyframeOf('brightness', video.brightness)}
          onChange={sliderChange('brightness', (value) => set({ brightness: value }))}
        />
        <Slider
          label={TEXT.videoEditor.exposure}
          value={sliderValue('exposure', video.exposure)}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          keyframe={keyframeOf('exposure', video.exposure)}
          onChange={sliderChange('exposure', (value) => set({ exposure: value }))}
        />

        <div className="facet-label">{TEXT.videoEditor.colorGroup}</div>
        <Slider
          label={TEXT.videoEditor.contrast}
          value={sliderValue('contrast', video.contrast)}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          keyframe={keyframeOf('contrast', video.contrast)}
          onChange={sliderChange('contrast', (value) => set({ contrast: value }))}
        />
        <Slider
          label={TEXT.videoEditor.saturation}
          value={sliderValue('saturation', video.saturation)}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          keyframe={keyframeOf('saturation', video.saturation)}
          onChange={sliderChange('saturation', (value) => set({ saturation: value }))}
        />
        <Slider
          label={TEXT.videoEditor.warmth}
          value={sliderValue('warmth', video.warmth)}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          keyframe={keyframeOf('warmth', video.warmth)}
          onChange={sliderChange('warmth', (value) => set({ warmth: value }))}
        />
        <Slider
          label={TEXT.videoEditor.vibrance}
          value={sliderValue('vibrance', video.vibrance)}
          min={MEDIA_VIDEO_RANGE.grade.min}
          max={MEDIA_VIDEO_RANGE.grade.max}
          title={TEXT.videoEditor.vibranceHint}
          keyframe={keyframeOf('vibrance', video.vibrance)}
          onChange={sliderChange('vibrance', (value) => set({ vibrance: value }))}
        />

        <div className="facet-label">{TEXT.videoEditor.curves}</div>
        <CurveEditor curves={video.curves} onChange={(curves) => set({ curves })} />
        <ClipEffectsSection video={video} onChange={set} />
        <ClipKeySection keyValue={clip.key} onChange={(key) => updateKey(clip.id, key)} />
      </section>

      {/* v9：音频与变速（与音频片段编辑器共用同一组控件） */}
      <ClipAudioSection
        audio={clip.audio}
        durationSec={clipTimelineDurationSec(clip)}
        onChange={setAudio}
      />
      <ClipSpeedSection speed={clip.speed} onChange={setSpeed} />

      {/* M8：手绘遮罩（预览 CSS mask + 预览上的画笔层；坐标归一化，与画幅/缩放无关） */}
      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.mask.title}</span>
          <span className={`chip${maskStrokes.length > 0 ? ' chip--ok' : ''}`}>
            {TEXT.mask.strokes(maskStrokes.length)}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className={`btn btn--sm${paintingMask ? ' btn--primary' : ''}`}
            aria-pressed={paintingMask}
            title={paintingMask ? TEXT.mask.exit : TEXT.mask.enterHint}
            onClick={toggleMaskPaint}
          >
            {paintingMask ? TEXT.mask.exit : TEXT.mask.enter}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            disabled={maskStrokes.length === 0}
            title={TEXT.mask.clearHint}
            onClick={clearMask}
          >
            {TEXT.mask.clear}
          </button>
        </div>
        {/* M8：羽化（柔边）——写进 mask.featherPct，预览与导出共用同一张遮罩 PNG */}
        {maskStrokes.length > 0 ? (
          <>
            <Slider
              label={TEXT.mask.feather}
              value={clip.mask?.featherPct ?? 0}
              min={0}
              max={20}
              step={0.5}
              unit="%"
              title={TEXT.mask.featherHint}
              onChange={(value) =>
                setMediaClipMask(clip.id, {
                  strokes: [...maskStrokes],
                  ...(value > 0 ? { featherPct: value } : {}),
                  ...(clip.mask?.invert === true ? { invert: true } : {})
                })
              }
            />
            {/* M8：反向遮罩（黑白互换）——光栅化最后一步整张取反，预览/导出仍同一张 PNG */}
            <label className="switch" title={TEXT.mask.invertHint}>
              <input
                type="checkbox"
                checked={clip.mask?.invert === true}
                onChange={(event) => {
                  const featherPct = clip.mask?.featherPct ?? 0
                  setMediaClipMask(clip.id, {
                    strokes: [...maskStrokes],
                    ...(featherPct > 0 ? { featherPct } : {}),
                    ...(event.target.checked ? { invert: true } : {})
                  })
                }}
              />
              <span>{TEXT.mask.invert}</span>
            </label>
          </>
        ) : null}
        {paintingMask ? (
          <>
            <div className="facet-label">{TEXT.mask.mode}</div>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className={`btn btn--sm${maskPaint.mode === 'hide' ? ' btn--primary' : ''}`}
                aria-pressed={maskPaint.mode === 'hide'}
                onClick={() => setMaskBrush({ mode: 'hide' })}
              >
                {TEXT.mask.hide}
              </button>
              <button
                type="button"
                className={`btn btn--sm${maskPaint.mode === 'restore' ? ' btn--primary' : ''}`}
                aria-pressed={maskPaint.mode === 'restore'}
                onClick={() => setMaskBrush({ mode: 'restore' })}
              >
                {TEXT.mask.restore}
              </button>
            </div>
            <Slider
              label={TEXT.mask.brush}
              value={maskPaint.radiusPct}
              min={MASK_BRUSH_RANGE.min}
              max={MASK_BRUSH_RANGE.max}
              step={0.5}
              unit="%"
              title={TEXT.mask.brushHint}
              onChange={(value) => setMaskBrush({ radiusPct: value })}
            />
            <p className="hint">{TEXT.mask.paintHint}</p>
          </>
        ) : (
          <p className="hint">{maskStrokes.length === 0 ? TEXT.mask.empty : TEXT.mask.hint}</p>
        )}
      </section>

      {/* M8-P0：外部 matte（图片/视频；导出侧 alpha 相乘，预览仍显示原片） */}
      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.matte.title}</span>
          <span className={`chip${clip.mattePath ? ' chip--ok' : ''}`}>
            {clip.mattePath ? (clip.matteKind === 'video' ? TEXT.matte.video : TEXT.matte.image) : TEXT.matte.none}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm"
            title={TEXT.matte.importHint}
            onClick={() => void importMatte()}
          >
            {TEXT.matte.import}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            disabled={!clip.mattePath}
            title={TEXT.matte.removeHint}
            onClick={removeMatte}
          >
            {TEXT.matte.remove}
          </button>
        </div>
        {clip.mattePath ? (
          <p className="hint mono" title={clip.mattePath}>
            {matteName}
          </p>
        ) : null}
        <p className="hint">{TEXT.matte.exportingOnly}</p>
      </section>

      {/* M8-P1：AI 人像抠像（主进程 ONNX 推理生成 matte；仅导出生效，预览仍显示原片） */}
      <section className="group">
        <div className="group__head">
          <span className="group__title">{TEXT.aiMatte.title}</span>
          <span className={`chip${aiStatus?.ready ? ' chip--ok' : ' chip--warn'}`}>
            {aiStatus === null
              ? '…'
              : aiStatus.ready
                ? TEXT.aiMatte.ready
                : aiStatus.runtimeOk
                  ? TEXT.aiMatte.modelMissing
                  : TEXT.aiMatte.runtimeMissing}
          </span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!aiStatus?.ready || aiRunning || !mediaItem}
            title={TEXT.aiMatte.generateHint}
            onClick={() => void generateAiMatte()}
          >
            {TEXT.aiMatte.generate}
          </button>
          {aiRunning ? (
            <button
              type="button"
              className="btn btn--sm btn--subtle"
              onClick={() => void window.socut.export.cancel(aiJobId)}
            >
              {TEXT.aiMatte.cancel}
            </button>
          ) : null}
        </div>
        {aiRunning && aiJob ? (
          <p className="hint">{TEXT.aiMatte.generating(aiJob.framesDone, aiJob.framesTotal)}</p>
        ) : null}
        <p className="hint">
          {aiStatus?.ready
            ? TEXT.aiMatte.readyHint
            : aiStatus?.reason || TEXT.aiMatte.installHint}
        </p>
      </section>

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
