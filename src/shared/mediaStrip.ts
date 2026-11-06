import { snapTimeToFrame } from './fps'
import type { Fps } from './types'

/**
 * 时间帧预览条（Thumbnail Strip）的采样与映射口径（纯函数，主/渲染/测试共用）。
 *
 * 一条 MediaClip 的预览条 = 从源区间 `[sourceInSec, sourceOutSec]` 均匀抽 N 帧，
 * 横向无缝拼成**一张长图**，再由 CSS 拉满卡片宽度。于是：
 * - 每个格子覆盖的时间 = 片段时长 / N，格子边界即"等分刻度"；
 * - 卡片被拖宽/时间轴变密时 N 跟着变大（动态采样），但 N 走**档位**而不是逐像素，
 *   否则一次窗口缩放就会连环重抽（性能与抖动都不可接受）；
 * - 长图本身是派生数据，**不写进工程 JSON**（与水印几何同一纪律：换机器/换缩放必须重算，
 *   留下过期值就会与真实像素分叉）。缓存只放在主进程磁盘 + 渲染层内存里。
 */

/** 目标密度：每约 44 CSS 像素一格，接近 NLE 里"一格 ≈ 一个可辨认的小画面"。 */
export const STRIP_TARGET_PX_PER_FRAME = 44

/**
 * 允许的帧数档位（升序）。取「不超过理想值的那一档」，所以卡片加宽时只有跨档才重抽。
 * 上限 24 格：单张长图 ≤ 24×128px，抽帧与解码成本都可控。
 */
export const STRIP_FRAME_STEPS = [3, 4, 6, 8, 10, 12, 16, 20, 24] as const

export const STRIP_FRAMES_MIN = STRIP_FRAME_STEPS[0] as number
export const STRIP_FRAMES_MAX = STRIP_FRAME_STEPS[STRIP_FRAME_STEPS.length - 1] as number

/** 拼接图里每帧的像素宽：与轨道高度无关，按比例缩小即可（不需要保持原始比例，能辨认内容就行）。 */
export const STRIP_FRAME_WIDTH_PX = 128

/** 主进程磁盘缓存目录（userData/thumbs/strips）里保留的最多文件数，超出按 mtime 淘汰。 */
export const STRIP_CACHE_MAX_FILES = 240

/** 并发上限：一次导入/一次缩放可能同时请求多条预览条，抽帧必须排队而不是打满 CPU。 */
export const STRIP_MAX_CONCURRENT = 2

export function stripDurationSec(clip: { sourceInSec: number; sourceOutSec: number }): number {
  return Math.max(0, clip.sourceOutSec - clip.sourceInSec)
}

/**
 * 该抽多少帧：由卡片像素宽决定密度，再受两个上限夹住——
 * 档位上限（成本）与该区间内**真实存在的帧数**（0.2s 的片段抽 24 格只是重复帧）。
 */
export function stripFrameCount(widthPx: number, durationSec: number, framesAvailable?: number): number {
  if (!(widthPx > 0) || !(durationSec > 0)) return STRIP_FRAMES_MIN
  const raw = Math.floor(widthPx / STRIP_TARGET_PX_PER_FRAME)
  let chosen = STRIP_FRAMES_MIN
  for (const step of STRIP_FRAME_STEPS) {
    if (step <= raw) chosen = step
  }
  const byWidth = Math.min(STRIP_FRAMES_MAX, Math.max(STRIP_FRAMES_MIN, chosen))
  if (framesAvailable === undefined || !Number.isFinite(framesAvailable)) return byWidth
  return Math.max(STRIP_FRAMES_MIN, Math.min(byWidth, Math.floor(framesAvailable)))
}

/**
 * 预览条生成请求的参与量（派生数据，不入工程）。键里必须带上**实际文件路径**：
 * 「重新定位」换源不换轨时 mediaId 与入出点都不变，不拿 path 参与就会复用旧素材的长图。
 */
export interface StripRequestInput {
  mediaId: string
  /** 抽帧用的实际文件（VFR 转 CFR / 重新定位后会变） */
  path: string
  sourceInSec: number
  sourceOutSec: number
  frames: number
}

/** 渲染层内存缓存用的键（可读，便于调试）。 */
export function stripCacheKey(input: StripRequestInput): string {
  return `${input.mediaId}|${input.path}|${input.sourceInSec.toFixed(3)}|${input.sourceOutSec.toFixed(3)}|${input.frames}`
}

/**
 * 文件名用的稳定令牌（FNV-1a 折叠成 16 位十六进制两段）。
 * 不直接用原始键：里面含素材 id、路径与小数点，拼进文件名既有长度问题也有跨平台字符问题。
 */
export function stripFileToken(key: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = (Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

/** 素材移出池时按前缀回收它的全部预览条（文件名带 mediaId 的安全化前缀）。 */
export function stripFilePrefix(mediaId: string): string {
  const safe = mediaId.replace(/[^\w-]/g, '_').slice(0, 64) || 'media'
  return `${safe}-`
}

export interface StripTimeInput {
  /** 指针在卡片内的水平比例（0 = 卡片左边界，1 = 右边界） */
  fraction: number
  sourceInSec: number
  sourceOutSec: number
  timelineStartSec: number
  fps: Fps
}

/**
 * 卡片内位置 → 时间：既给源坐标（tooltip 用），也给时间轴坐标（seek 用）。
 * 两者都吸附到当前预览帧率的帧边界，与拖拽入出点同一口径，点出来的位置一定能落在整帧上。
 */
export function stripTimeAtFraction(input: StripTimeInput): { sourceSec: number; timelineSec: number } {
  const fraction = Math.min(1, Math.max(0, input.fraction))
  const span = stripDurationSec(input)
  return {
    sourceSec: snapTimeToFrame(input.sourceInSec + span * fraction, input.fps),
    timelineSec: snapTimeToFrame(input.timelineStartSec + span * fraction, input.fps)
  }
}

/** 预览条状态：failed 时卡片显示占位符与「无法预览」，不再重复请求同一键。 */
export type StripStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface StripState {
  status: StripStatus
  url: string | null
  frames: number
}

export const STRIP_IDLE_STATE: StripState = { status: 'idle', url: null, frames: STRIP_FRAMES_MIN }

/**
 * 占位文案（三态分开，用户才知道是“素材没了”还是“这一条抽不出帧”）；
 * 卡片很窄，所以一律两个字到四个字，不写句子。
 */
export function stripFallbackLabel(input: {
  mediaMissing: boolean
  status: StripStatus
}): string {
  if (input.mediaMissing) return '素材已移出'
  if (input.status === 'loading') return '生成中…'
  if (input.status === 'failed') return '无法预览'
  return '待生成'
}
