import net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CliCommandError, CLI_ERROR_CODES, type CliCommandRequest } from '@shared/cliProtocol'
import { RPC_ERROR_CODES } from '@shared/jsonRpc'
import { JsonRpcControlServer, controlPipePath } from '../src/main/control/jsonRpcServer'

/**
 * M10：JSON-RPC 控制面（真 socket 往返）。
 *
 * 只起真实 TCP 回环连接，不 mock 传输层：认证、分帧、顺序、错误码都在这一层验证。
 * 业务分派用假实现（真分派会拉起渲染进程，不属于本测试的边界）。
 */

const TOKEN = 'test-token-0123456789'

const server = new JsonRpcControlServer({
  token: TOKEN,
  appVersion: '0.1.0-test',
  dispatch: async (request: CliCommandRequest): Promise<unknown> => {
    if (request.command === 'project.get') return { project: { name: 'demo' }, echo: request.params }
    if (request.command === 'project.save') {
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, '工程不存在', '路径为空')
    }
    return { command: request.command }
  }
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

interface Client {
  send: (payload: unknown) => void
  /** 直接写一行原始文本（用于构造坏 JSON） */
  sendRaw: (line: string) => void
  next: () => Promise<Record<string, unknown>>
  close: () => void
}

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    const queue: Record<string, unknown>[] = []
    const waiters: ((value: Record<string, unknown>) => void)[] = []
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        if (part.trim().length === 0) continue
        const parsed = JSON.parse(part) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) waiter(parsed)
        else queue.push(parsed)
      }
    })
    socket.on('error', reject)
    socket.on('connect', () =>
      resolve({
        send: (payload) => socket.write(`${JSON.stringify(payload)}\n`),
        sendRaw: (line) => socket.write(`${line}\n`),
        next: () =>
          new Promise((nextResolve) => {
            const pending = queue.shift()
            if (pending) nextResolve(pending)
            else waiters.push(nextResolve)
          }),
        close: () => socket.destroy()
      })
    )
  })
}

const request = (id: number | string, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {})
})

describe('JsonRpcControlServer', () => {
  it('首行不是 auth：拒绝并断开', async () => {
    const client = await connect()
    client.send(request(1, 'version'))
    const response = await client.next()
    expect((response['error'] as { code: number }).code).toBe(RPC_ERROR_CODES.unauthorized)
    client.close()
  })

  it('token 错误：拒绝', async () => {
    const client = await connect()
    client.send(request(1, 'auth', { token: 'wrong' }))
    const response = await client.next()
    expect((response['error'] as { code: number }).code).toBe(RPC_ERROR_CODES.unauthorized)
    client.close()
  })

  it('认证后：version / commands.list / 业务命令 / 未知方法 / 业务错误码', async () => {
    const client = await connect()
    client.send(request(0, 'auth', { token: TOKEN }))
    const auth = await client.next()
    expect((auth['result'] as { ok: boolean }).ok).toBe(true)

    client.send(request(1, 'version'))
    const version = await client.next()
    const capabilities = (version['result'] as { capabilities: string[] }).capabilities
    expect(capabilities).toContain('json-rpc')
    expect(capabilities).toContain('named-pipe')

    client.send(request(2, 'commands.list'))
    const commands = await client.next()
    expect((commands['result'] as { commands: unknown[] }).commands.length).toBeGreaterThan(90)

    client.send(request(3, 'project.get', { hello: 'world' }))
    const got = await client.next()
    expect((got['result'] as { echo: unknown }).echo).toEqual({ hello: 'world' })

    client.send(request(4, 'nope.method'))
    const unknown = await client.next()
    expect((unknown['error'] as { code: number }).code).toBe(RPC_ERROR_CODES.methodNotFound)

    client.send(request(5, 'project.save', {}))
    const failed = await client.next()
    const error = failed['error'] as { code: number; data: { code: string; detail?: string } }
    expect(error.code).toBe(RPC_ERROR_CODES.notFound)
    expect(error.data.code).toBe('NOT_FOUND')
    expect(error.data.detail).toBe('路径为空')
    client.close()
  })

  it('一包多条请求：按到达顺序回包（id 递增）', async () => {
    const client = await connect()
    client.send(request(0, 'auth', { token: TOKEN }))
    await client.next()
    client.send(request(10, 'version'))
    client.send(request(11, 'project.get'))
    client.send(request(12, 'project.save'))
    const ids: unknown[] = []
    for (let index = 0; index < 3; index += 1) ids.push((await client.next())['id'])
    expect(ids).toEqual([10, 11, 12])
    client.close()
  })

  it('坏行：回 parse 错误但不影响后续请求', async () => {
    const client = await connect()
    client.send(request(0, 'auth', { token: TOKEN }))
    await client.next()
    client.sendRaw('{not json')
    const parseError = await client.next()
    expect((parseError['error'] as { code: number }).code).toBe(RPC_ERROR_CODES.parse)

    client.send(request(2, 'version'))
    const ok = await client.next()
    expect(ok['id']).toBe(2)
    expect(ok['result']).toBeTruthy()
    client.close()
  })

  it('命名管道路径按 pid 生成（Windows 为 \\.\\pipe\\）', () => {
    const pipe = controlPipePath(1234)
    if (process.platform === 'win32') expect(pipe).toBe('\\\\.\\pipe\\socut-1234')
    else expect(pipe).toContain('socut-1234.sock')
  })
})
