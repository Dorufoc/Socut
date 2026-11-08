import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { AUTOSAVE_BACKUP_FILE, AUTOSAVE_FILE, AUTOSAVE_FLUSH_TIMEOUT_MS } from '../shared/constants'
import { PROJECT_FILE_EXTENSION, normalizeProject } from '../shared/projectSchema'
import type { Project } from '../shared/types'
import { projectsDir } from './paths'
import { log } from './log'

/**
 * 工程持久化（规格 §4.6：JSON 序列化 + 当前工程自动保存）。
 * 写入纪律：先写 .tmp 再 rename（原子），并把上一版轮转为 .bak，
 * 崩溃后读到坏 JSON 时回落备份（风险表「自动保存竞态」）。
 */

async function ensureDir(): Promise<string> {
  const dir = projectsDir()
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function serialize(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

/** 原子写：先写 .tmp 再 rename（同盘 rename 在 Windows 上不会留下半截文件）。 */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * 写入队列：同路径的 rename/copy 并发交叠在 Windows 上会撞 sharing violation，
 * 且退出前的 flush 需要能等到「最后一笔真正落盘」。
 * 因此所有自动存档写入串行排队；flushPendingAutosave 由主进程退出清理调用，
 * 保证 debounce 未及触发或 IPC 在途的进度不因关窗/崩溃而丢。
 */
let writeQueue: Promise<void> = Promise.resolve()

export function autosaveWrite(project: Project): Promise<void> {
  const task = writeQueue.catch(() => undefined).then(() => autosaveWriteNow(project))
  writeQueue = task.catch(() => undefined)
  return task
}

/** 等待在途写入全部落盘（封顶 AUTOSAVE_FLUSH_TIMEOUT_MS，超时放行不卡死退出） */
export async function flushPendingAutosave(): Promise<void> {
  await Promise.race([writeQueue, new Promise<void>((resolve) => setTimeout(resolve, AUTOSAVE_FLUSH_TIMEOUT_MS).unref?.())])
}

async function autosaveWriteNow(project: Project): Promise<void> {
  const dir = await ensureDir()
  const file = path.join(dir, AUTOSAVE_FILE)
  const backup = path.join(dir, AUTOSAVE_BACKUP_FILE)
  try {
    await fs.copyFile(file, backup)
  } catch {
    // 首次保存无旧文件
  }
  await atomicWrite(file, serialize(project))
}

async function parseFile(file: string): Promise<Project | null> {
  try {
    const text = await fs.readFile(file, 'utf8')
    return normalizeProject(JSON.parse(text))
  } catch {
    return null
  }
}

/** 读取任意工程文件并归一（坏 JSON / 文件不存在 / 结构不可用一律返回 null）。 */
export async function readProjectFile(file: string): Promise<Project | null> {
  return parseFile(file)
}

export async function autosaveRead(): Promise<Project | null> {
  const dir = await ensureDir()
  const primary = await parseFile(path.join(dir, AUTOSAVE_FILE))
  if (primary) return primary
  const backup = await parseFile(path.join(dir, AUTOSAVE_BACKUP_FILE))
  if (backup) await log('warn', '自动存档主文件不可读，已回落备份')
  return backup
}

export interface AutosaveStat {
  exists: boolean
  mtimeMs: number
  sizeBytes: number
}

export async function autosaveStat(): Promise<AutosaveStat> {
  const dir = await ensureDir()
  try {
    const stat = await fs.stat(path.join(dir, AUTOSAVE_FILE))
    return { exists: true, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }
  } catch {
    return { exists: false, mtimeMs: 0, sizeBytes: 0 }
  }
}

export interface LoadedProject {
  path: string
  project: Project
}

export async function openProjectDialog(parent: BrowserWindow | null): Promise<LoadedProject | null> {
  const options = {
    title: '打开工程',
    defaultPath: await ensureDir(),
    properties: ['openFile'] as ['openFile'],
    filters: [{ name: `FocusNews 工程 (*.${PROJECT_FILE_EXTENSION})`, extensions: [PROJECT_FILE_EXTENSION, 'json'] }]
  }
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const file = result.filePaths[0] as string
  const project = normalizeProject(JSON.parse(await fs.readFile(file, 'utf8')))
  if (!project) throw new Error(`工程文件结构不可用：${file}`)
  await log('info', `工程打开：${file}`)
  return { path: file, project }
}

export async function saveProjectAs(parent: BrowserWindow | null, project: Project): Promise<string | null> {
  const dir = await ensureDir()
  const options = {
    title: '另存为',
    defaultPath: path.join(dir, `${project.name || '未命名工程'}.${PROJECT_FILE_EXTENSION}`),
    filters: [{ name: `FocusNews 工程 (*.${PROJECT_FILE_EXTENSION})`, extensions: [PROJECT_FILE_EXTENSION] }]
  }
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await atomicWrite(result.filePath, serialize(project))
  await log('info', `工程另存为：${result.filePath}`)
  return result.filePath
}

/**
 * CLI 专用：保存到显式路径（不弹对话框）。
 * 与另存为共用同一套原子写 + 目录创建纪律；路径来自外部请求，必须 resolve 后使用。
 */
export async function writeProjectFile(file: string, project: Project): Promise<string> {
  const target = path.resolve(file)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await atomicWrite(target, serialize(project))
  await log('info', `工程写入：${target}`)
  return target
}

/** 参考视频是否存在（工程恢复时提示重新定位，规格 §8 数据模型）。 */
export async function fileExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target)
    return stat.isFile()
  } catch {
    return false
  }
}
