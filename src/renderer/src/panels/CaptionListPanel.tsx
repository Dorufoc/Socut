import { type ReactElement } from 'react'
import { getPreset } from '@shared/presets'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 左侧「字幕」Tab：按**时间顺序**列出当前视频里全部已添加的字幕条标题。
 *
 * 点一条做三件事（用户明确要求）：
 * 1. 选中它 → 右侧检查器随即显示这一条的配置；
 * 2. 播放头跳到它的**入点** → 预览画面与时间轴播放头同步跳转；
 * 3. 跳转前先暂停：播放中跳过去会被时钟立刻带走，看不出"跳到入点"的效果
 *    （与时间轴刮擦接管播放头同一口径）。
 *
 * 排序在这里显式做一次：「按时间顺序」是本面板的契约，不能依赖片段的写入顺序。
 */
export function CaptionListPanel(): ReactElement {
  const clips = useProjectStore((state) => state.project.clips)
  const fps = useProjectStore((state) => state.project.fps)
  const selectedId = useProjectStore((state) => state.selectedClipId)
  const selectClip = useProjectStore((state) => state.selectClip)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const seekHandler = useUiStore((state) => state.seekHandler)

  const ordered = [...clips].sort((a, b) => a.startTime - b.startTime)

  const jumpTo = (clipId: string, startSec: number): void => {
    selectClip(clipId)
    if (playing) setPlaying(false)
    seekHandler?.(startSec)
  }

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.captions.title}</span>
        <span className={`chip${ordered.length > 0 ? ' chip--ok' : ''}`}>{TEXT.captions.count(ordered.length)}</span>
      </div>

      {ordered.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state__glyph" aria-hidden="true">
            ¶
          </span>
          <span>
            {TEXT.captions.empty}
            <br />
            <span className="muted">{TEXT.captions.emptyHint}</span>
          </span>
        </div>
      ) : null}

      {ordered.length > 0 ? (
        <ol className="caption-list">
          {ordered.map((clip, index) => {
            const active = clip.id === selectedId
            const onAir = displayTime >= clip.startTime && displayTime < clip.endTime
            const classes = ['caption-item']
            if (active) classes.push('caption-item--active')
            if (onAir) classes.push('caption-item--onair')
            return (
              <li key={clip.id}>
                <button
                  type="button"
                  className={classes.join(' ')}
                  aria-pressed={active}
                  title={`${getPreset(clip.presetId).name} · ${TEXT.captions.hint}`}
                  onClick={() => jumpTo(clip.id, clip.startTime)}
                >
                  <span className="caption-item__index mono">{index + 1}</span>
                  <span className="caption-item__body">
                    <span className="caption-item__title">{clip.content.title || TEXT.captions.noTitle}</span>
                    <span className="caption-item__sub">{clip.content.subtitle || TEXT.captions.noSubtitle}</span>
                    <span className="caption-item__meta mono">
                      {secondsToTimecode(clip.startTime, fps)} → {secondsToTimecode(clip.endTime, fps)} ·{' '}
                      {getPreset(clip.presetId).name}
                      {onAir ? <span className="caption-item__onair-tag"> {TEXT.captions.onAir}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      ) : null}
    </section>
  )
}
