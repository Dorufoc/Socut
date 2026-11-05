/**
 * 时间轴片段的视频防抖口径（v8，主/渲染/测试共用）。
 *
 * 与 mediaClipVideo 同一套纪律：
 * 1. **默认值 = 不生效**：enabled false / level standard / tripod false；全部默认时整键不写进工程。
 * 2. **一套语义两处消费**：UI 只写档位（low/standard/high），
 *    「档位 → vidstab 滤镜参数」的映射只允许写在这里，导出侧（shared/ffmpegArgs）直接消费。
 * 3. **脏值全部可夹心**：任何脏工程值都能归一回合法枚举/布尔，不会有 undefined 进滤镜串。
 * 4. **v8.1 预览代理**：点「应用防抖预览」后主进程后台生成稳定化代理文件，
 *    就绪前预览仍播原片；坐标换算（stabProxyTimeOf）也只允许写在这里。
 */

import type { Fps, MediaClipStab, StabLevel } from './types'

export type { MediaClipStab, StabLevel }

export const STAB_LEVELS: StabLevel[] = ['low', 'standard', 'high']

/** vidstabdetect 一次性分析参数（pass 1）。 */
export interface StabDetectProfile {
  /** 1–10：镜头有多抖、抖多快（越大越慢越准） */
  shakiness: number
  /** 1–15：搜索精度（≥shakiness） */
  accuracy: number
  /** 虚拟三脚架参考帧号（>0 生效） */
  tripod: number
}

/** vidstabtransform 形变参数（pass 2，见 stabTransformProfile）。 */
export interface StabTransformProfile {
  /** 平滑窗口 = 帧数×2+1 */
  smoothing: number
  optalgo: 'opt' | 'gauss' | 'avg'
  /** 0=不缩放 1=静态最优 2=逐帧动态最优（oximedia 式 Zoom Optimization） */
  optzoom: 0 | 1 | 2
  /** 动态缩放（optzoom=2）时每帧最大变倍百分比；静态模式不写本项 */
  zoomspeed: number
  /** 静态最优缩放之外再内缩的百分比（>0 放大画面吃边缘）；仅三脚架静态模式用 */
  zoomMargin: number
  interpol: 'bilinear' | 'bicubic'
  /** keep=保留边框像素不涂黑（≈无黑边目标） */
  crop: 'keep' | 'black'
  /** smooth=常规相对平滑；tripod=虚拟三脚架（超长窗平滑钉死机位，绝非 vidstab 的 tripod 宏） */
  mode: 'smooth' | 'tripod'
}

const STAB_PROFILE_TABLE: Record<StabLevel, { shakiness: number; accuracy: number; smoothing: number; zoomspeed: number }> = {
  low: { shakiness: 3, accuracy: 8, smoothing: 10, zoomspeed: 0.15 },
  standard: { shakiness: 6, accuracy: 12, smoothing: 15, zoomspeed: 0.25 },
  high: { shakiness: 8, accuracy: 15, smoothing: 30, zoomspeed: 0.4 }
}

/**
 * v8.2：虚拟三脚架的真机实证参数。绝不能给 vidstabtransform 传 `tripod=1`：
 * 本机 -h filter 明确 `tripod=true` 等价 `relative=0:smoothing=0`，会把每帧拽回参考帧 1
 * 且关掉低通，实拍平移素材上反而把高频抖动放大到原片的 194%（用户现象）。
 * 改用「相对轨迹 + 超长窗高斯低通 + 静态最优缩放留边」钉住机位：真机测得抖动降到原片 57%，绝不放大。
 */
const TRIPOD_SMOOTHING = 120
const TRIPOD_ZOOM_MARGIN = 6

/** v8.2：预览代理算法修订号——防抖映射变更时递增，使旧缓存（含放大缺陷的代理）自动失效。 */
const STAB_PREVIEW_ALGO_REV = 2

export function defaultMediaStab(): MediaClipStab {
  return { enabled: false, level: 'standard', tripod: false }
}

function normalizeStabLevel(value: unknown): StabLevel {
  return value === 'low' || value === 'standard' || value === 'high' ? value : 'standard'
}

/** 任意 JSON → 合法参数；**全部默认时返回 undefined**（调用方据此整键删除）。 */
export function normalizeMediaStab(raw: unknown): MediaClipStab | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const next: MediaClipStab = {
    enabled: record['enabled'] === true,
    level: normalizeStabLevel(record['level']),
    tripod: record['tripod'] === true
  }
  return isDefaultMediaStab(next) ? undefined : next
}

/** 是否等于默认值（= 这条片段没有任何防抖设置）。 */
export function isDefaultMediaStab(stab: MediaClipStab | undefined): boolean {
  if (!stab) return true
  return !stab.enabled && stab.level === 'standard' && !stab.tripod
}

/** 档位 → detect（pass 1）滤镜参数。
 *  detect 恒走相对（帧间）运动：transform 也按 relative=1 读取，两侧口径必须一致。
 *  虚拟三脚架不再用 detect tripod=N 的绝对位移——那会与 relative=1 冲突（见 stabTransformProfile）。 */
export function stabDetectProfile(stab: MediaClipStab): StabDetectProfile {
  const table = STAB_PROFILE_TABLE[stab.level]
  return {
    shakiness: table.shakiness,
    accuracy: table.accuracy,
    tripod: 0
  }
}

/** 档位 → transform（pass 2）滤镜参数。
 *  常规（smooth）：optalgo=opt、optzoom=2（逐帧动态最优缩放）、interpol=bicubic、crop=keep。
 *  虚拟三脚架（tripod）：超长窗高斯低通 + 静态最优缩放留边，不碰 vidstab 的 tripod 宏。 */
export function stabTransformProfile(stab: MediaClipStab): StabTransformProfile {
  const table = STAB_PROFILE_TABLE[stab.level]
  if (stab.tripod) {
    return {
      smoothing: TRIPOD_SMOOTHING,
      optalgo: 'gauss',
      optzoom: 1,
      zoomspeed: 0,
      zoomMargin: TRIPOD_ZOOM_MARGIN,
      interpol: 'bicubic',
      crop: 'keep',
      mode: 'tripod'
    }
  }
  return {
    smoothing: table.smoothing,
    optalgo: 'opt',
    optzoom: 2,
    zoomspeed: table.zoomspeed,
    zoomMargin: 0,
    interpol: 'bicubic',
    crop: 'keep',
    mode: 'smooth'
  }
}

// ---------------------------------------------------------------- 预览代理（v8.1）

/**
 * 预览代理的坐标口径：代理文件就是「源区间 [sourceInSec, sourceOutSec] 防抖后」的 1:1 内容，
 * 所以预览要播代理时，时间轴坐标要换成代理坐标——这个减法只允许写在这里。
 * 超出区间（拖拽中/尾帧舍入）夹在 [0, 代理时长]，不会产生负 seek。
 */
export function stabProxyTimeOf(sourceSec: number, sourceInSec: number, sourceOutSec: number): number {
  const local = sourceSec - sourceInSec
  const max = Math.max(0, sourceOutSec - sourceInSec)
  if (!Number.isFinite(local)) return 0
  return Math.min(max, Math.max(0, local))
}

/** 渲染/主进程共用的代理新鲜度签名：片段区间、帧率、档位、三脚架、源路径任一变化即失效。 */
export interface StabPreviewSignatureInput {
  sourcePath: string
  sourceInSec: number
  sourceOutSec: number
  fps: Fps
  stab: MediaClipStab
}

function sec(v: number): string {
  return (Math.round(v * 1e6) / 1e6).toFixed(6)
}

export function stabPreviewSignature(input: StabPreviewSignatureInput): string {
  return [
    // 算法修订号前置：v8.2 修了虚拟三脚架映射，旧代理缓存（含放大缺陷）必须自动失效
    `r${STAB_PREVIEW_ALGO_REV}`,
    input.sourcePath,
    sec(input.sourceInSec),
    sec(input.sourceOutSec),
    `${input.fps.num}/${input.fps.den}`,
    input.stab.level,
    input.stab.tripod ? 'tripod' : 'smooth'
  ].join('|')
}

/**
 * 缓存文件令牌：签名 + 源文件指纹（大小/修改时间）的 FNV-1a 哈希（8 位十六进制）。
 * 不依赖 Node crypto：同一纯函数在主/渲染两侧都可调用，测试不需 Electron。
 */
export function stabPreviewToken(signature: string, sourceBytes: number, sourceMtimeMs: number): string {
  const text = `${signature}|${Math.round(sourceBytes)}|${Math.round(sourceMtimeMs)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 代理/运动数据文件名（安全化 clipId 前缀 + 令牌）：按 clipId 前缀可批量回收。 */
export function stabPreviewFileName(clipId: string, token: string): { video: string; trf: string } {
  const safeClip = clipId.replace(/[^\w-]/g, '_').slice(0, 64) || 'clip'
  const safeToken = token.replace(/[^\w-]/g, '').slice(0, 16) || 'plain'
  return { video: `stab-${safeClip}-${safeToken}.mp4`, trf: `stab-${safeClip}-${safeToken}.trf` }
}
