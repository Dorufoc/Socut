/**
 * M11：字幕格式（SRT / ASS）解析与生成（纯函数）。
 *
 * 用途：
 * - **导入**：把外部字幕（剪辑软件/翻译工具/语音识别产物）落成新闻字幕条；
 * - **导出**：把工程里的字幕条交给审片/翻译/播出系统。
 *
 * 口径：
 * - 内部一律用"秒"（浮点）；不做帧吸附 —— 落到工程时由 store 统一 `snapTimeToFrame`；
 * - 解析宽容：BOM/CRLF/缺序号/时间码用点号代替逗号/ASS 覆盖标签 `{\...}` 都吃；
 * - 解析严格处：时间倒挂、空文本、超长文本的 cue 直接丢弃（返回给调用方"丢弃条数"），不猜。
 */

export type SubtitleFormat = 'srt' | 'ass'

export interface SubtitleCue {
  startSec: number
  endSec: number
  text: string
}

export interface ParseReport {
  cues: SubtitleCue[]
  /** 被丢弃的原始块数（时间非法 / 空文本） */
  dropped: number
}

/** 单条字幕文本上限（工程里也会再夹一次；防止把整篇稿件塞进一条） */
export const MAX_CUE_TEXT_LENGTH = 500

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 去掉标签：SRT 的 `<i>` / ASS 的 `{...}` 覆盖标签（新闻字幕条只保留纯文本） */
function plainText(raw: string, isAss: boolean): string {
  let text = raw
  if (isAss) text = text.replace(/\{[^}]*\}/g, '')
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '')
  if (isAss) text = text.replace(/\\N/gi, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ')
  return text
}

function normalizeCue(startSec: number, endSec: number, rawText: string, isAss: boolean): SubtitleCue | null {
  const text = plainText(rawText, isAss).replace(/\r/g, '').trim()
  if (text.length === 0) return null
  if (text.length > MAX_CUE_TEXT_LENGTH) return null
  if (!(endSec > startSec + 1e-6)) return null
  if (startSec < 0) return null
  return {
    startSec: Math.round(startSec * 1000) / 1000,
    endSec: Math.round(endSec * 1000) / 1000,
    text
  }
}

/** `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` → 秒 */
export function parseSrtTimecode(raw: string): number | null {
  const match = raw
    .trim()
    .match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/)
  if (!match) return null
  const hours = match[1] ? Number(match[1]) : 0
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const fraction = Number((match[4] ?? '0').padEnd(3, '0')) / 1000
  if (minutes > 59 || seconds > 59) return null
  return hours * 3600 + minutes * 60 + seconds + fraction
}

/** `H:MM:SS.cc`（ASS 用两位厘秒）→ 秒 */
export function parseAssTimecode(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[.](\d{1,2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const centis = Number((match[4] ?? '0').padEnd(2, '0')) / 100
  if (minutes > 59 || seconds > 59) return null
  return hours * 3600 + minutes * 60 + seconds + centis
}

/** 解析 SRT。宽容缺序号/CRLF/BOM；返回 cues 与丢弃数。 */
export function parseSrt(raw: string): ParseReport {
  const text = stripBom(raw).replace(/\r\n?/g, '\n')
  const blocks = text.split(/\n{2,}/)
  const cues: SubtitleCue[] = []
  let dropped = 0
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length === 0) continue
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) {
      dropped += 1
      continue
    }
    const [rawStart, rawEnd] = lines[timeIndex]!.split('-->')
    const startSec = rawStart ? parseSrtTimecode(rawStart) : null
    const endSec = rawEnd ? parseSrtTimecode(rawEnd.trim().split(/\s+/)[0] ?? '') : null
    const cue =
      startSec === null || endSec === null ? null : normalizeCue(startSec, endSec, lines.slice(timeIndex + 1).join('\n'), false)
    if (cue) cues.push(cue)
    else dropped += 1
  }
  cues.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  return { cues, dropped }
}

/** 解析 ASS/SSA 的 [Events] 段（只取 Dialogue 行，忽略注释与样式）。 */
export function parseAss(raw: string): ParseReport {
  const text = stripBom(raw).replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const cues: SubtitleCue[] = []
  let dropped = 0
  let inEvents = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      inEvents = trimmed.toLowerCase() === '[events]'
      continue
    }
    if (!inEvents) continue
    if (!trimmed.toLowerCase().startsWith('dialogue:')) continue
    // Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    const parts = trimmed.slice('dialogue:'.length).split(',')
    if (parts.length < 10) {
      dropped += 1
      continue
    }
    const startSec = parseAssTimecode(parts[1] ?? '')
    const endSec = parseAssTimecode(parts[2] ?? '')
    const body = parts.slice(9).join(',')
    const cue = startSec === null || endSec === null ? null : normalizeCue(startSec, endSec, body, true)
    if (cue) cues.push(cue)
    else dropped += 1
  }
  cues.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec)
  return { cues, dropped }
}

/** 自动识别格式：含 `[Events]` 或 Dialogue 行按 ASS，否则按 SRT。 */
export function parseSubtitleFile(raw: string, format?: SubtitleFormat): ParseReport {
  if (format) return format === 'ass' ? parseAss(raw) : parseSrt(raw)
  return /\[events\]/i.test(raw) || /^\s*dialogue:/im.test(raw) ? parseAss(raw) : parseSrt(raw)
}

function pad(value: number, width = 2): string {
  return String(Math.floor(value)).padStart(width, '0')
}

export function formatSrtTimecode(timestampSec: number): string {
  const clamped = Math.max(0, timestampSec)
  const millisTotal = Math.round(clamped * 1000)
  const millis = millisTotal % 1000
  const totalSec = Math.floor(millisTotal / 1000)
  const seconds = totalSec % 60
  const minutes = Math.floor(totalSec / 60) % 60
  const hours = Math.floor(totalSec / 3600)
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`
}

export function formatAssTimecode(timestampSec: number): string {
  const clamped = Math.max(0, timestampSec)
  const centisTotal = Math.round(clamped * 100)
  const centis = centisTotal % 100
  const totalSec = Math.floor(centisTotal / 100)
  const seconds = totalSec % 60
  const minutes = Math.floor(totalSec / 60) % 60
  const hours = Math.floor(totalSec / 3600)
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`
}

/** 生成 SRT（空文本条目跳过；不写 BOM，CRLF 兼容交给使用方）。 */
export function formatSrt(cues: readonly SubtitleCue[]): string {
  const blocks: string[] = []
  let index = 1
  for (const cue of cues) {
    const text = cue.text.replace(/\r/g, '').trim()
    if (text.length === 0 || !(cue.endSec > cue.startSec)) continue
    blocks.push(`${index}\n${formatSrtTimecode(cue.startSec)} --> ${formatSrtTimecode(cue.endSec)}\n${text}`)
    index += 1
  }
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : ''
}

/** 生成一份可直接被 Premiere/Resolve 导入的最小 ASS（样式固定 Default）。 */
export function formatAss(cues: readonly SubtitleCue[], options: { title?: string; fontSize?: number } = {}): string {
  const fontSize = options.fontSize ?? 48
  const header = [
    '[Script Info]',
    `Title: ${options.title ?? 'Socut 字幕'}`,
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans SC,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,1,2,48,48,48,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  const events: string[] = []
  for (const cue of cues) {
    if (!(cue.endSec > cue.startSec)) continue
    const body = cue.text
      .replace(/\r/g, '')
      .replace(/\{/g, '')
      .replace(/\}/g, '')
      .replace(/\n/g, '\\N')
      .trim()
    if (body.length === 0) continue
    events.push(
      `Dialogue: 0,${formatAssTimecode(cue.startSec)},${formatAssTimecode(cue.endSec)},Default,,0,0,0,,${body}`
    )
  }
  return `${[...header, ...events].join('\n')}\n`
}

/** 把工程里的字幕条转成 cue（导出 SRT/ASS 用；标题与副标题用换行拼接）。 */
export function cuesFromClips(
  clips: readonly { startTime: number; endTime: number; content: { title: string; subtitle: string } }[]
): SubtitleCue[] {
  return clips
    .map((clip) => {
      const lines = [clip.content.title.trim(), clip.content.subtitle.trim()].filter((line) => line.length > 0)
      return { startSec: clip.startTime, endSec: clip.endTime, text: lines.join('\n') }
    })
    .filter((cue) => cue.text.length > 0 && cue.endSec > cue.startSec)
    .sort((a, b) => a.startSec - b.startSec)
}
