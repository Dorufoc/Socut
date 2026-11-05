import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { selectedClip, useProjectStore } from '../state/projectStore'
import { useRevealClip } from '../hooks/useRevealClip'

/** 主标题 / 副标题输入（规格 §3.1）。 */

export function TextPanel(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const updateClip = useProjectStore((state) => state.updateClip)
  const reveal = useRevealClip()

  /** 文字写完就把播放头落到本片段可见帧：否则在片段区间外打字，预览看起来毫无变化 */
  const patchContent = (key: 'title' | 'subtitle', value: string): void => {
    if (!clip) return
    updateClip(clip.id, { content: { ...clip.content, [key]: value } })
    reveal(clip.id)
  }

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.inspector.text}</span>
      </div>
      <label className="field">
        <span className="field__label">
          {TEXT.inspector.title}
          <span className="field__meta mono">{clip?.content.title.length ?? 0} 字</span>
        </span>
        <textarea
          className="textarea"
          rows={2}
          value={clip?.content.title ?? ''}
          disabled={!clip}
          placeholder="例如：长三角一体化新规今日发布"
          onChange={(event) => patchContent('title', event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">
          {TEXT.inspector.subtitle}
          <span className="field__meta mono">{clip?.content.subtitle.length ?? 0} 字</span>
        </span>
        <textarea
          className="textarea"
          rows={2}
          value={clip?.content.subtitle ?? ''}
          disabled={!clip}
          placeholder="例如：省发展改革委负责人解读"
          onChange={(event) => patchContent('subtitle', event.target.value)}
        />
      </label>
    </section>
  )
}
