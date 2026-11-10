import type { MediaClip } from '@shared/types'
import type { WhisperSegment } from '@shared/whisper'

/**
 * M11：自动字幕的「源时间 → 工程时间轴」映射（纯函数，面板与测试共用）。
 *
 * whisper 转写的是**整份媒体文件**，返回的 cue 时间相对文件起点；而选中片段可能是
 * 剪切 + 变速过的（`sourceInSec` 入点、`speed` 倍速）。口径：
 *
 *   timelineSec = clip.timelineStartSec + (cueSec - clip.sourceInSec) / speed
 *
 * 注意倍速是**源窗口不变、时间轴长度随倍速伸缩**（见 shared/types 的 MediaClip/ClipSpeed），
 * 所以除以 speed，不能写成 `timelineStartSec - sourceInSec`（那只对 1x 成立）。
 *
 * 落库前还做两件事：
 * 1. 裁剪到片段窗口 `[timelineStartSec, timelineEndSec]`——避免一个长素材的全文都堆进时间轴；
 * 2. 丢空文本与裁剪后没有正时长的条目（完全落在窗口外的 cue 自然被丢掉）。
 */

export interface CaptionAutoWindow {
  /** 片段在时间轴上的起止（秒） */
  timelineStartSec: number
  timelineEndSec: number
  /** 片段读取源文件的入点（秒） */
  sourceInSec: number
  /** 倍速（缺省 1 = 原速；必须为正，非法值按 1 处理） */
  speed?: number
}

/** 从媒体片段取映射窗口（speed 缺省不落盘 → 默认 1）。 */
export function captionAutoWindowOf(
  clip: Pick<MediaClip, 'timelineStartSec' | 'timelineEndSec' | 'sourceInSec' | 'speed'>
): CaptionAutoWindow {
  return {
    timelineStartSec: clip.timelineStartSec,
    timelineEndSec: clip.timelineEndSec,
    sourceInSec: clip.sourceInSec,
    ...(clip.speed ? { speed: clip.speed.speed } : {})
  }
}

/** 保留 3 位小数，避免浮点尾数在断言/工程文件里噪音。 */
function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function planCaptionAutoCues(
  cues: ReadonlyArray<WhisperSegment>,
  window: CaptionAutoWindow
): WhisperSegment[] {
  const speed = typeof window.speed === 'number' && Number.isFinite(window.speed) && window.speed > 0 ? window.speed : 1
  const windowStart = window.timelineStartSec
  const windowEnd = window.timelineEndSec
  const planned: WhisperSegment[] = []
  for (const cue of cues) {
    const text = cue.text.replace(/\s+/g, ' ').trim()
    if (text.length === 0) continue
    const startSec = roundSec(windowStart + (cue.startSec - window.sourceInSec) / speed)
    const endSec = roundSec(windowStart + (cue.endSec - window.sourceInSec) / speed)
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue
    // 裁剪到片段窗口：完全在窗口外 / 裁剪后没有正时长 → 丢弃
    const clampedStart = Math.max(startSec, windowStart)
    const clampedEnd = Math.min(endSec, windowEnd)
    if (!(clampedEnd > clampedStart + 1e-6)) continue
    planned.push({ startSec: clampedStart, endSec: clampedEnd, text })
  }
  return planned.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
}
