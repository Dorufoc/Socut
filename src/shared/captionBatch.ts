import { snapTimeToFrame } from './fps'
import type { Fps } from './types'

/**
 * M11：批量名单 → 字幕条序列（纯函数）。
 *
 * 新闻场景的高频动作：一份采访名单 / 通稿（10–30 条人名+职务）要在一分钟内变成
 * 一串字幕条。CSV / JSON / 纯文本三种输入足够覆盖记者与编辑手里的材料形态。
 *
 * 纪律：
 * - 不猜时间：每条时长 = 行内 duration（缺省用 defaultDurationSec），按顺序首尾相接（可留 gap）；
 * - 时间吸附到帧边界（工程统一口径），入点从 startSec 起；
 * - 上限保护：一次最多 500 条，标题 ≤200 字；空行/空标题丢弃（返回 dropped 计数）。
 */

export interface CaptionRow {
  title: string
  subtitle: string
  /** 该条持续秒数（缺省 = 调用方 defaultDurationSec） */
  durationSec?: number
}

export type CaptionListFormat = 'csv' | 'json' | 'lines' | 'auto'

export interface CaptionRowReport {
  rows: CaptionRow[]
  dropped: number
}

export const MAX_BATCH_ROWS = 500
export const MAX_ROW_TITLE_LENGTH = 200
export const MAX_ROW_SUBTITLE_LENGTH = 200

function clampRow(row: CaptionRow): CaptionRow | null {
  const title = row.title.replace(/\r/g, '').trim().slice(0, MAX_ROW_TITLE_LENGTH)
  if (title.length === 0) return null
  const subtitle = row.subtitle.replace(/\r/g, '').trim().slice(0, MAX_ROW_SUBTITLE_LENGTH)
  return {
    title,
    subtitle,
    ...(row.durationSec !== undefined && Number.isFinite(row.durationSec) && row.durationSec > 0
      ? { durationSec: row.durationSec }
      : {})
  }
}

/** CSV 单行拆分（支持双引号包裹与 `""` 转义；不做跨行字段——名单场景不需要） */
function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',' || char === '\t') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

const HEADER_HINTS = ['标题', '主标题', 'title', 'name', '姓名', '人名', '副标题', 'subtitle', '时长', 'duration']

/** 表头判定：**整格精确匹配**（不能用 includes，否则"有效标题"这种正常数据会被当表头丢掉） */
function looksLikeHeader(cells: string[]): boolean {
  return cells.some((cell) => HEADER_HINTS.includes(cell.trim().toLowerCase()))
}

/** 解析 CSV/TSV：列顺序 = 标题, 副标题(可空), 时长(秒，可空)；首行是表头时跳过。 */
export function parseCaptionCsv(raw: string): CaptionRowReport {
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim().length > 0)
  const rows: CaptionRow[] = []
  let dropped = 0
  let headerSkipped = false
  for (const line of lines) {
    if (rows.length >= MAX_BATCH_ROWS) break
    const cells = splitCsvLine(line)
    if (!headerSkipped && looksLikeHeader(cells)) {
      headerSkipped = true
      continue
    }
    const row = clampRow({
      title: cells[0] ?? '',
      subtitle: cells[1] ?? '',
      ...(cells[2] !== undefined && cells[2].length > 0 ? { durationSec: Number(cells[2]) } : {})
    })
    if (row) rows.push(row)
    else dropped += 1
  }
  return { rows, dropped }
}

/** 解析 JSON：`["标题", ...]` 或 `[{ title, subtitle?, durationSec? }, ...]`；也接受 `{ rows: [...] }`。 */
export function parseCaptionJson(raw: string): CaptionRowReport {
  const rows: CaptionRow[] = []
  let dropped = 0
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { rows: [], dropped: 0 }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
      ? ((parsed as { rows: unknown[] }).rows)
      : []
  for (const item of list) {
    if (rows.length >= MAX_BATCH_ROWS) break
    if (typeof item === 'string') {
      const row = clampRow({ title: item, subtitle: '' })
      if (row) rows.push(row)
      else dropped += 1
      continue
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const title = typeof record['title'] === 'string' ? record['title'] : typeof record['name'] === 'string' ? record['name'] : ''
      const subtitle = typeof record['subtitle'] === 'string' ? record['subtitle'] : ''
      const durationSec = typeof record['durationSec'] === 'number' ? record['durationSec'] : undefined
      const row = clampRow({ title, subtitle, ...(durationSec !== undefined ? { durationSec } : {}) })
      if (row) rows.push(row)
      else dropped += 1
      continue
    }
    dropped += 1
  }
  return { rows, dropped }
}

/** 纯文本：一行一条标题（副标题留空）。 */
export function parseCaptionLines(raw: string): CaptionRowReport {
  const rows: CaptionRow[] = []
  let dropped = 0
  for (const line of raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')) {
    if (rows.length >= MAX_BATCH_ROWS) break
    if (line.trim().length === 0) continue
    const row = clampRow({ title: line, subtitle: '' })
    if (row) rows.push(row)
    else dropped += 1
  }
  return { rows, dropped }
}

export function parseCaptionRows(raw: string, format: CaptionListFormat = 'auto'): CaptionRowReport {
  const resolved =
    format === 'auto'
      ? /^\s*[[{]/.test(raw)
        ? 'json'
        : raw.includes(',') || raw.includes('\t')
          ? 'csv'
          : 'lines'
      : format
  if (resolved === 'json') return parseCaptionJson(raw)
  if (resolved === 'csv') return parseCaptionCsv(raw)
  return parseCaptionLines(raw)
}

export interface PlannedCaptionClip {
  title: string
  subtitle: string
  startTime: number
  endTime: number
}

export interface PlanCaptionOptions {
  fps: Fps
  /** 第一条的入点（秒） */
  startSec?: number
  /** 行内没有 duration 时的缺省时长（秒） */
  defaultDurationSec?: number
  /** 相邻两条之间的空隙（秒） */
  gapSec?: number
}

/**
 * 名单 → 首尾相接的字幕条序列（帧对齐）。
 * duration 会被夹到 ≥0.2s（工程最短字幕时长）；gap 也吸附帧边界。
 */
export function planCaptionClips(rows: readonly CaptionRow[], options: PlanCaptionOptions): PlannedCaptionClip[] {
  const fps = options.fps
  const gap = Math.max(0, snapTimeToFrame(options.gapSec ?? 0, fps))
  const minDuration = 0.2
  let cursor = Math.max(0, snapTimeToFrame(options.startSec ?? 0, fps))
  const plan: PlannedCaptionClip[] = []
  for (const row of rows) {
    const duration = Math.max(minDuration, row.durationSec ?? options.defaultDurationSec ?? 5)
    const startTime = snapTimeToFrame(cursor, fps)
    const endTime = snapTimeToFrame(startTime + duration, fps)
    if (!(endTime > startTime)) continue
    plan.push({ title: row.title, subtitle: row.subtitle, startTime, endTime })
    cursor = snapTimeToFrame(endTime + gap, fps)
  }
  return plan
}
