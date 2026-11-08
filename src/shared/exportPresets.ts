import { classifyAspect, displayAspectRatio } from './aspect'
import { EXPORT_CANVAS_SIZES, EXPORT_QUALITY_CRF } from './constants'
import type { AspectMode, ExportCanvasKind, ExportCanvasSelection, ExportFit, ExportQuality } from './types'

/**
 * 交付画布预设（v10）：把用户选择解析成唯一的「尺寸 + 适配 + 宽高比分支 + 文件名后缀」口径。
 * 纯函数，不碰 Node / Electron / DOM——主进程、渲染进程与测试共用同一份。
 */

export interface ResolvedExportCanvas {
  kind: ExportCanvasKind
  width: number
  height: number
  /** cover = 等比放大后居中裁切；contain = 等比缩小后补边 */
  fit: ExportFit
  /** 字幕条分支（由解析后的宽高比推出） */
  mode: AspectMode
  /** 文件名后缀：16x9 / 9x16 / 1x1 */
  suffix: string
  /** 中文标签：横屏 16:9 / 竖屏 9:16 / 方形 1:1 */
  label: string
}

const CANVAS_META: Record<ExportCanvasKind, { suffix: string; label: string }> = {
  landscape: { suffix: '16x9', label: '横屏 16:9' },
  portrait: { suffix: '9x16', label: '竖屏 9:16' },
  square: { suffix: '1x1', label: '方形 1:1' }
}

function isValidSize(size: { width: number; height: number } | null | undefined): size is {
  width: number
  height: number
} {
  return !!size && Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0
}

/**
 * 目标画布解析。
 *
 * - `landscape`：跟随首个可见底层素材（`primaryMeta`），无媒体时跟随工程分辨率；
 * - `portrait` / `square`：按档位取固定尺寸（缺省 1080），与源素材无关。
 *
 * fit 缺省：横屏 `contain`（旧行为：完整画面补边），竖屏/方图 `cover`（满构图不拉伸）。
 */
export function resolveExportCanvas(input: {
  selection: ExportCanvasSelection
  primaryMeta?: { width: number; height: number } | null
  projectResolution: { width: number; height: number }
}): ResolvedExportCanvas {
  const meta = CANVAS_META[input.selection.kind]
  if (input.selection.kind === 'landscape') {
    const source = isValidSize(input.primaryMeta) ? input.primaryMeta : input.projectResolution
    const size = { width: source.width, height: source.height }
    return {
      kind: 'landscape',
      width: size.width,
      height: size.height,
      fit: input.selection.fit ?? 'contain',
      mode: classifyAspect(displayAspectRatio(size, null)),
      ...meta
    }
  }
  const tier = input.selection.tier ?? '1080'
  const size =
    input.selection.kind === 'portrait' ? EXPORT_CANVAS_SIZES.portrait[tier] : EXPORT_CANVAS_SIZES.square[tier]
  return {
    kind: input.selection.kind,
    width: size.width,
    height: size.height,
    fit: input.selection.fit ?? 'cover',
    mode: classifyAspect(size.width / size.height),
    ...meta
  }
}

/** 画质档 → CRF（缺省 high = 18，与现有默认逐字节一致）。 */
export function exportQualityCrf(quality: ExportQuality | undefined): number {
  return EXPORT_QUALITY_CRF[quality ?? 'high']
}

/** 是否为竖屏/方图（默认 cover、走紧凑分支的画布）。 */
export function isPortraitOrSquare(kind: ExportCanvasKind): boolean {
  return kind === 'portrait' || kind === 'square'
}
