import type { Fps } from './types'
import { frameTimeSec, timeToFrameNearest } from './fps'

const pad = (n: number, width = 2): string => String(Math.trunc(n)).padStart(width, '0')

/** 秒 → SMPTE 风格时间码 HH:MM:SS:FF（帧号按当前帧率取整）。 */
export function secondsToTimecode(sec: number, fps: Fps, withFrames = true): string {
  const clamped = Math.max(0, sec)
  const totalFrames = Math.round((clamped * fps.num) / fps.den)
  const fpsInt = Math.max(1, Math.round(fps.num / fps.den))
  const frames = totalFrames % fpsInt
  const totalSeconds = Math.floor(totalFrames / fpsInt)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`
  return withFrames ? `${base}:${pad(frames)}` : base
}

/** 时间码 → 秒（帧号按当前帧率折算）。 */
export function timecodeToSeconds(tc: string, fps: Fps): number | null {
  const parts = tc.trim().split(/[:;s]/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  const [h, m, s] = parts.map(Number)
  if (h === undefined || m === undefined || s === undefined) return null
  if ([h, m, s].some((v) => !Number.isFinite(v) || v < 0)) return null
  const frames = parts.length === 4 ? Number(parts[3]) ?? 0 : 0
  const totalFrames = Math.round(((h * 3600 + m * 60 + s) * fps.num) / fps.den) + (Number.isFinite(frames) ? frames : 0)
  return frameTimeSec(Math.max(0, totalFrames), fps)
}

/** 紧凑时长显示：12.34s / 1:03（大于一分钟按整秒四舍五入，不会出现 1:60） */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0.00s'
  if (sec < 60) return `${sec.toFixed(2)}s`
  const totalSeconds = Math.round(sec)
  return `${Math.floor(totalSeconds / 60)}:${pad(totalSeconds % 60, 2)}`
}

/** 帧序号 → 时间码（预览与时间轴刻度共用）。 */
export function frameToTimecode(frame: number, fps: Fps): string {
  return secondsToTimecode(frameTimeSec(frame, fps), fps)
}

/** 输入时间（秒）吸附后格式化，UI 展示与存储一致。 */
export function snappedTimeToTimecode(sec: number, fps: Fps): string {
  return secondsToTimecode(frameTimeSec(timeToFrameNearest(sec, fps), fps), fps)
}
