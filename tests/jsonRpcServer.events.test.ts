import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * engine.ts 依赖 electron：本文件只验证「进度钩子 → 事件总线 → JSON-RPC 推送」这条链路，
 * 窗口列表给空数组即可让假任务立刻以 NO_WINDOW 终态收尾——不跑 FFmpeg、不碰真实导出。
 */
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => process.env['TEMP'] ?? '/tmp',
    getAppPath: () => process.cwd()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: () => undefined }
}))

import { ControlEventBus, EVENT_TOPIC_LIST, EVENT_TOPICS, RPC_ERROR_CODES, projectChangedEvent } from '@shared/jsonRpc'
import type { ExportRequest, JobProgress } from '@shared/types'
import { JsonRpcControlServer } from '../src/main/control/jsonRpcServer'
import { ExportEngine } from '../src/main/export/engine'

/**
 * M10 尾项：JSON-RPC 事件流（events.subscribe / event notification）真 socket 端到端。
 *
 * 只起真实 TCP 回环连接；事件源用注入的独立 ControlEventBus（生产默认是进程内单例），
 * 导出进度用假导出（ExportEngine 的 NO_WINDOW 终态），不依赖真实 FFmpeg 长任务。
 */

const TOKEN = 'test-token-events-0123456789'

interface Client {
  send: (payload: unknown) => void
  sendRaw: (line: string) => void
  /** 读下一帧（响应或事件）；超时 reject，便于断言「没有推送」 */
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => void
}

function request(id: number | string, method: string, params?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    const queue: Record<string, unknown>[] = []
    interface Waiter {
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
    const waiters: Waiter[] = []
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.trim().length === 0) continue
        const parsed = JSON.parse(part) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) {
          clearTimeout(waiter.timer)
          waiter.resolve(parsed)
        } else {
          queue.push(parsed)
        }
      }
    })
    socket.on('error', reject)
    socket.on('connect', () =>
      resolve({
        send: (payload) => socket.write(`${JSON.stringify(payload)}\n`),
        sendRaw: (line) => socket.write(`${line}\n`),
        next: (timeoutMs = 3000) =>
          new Promise<Record<string, unknown>>((nextResolve, nextReject) => {
            const pending = queue.shift()
            if (pending) {
              nextResolve(pending)
              return
            }
            const timer = setTimeout(() => {
              const index = waiters.findIndex((waiter) => waiter.timer === timer)
              if (index >= 0) waiters.splice(index, 1)
              nextReject(new Error('等待 JSON-RPC 帧超时'))
            }, timeoutMs)
            waiters.push({ resolve: nextResolve, reject: nextReject, timer })
          }),
        close: () => socket.destroy()
      })
    )
  })
}

/** 认证 + 订阅指定主题，返回客户端与订阅确认结果。 */
async function authedSubscriber(
  port: number,
  topics: string[]
): Promise<{ client: Client; subscribed: Record<string, unknown> }> {
  const client = await connect(port)
  client.send(request(0, 'auth', { token: TOKEN }))
  await client.next()
  client.send(request(1, 'events.subscribe', { topics }))
  const response = await client.next()
  return { client, subscribed: response['result'] as Record<string, unknown> }
}

function eventParamsOf(frame: Record<string, unknown>): { topic: string; data: unknown; seq: number } {
  return frame['params'] as { topic: string; data: unknown; seq: number }
}

/** 起一台带自定义选项的服务器（用完即停），返回端口与总线。 */
async function startServer(options: {
  maxSubscriptions?: number
  maxPendingEvents?: number
}): Promise<{ server: JsonRpcControlServer; bus: ControlEventBus; port: number }> {
  const bus = new ControlEventBus()
  const server = new JsonRpcControlServer({
    token: TOKEN,
    appVersion: '0.1.0-test',
    events: bus,
    dispatch: async (command) => ({ command: command.command }),
    ...(options.maxSubscriptions !== undefined ? { maxSubscriptions: options.maxSubscriptions } : {}),
    ...(options.maxPendingEvents !== undefined ? { maxPendingEvents: options.maxPendingEvents } : {})
  })
  const info = await server.start()
  return { server, bus, port: info.tcpPort }
}

function fakeProgress(jobId: string, framesDone: number): JobProgress {
  return {
    jobId,
    phase: 'rendering',
    framesDone,
    framesTotal: 100,
    outTimeUs: 0,
    percent: framesDone / 100,
    bytesWritten: 0,
    elapsedMs: 12,
    notices: []
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const bus = new ControlEventBus()
const server = new JsonRpcControlServer({
  token: TOKEN,
  appVersion: '0.1.0-test',
  events: bus,
  dispatch: async (command) => ({ command: command.command })
})
let port = 0

beforeAll(async () => {
  const info = await server.start()
  port = info.tcpPort
  expect(port).toBeGreaterThan(0)
})

afterAll(async () => {
  await server.stop()
})

describe('JSON-RPC 事件流：订阅 / 推送 / 退订（真 socket）', () => {
  it('subscribe 返回确认 + 可用主题；未订阅的主题不推送', async () => {
    const { client, subscribed } = await authedSubscriber(port, [EVENT_TOPICS.exportProgress])
    expect(subscribed['ok']).toBe(true)
    expect(subscribed['subscribed']).toEqual([EVENT_TOPICS.exportProgress])
    expect(subscribed['topics']).toEqual([EVENT_TOPICS.exportProgress])
    expect(subscribed['available']).toEqual(EVENT_TOPIC_LIST)
    expect(subscribed['limit']).toBe(32)
    expect(subscribed['nextSeq']).toBe(1)

    // 只订阅了 export.progress：工程变更事件不应推给这个连接
    bus.publish(EVENT_TOPICS.projectChanged, { path: 'D:\\proj.socut', reason: 'open' })
    await expect(client.next(150)).rejects.toThrow('等待 JSON-RPC 帧超时')

    // 之后的正常请求仍然可用（无残帧/无污染）
    client.send(request(2, 'version'))
    const version = await client.next()
    expect(version['id']).toBe(2)
    expect((version['result'] as { capabilities: string[] }).capabilities).toContain('events')
    client.close()
  })

  it('订阅后收到 export.progress 通知：无 id、字段与 job 快照一致、seq 递增', async () => {
    const { client } = await authedSubscriber(port, [EVENT_TOPICS.exportProgress])
    const first = fakeProgress('job-events-1', 10)
    bus.publish(EVENT_TOPICS.exportProgress, first)
    bus.publish(EVENT_TOPICS.exportProgress, fakeProgress('job-events-1', 20))
    bus.publish(EVENT_TOPICS.exportProgress, fakeProgress('job-events-1', 30))

    const frames: Record<string, unknown>[] = []
    for (let index = 0; index < 3; index += 1) frames.push(await client.next())
    const seqs: number[] = []
    for (const frame of frames) {
      // 通知没有 id（不是响应，客户端不能按 id 配对）
      expect('id' in frame).toBe(false)
      expect(frame['jsonrpc']).toBe('2.0')
      expect(frame['method']).toBe('event')
      const params = eventParamsOf(frame)
      expect(params.topic).toBe(EVENT_TOPICS.exportProgress)
      seqs.push(params.seq)
    }
    expect(seqs).toEqual([1, 2, 3])
    const data = eventParamsOf(frames[0]!)['data'] as JobProgress
    expect(data).toEqual(first)
    // 与 export.status 的 job 快照同口径（字段名/含义一致）
    expect(Object.keys(data).sort()).toEqual(
      ['jobId', 'phase', 'framesDone', 'framesTotal', 'outTimeUs', 'percent', 'bytesWritten', 'elapsedMs', 'notices'].sort()
    )
    client.close()
  })

  it('非订阅者收不到别人的事件；不同连接的 seq 互不干扰', async () => {
    const a = await authedSubscriber(port, [EVENT_TOPICS.exportProgress])
    const b = await connect(port)
    b.send(request(0, 'auth', { token: TOKEN }))
    await b.next()

    bus.publish(EVENT_TOPICS.exportProgress, fakeProgress('job-events-2', 50))
    const frame = await a.client.next()
    expect(eventParamsOf(frame).seq).toBe(1)
    // B 没订阅：任何帧都不该出现（事件与响应都走同一行协议）
    await expect(b.next(150)).rejects.toThrow('等待 JSON-RPC 帧超时')

    // B 订阅后从头编号（每连接独立 seq）
    b.send(request(2, 'events.subscribe', { topics: [EVENT_TOPICS.exportProgress] }))
    const subscribed = await b.next()
    expect((subscribed['result'] as { nextSeq: number }).nextSeq).toBe(1)
    a.client.close()
    b.close()
  })

  it('unsubscribe 后不再收到；省略 topics = 全部退订；未知/未订阅主题忽略', async () => {
    const { client } = await authedSubscriber(port, [EVENT_TOPICS.exportProgress, EVENT_TOPICS.projectChanged])
    client.send(request(2, 'events.unsubscribe', { topics: [EVENT_TOPICS.exportProgress, 'not.subscribed'] }))
    const removed = await client.next()
    const removedResult = removed['result'] as { unsubscribed: string[]; topics: string[] }
    expect(removedResult.unsubscribed).toEqual([EVENT_TOPICS.exportProgress])
    expect(removedResult.topics).toEqual([EVENT_TOPICS.projectChanged])

    bus.publish(EVENT_TOPICS.exportProgress, fakeProgress('job-events-3', 60))
    await expect(client.next(150)).rejects.toThrow('等待 JSON-RPC 帧超时')

    // 仍然订阅的工程变更主题照常收到
    bus.publish(
      EVENT_TOPICS.projectChanged,
      projectChangedEvent({ path: 'D:\\demo.socut', name: '演示', reason: 'open' })
    )
    const changed = await client.next()
    expect(eventParamsOf(changed).topic).toBe(EVENT_TOPICS.projectChanged)

    // 不带 topics：清空全部订阅
    client.send(request(3, 'events.unsubscribe'))
    const cleared = await client.next()
    expect((cleared['result'] as { topics: string[] }).topics).toEqual([])
    bus.publish(EVENT_TOPICS.projectChanged, { path: null, reason: 'save' })
    await expect(client.next(150)).rejects.toThrow('等待 JSON-RPC 帧超时')
    client.close()
  })

  it('project.changed 数据：路径/来源/revision(null)/时间戳', async () => {
    const { client } = await authedSubscriber(port, [EVENT_TOPICS.projectChanged])
    bus.publish(
      EVENT_TOPICS.projectChanged,
      projectChangedEvent({ path: 'D:\\demo.socut', name: '演示', reason: 'open', mode: 'window' })
    )
    const frame = await client.next()
    const data = eventParamsOf(frame)['data'] as Record<string, unknown>
    expect(data['path']).toBe('D:\\demo.socut')
    expect(data['name']).toBe('演示')
    expect(data['reason']).toBe('open')
    expect(data['mode']).toBe('window')
    // 主进程观测不到渲染侧 revision：字段在但为 null（不臆造版本号）
    expect(data['revision']).toBeNull()
    expect(typeof data['at']).toBe('string')
    client.close()
  })

  it('未知主题 / 空 topics / 不是数组：invalidParams；订阅上限：subscriptionLimit', async () => {
    const client = await connect(port)
    client.send(request(0, 'auth', { token: TOKEN }))
    await client.next()

    client.send(request(1, 'events.subscribe', { topics: ['no.such.topic'] }))
    const unknown = await client.next()
    const unknownError = unknown['error'] as { code: number; data: { code: string; detail: string } }
    expect(unknownError.code).toBe(RPC_ERROR_CODES.invalidParams)
    expect(unknownError.data.code).toBe('BAD_PARAMS')
    expect(unknownError.data.detail).toContain('export.progress')

    client.send(request(2, 'events.subscribe', { topics: [] }))
    expect(((await client.next())['error'] as { code: number }).code).toBe(RPC_ERROR_CODES.invalidParams)

    client.send(request(3, 'events.subscribe', { topics: 'export.progress' }))
    expect(((await client.next())['error'] as { code: number }).code).toBe(RPC_ERROR_CODES.invalidParams)
    client.close()

    // 上限用独立服务器把 maxSubscriptions 调小到 1（生产默认 32）
    const limited = await startServer({ maxSubscriptions: 1 })
    try {
      const bounded = await connect(limited.port)
      bounded.send(request(0, 'auth', { token: TOKEN }))
      await bounded.next()
      bounded.send(request(1, 'events.subscribe', { topics: [EVENT_TOPICS.exportProgress] }))
      expect(((await bounded.next())['result'] as { ok: boolean }).ok).toBe(true)
      bounded.send(request(2, 'events.subscribe', { topics: [EVENT_TOPICS.projectChanged] }))
      const limitedError = await bounded.next()
      expect(((limitedError['error'] as { code: number }).code)).toBe(RPC_ERROR_CODES.subscriptionLimit)
      expect((limitedError['error'] as { data: { code: string } }).data.code).toBe('EVENT_SUBSCRIPTION_LIMIT')
      bounded.close()
    } finally {
      await limited.server.stop()
    }
  })

  it('断连清理：连接关闭后订阅表移除，事件继续广播给其它连接', async () => {
    // 等前面用例的连接 close 事件传播完，保证诊断表是干净的
    await waitFor(() => server.eventDiagnostics().length === 0)
    const a = await authedSubscriber(port, [EVENT_TOPICS.exportProgress])
    const b = await authedSubscriber(port, [EVENT_TOPICS.exportProgress])
    expect(server.eventDiagnostics().length).toBe(2)
    a.client.close()
    await waitFor(() => server.eventDiagnostics().length === 1)

    bus.publish(EVENT_TOPICS.exportProgress, fakeProgress('job-events-4', 70))
    const frame = await b.client.next()
    expect(eventParamsOf(frame).seq).toBe(1)
    expect(server.eventDiagnostics()[0]?.topics).toEqual([EVENT_TOPICS.exportProgress])
    b.client.close()
    await waitFor(() => server.eventDiagnostics().length === 0)
  })

  it('背压：慢客户端待发队列有界（丢最旧），seq 跳号可感知', async () => {
    const limited = await startServer({ maxPendingEvents: 8 })
    try {
      const { client } = await authedSubscriber(limited.port, [EVENT_TOPICS.exportProgress])
      // 同步连发 100 条：drain 在 setImmediate 里，队列在排空前就超过上限 → 只保留最后 8 条
      for (let index = 1; index <= 100; index += 1) {
        limited.bus.publish(EVENT_TOPICS.exportProgress, fakeProgress('job-slow', index))
      }
      const received = []
      for (let index = 0; index < 8; index += 1) received.push(await client.next())
      const seqs = received.map((frame) => eventParamsOf(frame).seq)
      expect(seqs).toEqual([93, 94, 95, 96, 97, 98, 99, 100])
      // 丢弃计数可诊断（正常导出节奏下恒为 0）
      expect(limited.server.eventDiagnostics()[0]?.dropped).toBe(92)
      // 丢事件不能把连接搞坏：后续请求照常
      client.send(request(9, 'version'))
      expect((await client.next())['id']).toBe(9)
      client.close()
    } finally {
      await limited.server.stop()
    }
  })

  it('stop() 解除事件源订阅（不留悬空监听）', async () => {
    const solo = new ControlEventBus()
    const soloServer = new JsonRpcControlServer({
      token: TOKEN,
      appVersion: '0.1.0-test',
      events: solo,
      dispatch: async (command) => ({ command: command.command })
    })
    await soloServer.start()
    expect(solo.listenerCount).toBe(1)
    await soloServer.stop()
    expect(solo.listenerCount).toBe(0)
  })
})

describe('ExportEngine 进度钩子（假导出，不跑 FFmpeg）', () => {
  function fakeRequest(jobId: string): ExportRequest {
    return {
      jobId,
      frameSpec: {
        startFrame: 0,
        endFrame: 10,
        fps: { num: 30, den: 1 },
        width: 1920,
        height: 1080,
        frameFormat: 'png'
      },
      target: { kind: 'pngSequence', outputDir: 'C:\\tmp', fileName: 'events' }
    } as unknown as ExportRequest
  }

  it('onProgress 收到 queued/failed 终态；取消订阅后不再回调', async () => {
    const engine = new ExportEngine()
    const received: JobProgress[] = []
    const detach = engine.onProgress((progress) => received.push(progress))

    // 窗口列表为空 → 任务立刻以 NO_WINDOW 失败（不解析 FFmpeg、不渲染帧）
    await engine.submit(fakeRequest('job-engine-1'), { id: 7 } as unknown as Parameters<ExportEngine['submit']>[1])
    await waitFor(() => received.some((progress) => progress.phase === 'failed'))

    expect(received[0]?.phase).toBe('queued')
    expect(received[0]?.jobId).toBe('job-engine-1')
    expect(received[0]?.framesTotal).toBe(10)
    const failed = received.find((progress) => progress.phase === 'failed')
    expect(failed?.percent).toBeGreaterThanOrEqual(0)
    expect(engine.jobStatus('job-engine-1')?.result?.ok).toBe(false)

    detach()
    const before = received.length
    await engine.submit(fakeRequest('job-engine-2'), { id: 7 } as unknown as Parameters<ExportEngine['submit']>[1])
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(received.length).toBe(before)
    await engine.shutdown()
  })

  it('订阅者抛错不影响导出推进（事件 bug 不能反过来让导出失败）', async () => {
    const engine = new ExportEngine()
    const detach = engine.onProgress(() => {
      throw new Error('订阅者故意抛错')
    })
    await engine.submit(fakeRequest('job-engine-3'), { id: 8 } as unknown as Parameters<ExportEngine['submit']>[1])
    await waitFor(() => engine.jobStatus('job-engine-3')?.result != null)
    expect(engine.jobStatus('job-engine-3')?.result?.error?.code).toBe('NO_WINDOW')
    detach()
    await engine.shutdown()
  })

  it('engine → 事件总线 → JSON-RPC 真 socket：export.progress 端到端', async () => {
    const engine = new ExportEngine()
    const engineBus = new ControlEventBus()
    const engineServer = new JsonRpcControlServer({
      token: TOKEN,
      appVersion: '0.1.0-test',
      events: engineBus,
      dispatch: async (command) => ({ command: command.command })
    })
    const info = await engineServer.start()
    const detach = engine.onProgress((progress) => {
      engineBus.publish(EVENT_TOPICS.exportProgress, progress)
    })
    try {
      const { client } = await authedSubscriber(info.tcpPort, [EVENT_TOPICS.exportProgress])
      await engine.submit(fakeRequest('job-e2e-1'), { id: 9 } as unknown as Parameters<ExportEngine['submit']>[1])
      const first = await client.next()
      expect(first['method']).toBe('event')
      expect((eventParamsOf(first)['data'] as JobProgress).jobId).toBe('job-e2e-1')

      const phases: string[] = []
      for (let index = 0; index < 5; index += 1) {
        const frame = await client.next(2000)
        phases.push((eventParamsOf(frame)['data'] as JobProgress).phase)
        if (phases[phases.length - 1] === 'failed') break
      }
      expect(phases).toContain('failed')
      client.close()
    } finally {
      detach()
      await engineServer.stop()
      await engine.shutdown()
    }
  })
})
