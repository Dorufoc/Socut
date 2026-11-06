import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { CaptionListPanel } from './CaptionListPanel'
import { WatermarkPanel } from './WatermarkPanel'

/**
 * 左侧「包装」Tab（P6）：字幕 / 片尾 / 水印从上到下一次铺开。
 *
 * 合并的只是「入口位置」，三块各自的契约一个字没改——这里不做状态搬运、不做二次封装，
 * 直接把两个面板按顺序摆进来，所以字幕区的新建/删除/跳中点、水印区的导入/开关/换算
 * 行为与合并前完全一致（各自的测试也原样有效）。
 *
 * 片尾是**占位**：功能还没实现，所以只留一段说明、不放任何可点的入口；
 * 给一个点了没反应的按钮，比没有更糟。真做的时候，这一块的边界已经在这儿了。
 */
export function WrapPanel(): ReactElement {
  return (
    <div className="wrap-panel">
      <section className="wrap-section wrap-section--captions">
        <CaptionListPanel />
      </section>

      <section className="group wrap-section wrap-section--ending">
        <div className="group__head">
          <span className="group__title">{TEXT.wrap.ending}</span>
          <span className="chip">{TEXT.wrap.endingPlaceholder}</span>
        </div>
        <div className="empty-state">
          <span className="empty-state__glyph" aria-hidden="true">
            ⊘
          </span>
          <span>{TEXT.wrap.endingTodo}</span>
        </div>
      </section>

      <section className="wrap-section wrap-section--watermark">
        <WatermarkPanel />
      </section>
    </div>
  )
}
