/**
 * 素材库卡片尺寸偏好（Ctrl + 滚轮缩放）。
 *
 * 与分栏比例同理：卡片大小属于「这台机器 / 这个窗口」的浏览习惯，不进工程，
 * 换工程不该跟着变。任何异常（隐私模式、配额、脏值）都静默回落到默认尺寸，
 * 绝不阻断素材库渲染。
 */

export const MEDIA_TILE_SIZE_KEY = 'focusnews.media.tile-size.v1'

/** 默认列宽（px）：默认左栏 300px 时排成 2 列，接近剪映导入面板的密度 */
export const MEDIA_TILE_SIZE_DEFAULT = 120

/** Ctrl + 滚轮每格的增减量（px） */
export const MEDIA_TILE_SIZE_STEP = 8

/** 56px 时默认左栏仍能排 4 列（缩略图为主的极限密度）；再大则一列占满侧栏，失去网格意义 */
export const MEDIA_TILE_SIZE_MIN = 56
export const MEDIA_TILE_SIZE_MAX = 280

/** 只暴露读写两件事，测试可以直接传入内存实现。 */
export type TileSizeStorage = Pick<Storage, 'getItem' | 'setItem'>

function resolveStorage(): TileSizeStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: TileSizeStorage }).localStorage
    return candidate ?? null
  } catch {
    return null
  }
}

/** 夹到合法区间；非有限值（NaN / Infinity）直接回默认。 */
export function clampMediaTileSize(value: number): number {
  if (!Number.isFinite(value)) return MEDIA_TILE_SIZE_DEFAULT
  return Math.min(MEDIA_TILE_SIZE_MAX, Math.max(MEDIA_TILE_SIZE_MIN, Math.round(value)))
}

/**
 * 一次滚轮事件之后的尺寸：deltaY > 0（向下滚）缩小，向上滚放大。
 * 只取方向、不按 deltaY 大小缩放——鼠标滚轮一格约 100，触控板一小格只有个位数，
 * 按比例算会让两种设备的缩放手感差出一个数量级。
 */
export function nextMediaTileSize(current: number, deltaY: number): number {
  if (deltaY === 0) return clampMediaTileSize(current)
  const direction = deltaY > 0 ? -1 : 1
  return clampMediaTileSize(current + direction * MEDIA_TILE_SIZE_STEP)
}

/** 读回上次的卡片尺寸；无存档 / 脏值 / 存储不可用时返回默认值。 */
export function readMediaTileSize(storage: TileSizeStorage | null = resolveStorage()): number {
  if (!storage) return MEDIA_TILE_SIZE_DEFAULT
  let raw: string | null = null
  try {
    raw = storage.getItem(MEDIA_TILE_SIZE_KEY)
  } catch {
    return MEDIA_TILE_SIZE_DEFAULT
  }
  if (!raw) return MEDIA_TILE_SIZE_DEFAULT
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? clampMediaTileSize(parsed) : MEDIA_TILE_SIZE_DEFAULT
}

/** 写回尺寸；存储不可用时静默失败（本会话内的缩放仍然生效）。 */
export function writeMediaTileSize(size: number, storage: TileSizeStorage | null = resolveStorage()): void {
  if (!storage) return
  try {
    storage.setItem(MEDIA_TILE_SIZE_KEY, String(clampMediaTileSize(size)))
  } catch {
    // 配额或隐私模式：忽略
  }
}
