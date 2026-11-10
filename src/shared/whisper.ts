/**
 * M11：Whisper 字幕（whisper.cpp）的纯口径 —— argv、结果解析、cue 规划。
 *
 * 设计前提：**离线交付纪律**下不联网、不自动下载模型；二进制与模型都由用户/安装包提供。
 * 所以本模块只负责：
 * - 参数 → whisper.cpp 命令行（`-m` 模型、`-f` 音频、`-oj` JSON 输出、线程/语言/翻译）；
 * - whisper.cpp JSON → 内部 cue（时间码/文本/丢弃策略）；
 * - 把 ASR 片段整理成新闻字幕条可用的 cue（短片段合并、长片段按字符比例切分）。
 *
 * 主进程的进程管理与配置落盘在 `src/main/whisper.ts`；渲染侧只消费 cue（复用 M11 的
 * `addCaptionsFromCues`，所以"识别结果"和"导入 SRT"走同一条落库路径）。
 */

export interface WhisperSegment {
  startSec: number
  endSec: number
  text: string
}

export interface WhisperResult {
  segments: WhisperSegment[]
  /** whisper.cpp 自动检测到的语言（可能没有） */
  language?: string
  /** 被丢弃的片段数（时间非法/空文本/超长） */
  dropped: number
}

export interface WhisperTranscribeOptions {
  /** 模型文件（ggml-*.bin） */
  modelPath: string
  /** 音频/视频输入（whisper.cpp 内部用 ffmpeg 解码，故直接喂视频也行） */
  mediaPath: string
  /** 语言代码（zh/en/…；缺省自动检测） */
  language?: string
  /** 翻译成英文（`-tr`） */
  translate?: boolean
  /** 线程数（缺省 4） */
  threads?: number
  /** 输出 JSON 的临时基线路径（不带扩展名；whisper.cpp 会写 `<base>.json`） */
  outputBase?: string
}

export const WHISPER_MAX_SEGMENT_TEXT = 500

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, number))
}

/** whisper.cpp 命令行参数（不含可执行文件本身；顺序稳定，便于测试与日志）。 */
export function buildWhisperArgs(options: WhisperTranscribeOptions): string[] {
  const args = [
    '-m',
    options.modelPath,
    '-f',
    options.mediaPath,
    '-oj',
    '-of',
    options.outputBase ?? 'whisper-out',
    '-t',
    String(Math.round(clampNumber(options.threads, 4, 1, 64))),
    // -np：只输出结果（压掉加载模型的噪声日志）；-pp：进度打 stderr。
    // 二者可共存；没有 -pp 时 whisper.cpp 默认**不打印进度**，主进程的进度回调会一直不动
    // （真机验收抓到的：以前只传 -np，进度永远 0）。
    '-np',
    '-pp'
  ]
  if (options.language && options.language.trim().length > 0) args.push('-l', options.language.trim())
  if (options.translate === true) args.push('-tr')
  return args
}

/** 归一化单条片段：去标签/空白、夹时间、丢非法；无字幕内容的 `[BLANK_AUDIO]` 之类丢弃。 */
export function normalizeWhisperSegment(segment: WhisperSegment): WhisperSegment | null {
  const text = segment.text
    .replace(/\r/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0 || text.length > WHISPER_MAX_SEGMENT_TEXT) return null
  const startSec = Number(segment.startSec)
  const endSec = Number(segment.endSec)
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null
  if (!(endSec > startSec + 1e-6) || startSec < 0) return null
  return { startSec: Math.round(startSec * 1000) / 1000, endSec: Math.round(endSec * 1000) / 1000, text }
}

/** `00:00:01,250` / `00:00:01.250` → 秒。 */
function parseTimecode(raw: string): number | null {
  const match = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!match) return null
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number((match[4] ?? '0').padEnd(3, '0')) / 1000
  )
}

/**
 * 毫秒口径（whisper.cpp 原生 `offsets: { from, to }`）。
 *
 * **真机踩过的坑**：真二进制输出的是**数字**毫秒（`"to": 5500`），而假 sidecar 的夹具
 * 写成了**字符串**；旧实现把数字当秒，一条 8s 音频识别成 5500s，cue 直接飞出色带。
 */
function parseMilliseconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw / 1000
  if (typeof raw === 'string') {
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) / 1000
    return parseTimecode(raw)
  }
  return null
}

/** 秒口径（简化 JSON 的 `startSec/endSec`、裸数组的 `start/from`）。 */
function parseSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw)
    return parseTimecode(raw)
  }
  return null
}

interface RawWhisperSegment {
  fromMs?: unknown
  toMs?: unknown
  fromSec?: unknown
  toSec?: unknown
  text?: unknown
}

function rawSegmentsOf(parsed: unknown): RawWhisperSegment[] {
  if (Array.isArray(parsed)) return parsed as RawWhisperSegment[]
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    for (const key of ['transcription', 'segments']) {
      const value = record[key]
      if (Array.isArray(value)) return value as RawWhisperSegment[]
    }
  }
  return []
}

function rawSegmentToCue(raw: RawWhisperSegment): WhisperSegment | null {
  const record = raw as Record<string, unknown>
  const text = typeof record['text'] === 'string' ? record['text'] : ''
  // whisper.cpp: { timestamps: { from: "00:00:00,000", to: … }, offsets: { from: 0, to: 1200 } }
  const timestamps =
    typeof record['timestamps'] === 'object' && record['timestamps'] !== null
      ? (record['timestamps'] as Record<string, unknown>)
      : null
  const offsets =
    typeof record['offsets'] === 'object' && record['offsets'] !== null
      ? (record['offsets'] as Record<string, unknown>)
      : null
  // 按"单位明确"的顺序取值：offsets 是毫秒，timestamps 是时间码，简化形态是秒。
  const startCandidates: Array<[unknown, 'ms' | 'sec']> = [
    [offsets?.['from'], 'ms'],
    [timestamps?.['from'], 'ms'],
    [record['startSec'], 'sec'],
    [record['start'], 'sec'],
    [record['from'], 'sec']
  ]
  const endCandidates: Array<[unknown, 'ms' | 'sec']> = [
    [offsets?.['to'], 'ms'],
    [timestamps?.['to'], 'ms'],
    [record['endSec'], 'sec'],
    [record['end'], 'sec'],
    [record['to'], 'sec']
  ]
  let startSec: number | null = null
  let endSec: number | null = null
  for (const [candidate, unit] of startCandidates) {
    startSec = unit === 'ms' ? parseMilliseconds(candidate) : parseSeconds(candidate)
    if (startSec !== null) break
  }
  for (const [candidate, unit] of endCandidates) {
    endSec = unit === 'ms' ? parseMilliseconds(candidate) : parseSeconds(candidate)
    if (endSec !== null) break
  }
  if (startSec === null || endSec === null) return null
  return normalizeWhisperSegment({ startSec, endSec, text })
}

/**
 * 解析 whisper.cpp `-oj` 的输出 JSON。
 *
 * 支持两种形态：
 * 1. whisper.cpp 原生：`{ transcription: [{ timestamps, offsets, text }], result: { language } }`；
 * 2. 简化：`{ segments: [{ startSec, endSec, text }] }` 或裸数组（测试/其他工具）。
 */
export function parseWhisperJson(raw: string): WhisperResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { segments: [], dropped: 0 }
  }
  const list = rawSegmentsOf(parsed)
  const segments: WhisperSegment[] = []
  let dropped = 0
  for (const item of list) {
    const segment = rawSegmentToCue(item)
    if (segment) segments.push(segment)
    else dropped += 1
  }
  segments.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  const record = parsed as Record<string, unknown>
  const result = typeof record['result'] === 'object' && record['result'] !== null ? (record['result'] as Record<string, unknown>) : null
  const language =
    typeof result?.['language'] === 'string'
      ? result['language']
      : typeof record['language'] === 'string'
        ? record['language']
        : undefined
  return { segments, ...(language ? { language } : {}), dropped }
}

/**
 * ASR 片段 → cue（新闻字幕条口径）：
 * - 过短片段（< minDurationSec）向后合并到相邻段，避免"闪一下就没"；
 * - 过长片段（> maxDurationSec 或文字过长）按字符比例切分，切点落在标点/空格附近；
 * - 全部按时间升序、去重叠（后一段入点不早于前一段出点）。
 */
export function planCuesFromSegments(
  segments: readonly WhisperSegment[],
  options: { minDurationSec?: number; maxDurationSec?: number; maxChars?: number } = {}
): WhisperSegment[] {
  const minDuration = options.minDurationSec ?? 1
  const maxDuration = options.maxDurationSec ?? 8
  const maxChars = options.maxChars ?? 40
  const ordered = [...segments]
    .map((segment) => normalizeWhisperSegment(segment))
    .filter((segment): segment is WhisperSegment => segment !== null)
    .sort((a, b) => a.startSec - b.startSec)

  // 1) 合并：只把**短片段**并到相邻段（避免"闪一下就没"的碎句），长句保持原样；
  //    合并后仍受总时长与字符数上限约束。
  const merged: WhisperSegment[] = []
  for (const segment of ordered) {
    const last = merged[merged.length - 1]
    const short = (item: WhisperSegment): boolean =>
      item.endSec - item.startSec < minDuration || item.text.length < 8
    if (
      last &&
      short(last) &&
      short(segment) &&
      segment.startSec - last.endSec <= minDuration / 2 &&
      segment.endSec - last.startSec <= maxDuration &&
      last.text.length + segment.text.length + 1 <= maxChars
    ) {
      last.endSec = segment.endSec
      last.text = `${last.text} ${segment.text}`.trim()
    } else {
      merged.push({ ...segment })
    }
  }

  // 2) 切分：超时长或超字符的段按比例切成 2..N 条
  const cues: WhisperSegment[] = []
  for (const segment of merged) {
    const duration = segment.endSec - segment.startSec
    const parts = Math.max(
      1,
      Math.min(
        Math.ceil(duration / maxDuration),
        Math.max(1, Math.ceil(segment.text.length / maxChars)),
        Math.max(1, Math.ceil(duration / Math.max(0.5, minDuration)))
      )
    )
    if (parts <= 1) {
      cues.push(segment)
      continue
    }
    const words = segment.text.split(/(?<=[，。！？；,.!?;])|\s+/).filter((word) => word.length > 0)
    const perPart = Math.ceil(words.length / parts)
    for (let index = 0; index < parts; index += 1) {
      const text = words.slice(index * perPart, (index + 1) * perPart).join(' ').trim()
      if (text.length === 0) continue
      const startSec = segment.startSec + (duration * index) / parts
      const endSec = segment.startSec + (duration * (index + 1)) / parts
      cues.push({ startSec, endSec, text })
    }
  }

  // 3) 去重叠（后段入点夹到前段出点）
  for (let index = 1; index < cues.length; index += 1) {
    const previous = cues[index - 1]!
    const current = cues[index]!
    if (current.startSec < previous.endSec) current.startSec = previous.endSec
    if (!(current.endSec > current.startSec + 1e-6)) current.endSec = current.startSec + Math.min(minDuration, 1)
  }
  return cues
}