import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { useUiStore } from '../state/uiStore'

/** 大字体加载遮罩（规格 §4.5：加载期间禁用导出并显示指示）。 */

export function FontLoadingOverlay(): ReactElement | null {
  const count = useUiStore((state) => state.fontLoadingCount)
  if (count <= 0) return null
  return <div className="overlay-loading">{TEXT.fonts.loading}</div>
}
