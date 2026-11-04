import { LineBuffer } from './lineBuffer'

/**
 * `-progress pipe:1` 解析器（规格 §5.3）。
 * 纪律：
 * - 自行缓冲行边界（chunk 可能把一行切断）；
 * - 只采信 out_time_us（out_time_ms 在部分版本里同为微秒语义，一律忽略以免误用）；
 * - frame/speed/logLine 仅用于诊断，不作为进度依据。
 */

export interface ProgressSnapshot {
  /** 已输出时长（微秒），未到达时为 0 */
  outTimeUs: number
  /** FFmpeg 报告的已编码帧数（诊断用） */
  ffmpegFrames: number | null
  /** 瞬时速度（诊断用，如 "12.4x"） */
  speed: string | null
  /** progress=end：编码收尾完成 */
  ended: boolean
  /** 自上次快照以来是否有 out_time_us 更新 */
  updated: boolean
}

const EMPTY: ProgressSnapshot = {
  outTimeUs: 0,
  ffmpegFrames: null,
  speed: null,
  ended: false,
  updated: false
}

export class ProgressParser {
  private readonly lines = new LineBuffer()
  private snapshot: ProgressSnapshot = { ...EMPTY }

  feed(chunk: Buffer | string): ProgressSnapshot | null {
    const arrived = this.lines.push(chunk)
    return this.consume(arrived)
  }

  /** 流结束：处理没有换行结尾的最后一行。 */
  finish(): ProgressSnapshot | null {
    return this.consume(this.lines.flush())
  }

  current(): ProgressSnapshot {
    return this.snapshot
  }

  private consume(lines: string[]): ProgressSnapshot | null {
    if (lines.length === 0) return null
    let updated = false
    let ended = this.snapshot.ended
    for (const line of lines) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      switch (key) {
        case 'out_time_us': {
          const us = Number(value)
          if (Number.isFinite(us) && us >= 0 && us !== this.snapshot.outTimeUs) {
            this.snapshot = { ...this.snapshot, outTimeUs: us, updated: true }
            updated = true
          }
          break
        }
        case 'frame': {
          const frames = Number(value)
          if (Number.isFinite(frames)) this.snapshot = { ...this.snapshot, ffmpegFrames: frames }
          break
        }
        case 'speed':
          this.snapshot = { ...this.snapshot, speed: value }
          break
        case 'progress':
          if (value === 'end') ended = true
          break
        default:
          // out_time_ms / bitrate / total_size 等一律忽略（规格 §5.3 只用 out_time_us）
          break
      }
    }
    if (ended) {
      this.snapshot = { ...this.snapshot, ended }
      return this.snapshot
    }
    return updated ? this.snapshot : null
  }
}

/** 由 out_time_us 与总时长换算比例（0~1，超出视为 1）。 */
export function outTimeRatio(outTimeUs: number, totalDurationSec: number): number {
  if (totalDurationSec <= 0) return 0
  return Math.min(1, Math.max(0, outTimeUs / (totalDurationSec * 1e6)))
}
