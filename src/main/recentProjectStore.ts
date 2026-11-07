import fs from 'node:fs/promises'
import path from 'node:path'
import { AUTOSAVE_BACKUP_FILE, AUTOSAVE_FILE, RECENT_HISTORY_FILE } from '../shared/constants'
import {
  AUTOSAVE_ENTRY_ID,
  RECENT_ENTRY_ID_PATTERN,
  RECENT_HISTORY_VERSION,
  RECENT_PROJECT_LIMIT,
  clampProjectName,
  coverUrlFor,
  formatDefaultProjectName,
  nextProjectName,
  normalizeRecentHistory,
  projectHasProgress,
  projectStats,
  recentEntryIdForPath,
  sortRecentProjects,
  type RecentHistoryFile,
  type RecentProjectCard,
  type RecentProjectEntry
} from '../shared/recentProjects'
import { PROJECT_FILE_EXTENSION, createDefaultProject } from '../shared/projectSchema'
import type { Project } from '../shared/types'
import type { OpenProjectResult } from '../shared/api'
import { projectsDir, userCoverPath, userCoversDir } from './paths'
import { atomicWrite, autosaveRead, autosaveStat, autosaveWrite, readProjectFile } from './projectStore'
import { log } from './log'

/**
 * 最近工程索引（启动页）。
 *
 * 索引文件：userData/projects/history.json（原子写）。
 * 自动存档归属：userData/projects/autosave.owner.json —— 记录「退出时打开的是哪个文件工程」，
 * 避免下次启动把同一份草稿再显示成一张 'autosave' 卡片。
 *
 * 所有会改索引/归属/封面的操作都排进同一条串行队列：并发自动保存与列表刷新
 * 不会交错写盘，Windows 上也不会撞 rename 的 sharing violation。
 *
 * allow: SIZE_OK — 启动页数据源按契约集中在一个存储模块（索引 / 自动存档归属 / 封面回收），
 * 它就是这个 feature 的主进程边界；内部已按「队列 / 索引 / 条目构建 / 对外接口」分区。
 */

const PROJECT_SUFFIX = `.${PROJECT_FILE_EXTENSION}`
const OWNER_FILE = 'autosave.owner.json'
const COVER_MAX_BYTES = 8 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

interface StatInfo {
  exists: boolean
  birthtimeMs: number
  mtimeMs: number
}

interface ScannedProject {
  path: string
  fileName: string
  stat: StatInfo
}

// ---------------------------------------------------------------------------
// 串行队列
// ---------------------------------------------------------------------------

let queue: Promise<void> = Promise.resolve()

/** 把一次索引变更排进唯一队列；前一笔失败不阻塞后一笔。 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task)
  queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

// ---------------------------------------------------------------------------
// 索引读写
// ---------------------------------------------------------------------------

function historyPath(): string {
  return path.join(projectsDir(), RECENT_HISTORY_FILE)
}

function ownerPath(): string {
  return path.join(projectsDir(), OWNER_FILE)
}

function autosavePath(): string {
  return path.join(projectsDir(), AUTOSAVE_FILE)
}

interface LoadedHistory {
  history: RecentHistoryFile
  /** 索引文件是否成功读到：只有首次启动（不存在/坏文件）才做目录回填，否则会复活已移除的卡片。 */
  existed: boolean
}

async function readHistoryState(): Promise<LoadedHistory> {
  try {
    const text = await fs.readFile(historyPath(), 'utf8')
    return { history: normalizeRecentHistory(JSON.parse(text)), existed: true }
  } catch {
    // 首次启动 / 坏 JSON：都从空索引开始，不让一条脏数据带垮启动页
    return { history: normalizeRecentHistory(null), existed: false }
  }
}

async function readHistory(): Promise<RecentHistoryFile> {
  return (await readHistoryState()).history
}

async function writeHistory(entries: readonly RecentProjectEntry[]): Promise<void> {
  await fs.mkdir(projectsDir(), { recursive: true })
  const payload: RecentHistoryFile = { version: RECENT_HISTORY_VERSION, entries: [...entries] }
  await atomicWrite(historyPath(), `${JSON.stringify(payload, null, 2)}\n`)
}

/** 排序 + 截断到上限，并回收被淘汰条目的封面（工程文件本身绝不删除）。 */
async function persistEntries(entries: readonly RecentProjectEntry[]): Promise<RecentProjectEntry[]> {
  const sorted = sortRecentProjects([...entries], 'recent')
  const kept = sorted.slice(0, RECENT_PROJECT_LIMIT)
  const dropped = sorted.slice(RECENT_PROJECT_LIMIT)
  await writeHistory(kept)
  for (const entry of dropped) await deleteCoverFile(entry.id)
  return kept
}

async function readOwnerEntryId(): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(ownerPath(), 'utf8'))
    if (!isRecord(raw)) return null
    const value = raw['entryId']
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

async function writeOwnerEntryId(entryId: string | null): Promise<void> {
  await fs.mkdir(projectsDir(), { recursive: true })
  await atomicWrite(ownerPath(), `${JSON.stringify({ entryId }, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validMs(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null
}

function isoFromMs(ms: number): string {
  return new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString()
}

function firstTime(...values: number[]): number {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) return value
  }
  return Date.now()
}

async function statInfo(file: string): Promise<StatInfo> {
  try {
    const stat = await fs.stat(file)
    return { exists: stat.isFile(), birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs }
  } catch {
    return { exists: false, birthtimeMs: 0, mtimeMs: 0 }
  }
}

function findEntry(entries: readonly RecentProjectEntry[], id: string): RecentProjectEntry | null {
  return entries.find((entry) => entry.id === id) ?? null
}

function upsertEntry(entries: readonly RecentProjectEntry[], entry: RecentProjectEntry): RecentProjectEntry[] {
  const index = entries.findIndex((item) => item.id === entry.id)
  if (index < 0) return [...entries, entry]
  const next = [...entries]
  next[index] = entry
  return next
}

function sameEntries(a: readonly RecentProjectEntry[], b: readonly RecentProjectEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function stripProjectSuffix(fileName: string): string {
  return fileName.toLowerCase().endsWith(PROJECT_SUFFIX) ? fileName.slice(0, -PROJECT_SUFFIX.length) : fileName
}

/** 工程展示名：project.name 优先，其次文件基名，最后兜底。 */
function projectName(project: Project, filePath: string | null): string {
  const trimmed = project.name.trim()
  if (trimmed.length > 0) return trimmed
  if (filePath) {
    const base = stripProjectSuffix(path.basename(filePath))
    if (base.length > 0) return base
  }
  return '未命名工程'
}

/** 自动存档草稿名：工程名优先，空名回落到「上次编辑」。 */
function autosaveName(project: Project): string {
  const trimmed = project.name.trim()
  return trimmed.length > 0 ? trimmed : '上次编辑'
}

/** 文件名安全化：Windows 保留字符替换为 '-'，去首尾点/空格，限长 80。 */
function safeFileBase(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : `project-${Date.now()}`
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

async function deleteCoverFile(entryId: string): Promise<void> {
  try {
    await fs.rm(userCoverPath(entryId), { force: true })
  } catch {
    // 非法 id 或目录不可写：封面回收是尽力而为，不影响索引本身
  }
}

// ---------------------------------------------------------------------------
// 条目构建
// ---------------------------------------------------------------------------

async function buildFileEntry(
  existing: RecentProjectEntry | null,
  filePath: string,
  project: Project,
  touchOpened: boolean
): Promise<RecentProjectEntry> {
  const stat = await statInfo(filePath)
  const now = Date.now()
  const existingCreated = existing ? validMs(Date.parse(existing.createdAt)) : null
  const existingModified = existing ? validMs(Date.parse(existing.modifiedAt)) : null
  const existingOpened = existing ? validMs(Date.parse(existing.lastOpenedAt)) : null
  return {
    id: recentEntryIdForPath(filePath),
    name: projectName(project, filePath),
    source: 'file',
    filePath,
    createdAt: isoFromMs(existingCreated ?? validMs(stat.birthtimeMs) ?? now),
    // 保存流程写完文件后 mtime 就是「刚才」；打开流程不会把 mtime 提前，因此 modifiedAt 不会被无谓刷新
    modifiedAt: isoFromMs(Math.max(existingModified ?? 0, validMs(stat.mtimeMs) ?? 0) || now),
    lastOpenedAt: isoFromMs(touchOpened ? now : (existingOpened ?? now)),
    ...projectStats(project),
    hasCover: existing?.hasCover ?? false,
    nameCustomized: existing?.nameCustomized ?? false
  }
}

function scannedEntry(item: ScannedProject, project: Project): RecentProjectEntry {
  const now = Date.now()
  return {
    id: recentEntryIdForPath(item.path),
    name: projectName(project, item.path),
    source: 'file',
    filePath: item.path,
    createdAt: isoFromMs(validMs(item.stat.birthtimeMs) ?? validMs(item.stat.mtimeMs) ?? now),
    modifiedAt: isoFromMs(validMs(item.stat.mtimeMs) ?? now),
    lastOpenedAt: isoFromMs(validMs(item.stat.mtimeMs) ?? now),
    ...projectStats(project),
    hasCover: false,
    nameCustomized: false
  }
}

/** 合并工程内容：只更新统计/名称/时间，绝不改 source/filePath/createdAt/hasCover。 */
function mergeProject(
  entry: RecentProjectEntry,
  project: Project,
  touch: { modified: boolean; opened: boolean }
): RecentProjectEntry {
  const now = isoFromMs(Date.now())
  const trimmed = project.name.trim()
  return {
    ...entry,
    name: trimmed.length > 0 ? trimmed : entry.name,
    ...projectStats(project),
    modifiedAt: touch.modified ? now : entry.modifiedAt,
    lastOpenedAt: touch.opened ? now : entry.lastOpenedAt
  }
}

/** 扫描 projects 目录里的工程文件（排除自动存档），供首启回填用。 */
async function scanProjectFiles(): Promise<ScannedProject[]> {
  let names: string[]
  try {
    names = await fs.readdir(projectsDir())
  } catch {
    return []
  }
  const out: ScannedProject[] = []
  for (const fileName of names) {
    const lower = fileName.toLowerCase()
    if (!lower.endsWith(PROJECT_SUFFIX) || lower.startsWith('autosave.')) continue
    const file = path.join(projectsDir(), fileName)
    const stat = await statInfo(file)
    if (!stat.exists) continue
    out.push({ path: file, fileName, stat })
  }
  return out
}

async function uniqueProjectPath(baseName: string): Promise<string> {
  const dir = projectsDir()
  await fs.mkdir(dir, { recursive: true })
  const base = safeFileBase(baseName)
  let candidate = path.join(dir, `${base}${PROJECT_SUFFIX}`)
  let counter = 1
  while ((await statInfo(candidate)).exists && counter <= 999) {
    candidate = path.join(dir, `${base}-${counter}${PROJECT_SUFFIX}`)
    counter += 1
  }
  return candidate
}

async function toCard(entry: RecentProjectEntry): Promise<RecentProjectCard> {
  let missing = false
  if (entry.source === 'file' && entry.filePath) {
    missing = !(await statInfo(entry.filePath)).exists
  }
  return {
    ...entry,
    missing,
    // 文件不在时封面也不该继续展示；hasCover=false 时 coverUrlFor 直接返回 null
    coverUrl: missing ? null : coverUrlFor(entry)
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 打开 / 另存后登记文件工程：按路径哈希 upsert，保留已有封面与自定义名。 */
export async function registerFileProject(
  filePath: string,
  project: Project,
  opts?: { touchOpened?: boolean }
): Promise<RecentProjectEntry> {
  return enqueue(async () => {
    const history = await readHistory()
    const id = recentEntryIdForPath(filePath)
    const entry = await buildFileEntry(findEntry(history.entries, id), filePath, project, opts?.touchOpened === true)
    const kept = await persistEntries(upsertEntry(history.entries, entry))
    return findEntry(kept, id) ?? entry
  })
}

/** 未另存的新工程自动存档：空工程不建卡片，避免启动页出现一张空白草稿。 */
export async function registerAutosaveProject(project: Project): Promise<RecentProjectEntry | null> {
  if (!projectHasProgress(project)) {
    // 用户把草稿清空后不该继续留着一张「打开就失败」的卡片：内容已经写空，
    // 下次有进度时再重新登记即可。
    return enqueue(async () => {
      const history = await readHistory()
      if (!findEntry(history.entries, AUTOSAVE_ENTRY_ID)) return null
      await persistEntries(history.entries.filter((entry) => entry.id !== AUTOSAVE_ENTRY_ID))
      await deleteCoverFile(AUTOSAVE_ENTRY_ID)
      return null
    })
  }
  return enqueue(async () => {
    const history = await readHistory()
    const existing = findEntry(history.entries, AUTOSAVE_ENTRY_ID)
    const stat = await statInfo(autosavePath())
    const now = Date.now()
    const entry: RecentProjectEntry = {
      id: AUTOSAVE_ENTRY_ID,
      // 用户改过名就保留自定义名；否则跟随工程当前名称
      name: existing?.nameCustomized ? existing.name : autosaveName(project),
      source: 'autosave',
      filePath: null,
      createdAt: existing ? existing.createdAt : isoFromMs(firstTime(stat.birthtimeMs, now)),
      modifiedAt: isoFromMs(now),
      lastOpenedAt: isoFromMs(now),
      ...projectStats(project),
      hasCover: existing?.hasCover ?? false,
      nameCustomized: existing?.nameCustomized ?? false
    }
    const kept = await persistEntries(upsertEntry(history.entries, entry))
    return findEntry(kept, AUTOSAVE_ENTRY_ID) ?? entry
  })
}

/** 自动存档写盘后同步条目；索引里没有该 id 时静默跳过。 */
export async function updateEntryFromProject(
  entryId: string,
  project: Project,
  opts?: { touchModified?: boolean; touchOpened?: boolean }
): Promise<RecentProjectEntry | null> {
  return enqueue(async () => {
    const history = await readHistory()
    const existing = findEntry(history.entries, entryId)
    if (!existing) return null
    const entry = mergeProject(existing, project, {
      modified: opts?.touchModified === true,
      opened: opts?.touchOpened === true
    })
    const kept = await persistEntries(upsertEntry(history.entries, entry))
    return findEntry(kept, entryId) ?? entry
  })
}

/** 记录自动存档当前归属：文件工程 id（非空）表示草稿就是那个文件；null 表示独立草稿。 */
export async function setAutosaveOwner(entryId: string | null): Promise<void> {
  await enqueue(async () => {
    await writeOwnerEntryId(entryId)
  })
}

/** 启动页列表：修正自动存档归属、回填已有工程、补齐 missing/coverUrl 后按最近使用排序。 */
export async function listRecentProjects(): Promise<RecentProjectCard[]> {
  return enqueue(async () => {
    const loaded = await readHistoryState()
    let entries = loaded.history.entries
    let changed = false

    // 1) 自动存档去重：退出时打开的文件工程仍存在，就不再显示独立草稿卡片
    const ownerId = await readOwnerEntryId()
    const owner = ownerId ? findEntry(entries, ownerId) : null
    const ownerFileExists =
      owner !== null && owner.source === 'file' && owner.filePath
        ? (await statInfo(owner.filePath)).exists
        : false

    if (owner !== null && ownerFileExists) {
      if (entries.some((entry) => entry.id === AUTOSAVE_ENTRY_ID)) {
        entries = entries.filter((entry) => entry.id !== AUTOSAVE_ENTRY_ID)
        await deleteCoverFile(AUTOSAVE_ENTRY_ID)
        changed = true
      }
    } else if (ownerId !== null && owner === null) {
      // 归属的文件工程已被「移除最近项目」：草稿仍留在磁盘上（用户重新打开该文件时可恢复），
      // 但不能以草稿卡的形式复活——否则移除操作下一次刷新就失效。
      if (entries.some((entry) => entry.id === AUTOSAVE_ENTRY_ID)) {
        entries = entries.filter((entry) => entry.id !== AUTOSAVE_ENTRY_ID)
        changed = true
      }
    } else {
      // 2) 没有有效归属（独立草稿 / 旧版本没有 owner 文件）：按自动存档文件重建草稿卡片
      const autosaveInfo = await autosaveStat()
      if (autosaveInfo.exists) {
        const autosaveProject = await autosaveRead()
        if (autosaveProject && projectHasProgress(autosaveProject)) {
          const existing = findEntry(entries, AUTOSAVE_ENTRY_ID)
          const stat = await statInfo(autosavePath())
          const now = Date.now()
          const entry: RecentProjectEntry = {
            id: AUTOSAVE_ENTRY_ID,
            name: existing ? existing.name : autosaveName(autosaveProject),
            source: 'autosave',
            filePath: null,
            createdAt: existing ? existing.createdAt : isoFromMs(firstTime(stat.birthtimeMs, now)),
            modifiedAt: isoFromMs(firstTime(autosaveInfo.mtimeMs, now)),
            // 列表刷新绝不推进 lastOpenedAt（只有真正打开才推进）
            lastOpenedAt: existing ? existing.lastOpenedAt : isoFromMs(now),
            ...projectStats(autosaveProject),
            hasCover: existing?.hasCover ?? false,
            nameCustomized: existing?.nameCustomized ?? false
          }
          const next = upsertEntry(entries, entry)
          if (!sameEntries(entries, next)) changed = true
          entries = next
        }
      }
    }

    // 3) 首启回填：仅在索引还不存在时扫描 projects 目录。
    //    索引存在后不再扫描——否则「移除最近项目」会在下一次刷新时被文件扫描复活。
    if (!loaded.existed) {
      const scanned = await scanProjectFiles()
      const knownIds = new Set(entries.map((entry) => entry.id))
      let added = false
      for (const item of scanned) {
        const id = recentEntryIdForPath(item.path)
        if (knownIds.has(id)) continue
        const project = await readProjectFile(item.path)
        if (!project) continue
        entries = [...entries, scannedEntry(item, project)]
        knownIds.add(id)
        added = true
      }
      if (added) changed = true
    }
    if (entries.length > RECENT_PROJECT_LIMIT) changed = true

    if (changed) entries = await persistEntries(entries)

    const cards = await Promise.all(entries.map((entry) => toCard(entry)))
    return sortRecentProjects(cards, 'recent')
  })
}

/** 新建「日期命名」工程并落盘（同名自动加中文括号序号）。 */
export async function createRecentProject(): Promise<{ entry: RecentProjectCard; project: Project }> {
  return enqueue(async () => {
    const history = await readHistory()
    const base = formatDefaultProjectName(new Date())
    const names = new Set<string>(history.entries.map((entry) => entry.name))
    for (const item of await scanProjectFiles()) names.add(stripProjectSuffix(item.fileName))
    const next = nextProjectName(base, [...names])
    const target = await uniqueProjectPath(next)
    const project = createDefaultProject(next)
    await fs.mkdir(projectsDir(), { recursive: true })
    await atomicWrite(target, `${JSON.stringify(project, null, 2)}\n`)

    const entry = await buildFileEntry(null, target, project, false)
    const kept = await persistEntries(upsertEntry(history.entries, entry))
    const record = findEntry(kept, entry.id) ?? entry
    return { entry: await toCard(record), project }
  })
}

/** 按 id 打开最近工程；自动存档读草稿，文件工程读文件，失败一律返回 null。 */
export async function openRecentProject(id: string): Promise<OpenProjectResult | null> {
  if (typeof id !== 'string' || id.length === 0) return null
  return enqueue(async () => {
    if (id === AUTOSAVE_ENTRY_ID) {
      const project = await autosaveRead()
      if (!project || !projectHasProgress(project)) return null
      const history = await readHistory()
      const entry = findEntry(history.entries, id)
      if (entry) {
        const touched = mergeProject(entry, project, { modified: false, opened: true })
        await persistEntries(upsertEntry(history.entries, touched))
      }
      // 草稿没有用户文件路径：交给渲染侧的当前路径保持为空（另存为时才落新文件）
      return { path: '', project, entryId: id }
    }

    const history = await readHistory()
    const entry = findEntry(history.entries, id)
    if (!entry || entry.source !== 'file' || !entry.filePath) return null
    const diskProject = await readProjectFile(entry.filePath)
    if (!diskProject) return null

    /**
     * 未另存的编辑只存在于 autosave.json。若这次退出时打开的就是这个文件工程
     * （owner 匹配）且草稿比工程文件新，优先恢复草稿，避免「打开最近工程」把
     * 上次未保存的编辑丢掉。
     */
    let project = diskProject
    const ownerId = await readOwnerEntryId()
    if (ownerId === id) {
      const draftInfo = await autosaveStat()
      if (draftInfo.exists) {
        const draft = await autosaveRead()
        const diskInfo = await statInfo(entry.filePath)
        if (draft && projectHasProgress(draft) && draftInfo.mtimeMs > diskInfo.mtimeMs) {
          project = draft
        }
      }
    }

    const touched = mergeProject(entry, project, { modified: false, opened: true })
    await persistEntries(upsertEntry(history.entries, touched))
    return { path: entry.filePath, project, entryId: id }
  })
}

/** 自定义名称：写回工程文件/自动存档后更新索引（不推进 lastOpenedAt）。 */
export async function renameRecentProject(id: string, name: string): Promise<RecentProjectCard | null> {
  if (typeof id !== 'string' || id.length === 0) return null
  const cleaned = clampProjectName(name)
  if (cleaned.length === 0) return null

  return enqueue(async () => {
    const history = await readHistory()
    const entry = findEntry(history.entries, id)
    if (!entry) return null
    if (!(await writeProjectName(entry, cleaned))) return null

    const updated: RecentProjectEntry = {
      ...entry,
      name: cleaned,
      nameCustomized: true,
      modifiedAt: isoFromMs(Date.now())
    }
    const kept = await persistEntries(upsertEntry(history.entries, updated))
    return toCard(findEntry(kept, id) ?? updated)
  })
}

async function writeProjectName(entry: RecentProjectEntry, name: string): Promise<boolean> {
  try {
    if (entry.source === 'autosave') {
      const project = await autosaveRead()
      if (!project) return false
      await autosaveWrite({ ...project, name })
      return true
    }
    if (!entry.filePath) return false
    const raw: unknown = JSON.parse(await fs.readFile(entry.filePath, 'utf8'))
    if (!isRecord(raw)) return false
    // 保留原文件里的其它键（含未知字段），只改 name
    await atomicWrite(entry.filePath, `${JSON.stringify({ ...raw, name }, null, 2)}\n`)
    return true
  } catch (error) {
    await log('warn', `重命名工程失败（${entry.id}）：${String(error)}`)
    return false
  }
}

/** 只移出最近列表（不删工程文件）；自动存档会连同草稿与归属一起丢弃。 */
export async function removeRecentProject(id: string): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) return
  await enqueue(async () => {
    const history = await readHistory()
    if (!findEntry(history.entries, id)) return
    const entries = history.entries.filter((entry) => entry.id !== id)
    await persistEntries(entries)
    await deleteCoverFile(id)

    if (id === AUTOSAVE_ENTRY_ID) {
      const dir = projectsDir()
      await fs.rm(path.join(dir, AUTOSAVE_FILE), { force: true }).catch(() => undefined)
      await fs.rm(path.join(dir, AUTOSAVE_BACKUP_FILE), { force: true }).catch(() => undefined)
      await writeOwnerEntryId(null)
    }
  })
}

/** 保存封面（PNG 字节）：校验签名与体积，原子写 userData/covers/<id>.png。 */
export async function saveRecentCover(id: string, png: Uint8Array): Promise<string | null> {
  if (typeof id !== 'string' || !RECENT_ENTRY_ID_PATTERN.test(id)) return null
  if (!(png instanceof Uint8Array) || png.length === 0 || png.length > COVER_MAX_BYTES) return null
  if (!hasPngSignature(png)) return null

  return enqueue(async () => {
    const history = await readHistory()
    const entry = findEntry(history.entries, id)
    const file = userCoverPath(id)
    await fs.mkdir(userCoversDir(), { recursive: true })
    // 封面是二进制，projectStore.atomicWrite 只收字符串，这里沿用同一套 tmp+rename 纪律
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, png)
    await fs.rename(tmp, file)

    let modifiedAt = isoFromMs(Date.now())
    if (entry) {
      modifiedAt = entry.modifiedAt
      if (!entry.hasCover) {
        await persistEntries(upsertEntry(history.entries, { ...entry, hasCover: true }))
      }
    }
    return coverUrlFor({ id, hasCover: true, modifiedAt })
  })
}

/** 回收封面文件并把条目 hasCover 置回 false。 */
export async function removeRecentCover(id: string): Promise<void> {
  if (typeof id !== 'string' || !RECENT_ENTRY_ID_PATTERN.test(id)) return
  await enqueue(async () => {
    await deleteCoverFile(id)
    const history = await readHistory()
    const entry = findEntry(history.entries, id)
    if (entry?.hasCover) {
      await persistEntries(upsertEntry(history.entries, { ...entry, hasCover: false }))
    }
  })
}
