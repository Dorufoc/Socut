import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_LOCK_STALE_MS,
  acquireProjectLock,
  isLockStale,
  projectLockPath,
  readProjectLock,
  releaseProjectLock
} from '../src/main/projectLock'

/** M10：工程锁（真文件系统，临时目录隔离）。 */

let dir = ''
let projectPath = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-lock-'))
  projectPath = path.join(dir, 'news.socut')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function writeRawLock(info: Record<string, unknown>): Promise<void> {
  await fs.writeFile(projectLockPath(projectPath), JSON.stringify(info), 'utf8')
}

describe('projectLock', () => {
  it('申请成功：锁文件落盘、processPending；释放后文件消失', async () => {
    const result = await acquireProjectLock(projectPath, 'agent')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const onDisk = await readProjectLock(projectPath)
    expect(onDisk?.mode).toBe('agent')
    expect(onDisk?.pid).toBe(process.pid)
    expect(onDisk?.token).toBe(result.handle.info.token)

    await result.handle.release()
    expect(await readProjectLock(projectPath)).toBeNull()
    await expect(fs.stat(projectLockPath(projectPath))).rejects.toThrow()
  })

  it('已有新鲜锁：第二个申请者被拒并拿到持有者信息', async () => {
    const first = await acquireProjectLock(projectPath, 'window')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await acquireProjectLock(projectPath, 'agent')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toBe('locked')
    expect(second.holder?.token).toBe(first.handle.info.token)
    expect(second.holder?.mode).toBe('window')

    await first.handle.release()
  })

  it('按 token 释放：token 不对不动别人的锁', async () => {
    const held = await acquireProjectLock(projectPath, 'agent')
    expect(held.ok).toBe(true)
    if (!held.ok) return

    expect(await releaseProjectLock(projectPath, 'wrong-token')).toBe(false)
    expect(await readProjectLock(projectPath)).not.toBeNull()

    expect(await releaseProjectLock(projectPath, held.handle.info.token)).toBe(true)
    expect(await readProjectLock(projectPath)).toBeNull()
  })

  it('心跳超时视为陈旧：可被接管', async () => {
    const old = new Date(Date.now() - PROJECT_LOCK_STALE_MS - 5_000).toISOString()
    const stale = {
      token: 'stale-token',
      pid: process.pid, // 进程活着，但心跳过期
      mode: 'agent',
      projectPath,
      startedAt: old,
      heartbeatAt: old
    }
    await writeRawLock(stale)
    expect(isLockStale(stale as never)).toBe(true)

    const taken = await acquireProjectLock(projectPath, 'window')
    expect(taken.ok).toBe(true)
    if (!taken.ok) return
    expect(taken.handle.info.token).not.toBe('stale-token')
    await taken.handle.release()
  })

  it('持有进程已退出：即使心跳很新也算陈旧（崩溃残留可接管）', async () => {
    const fresh = new Date().toISOString()
    const dead = {
      token: 'dead-token',
      pid: 999_999, // 不存在的进程
      mode: 'agent',
      projectPath,
      startedAt: fresh,
      heartbeatAt: fresh
    }
    await writeRawLock(dead)
    expect(isLockStale(dead as never)).toBe(true)

    const taken = await acquireProjectLock(projectPath, 'agent')
    expect(taken.ok).toBe(true)
    if (taken.ok) await taken.handle.release()
  })

  it('锁文件内容损坏：按无锁处理并可接管', async () => {
    await fs.writeFile(projectLockPath(projectPath), '{broken json', 'utf8')
    expect(await readProjectLock(projectPath)).toBeNull()
    const taken = await acquireProjectLock(projectPath, 'window')
    expect(taken.ok).toBe(true)
    if (taken.ok) await taken.handle.release()
  })

  it('锁路径 = 工程绝对路径 + .lock（同一工程两种相对写法落到同一把锁）', () => {
    expect(projectLockPath('news.socut')).toBe(`${path.resolve('news.socut')}.lock`)
  })
})
