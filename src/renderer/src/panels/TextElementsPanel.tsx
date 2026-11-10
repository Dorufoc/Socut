import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { secondsToTimecode } from '@shared/timecode'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { IconPlus, IconTrash } from '../components/ui/Icon'

/**
 * M7-D：左侧「包装」Tab 里的「文本元素」列表。
 *
 * 与字幕条列表同一交互口径：
 * - 点条目 = 选中（右侧检查器切到文本元素）+ 播放头跳到区间中点（预览一定看得见完整样式）；
 * - 「+」= 在时间轴末尾之后追加一条默认 5s 的文本元素并选中；
 * - 「−」= 删除（靠项目级撤销找回）。
 *
 * 文本元素与字幕条是两套体系：这里只列 `project.textClips`，不碰包装字幕条。
 */

const EMPTY_TEXT_CLIPS: never[] = []

export function TextElementsPanel(): ReactElement {
  const textClips = useProjectStore((state) => state.project.textClips) ?? EMPTY_TEXT_CLIPS
  const selectedId = useProjectStore((state) => state.selectedTextClipId)
  const addTextClip = useProjectStore((state) => state.addTextClip)
  const selectTextClip = useProjectStore((state) => state.selectTextClip)
  const removeTextClip = useProjectStore((state) => state.removeTextClip)
  const fps = useProjectStore((state) => state.project.fps)
  const seek = useUiStore((state) => state.seekHandler)
  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)

  const ordered = [...textClips].sort((a, b) => a.startTime - b.startTime)

  const jumpTo = (id: string): void => {
    selectTextClip(id)
    if (playing) setPlaying(false)
    const clip = textClips.find((item) => item.id === id)
    if (clip) seek?.((clip.startTime + clip.endTime) / 2)
  }

  const create = (): void => {
    const lastEnd = textClips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
    const clip = addTextClip({ at: lastEnd })
    if (clip) {
      if (playing) setPlaying(false)
      seek?.((clip.startTime + clip.endTime) / 2)
    }
  }

  return (
    <section className="group wrap-section wrap-section--text">
      <div className="group__head">
        <span className="group__title">{TEXT.wrap.textElements}</span>
        <span className="chip">{textClips.length}</span>
      </div>

      <button type="button" className="btn btn--block" title={TEXT.textElement.addHint} onClick={create}>
        <IconPlus size={13} />
        {TEXT.textElement.add}
      </button>

      {ordered.length === 0 ? (
        <p className="hint">{TEXT.textElement.empty}</p>
      ) : (
        <ul className="caption-list">
          {ordered.map((clip) => (
            <li key={clip.id}>
              <button
                type="button"
                className={`caption-list__item${clip.id === selectedId ? ' caption-list__item--selected' : ''}`}
                title={TEXT.textElement.hint}
                aria-label={`${clip.text} · ${secondsToTimecode(clip.startTime, fps)} → ${secondsToTimecode(clip.endTime, fps)}`}
                onClick={() => jumpTo(clip.id)}
              >
                <span className="caption-list__title">{clip.text || '（空文本）'}</span>
                <span className="caption-list__time mono">
                  {secondsToTimecode(clip.startTime, fps)} → {secondsToTimecode(clip.endTime, fps)}
                </span>
              </button>
              <button
                type="button"
                className="btn btn--sm btn--subtle"
                title={TEXT.textElement.remove}
                aria-label={TEXT.textElement.remove}
                onClick={() => removeTextClip(clip.id)}
              >
                <IconTrash size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
