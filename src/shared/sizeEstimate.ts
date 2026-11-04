import { PNG_RECOMMEND_THRESHOLD_BYTES, PRORES_4444_BITS_PER_PIXEL_FRAME } from './constants'
import type { Fps, SizeEstimate } from './types'

/** 体积预估（规格 §2.3：4K60 透明 MOV 导出前须显示预估文件大小）。 */

export function estimateProres4444Bytes(
  width: number,
  height: number,
  fps: Fps,
  frames: number,
  bitsPerPixelFrame = PRORES_4444_BITS_PER_PIXEL_FRAME
): number {
  const fpsRatio = fps.num / fps.den
  // 双线性口径：像素 × 帧率 × 单位比特，最后按实际帧数折算（帧数已是权威值）
  const perFrameBits = width * height * bitsPerPixelFrame
  const bytesByFrames = (perFrameBits * frames) / 8
  // 参考核对：时长口径（避免帧数为 0 时给出 0）
  const durationSec = fpsRatio > 0 ? (frames * fps.den) / fps.num : 0
  const bytesByTime = (width * height * fpsRatio * bitsPerPixelFrame * durationSec) / 8
  return Math.max(0, Math.round((bytesByFrames + bytesByTime) / 2))
}

export interface SizeEstimateInput {
  width: number
  height: number
  fps: Fps
  frames: number
  /** 目标卷可用字节（fs.statfs 结果） */
  freeBytes?: number
  /** 磁盘安全系数（规格 §5 预检 1.5×） */
  safetyFactor?: number
}

export function buildSizeEstimate(input: SizeEstimateInput): SizeEstimate {
  const bytes = estimateProres4444Bytes(input.width, input.height, input.fps, input.frames)
  const freeBytes = input.freeBytes
  const need = bytes * (input.safetyFactor ?? 1.5)
  return {
    bytes,
    recommendPng: bytes >= PNG_RECOMMEND_THRESHOLD_BYTES,
    freeBytes,
    sufficientDisk: freeBytes === undefined ? true : freeBytes >= need
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[index]}`
}

/**
 * 写盘前的硬磁盘预检（计划 §5：「写盘前 fs.promises.statfs 要求可用空间 ≥ 预估 ×1.5」）。
 * 之前这一步只在 UI 里作为提示/弹窗存在，主进程本身不拦——绕过 UI 的调用（进口、自动化）
 * 会在写满的盘上跑到一半才报一个无法归因的 FFmpeg 错误。
 *
 * 不强行拦截的情形（估错方向反而造成误拒）：
 *  - pngSequence：它本身就是磁盘紧张时的推荐出口，用 ProRes 口径去量它必然高估；
 *  - directPipe 叠加：不落中间透明 MOV，产物是 H.264，ProRes 系数不适用。
 * 这两种仍由 UI 的预估与安量提示兼顾，但不硬拦。
 */
export interface DiskPrecheckInput {
  kind: 'transparentMov' | 'overlayMp4' | 'pngSequence'
  directPipe: boolean
  width: number
  height: number
  fps: Fps
  frames: number
  freeBytes?: number
  safetyFactor?: number
}

export interface DiskPrecheckResult {
  /** false = 不硬拦（仅提示） */
  enforced: boolean
  requiredBytes: number
  freeBytes?: number
  ok: boolean
  reason?: string
}

export function diskPrecheck(input: DiskPrecheckInput): DiskPrecheckResult {
  const safety = input.safetyFactor ?? 1.5
  const enforced = input.kind !== 'pngSequence' && !(input.kind === 'overlayMp4' && input.directPipe)
  const estimate = estimateProres4444Bytes(input.width, input.height, input.fps, input.frames)
  const requiredBytes = Math.round(estimate * safety)
  if (!enforced) return { enforced, requiredBytes, freeBytes: input.freeBytes, ok: true }
  if (input.freeBytes === undefined) {
    // statfs 不可用：无法判定就不拦，但不能谎称已校验
    return { enforced, requiredBytes, freeBytes: undefined, ok: true, reason: '无法读取目标卷可用空间（statfs 不可用），已跳过硬预检' }
  }
  if (input.freeBytes < requiredBytes) {
    return {
      enforced,
      requiredBytes,
      freeBytes: input.freeBytes,
      ok: false,
      reason: `目标盘可用 ${formatBytes(input.freeBytes)}，不足预估产物 ${formatBytes(estimate)} 的 ${safety} 倍（需 ${formatBytes(requiredBytes)}）`
    }
  }
  return { enforced, requiredBytes, freeBytes: input.freeBytes, ok: true }
}

/** Mbps 显示（标定与验收用）。 */
export function formatMbps(bytes: number, durationSec: number): string {
  if (durationSec <= 0) return '—'
  return `${((bytes * 8) / durationSec / 1e6).toFixed(1)} Mbps`
}
