import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * M10：项目锁（窗口 ↔ Agent 互斥）。
 *
 * 目的（与 Concat 的 `concat.lock` 同一动机）：GUI 正在编辑的工程，不能被 Agent
 * 或另一个隐藏实例同时改写；反过来 Agent 持有的工程，GUI 打开时应给出可读提示。
 *
 * 实现口径：
 * - 锁文件放在工程文件旁边：`<project>.lock`（一个工程目录/文件只对应一把锁）；
 * - 内容：pid / token / mode / 心跳时间；**心跳每 5s 更新**，超过 15s 未更新视为陈旧；
 * - 陈旧判定同时看「进程是否还活着」：崩溃残留的锁能被下一次打开自动接管；
 * - token 保证「只有持有者能释放」：进程 A 不能删掉 B 的锁；
 * - 原子写（写临时文件再 rename），避免读到半截 JSON；
 * - 本模块只用 fs，不 import electron：主进程、测试、将来的 headless 入口共用。
 */

export const PROJECT_LOCK_STALE_MS = 15_000
export const PROJECT_LOCK_HEARTBEAT_MS = 5_000

export type ProjectLockMode = 'window' | 'agent'

export interface ProjectLockInfo {
  token: string
  pid: number
  mode: ProjectLockMode
  projectPath: string
  startedAt: string
  heartbeatAt: string
}

export interface ProjectLockHandle {
  info: ProjectLockInfo
  /** 停止心跳并删除锁文件（token 不匹配时不动别人的锁） */
  release: () => Promise<void>
}

export type AcquireResult =
  | { ok: true; handle: ProjectLockHandle }
  | { ok: false; reason: 'locked' | 'error'; holder?: ProjectLockInfo; message?: string }

/** 锁文件路径：工程路径 + `.lock`（绝对路径规范化的结果，避免同一工程两种写法拿到两把锁）。 */
export function projectLockPath(projectPath: string): string {
  return `${path.resolve(projectPath)}.lock`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseLockInfo(value: unknown): ProjectLockInfo | null {
  if (!isRecord(value)) return null
  const token = value['token']
  const pid = value['pid']
  const mode = value['mode']
  const projectPath = value['projectPath']
  const startedAt = value['startedAt']
  const heartbeatAt = value['heartbeatAt']
  if (typeof token !== 'string' || token.length === 0) return null
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (mode !== 'window' && mode !== 'agent') return null
  if (typeof projectPath !== 'string') return null
  if (typeof startedAt !== 'string' || typeof heartbeatAt !== 'string') return null
  return { token, pid, mode, projectPath, startedAt, heartbeatAt }
}

/** 读锁；文件不存在 / 内容坏 / 读失败一律返回 null（坏锁按"无锁"处理，可被接管）。 */
export async function readProjectLock(projectPath: string): Promise<ProjectLockInfo | null> {
  try {
    const text = await fs.readFile(projectLockPath(projectPath), 'utf8')
    return parseLockInfo(JSON.parse(text))
  } catch {
    return null
  }
}

/** 进程是否还活着：EPERM 说明进程存在但无权限（也算活着）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

/** 是否陈旧：心跳超时 或 持有进程已退出。 */
export function isLockStale(info: ProjectLockInfo, now = Date.now()): boolean {
  const heartbeat = Date.parse(info.heartbeatAt)
  if (!Number.isFinite(heartbeat) || now - heartbeat > PROJECT_LOCK_STALE_MS) return true
  return !isProcessAlive(info.pid)
}

async function writeLockAtomically(file: string, info: ProjectLockInfo): Promise<void> {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await fs.writeFile(temp, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temp, file)
}

function createInfo(projectPath: string, mode: ProjectLockMode): ProjectLockInfo {
  const now = new Date().toISOString()
  return {
    token: randomBytes(16).toString('hex'),
    pid: process.pid,
    mode,
    projectPath: path.resolve(projectPath),
    startedAt: now,
    heartbeatAt: now
  }
}

/**
 * 申请工程锁。
 * - 已有新鲜且活着的锁 → `{ ok:false, reason:'locked', holder }`（调用方给用户提示）；
 * - 有陈旧锁（崩溃残留 / 心跳超时）→ 直接接管；
 * - 写入后二次读取确认自己是持有者（两个进程同时抢时，败者返回 locked）。
 */
export async function acquireProjectLock(
  projectPath: string,
  mode: ProjectLockMode,
  options: { now?: number } = {}
): Promise<AcquireResult> {
  const file = projectLockPath(projectPath)
  const existing = await readProjectLock(projectPath)
  if (existing && !isLockStale(existing, options.now)) {
    return { ok: false, reason: 'locked', holder: existing }
  }
  const info = createInfo(projectPath, mode)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeLockAtomically(file, info)
  } catch (error) {
    return { ok: false, reason: 'error', message: String(error) }
  }
  // 二次确认：并发抢锁时只有一个 token 会被看到
  const confirmed = await readProjectLock(projectPath)
  if (!confirmed || confirmed.token !== info.token) {
    return { ok: false, reason: 'locked', ...(confirmed ? { holder: confirmed } : {}) }
  }

  const timer = setInterval(() => {
    const next: ProjectLockInfo = { ...info, heartbeatAt: new Date().toISOString() }
    void writeLockAtomically(file, next).catch(() => undefined)
  }, PROJECT_LOCK_HEARTBEAT_MS)
  timer.unref?.()

  const release = async (): Promise<void> => {
    clearInterval(timer)
    const current = await readProjectLock(projectPath)
    if (current && current.token !== info.token) return
    await fs.rm(file, { force: true }).catch(() => undefined)
  }

  return { ok: true, handle: { info, release } }
}

/** 按 token 释放（不知道 token 时用 handle.release；本函数供 CLI/会话恢复用）。 */
export async function releaseProjectLock(projectPath: string, token: string): Promise<boolean> {
  const current = await readProjectLock(projectPath)
  if (!current || current.token !== token) return false
  await fs.rm(projectLockPath(projectPath), { force: true }).catch(() => undefined)
  return true
}
