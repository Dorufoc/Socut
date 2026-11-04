import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { selectedClip, useProjectStore } from '../state/projectStore'

/** 主标题 / 副标题输入（规格 §3.1）。 */

export function TextPanel(): ReactElement {
  const clip = useProjectStore(selectedClip)
  const updateClip = useProjectStore((state) => state.updateClip)

  return (
    <section className="group">
      <div className="group__head">
        <span className="group__title">{TEXT.inspector.text}</span>
        <span className="group__hint">点预览里的字幕条也可选中</span>
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
          onChange={(event) => {
            if (!clip) return
            updateClip(clip.id, { content: { ...clip.content, title: event.target.value } })
          }}
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
          onChange={(event) => {
            if (!clip) return
            updateClip(clip.id, { content: { ...clip.content, subtitle: event.target.value } })
          }}
        />
      </label>
      <p className="hint">标题超过条宽上限会自动换行（最多 3 行），竖屏紧凑分支仍按单行省略（规格 §4.3）。</p>
    </section>
  )
}
