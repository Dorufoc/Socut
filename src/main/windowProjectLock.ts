import path from 'node:path'
import {
  acquireProjectLock,
  type AcquireResult,
  type ProjectLockHandle,
  type ProjectLockInfo
} from './projectLock'

/**
 * M10 尾项：**窗口侧**工程锁接线。
 *
 * 口径（与 Agent 侧 `project.lock` 共用同一套 `projectLock.ts`）：
 * - 窗口在同一时刻最多持有一把锁：打开/另存为另一个工程时先释放旧的再拿新的；
 * - 打开工程（含从「最近项目」打开、另存为、CLI 指定路径保存）成功后立即持锁，
 *   这样 Agent 之后 `project.lock`/保存会被明确拒绝（错误信息带 pid 与 mode=window）；
 * - **冲突时不让窗口"打不开工程"**：Agent 已持锁时只记日志、不持锁照常打开——
 *   用户可见的拒绝只发生在 Agent 侧（可读），窗口侧退回"无锁"旧行为；
 * - 退出应用时释放（`registerIpc` 里挂 `will-quit`）；即使没来得及释放，
 *   心跳停止后 15s 也会被判为陈旧锁，下一次打开自动接管。
 */

export type WindowLockBindResult =
  | { ok: true; path: string; previous: string | null }
  | { ok: false; path: string; reason: 'locked' | 'error'; holder?: ProjectLockInfo; message?: string }

export interface WindowProjectLock {
  /** 把窗口锁切到某个工程文件（同一路径重复调用 = 幂等 no-op） */
  bind: (projectPath: string) => Promise<WindowLockBindResult>
  /** 释放当前窗口锁（没有持锁时 no-op） */
  release: () => Promise<void>
  /** 当前持锁的工程绝对路径（未持锁 = null） */
  currentPath: () => string | null
}

export function createWindowProjectLock(): WindowProjectLock {
  let current: { path: string; handle: ProjectLockHandle } | null = null

  async function release(): Promise<void> {
    const held = current
    current = null
    if (held) await held.handle.release()
  }

  async function bind(projectPath: string): Promise<WindowLockBindResult> {
    if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
      return { ok: false, path: '', reason: 'error', message: '工程路径为空' }
    }
    const resolved = path.resolve(projectPath)
    const previous = current?.path ?? null
    if (previous === resolved) return { ok: true, path: resolved, previous }
    // 先释放旧锁再拿新锁：不释放会自己挡住自己（同一进程持有两把不同的锁没问题，
    // 但换工程后旧锁必须撤掉，否则旧工程对 Agent 永远是"占用中"）
    await release()

    const result: AcquireResult = await acquireProjectLock(resolved, 'window')
    if (result.ok) {
      current = { path: resolved, handle: result.handle }
      return { ok: true, path: resolved, previous }
    }
    const holder = result.holder
    if (result.reason === 'locked' && holder) return { ok: false, path: resolved, reason: 'locked', holder }
    return { ok: false, path: resolved, reason: 'error', ...(result.message ? { message: result.message } : {}) }
  }

  return { bind, release, currentPath: () => current?.path ?? null }
}
