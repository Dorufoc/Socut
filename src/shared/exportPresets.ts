import { classifyAspect, displayAspectRatio } from './aspect'
import { EXPORT_BITRATE_BASE_KBPS, EXPORT_QUALITY_CRF, EXPORT_RESOLUTION_SHORT_SIDE } from './constants'
import type {
  AspectMode,
  ExportBitrateTier,
  ExportCanvasKind,
  ExportCanvasSelection,
  ExportFit,
  ExportQuality,
  ExportResolutionTier
} from './types'

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

/** 分辨率档位对应的目标短边像素。 */
export function resolutionShortSide(tier: ExportResolutionTier): number {
  return EXPORT_RESOLUTION_SHORT_SIDE[tier]
}

/**
 * 按短边缩放画布，保持宽高比；宽高都取偶数（H.264/HEVC 要求）。
 * 短边 = min(width, height)：横屏看高度、竖屏/方图看宽度。
 */
export function scaleCanvasToShortSide(
  base: { width: number; height: number },
  shortSide: number
): { width: number; height: number } {
  const baseShort = Math.min(base.width, base.height)
  const factor = baseShort > 0 ? shortSide / baseShort : 1
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)
  return { width: even(base.width * factor), height: even(base.height * factor) }
}

/** 按像素数把 1080p 基准码率缩放到目标画布（四舍五入到 100 kbps，下限 100）。 */
export function scaledBitrateKbps(baseKbps: number, width: number, height: number): number {
  const scaled = (baseKbps * width * height) / (1920 * 1080)
  return Math.max(100, Math.round(scaled / 100) * 100)
}

/**
 * 码率档位换算成目标画布的实际 kbps。
 * 自定义码率是绝对值（不随分辨率缩放），夹在 100..100000 之间。
 */
export function videoBitrateKbpsOf(
  tier: ExportBitrateTier,
  customKbps: number,
  size: { width: number; height: number }
): number {
  if (tier === 'custom') {
    const value = Number.isFinite(customKbps) ? Math.round(customKbps) : 2000
    return Math.max(100, Math.min(100000, value))
  }
  return scaledBitrateKbps(EXPORT_BITRATE_BASE_KBPS[tier], size.width, size.height)
}

/**
 * 目标画布解析。
 *
 * - `landscape`：跟随首个可见底层素材（`primaryMeta`），无媒体时跟随工程分辨率；
 *   `resolution` 为具体档位时按短边缩放（保持素材宽高比）；
 * - `portrait` / `square`：9:16 / 1:1 固定宽高比，缺省 1080 短边，具体档位按短边缩放。
 *
 * fit 缺省：横屏 `contain`（旧行为：完整画面补边），竖屏/方图 `cover`（满构图不拉伸）。
 */
export function resolveExportCanvas(input: {
  selection: ExportCanvasSelection
  primaryMeta?: { width: number; height: number } | null
  projectResolution: { width: number; height: number }
}): ResolvedExportCanvas {
  const meta = CANVAS_META[input.selection.kind]
  const choice = input.selection.resolution ?? input.selection.tier ?? (input.selection.kind === 'landscape' ? 'source' : '1080')
  if (input.selection.kind === 'landscape') {
    const source = isValidSize(input.primaryMeta) ? input.primaryMeta : input.projectResolution
    const size =
      choice === 'source'
        ? { width: source.width, height: source.height }
        : scaleCanvasToShortSide(source, resolutionShortSide(choice))
    return {
      kind: 'landscape',
      width: size.width,
      height: size.height,
      fit: input.selection.fit ?? 'contain',
      mode: classifyAspect(displayAspectRatio(size, null)),
      ...meta
    }
  }
  const shortSide = choice === 'source' ? resolutionShortSide('1080') : resolutionShortSide(choice)
  const base = input.selection.kind === 'portrait' ? { width: 9, height: 16 } : { width: 1, height: 1 }
  const size = scaleCanvasToShortSide(base, shortSide)
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
