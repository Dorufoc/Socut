import fs from 'node:fs/promises'
import path from 'node:path'
import { tempRoot } from './paths'

/** 任务临时目录（规格 §5.3：临时文件必须清理；§5.1：导出完成后清理）。 */

export interface Workspace {
  jobId: string
  dir: string
}

export async function ensureTempRoot(): Promise<string> {
  const root = tempRoot()
  await fs.mkdir(root, { recursive: true })
  return root
}

export async function createWorkspace(jobId: string): Promise<Workspace> {
  const root = await ensureTempRoot()
  // mkdtemp 保证并发任务互不覆盖
  const dir = await fs.mkdtemp(path.join(root, `${sanitize(jobId)}-`))
  return { jobId, dir }
}

export async function disposeWorkspace(workspace: Workspace): Promise<void> {
  await fs
    .rm(workspace.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    .catch(() => undefined)
}

/** 启动/退出时清扫残留（崩溃遗留的临时目录）。 */
export async function sweepStaleWorkspaces(maxAgeMs = 6 * 60 * 60 * 1000): Promise<number> {
  const root = tempRoot()
  let removed = 0
  let entries: string[] = []
  try {
    entries = await fs.readdir(root)
  } catch {
    return 0
  }
  const now = Date.now()
  for (const entry of entries) {
    const full = path.join(root, entry)
    try {
      const stat = await fs.stat(full)
      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        removed++
      }
    } catch {
      // 竞态删除：忽略
    }
  }
  return removed
}

/** 磁盘可用空间（Node 20+ 的 fs.statfs，避免引入第三方依赖）。 */
export async function diskFreeBytes(targetPath: string): Promise<number | undefined> {
  if (typeof fs.statfs !== 'function') return undefined
  const probeDir = (await pathIsDirectory(targetPath)) ? targetPath : path.dirname(targetPath)
  try {
    const stats = await fs.statfs(probeDir)
    return Number(stats.bsize) * Number(stats.bavail)
  } catch {
    return undefined
  }
}

async function pathIsDirectory(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target)
    return stat.isDirectory()
  } catch {
    return false
  }
}

export function frameFileName(index: number, prefix = 'frame'): string {
  return `${prefix}_${String(index).padStart(6, '0')}.png`
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'job'
}

/** 输出目录与临时目录是否同卷（跨卷时中间透明 MOV 会多一次完整拷贝，给出提示）。 */
export function isSameVolume(left: string, right: string): boolean {
  return path.parse(left).root.toLowerCase() === path.parse(right).root.toLowerCase()
}
