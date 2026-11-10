import { describe, expect, it, vi } from 'vitest'
import {
  BoundedEventQueue,
  ControlEventBus,
  EVENT_NOTIFICATION_METHOD,
  EVENT_TOPIC_LIST,
  EVENT_TOPICS,
  JSON_RPC_MAX_LINE_BYTES,
  RPC_ERROR_CODES,
  jsonRpcError,
  jsonRpcErrorFromCli,
  jsonRpcEvent,
  jsonRpcResult,
  parseJsonRpcRequest,
  projectChangedEvent,
  rpcCodeOf,
  splitLines
} from '@shared/jsonRpc'
import { base64ToBytes, bytesToBase64 } from '@shared/base64'

/** M10：JSON-RPC 2.0 行协议（纯函数层）。 */

describe('jsonRpc.parseJsonRpcRequest', () => {
  it('合法请求：保留 id / method / params', () => {
    const parsed = parseJsonRpcRequest('{"jsonrpc":"2.0","id":7,"method":"project.get","params":{"a":1}}')
    expect(parsed).toEqual({
      ok: true,
      request: { jsonrpc: '2.0', id: 7, method: 'project.get', params: { a: 1 } }
    })
    expect(parseJsonRpcRequest('{"jsonrpc":"2.0","id":"x","method":"version"}')).toEqual({
      ok: true,
      request: { jsonrpc: '2.0', id: 'x', method: 'version' }
    })
  })

  it('非法 JSON / 非对象 / 缺 method / 错版本：返回可直接回写的错误', () => {
    expect(parseJsonRpcRequest('{bad json').ok).toBe(false)
    const notObject = parseJsonRpcRequest('[]')
    expect(notObject.ok).toBe(false)
    if (!notObject.ok) expect(notObject.error.code).toBe(RPC_ERROR_CODES.invalidRequest)

    const noMethod = parseJsonRpcRequest('{"jsonrpc":"2.0","id":1}')
    expect(noMethod.ok).toBe(false)
    if (!noMethod.ok) {
      expect(noMethod.error.code).toBe(RPC_ERROR_CODES.invalidRequest)
      expect(noMethod.id).toBe(1)
    }

    const wrongVersion = parseJsonRpcRequest('{"jsonrpc":"1.0","id":2,"method":"x"}')
    expect(wrongVersion.ok).toBe(false)
    if (!wrongVersion.ok) expect(wrongVersion.error.code).toBe(RPC_ERROR_CODES.invalidRequest)
  })

  it('id 缺失/非法：invalidRequest 且 id 回 null；params 非对象/数组也拒绝', () => {
    const badId = parseJsonRpcRequest('{"jsonrpc":"2.0","id":{},"method":"x"}')
    expect(badId.ok).toBe(false)
    if (!badId.ok) expect(badId.id).toBeNull()

    const badParams = parseJsonRpcRequest('{"jsonrpc":"2.0","id":1,"method":"x","params":42}')
    expect(badParams.ok).toBe(false)
    if (!badParams.ok) expect(badParams.error.code).toBe(RPC_ERROR_CODES.invalidRequest)
  })

  it('空行不是合法请求', () => {
    expect(parseJsonRpcRequest('   ').ok).toBe(false)
  })
})

describe('jsonRpc 响应与错误映射', () => {
  it('成功/失败响应形状符合 JSON-RPC 2.0', () => {
    expect(jsonRpcResult(3, { ok: true })).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: true } })
    const failure = jsonRpcError(3, RPC_ERROR_CODES.notFound, '不存在', { code: 'NOT_FOUND', detail: 'x' })
    expect(failure.error.code).toBe(RPC_ERROR_CODES.notFound)
    expect(failure.error.data).toEqual({ code: 'NOT_FOUND', detail: 'x' })
    // 没有 data 时不写空对象
    expect(jsonRpcError(1, RPC_ERROR_CODES.internal, 'x').error['data']).toBeUndefined()
  })

  it('CLI 错误码 → JSON-RPC 错误码映射', () => {
    expect(rpcCodeOf('BAD_PARAMS')).toBe(RPC_ERROR_CODES.invalidParams)
    expect(rpcCodeOf('NOT_FOUND')).toBe(RPC_ERROR_CODES.notFound)
    expect(rpcCodeOf('UNAUTHORIZED')).toBe(RPC_ERROR_CODES.unauthorized)
    expect(rpcCodeOf('GATE_BLOCKED')).toBe(RPC_ERROR_CODES.unavailable)
    expect(rpcCodeOf('EXPORT_FAILED')).toBe(RPC_ERROR_CODES.failed)
    expect(rpcCodeOf('SOMETHING_NEW')).toBe(RPC_ERROR_CODES.internal)
    expect(jsonRpcErrorFromCli(5, { code: 'BAD_PARAMS', message: '缺参数' }).error).toEqual({
      code: RPC_ERROR_CODES.invalidParams,
      message: '缺参数',
      data: { code: 'BAD_PARAMS' }
    })
  })

  it('分帧：跨块拼接、CRLF 兼容、保留未闭合尾巴', () => {
    expect(splitLines('{"a":1}\n{"b":2}\n')).toEqual({ lines: ['{"a":1}', '{"b":2}'], rest: '' })
    expect(splitLines('{"a":1}\r\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
    expect(splitLines('')).toEqual({ lines: [], rest: '' })
    expect(JSON_RPC_MAX_LINE_BYTES).toBeGreaterThan(1024 * 1024)
  })
})

describe('base64：帧图编码（不依赖 toDataURL）', () => {
  it('字节往返一致；空数组/大数组都能编码', () => {
    const small = new Uint8Array([0, 1, 2, 253, 254, 255])
    expect(Array.from(base64ToBytes(bytesToBase64(small)))).toEqual(Array.from(small))
    expect(bytesToBase64(new Uint8Array(0))).toBe('')

    const big = new Uint8Array(200_000)
    for (let index = 0; index < big.length; index += 1) big[index] = index % 256
    const encoded = bytesToBase64(big)
    expect(encoded.length).toBeGreaterThan(big.length)
    expect(Array.from(base64ToBytes(encoded).subarray(0, 8))).toEqual(Array.from(big.subarray(0, 8)))
  })
})

describe('jsonRpc 事件流（协议层纯函数）', () => {
  it('event notification：固定 method、无 id、params 带 topic/data/seq', () => {
    const notification = jsonRpcEvent(EVENT_TOPICS.exportProgress, { jobId: 'j1', percent: 0.5 }, 7)
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'event',
      params: { topic: 'export.progress', data: { jobId: 'j1', percent: 0.5 }, seq: 7 }
    })
    expect(EVENT_NOTIFICATION_METHOD).toBe('event')
    // 通知不能带 id（否则客户端会当成响应去配对）
    expect('id' in notification).toBe(false)
    expect(EVENT_TOPIC_LIST).toEqual([EVENT_TOPICS.exportProgress, EVENT_TOPICS.projectChanged])
  })

  it('project.changed：路径/来源/时间戳；revision 缺省 null、mode 按需带', () => {
    const at = '2026-01-01T00:00:00.000Z'
    expect(projectChangedEvent({ path: 'D:\\p.socut', name: '演示', reason: 'open', at })).toEqual({
      path: 'D:\\p.socut',
      name: '演示',
      reason: 'open',
      revision: null,
      at
    })
    const locked = projectChangedEvent({ path: null, reason: 'lock', mode: 'window', at })
    expect(locked.mode).toBe('window')
    expect(locked.revision).toBeNull()
    expect(locked.name).toBeNull()
    // 不传 at 时取当前时间（ISO 格式可解析）
    const now = projectChangedEvent({ path: null, reason: 'save' })
    expect(Number.isNaN(Date.parse(now.at))).toBe(false)
  })

  it('有界事件队列：超限丢最旧、计数正确、clear/take 语义', () => {
    const queue = new BoundedEventQueue<number>(3)
    expect(queue.push(1)).toBe(false)
    expect(queue.push(2)).toBe(false)
    expect(queue.push(3)).toBe(false)
    expect(queue.dropped).toBe(0)
    // 第 4 条：丢最旧的 1
    expect(queue.push(4)).toBe(true)
    expect(queue.size).toBe(3)
    expect(queue.dropped).toBe(1)
    expect([queue.take(), queue.take(), queue.take()]).toEqual([2, 3, 4])
    expect(queue.take()).toBeUndefined()
    queue.push(9)
    queue.clear()
    expect(queue.size).toBe(0)
    expect(queue.dropped).toBe(1)
    // 上限必须是正整数（防止误配成 0/负数把队列变成"全丢"）
    expect(() => new BoundedEventQueue(0)).toThrow()
  })

  it('事件总线：多订阅者广播、取消函数幂等、订阅者抛错不影响其它订阅者', () => {
    const bus = new ControlEventBus()
    const received: Array<{ topic: string; data: unknown }> = []
    const bad = vi.fn(() => {
      throw new Error('订阅者故意抛错')
    })
    const detach = bus.subscribe((event) => received.push(event))
    bus.subscribe(bad)
    const delivered = bus.publish(EVENT_TOPICS.projectChanged, { path: 'D:\\x' })
    expect(delivered).toBe(2)
    expect(received).toEqual([{ topic: EVENT_TOPICS.projectChanged, data: { path: 'D:\\x' } }])
    expect(bus.listenerCount).toBe(2)
    detach()
    detach() // 幂等：重复取消不报错
    expect(bus.listenerCount).toBe(1)
    bus.publish(EVENT_TOPICS.exportProgress, { jobId: 'j2' })
    expect(received).toHaveLength(1)
  })
})
