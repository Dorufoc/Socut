import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { BIG_FONT_BYTES, BUILTIN_FONTS, FONTS_MANIFEST_FILE, MAX_IMPORT_FONT_BYTES } from '../shared/constants'
import type { FontRecord } from '../shared/types'
import { builtinFontsDir, userFontsDir } from './paths'
import { log } from './log'

/**
 * 字体管理（规格 §4.5）：
 * - 内置字体：resources/fonts/（由 scripts/fetch-fonts.mjs 产出，含 manifest.json）；
 * - 用户导入：拷贝到 userData/fonts/<fontId>.<ext>，元数据写入 userData/fonts/fonts.json，永久持久化；
 * - 片段只保存 fontId，不保存字体名；
 * - MVP 仅枚举应用字体库（系统字体枚举为后续版本）。
 */

export class FontError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

interface ManifestShape {
  version?: number
  fonts: FontRecord[]
}

/** TTF / OTF 魔数识别；TTC 集合与 WOFF 明确拒绝。 */
export function detectFontFormat(head: Buffer): 'ttf' | 'otf' | null {
  if (head.length < 4) return null
  const sig = head.readUInt32BE(0)
  if (sig === 0x0001_0000 || sig === 0x74_72_75_65 /* true */) return 'ttf'
  if (sig === 0x4f_54_54_4f /* OTTO */) return 'otf'
  return null
}

async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

async function sha1OfFile(file: string): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const hash = crypto.createHash('sha1')
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** 内置字体清单：优先读 manifest.json（含 bytes/sha1），否则回退常量表。 */
export async function listBuiltinFonts(): Promise<FontRecord[]> {
  const manifest = await readJsonSafe<ManifestShape>(path.join(builtinFontsDir(), 'manifest.json'), {
    fonts: []
  })
  if (manifest.fonts.length > 0) {
    const existing: FontRecord[] = []
    for (const record of manifest.fonts) {
      try {
        const stat = await fs.stat(path.join(builtinFontsDir(), record.fileName))
        existing.push({ ...record, source: 'builtin', bytes: stat.size })
      } catch {
        // 文件缺失：跳过（UI 会提示执行 fetch:fonts）
      }
    }
    return existing
  }
  // 回退：常量表 + stat 补齐
  const records: FontRecord[] = []
  for (const meta of BUILTIN_FONTS) {
    const fileName = meta.fileName
    try {
      const stat = await fs.stat(path.join(builtinFontsDir(), fileName))
      records.push({
        ...meta,
        source: 'builtin',
        bytes: stat.size,
        sha1: '',
        importedAt: new Date(stat.mtimeMs).toISOString()
      })
    } catch {
      // 未下载
    }
  }
  return records
}

export async function listUserFonts(): Promise<FontRecord[]> {
  const dir = userFontsDir()
  await fs.mkdir(dir, { recursive: true })
  const manifest = await readJsonSafe<ManifestShape>(path.join(dir, FONTS_MANIFEST_FILE), { fonts: [] })
  const alive: FontRecord[] = []
  for (const record of manifest.fonts) {
    try {
      await fs.stat(path.join(dir, record.fileName))
      alive.push(record)
    } catch {
      // 文件被外部删除：丢弃记录
    }
  }
  return alive
}

export async function listFonts(): Promise<FontRecord[]> {
  const [builtin, user] = await Promise.all([listBuiltinFonts(), listUserFonts()])
  return [...builtin, ...user]
}

async function writeUserManifest(fonts: FontRecord[]): Promise<void> {
  const dir = userFontsDir()
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, FONTS_MANIFEST_FILE)
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ version: 1, fonts }, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 导入用户 TTF/OTF：拷贝 + 元数据持久化（重复 sha1 直接复用，不重复拷贝）。 */
export async function importFont(sourcePath: string): Promise<FontRecord> {
  const stat = await fs.stat(sourcePath)
  if (stat.size > MAX_IMPORT_FONT_BYTES) {
    throw new FontError(`字体文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过上限`, 'FONT_TOO_LARGE')
  }
  const handle = await fs.open(sourcePath, 'r')
  let head: Buffer
  try {
    head = Buffer.alloc(16)
    const { bytesRead } = await handle.read(head, 0, 16, 0)
    head = head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const format = detectFontFormat(head)
  if (!format) {
    throw new FontError('仅支持 TrueType（.ttf）与 OpenType（.otf）单字体文件', 'FONT_FORMAT')
  }

  const sha1 = await sha1OfFile(sourcePath)
  const existing = await listUserFonts()
  const duplicated = existing.find((f) => f.sha1 === sha1)
  if (duplicated) {
    await log('info', `字体重复导入，复用 ${duplicated.fontId}`)
    return duplicated
  }

  const base = path.basename(sourcePath, path.extname(sourcePath))
  const fontId = `user-${sha1.slice(0, 12)}`
  const fileName = `${fontId}.${format}`
  const target = path.join(userFontsDir(), fileName)
  await fs.mkdir(userFontsDir(), { recursive: true })
  await fs.copyFile(sourcePath, target)

  const record: FontRecord = {
    fontId,
    // family 由渲染层用 cssFamilyFor(fontId) 注册；这里保留可读名供 UI 显示
    family: fontId,
    displayName: base || '导入字体',
    weight: 400,
    style: 'normal',
    bytes: stat.size,
    sha1,
    fileName,
    source: 'user',
    importedAt: new Date().toISOString()
  }
  await writeUserManifest([...existing, record])
  await log('info', `字体导入：${record.displayName} → ${fileName}`)
  return record
}

export async function importFontDialog(parent: BrowserWindow | null): Promise<FontRecord | null> {
  const options = {
    title: '导入 TTF / OTF 字体',
    properties: ['openFile'] as ['openFile'],
    filters: [{ name: '字体', extensions: ['ttf', 'otf'] }]
  }
  // 有父窗口时以模态方式弹出（规格 §6 的阻断式交互依赖窗口级模态）
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return importFont(result.filePaths[0] as string)
}

/** 读取字体字节（渲染进程据此 new FontFace）。 */
export async function readFontBytes(fontId: string): Promise<ArrayBuffer> {
  const dir = userFontsDir()
  const userCandidates = await listUserFonts()
  const userRecord = userCandidates.find((f) => f.fontId === fontId)
  if (userRecord) {
    const buffer = await fs.readFile(path.join(dir, userRecord.fileName))
    return toArrayBuffer(buffer)
  }
  const builtinRecords = await listBuiltinFonts()
  const builtinRecord = builtinRecords.find((f) => f.fontId === fontId)
  if (!builtinRecord) throw new FontError(`未找到字体：${fontId}`, 'FONT_NOT_FOUND')
  const buffer = await fs.readFile(path.join(builtinFontsDir(), builtinRecord.fileName))
  return toArrayBuffer(buffer)
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

export async function removeFont(fontId: string): Promise<void> {
  if (fontId.startsWith('builtin-')) {
    throw new FontError('内置字体不可移除', 'FONT_PROTECTED')
  }
  const current = await listUserFonts()
  const removed = current.find((f) => f.fontId === fontId)
  const remaining = current.filter((f) => f.fontId !== fontId)
  if (removed) {
    await fs.rm(path.join(userFontsDir(), removed.fileName), { force: true }).catch(() => undefined)
  }
  await writeUserManifest(remaining)
  await log('info', `字体移除：${fontId}`)
}

/** 供 UI 判定「大字体加载期间禁用导出」（规格 §4.5）。 */
export function isBigFont(record: FontRecord | undefined): boolean {
  if (!record) return false
  return record.bytes > BIG_FONT_BYTES
}
