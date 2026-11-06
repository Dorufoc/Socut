import { type ReactElement } from 'react'
import { getPreset } from '@shared/presets'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import type { SubtitleClip } from '@shared/types'
import { IconPlus, IconTrash } from '../components/ui/Icon'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 左侧「字幕」Tab（v10 P2）：按**时间顺序**列出全部字幕条，同时是新建/删除字幕条的唯一入口。
 *
 * 三种点击各自的契约：
 * 1. **点卡片** = 选中（右侧检查器随即指向这一条）+ 播放头跳到该条**区间中点**
 *    → 预览与时间轴同步过去。用中点而不是入点：中点天然落在「入场完成 → 出场开始」
 *    窗口里，预览一定看得见完整样式，入点则正好压在入场动画的第一帧上。
 * 2. **点加号** = 在时间轴末尾新建一条并选中它，同样跳到中点（不跳的话右侧在编辑、
 *    预览里却看不到这一条，等于「改了但没反应」）。空态是整块大虚线框，有字幕时
 *    退成列表末尾一条矮虚线条——两个入口走同一段逻辑。
 * 3. **点删除** = 直接删这一条，不弹二次确认：删错了靠项目级撤销（Ctrl+Z）找回。
 *
 * 跳转前一律先暂停：播放中跳过去会被时钟立刻带走，看不出跳转效果
 * （与时间轴刮擦接管播放头同一口径）。
 *
 * 排序在这里显式做一次：「按时间顺序」是本面板的契约，不能依赖片段的写入顺序。
 */

/** 该条在轨道上的中点（秒）：预览与时间轴都落到这里 */
function midSec(clip: SubtitleClip): number {
  return (clip.startTime + clip.endTime) / 2
}

export function CaptionListPanel(): ReactElement {
  const clips = useProjectStore((state) => state.project.clips)
  const fps = useProjectStore((state) => state.project.fps)
  const selectedId = useProjectStore((state) => state.selectedClipId)
  const selectClip = useProjectStore((state) => state.selectClip)
  const addClip = useProjectStore((state) => state.addClip)
  const removeClip = useProjectStore((state) => state.removeClip)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const seekHandler = useUiStore((state) => state.seekHandler)

  const ordered = [...clips].sort((a, b) => a.startTime - b.startTime)

  const takeOverClock = (): void => {
    if (playing) setPlaying(false)
  }

  const jumpTo = (clip: SubtitleClip): void => {
    selectClip(clip.id)
    takeOverClock()
    seekHandler?.(midSec(clip))
  }

  const create = (): void => {
    // addClip 自己会把新片段设为选中态，这里只负责把画面带过去
    const id = addClip()
    takeOverClock()
    const created = useProjectStore.getState().project.clips.find((clip) => clip.id === id)
    if (created) seekHandler?.(midSec(created))
  }

  const addHero = (
    <button type="button" className="caption-add caption-add--hero" onClick={create}>
      <span className="caption-add__glyph" aria-hidden="true">
        <IconPlus size={26} strokeWidth={1.6} />
      </span>
      <span className="caption-add__label">{TEXT.captions.add}</span>
      <span className="caption-add__hint">
        {TEXT.captions.empty}
        <br />
        {TEXT.captions.addHint}
      </span>
    </button>
  )

  const addRow = (
    <button type="button" className="caption-add" onClick={create}>
      <IconPlus size={13} />
      <span>{TEXT.captions.add}</span>
    </button>
  )

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.captions.title}</span>
        <span className={`chip${ordered.length > 0 ? ' chip--ok' : ''}`}>{TEXT.captions.count(ordered.length)}</span>
      </div>

      {ordered.length === 0 ? (
        addHero
      ) : (
        <>
          <ol className="caption-list">
            {ordered.map((clip, index) => {
              const active = clip.id === selectedId
              const onAir = displayTime >= clip.startTime && displayTime < clip.endTime
              const classes = ['caption-item']
              if (active) classes.push('caption-item--active')
              if (onAir) classes.push('caption-item--onair')
              const title = clip.content.title || TEXT.captions.noTitle
              return (
                <li key={clip.id}>
                  <div className={classes.join(' ')}>
                    <button
                      type="button"
                      className="caption-item__pick"
                      aria-pressed={active}
                      title={`${getPreset(clip.presetId).name} · ${TEXT.captions.hint}`}
                      onClick={() => jumpTo(clip)}
                    >
                      <span className="caption-item__index mono">{index + 1}</span>
                      <span className="caption-item__body">
                        <span className="caption-item__title">{title}</span>
                        <span className="caption-item__sub">{clip.content.subtitle || TEXT.captions.noSubtitle}</span>
                        <span className="caption-item__meta mono">
                          {secondsToTimecode(clip.startTime, fps)} → {secondsToTimecode(clip.endTime, fps)} ·{' '}
                          {getPreset(clip.presetId).name}
                          {onAir ? <span className="caption-item__onair-tag"> {TEXT.captions.onAir}</span> : null}
                        </span>
                      </span>
                    </button>
                    {/* 删除按钮常驻：入口藏起来等于没有入口；卡片本体是按钮，所以两者并列而不能嵌套 */}
                    <button
                      type="button"
                      className="caption-item__remove"
                      aria-label={TEXT.captions.removeNamed(title)}
                      title={TEXT.captions.remove}
                      onClick={() => removeClip(clip.id)}
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
          {addRow}
        </>
      )}
    </section>
  )
}
