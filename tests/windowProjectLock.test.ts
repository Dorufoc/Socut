import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acquireProjectLock, readProjectLock, releaseProjectLock } from '../src/main/projectLock'
import { createWindowProjectLock } from '../src/main/windowProjectLock'

/**
 * M10 尾项：窗口侧工程锁。
 *
 * 锁四件事：
 * 1. 打开工程后持锁（锁文件真实存在，mode=window）；
 * 2. 切到另一个工程：旧锁被撤、新锁生效（不能把自己钉在旧工程上）；
 * 3. Agent 已持锁时窗口**不阻止打开**（bind 返回 locked，窗口退回无锁）；
 * 4. 释放后 Agent 能正常拿锁；重复 bind 同一路径幂等。
 */

let dir = ''

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-window-lock-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const projectA = (): string => path.join(dir, 'a.socut.json')
const projectB = (): string => path.join(dir, 'b.socut.json')

describe('窗口侧工程锁', () => {
  it('打开工程 → 持 window 锁；退出释放', async () => {
    const lock = createWindowProjectLock()
    const bound = await lock.bind(projectA())
    expect(bound.ok).toBe(true)
    expect(lock.currentPath()).toBe(path.resolve(projectA()))

    const info = await readProjectLock(projectA())
    expect(info?.mode).toBe('window')
    expect(info?.pid).toBe(process.pid)

    await lock.release()
    expect(lock.currentPath()).toBeNull()
    expect(await readProjectLock(projectA())).toBeNull()
  })

  it('切到另一个工程：旧锁撤掉、新锁生效（不能把旧工程一直锁住）', async () => {
    const lock = createWindowProjectLock()
    await lock.bind(projectA())
    const switched = await lock.bind(projectB())
    expect(switched).toMatchObject({ ok: true, previous: path.resolve(projectA()) })
    expect(await readProjectLock(projectA())).toBeNull()
    expect((await readProjectLock(projectB()))?.mode).toBe('window')
    await lock.release()
  })

  it('重复 bind 同一路径幂等（心跳不被重置成新 token）', async () => {
    const lock = createWindowProjectLock()
    await lock.bind(projectA())
    const first = await readProjectLock(projectA())
    const again = await lock.bind(projectA())
    expect(again.ok).toBe(true)
    expect((await readProjectLock(projectA()))?.token).toBe(first?.token)
    await lock.release()
  })

  it('Agent 已持锁：窗口 bind 返回 locked 且不改动 Agent 的锁（窗口照常打开，只是不持锁）', async () => {
    const agent = await acquireProjectLock(projectA(), 'agent')
    expect(agent.ok).toBe(true)
    if (!agent.ok) return
    const lock = createWindowProjectLock()
    const bound = await lock.bind(projectA())
    expect(bound).toMatchObject({ ok: false, reason: 'locked' })
    if (!bound.ok) {
      expect(bound.holder?.mode).toBe('agent')
      expect(bound.holder?.pid).toBe(process.pid)
    }
    expect(lock.currentPath()).toBeNull()
    const still = await readProjectLock(projectA())
    expect(still?.mode).toBe('agent')
    // 释放 Agent 锁后窗口能正常拿到
    expect(await releaseProjectLock(projectA(), agent.handle.info.token)).toBe(true)
    expect((await lock.bind(projectA())).ok).toBe(true)
    await lock.release()
  })

  it('空路径被拒绝（不产生一个 ???.lock 文件）', async () => {
    const lock = createWindowProjectLock()
    const result = await lock.bind('   ')
    expect(result).toMatchObject({ ok: false, reason: 'error' })
    expect(lock.currentPath()).toBeNull()
  })
})
