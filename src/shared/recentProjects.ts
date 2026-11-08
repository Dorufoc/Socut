import type { Fps, Project, Resolution } from './types'

/**
 * 最近工程（启动页）共享口径。
 *
 * 这里只放**纯函数与类型**：主进程写索引、渲染进程读卡片、测试断言三边共用同一份规则，
 * 避免「日期命名」和「括号序号」在两个进程里各写一遍然后慢慢跑偏。
 *
 * 记录保存位置：userData/projects/history.json（由主进程原子写）。
 * 封面保存位置：userData/covers/<entryId>.png（由 socut-cover:// 协议读取）。
 */

export const RECENT_HISTORY_VERSION = 1
/** 自动存档（未另存的当前工程）在历史里的固定 id */
export const AUTOSAVE_ENTRY_ID = 'autosave'
/** 历史最多保留的工程数（按最近使用时间淘汰） */
export const RECENT_PROJECT_LIMIT = 60
/** 工程名长度上限（与文件基名保持同一口径，避免重命名后文件名不可用） */
export const RECENT_PROJECT_NAME_MAX = 60
/** 合法的 entryId：自动存档固定值，或由路径哈希得到的 p + 16 位十六进制 */
export const RECENT_ENTRY_ID_PATTERN = /^(autosave|p[0-9a-f]{16})$/

export type RecentProjectSource = 'file' | 'autosave'
/** 默认按最近使用；name 为工程名字母序（中文按拼音排序） */
export type RecentSortMode = 'recent' | 'name'

/** 工程卡片上展示的只读统计信息（列表里不读整份工程，索引里直接存） */
export interface RecentProjectStats {
  resolution: Resolution
  fps: Fps
  clipCount: number
  mediaCount: number
  audioClipCount: number
}

export interface RecentProjectEntry extends RecentProjectStats {
  /** 稳定主键：文件工程 = 路径哈希；自动存档 = 'autosave' */
  id: string
  name: string
  source: RecentProjectSource
  /** 文件工程为绝对路径；自动存档为 null */
  filePath: string | null
  /** 第一次出现在历史里的时间（ISO） */
  createdAt: string
  /** 工程内容最后一次保存/修改时间（ISO） */
  modifiedAt: string
  /** 最后一次打开时间（ISO）；默认排序用它 */
  lastOpenedAt: string
  /** 是否已有封面图（covers/<id>.png） */
  hasCover: boolean
  /** 用户是否手动改过名字（改过之后不再自动套日期名） */
  nameCustomized: boolean
}

/** 渲染进程拿到的卡片：在索引条目上补「文件是否还在」与可直接放进 <img> 的地址 */
export interface RecentProjectCard extends RecentProjectEntry {
  missing: boolean
  coverUrl: string | null
}

export interface RecentHistoryFile {
  version: number
  entries: RecentProjectEntry[]
}

/** 索引文件解析结果（坏 JSON / 坏条目一律丢弃，不让一条脏数据带垮启动页） */
export function normalizeRecentHistory(raw: unknown): RecentHistoryFile {
  const source = Array.isArray(raw)
    ? { version: RECENT_HISTORY_VERSION, entries: raw }
    : isRecord(raw)
      ? { version: raw['version'], entries: raw['entries'] }
      : null
  if (!source) return { version: RECENT_HISTORY_VERSION, entries: [] }
  const entriesRaw = Array.isArray(source.entries) ? source.entries : []
  const seen = new Set<string>()
  const entries: RecentProjectEntry[] = []
  for (const item of entriesRaw) {
    const entry = normalizeEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
    if (entries.length >= RECENT_PROJECT_LIMIT * 4) break
  }
  return {
    version: RECENT_HISTORY_VERSION,
    entries: sortRecentProjects(entries, 'recent')
  }
}

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z'

function normalizeEntry(raw: unknown): RecentProjectEntry | null {
  if (!isRecord(raw)) return null
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (!RECENT_ENTRY_ID_PATTERN.test(id)) return null
  const source: RecentProjectSource = raw['source'] === 'autosave' ? 'autosave' : 'file'
  const filePath = source === 'autosave' ? null : typeof raw['filePath'] === 'string' && raw['filePath'].length > 0 ? raw['filePath'] : null
  if (source === 'file' && !filePath) return null
  const createdAt = isoOr(raw['createdAt'], FALLBACK_TIMESTAMP)
  const modifiedAt = isoOr(raw['modifiedAt'], createdAt)
  const lastOpenedAt = isoOr(raw['lastOpenedAt'], modifiedAt)
  return {
    id,
    name: normalizeName(raw['name'], source === 'autosave' ? '上次编辑' : '未命名工程'),
    source,
    filePath,
    createdAt,
    modifiedAt,
    lastOpenedAt,
    resolution: normalizeResolution(raw['resolution']),
    fps: normalizeFps(raw['fps']),
    clipCount: countOr(raw['clipCount']),
    mediaCount: countOr(raw['mediaCount']),
    audioClipCount: countOr(raw['audioClipCount']),
    hasCover: raw['hasCover'] === true,
    nameCustomized: raw['nameCustomized'] === true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function countOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function isoOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback
}

function normalizeResolution(value: unknown): Resolution {
  if (!isRecord(value)) return { width: 1920, height: 1080 }
  const width = Math.max(16, Math.round(countOr(value['width']) || 1920))
  const height = Math.max(16, Math.round(countOr(value['height']) || 1080))
  return { width, height }
}

function normalizeFps(value: unknown): Fps {
  if (isRecord(value)) {
    const num = Math.round(countOr(value['num']))
    const den = Math.round(countOr(value['den']))
    if (num > 0 && den > 0) return { num, den }
  }
  return { num: 25, den: 1 }
}

function normalizeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const cleaned = clampProjectName(value)
  return cleaned.length > 0 ? cleaned : fallback
}

/** 工程名清洗：去控制字符、折叠空白、限长；空字符串表示非法。 */
export function clampProjectName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RECENT_PROJECT_NAME_MAX)
}

/** 工程是否值得出现在启动页（与 App 冷启动恢复判据同源：任意一轨有内容或启用水印）。 */
export function projectHasProgress(project: Project): boolean {
  return (
    project.clips.length > 0 ||
    project.mediaClips.length > 0 ||
    (project.audioClips?.length ?? 0) > 0 ||
    project.watermark?.enabled === true
  )
}

export function projectStats(project: Project): RecentProjectStats {
  return {
    resolution: { width: project.resolution.width, height: project.resolution.height },
    fps: { num: project.fps.num, den: project.fps.den },
    clipCount: project.clips.length,
    mediaCount: project.media.length,
    audioClipCount: project.audioClips?.length ?? 0
  }
}

/** 默认工程名：本地日期 YYYY-MM-DD（与「同一天第二个工程加括号一」的规则配套）。 */
export function formatDefaultProjectName(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const

/** 1..99 的中文序号（选择「一、二、三」而不是阿拉伯数字，是需求里的括号写法）。 */
function chineseOrdinal(value: number): string {
  if (value < 10) return CN_DIGITS[value] ?? String(value)
  if (value < 20) return value === 10 ? '十' : `十${CN_DIGITS[value - 10] ?? ''}`
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    return `${CN_DIGITS[tens] ?? ''}十${ones === 0 ? '' : (CN_DIGITS[ones] ?? '')}`
  }
  return String(value)
}

/**
 * 同名工程自动加括号序号：基名空闲就用基名，否则依次试「（一）」「（二）」……
 * 只认**完全相等**的名字；中间被删掉一个不会重排已有序号（用户已经认得的名字不跳变）。
 */
export function nextProjectName(baseName: string, existingNames: readonly string[]): string {
  const base = clampProjectName(baseName) || formatDefaultProjectName(new Date())
  const taken = new Set(existingNames.map((name) => clampProjectName(name)))
  if (!taken.has(base)) return base
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${base}（${chineseOrdinal(index)}）`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}（${Date.now()}）`
}

/** 工程路径 → 稳定 id。Windows 下大小写不敏感，统一小写并归一斜杠，避免同一文件两条记录。 */
export function recentEntryIdForPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= Math.imul(code + index, 0x85ebca6b) >>> 0
    h2 = (Math.imul(h2, 0xc2b2ae35) ^ (h2 >>> 13)) >>> 0
  }
  return `p${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

const NAME_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function timeOf(entry: RecentProjectEntry, field: 'createdAt' | 'modifiedAt' | 'lastOpenedAt'): number {
  const time = Date.parse(entry[field])
  return Number.isFinite(time) ? time : 0
}

/**
 * 排序：
 * - recent（默认）：按最近使用倒序；同一时刻再按修改时间、名字兜底，保证顺序稳定。
 * - name：工程名字母序（中文按拼音、数字按大小）；同名再按最近使用倒序。
 */
export function sortRecentProjects<T extends RecentProjectEntry>(entries: readonly T[], mode: RecentSortMode): T[] {
  const copy = [...entries]
  if (mode === 'name') {
    copy.sort((a, b) => {
      const byName = NAME_COLLATOR.compare(a.name, b.name)
      if (byName !== 0) return byName
      return timeOf(b, 'lastOpenedAt') - timeOf(a, 'lastOpenedAt')
    })
    return copy
  }
  copy.sort((a, b) => {
    const byOpened = timeOf(b, 'lastOpenedAt') - timeOf(a, 'lastOpenedAt')
    if (byOpened !== 0) return byOpened
    const byModified = timeOf(b, 'modifiedAt') - timeOf(a, 'modifiedAt')
    if (byModified !== 0) return byModified
    return NAME_COLLATOR.compare(a.name, b.name)
  })
  return copy
}

/** 搜索只是过滤，不改排序；空查询返回原顺序的副本。 */
export function filterRecentProjects<T extends RecentProjectEntry>(entries: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...entries]
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle))
}

/** 卡片封面地址：带版本参数，封面重拍后立即失效（协议侧 no-cache）。 */
export function coverUrlFor(entry: Pick<RecentProjectEntry, 'id' | 'hasCover' | 'modifiedAt'>): string | null {
  if (!entry.hasCover) return null
  const version = Date.parse(entry.modifiedAt)
  return `socut-cover://${entry.id}?v=${Number.isFinite(version) ? version : 0}`
}
