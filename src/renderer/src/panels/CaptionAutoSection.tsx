import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { CaptionProgressEvent, CaptionTranscribeResult } from '@shared/api'
import { TEXT } from '@shared/i18n'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { captionAutoWindowOf, planCaptionAutoCues } from './captionAuto'

/**
 * M11：「自动字幕」入口（字幕列表上方的后处理区）。
 *
 * 流转：选中一个媒体片段 → 点「自动字幕」→ 主进程 whisper.cpp 转写（进度经 caption:progress）
 * → 成功后把与片段窗口重叠的 cue 映射到时间轴、走 `addCaptionsFromCues(..., {replace:false})`
 * 落到字幕轨；失败时给出可执行提示（导入二进制/模型、重新定位素材等）。
 *
 * 三个边界：
 * 1. 没有选中媒体片段（或素材已被移出）时按钮禁用，并在下方常驻提示「先选中媒体片段」；
 * 2. 识别语言默认中文——M11 真机验收抓到：自动检测会把中文短音频识别成英文，
 *    中文新闻素材显式给 `-l zh` 才稳定（仍可切「自动检测/英文」）；
 * 3. 组件卸载只退订进度，不取消在跑的转写：切走再回来仍会落库，只是中途进度看不到。
 */

type ProgressState = { requestId: string; percent: number; stage: CaptionProgressEvent['stage'] }

/** 失败文案 + 按错误码追加「可执行」提示（用户看完就知道下一步点哪里）。 */
function failureText(result: CaptionTranscribeResult): string {
  const base = result.errorMessage
    ? `${TEXT.captions.autoCaptionFailed}：${result.errorMessage}`
    : TEXT.captions.autoCaptionFailed
  switch (result.errorCode) {
    case 'WHISPER_BINARY_MISSING':
    case 'WHISPER_MODEL_MISSING':
      return `${base}\n${TEXT.captions.autoCaptionImportHint}`
    case 'WHISPER_MEDIA_MISSING':
      return `${base}\n${TEXT.captions.autoCaptionMissingMedia}`
    case 'WHISPER_AUDIO_FAILED':
      return `${base}\n${TEXT.captions.autoCaptionAudioFailed}`
    default:
      return base
  }
}

/** 渲染侧生成请求 id：进度过滤与取消都按它配对（不用 crypto.randomUUID，jsdom 也稳）。 */
function createRequestId(clipId: string): string {
  return `caption-${clipId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function CaptionAutoSection(): ReactElement {
  const selectedMediaClipId = useProjectStore((state) => state.selectedMediaClipId)
  const mediaClips = useProjectStore((state) => state.project.mediaClips)
  const media = useProjectStore((state) => state.project.media)
  const addCaptionsFromCues = useProjectStore((state) => state.addCaptionsFromCues)
  const setNotice = useUiStore((state) => state.setNotice)

  const [language, setLanguage] = useState('zh')
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  /** 防双击：按钮的 disabled 要等一次渲染才生效，这里用 ref 抢在同 tick 的第二次点击之前挡住 */
  const runningRef = useRef(false)

  // 组件卸载只退订进度回调（在跑的转写允许自然结束并落库，见文件头说明）
  useEffect(() => {
    return () => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
    }
  }, [])

  const mediaClip = mediaClips.find((clip) => clip.id === selectedMediaClipId) ?? null
  const mediaItem = mediaClip ? (media.find((item) => item.id === mediaClip.mediaId) ?? null) : null
  const api = typeof window === 'undefined' ? undefined : window.socut?.caption
  const running = progress !== null
  const disabled = !api || !mediaClip || !mediaItem || running

  const start = async (): Promise<void> => {
    if (!api || !mediaClip || !mediaItem || running || runningRef.current) return
    runningRef.current = true
    const requestId = createRequestId(mediaClip.id)
    setError(null)
    setProgress({ requestId, percent: 0, stage: 'prepare' })
    unsubscribeRef.current?.()
    unsubscribeRef.current = api.onProgress((event) => {
      // 只画自己这次请求的进度（别的请求/上一次请求的残留一律忽略）
      if (event.requestId !== requestId) return
      setProgress({ requestId, percent: event.percent, stage: event.stage })
    })
    try {
      const result = await api.transcribe({
        requestId,
        mediaPath: mediaItem.path,
        ...(language === 'auto' ? {} : { language })
      })
      if (!result.ok) {
        if (result.errorCode === 'CANCELLED') {
          setNotice(TEXT.captions.autoCaptionCancelled)
          return
        }
        const text = failureText(result)
        setError(text)
        setNotice(text)
        return
      }
      // 源时间 → 时间轴：处理片段入点与变速，并只保留与该片段窗口重叠的部分
      const cues = planCaptionAutoCues(result.cues, captionAutoWindowOf(mediaClip))
      const added = addCaptionsFromCues(cues, { replace: false })
      setNotice(added > 0 ? TEXT.captions.autoCaptionAdded(added) : TEXT.captions.autoCaptionEmpty)
    } catch (unknownError) {
      const text = `${TEXT.captions.autoCaptionFailed}：${String(unknownError)}`
      setError(text)
      setNotice(text)
    } finally {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      runningRef.current = false
      setProgress(null)
    }
  }

  const cancel = (): void => {
    if (!progress) return
    // 取消失败（窗口/通道已销毁）不该变成未处理 rejection：转写最终仍会以 CANCELLED 结束
    void api?.cancel(progress.requestId).catch(() => undefined)
  }

  return (
    <div className="caption-auto" style={{ marginTop: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="btn btn--sm btn--subtle"
          style={{ flex: 1 }}
          disabled={disabled}
          title={TEXT.captions.autoCaptionHint}
          onClick={() => void start()}
        >
          {TEXT.captions.autoCaption}
        </button>
        <select
          className="select select--compact"
          style={{ width: 104 }}
          aria-label={TEXT.captions.autoCaptionLanguage}
          title={TEXT.captions.autoCaptionLanguage}
          value={language}
          disabled={running}
          onChange={(event) => setLanguage(event.target.value)}
        >
          <option value="zh">{TEXT.captions.autoCaptionLangZh}</option>
          <option value="en">{TEXT.captions.autoCaptionLangEn}</option>
          <option value="auto">{TEXT.captions.autoCaptionLangAuto}</option>
        </select>
      </div>

      {progress ? (
        <div style={{ marginTop: 6 }}>
          <div className="progress-bar">
            <div className="progress-bar__fill" style={{ width: `${progress.percent}%` }} />
          </div>
          <div className="row row--between" style={{ marginTop: 4 }}>
            <span className="hint">
              {progress.stage === 'prepare'
                ? TEXT.captions.autoCaptionPrepare
                : TEXT.captions.autoCaptionProgress(progress.percent)}
            </span>
            <button type="button" className="btn btn--sm btn--danger" onClick={cancel}>
              {TEXT.captions.autoCaptionCancel}
            </button>
          </div>
        </div>
      ) : error ? (
        <p className="hint text-danger" style={{ marginTop: 4 }}>
          {error}
        </p>
      ) : (
        <p className="hint" style={{ marginTop: 4 }}>
          {mediaItem ? TEXT.captions.autoCaptionSelected(mediaItem.name) : TEXT.captions.autoCaptionNoMedia}
        </p>
      )}
    </div>
  )
}
