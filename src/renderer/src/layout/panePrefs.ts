import { normalizePaneRatios, serializePaneRatios, type PaneRatios } from '@shared/paneLayout'

/**
 * 布局偏好的本机持久化（localStorage，应用级而非工程级）。
 *
 * 为什么不写进 `project.ui`：分栏比例属于「这台机器 / 这个窗口」的习惯，
 * 换工程不该变；而工程里的 `ui.leftTab` 属于「当时在看哪个面板」，随工程走。
 * 另外自动存档恢复要先经用户确认，比例若存在那儿，冷启动不恢复工程就丢失了。
 *
 * 任何异常（隐私模式、配额、脏 JSON）都只回落到默认布局，绝不阻断界面渲染。
 */

export const PANE_PREFS_KEY = 'focusnews.layout.panes.v1'

/** 只暴露读写删除三件事，测试可以直接传入内存实现。 */
export type PanePrefsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function resolveStorage(): PanePrefsStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: PanePrefsStorage }).localStorage
    return candidate ?? null
  } catch {
    return null
  }
}

/** 读回上次偏好；无存档 / 结构或版本不合法时 null（调用方落到默认布局）。 */
export function readPaneRatios(storage: PanePrefsStorage | null = resolveStorage()): PaneRatios | null {
  if (!storage) return null
  let raw: string | null = null
  try {
    raw = storage.getItem(PANE_PREFS_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    return normalizePaneRatios(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

/** 写回偏好；传 null 表示「恢复默认」，直接删键而不是留一份自造默认值。 */
export function writePaneRatios(
  ratios: PaneRatios | null,
  storage: PanePrefsStorage | null = resolveStorage()
): void {
  if (!storage) return
  try {
    if (ratios === null) storage.removeItem(PANE_PREFS_KEY)
    else storage.setItem(PANE_PREFS_KEY, serializePaneRatios(ratios))
  } catch {
    // 配额或隐私模式：静默失败，布局仍在本会话内生效
  }
}
