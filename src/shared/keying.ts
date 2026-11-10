/**
 * M8：抠像（键控）纯口径 —— 色度键 / 亮度键 / 去溢色。
 *
 * 为什么先做键控而不是人像分割：键控是 FFmpeg 原生滤镜（`chromakey` / `lumakey` / `despill`），
 * 不依赖 ONNX 运行时与模型资产，绿幕/蓝幕/白底素材当天就能用；人像/物体分割（MODNet/RVM）
 * 作为后续可插拔能力，接口与数据模型保持一致（`MediaClip.key`）。
 *
 * 纪律（与降噪/特效一致）：
 * - 默认值不落盘：整键在等于默认时删掉（`normalizeMediaClipKey` 返回 undefined）；
 * - 归一化把脏值夹到合法范围，颜色统一成小写 `#rrggbb`；
 * - 仅导出侧生效：预览的 `<video>` 元素做不了像素键控，面板上明确标注"导出生效"。
 */

export const KEY_MODES = ['chroma', 'luma'] as const
export type KeyMode = (typeof KEY_MODES)[number]

export interface MediaClipKey {
  mode: KeyMode
  /** 键色（#rrggbb）：绿幕/蓝幕/白底） */
  color: string
  /** 色度键相似度 0..1 */
  similarity: number
  /** 色度键边缘混合 0..1 */
  blend: number
  /** 去溢色强度 0..1（0 = 不去溢色） */
  despill: number
  /** 亮度键阈值 0..1 */
  threshold: number
  /** 亮度键容差 0..1 */
  tolerance: number
  /** 亮度键边缘柔和 0..1 */
  softness: number
}

export const KEY_DEFAULTS: Readonly<MediaClipKey> = {
  mode: 'chroma',
  color: '#00b140',
  similarity: 0.12,
  blend: 0.08,
  despill: 0.5,
  threshold: 0.1,
  tolerance: 0.06,
  softness: 0.04
}

export const KEY_RANGE = {
  similarity: { min: 0, max: 1 },
  blend: { min: 0, max: 1 },
  despill: { min: 0, max: 1 },
  threshold: { min: 0, max: 1 },
  tolerance: { min: 0, max: 1 },
  softness: { min: 0, max: 1 }
} as const

const HEX_RE = /^#[0-9a-f]{6}$/i

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.round(Math.min(max, Math.max(min, number)) * 1000) / 1000
}

function normalizeColor(raw: unknown): string {
  if (typeof raw !== 'string') return KEY_DEFAULTS.color
  const value = raw.trim().toLowerCase()
  return HEX_RE.test(value) ? value : KEY_DEFAULTS.color
}

/** 任意 JSON → 合法键控参数；**全部等于默认时返回 undefined**（整键删除）。 */
export function normalizeMediaClipKey(raw: unknown): MediaClipKey | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const mode: KeyMode = record['mode'] === 'luma' ? 'luma' : 'chroma'
  const next: MediaClipKey = {
    mode,
    color: normalizeColor(record['color']),
    similarity: clamp(record['similarity'], KEY_DEFAULTS.similarity, KEY_RANGE.similarity.min, KEY_RANGE.similarity.max),
    blend: clamp(record['blend'], KEY_DEFAULTS.blend, KEY_RANGE.blend.min, KEY_RANGE.blend.max),
    despill: clamp(record['despill'], KEY_DEFAULTS.despill, KEY_RANGE.despill.min, KEY_RANGE.despill.max),
    threshold: clamp(record['threshold'], KEY_DEFAULTS.threshold, KEY_RANGE.threshold.min, KEY_RANGE.threshold.max),
    tolerance: clamp(record['tolerance'], KEY_DEFAULTS.tolerance, KEY_RANGE.tolerance.min, KEY_RANGE.tolerance.max),
    softness: clamp(record['softness'], KEY_DEFAULTS.softness, KEY_RANGE.softness.min, KEY_RANGE.softness.max)
  }
  return isDefaultMediaClipKey(next) ? undefined : next
}

export function isDefaultMediaClipKey(key: MediaClipKey | undefined): boolean {
  if (!key) return true
  return (
    key.mode === KEY_DEFAULTS.mode &&
    key.color === KEY_DEFAULTS.color &&
    Math.abs(key.similarity - KEY_DEFAULTS.similarity) < 1e-9 &&
    Math.abs(key.blend - KEY_DEFAULTS.blend) < 1e-9 &&
    Math.abs(key.despill - KEY_DEFAULTS.despill) < 1e-9 &&
    Math.abs(key.threshold - KEY_DEFAULTS.threshold) < 1e-9 &&
    Math.abs(key.tolerance - KEY_DEFAULTS.tolerance) < 1e-9 &&
    Math.abs(key.softness - KEY_DEFAULTS.softness) < 1e-9
  )
}

/** 键色 → 去溢色类型：绿色分量占优 → green，否则 blue。 */
export function despillTypeOf(color: string): 'green' | 'blue' {
  const value = normalizeColor(color)
  const g = parseInt(value.slice(3, 5), 16)
  const b = parseInt(value.slice(5, 7), 16)
  return g >= b ? 'green' : 'blue'
}

function hexOf(color: string): string {
  return normalizeColor(color).slice(1)
}

/**
 * 键控参数 → FFmpeg 滤镜串（导出侧）。
 *
 * - 色度键：`chromakey=color=0xRRGGBB:similarity=..:blend=..`，紧接着 `despill` 去掉
 *   皮肤/头发边缘残留的键色（mix = despill 强度）；
 * - 亮度键：`lumakey=threshold=..:tolerance=..:softness=..`（白底/黑底素材）。
 *
 * 返回空数组 = 关闭（调用方不注入任何滤镜）。
 */
export function keyFilters(key: MediaClipKey | undefined): string[] {
  if (!key) return []
  if (key.mode === 'luma') {
    return [
      `lumakey=threshold=${key.threshold}:tolerance=${key.tolerance}:softness=${key.softness}`
    ]
  }
  const filters = [`chromakey=color=0x${hexOf(key.color)}:similarity=${key.similarity}:blend=${key.blend}`]
  if (key.despill > 0) filters.push(`despill=type=${despillTypeOf(key.color)}:mix=${key.despill}`)
  return filters
}

/** 预览侧：像素键控无法在 `<video>` 上近似，返回空（面板标注"导出生效"）。 */
export function keyPreviewHint(): string {
  return ''
}
