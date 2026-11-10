import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * M10：MCP stdio server 端到端（真进程 + 假控制服务）。
 *
 * 不起 Electron：用 node:http 假扮 Socut 的 `/v1/health` 与 `/v1/command`，
 * 把 server.json 指给 MCP 子进程。验证的是 MCP 协议层与工具→命令的映射，
 * 不验证 Electron 侧（那属于 verify:all 的冒烟）。
 */

const TOKEN = 'mcp-test-token'
const MCP_SCRIPT = path.resolve('cli', 'socut-mcp.mjs')

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

let httpServer: http.Server
let child: ChildProcessWithoutNullStreams
let serverFile = ''
let tempDir = ''

const responses = new Map<number, unknown>()
const waiters = new Map<number, (value: unknown) => void>()

function waitForId(id: number, timeoutMs = 8000): Promise<unknown> {
  const existing = responses.get(id)
  if (existing) {
    responses.delete(id)
    return Promise.resolve(existing)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id)
      reject(new Error(`等待 id=${id} 响应超时`))
    }, timeoutMs)
    waiters.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function send(payload: unknown): void {
  child.stdin.write(`${JSON.stringify(payload)}\n`)
}

function sendRaw(line: string): void {
  child.stdin.write(`${line}\n`)
}

const call = (id: number, method: string, params?: unknown) =>
  send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-mcp-'))
  httpServer = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const sendJson = (payload: unknown): void => {
        const body = JSON.stringify(payload)
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        response.end(body)
      }
      if (request.method === 'GET' && request.url === '/v1/health') {
        sendJson({ ok: true, result: { protocolVersion: 1, rendererReady: true } })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/command') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          command: string
          params?: Record<string, unknown>
        }
        if (body.command === 'export.status') {
          sendJson({ ok: true, result: { progress: { phase: 'done', frame: 10, total: 10 }, result: { ok: true } } })
          return
        }
        if (body.command === 'preview.frame') {
          sendJson({
            ok: true,
            result: { pngBase64: PNG_1PX, width: 1, height: 1, frame: 0, atSec: 0, bytes: 70 }
          })
          return
        }
        sendJson({ ok: true, result: { command: body.command, params: body.params ?? {} } })
        return
      }
      response.writeHead(404)
      response.end()
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('假控制服务未取得端口')
  serverFile = path.join(tempDir, 'server.json')
  await fs.writeFile(
    serverFile,
    JSON.stringify({
      protocolVersion: 1,
      port: address.port,
      token: TOKEN,
      pid: process.pid,
      appVersion: '0.1.0-test',
      startedAt: new Date().toISOString(),
      userDataPath: tempDir
    }),
    'utf8'
  )

  child = spawn(process.execPath, [MCP_SCRIPT, '--server', serverFile, '--no-launch'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const parsed = JSON.parse(trimmed) as { id?: number }
    if (typeof parsed.id === 'number') {
      const waiter = waiters.get(parsed.id)
      if (waiter) {
        waiters.delete(parsed.id)
        waiter(parsed)
      } else {
        responses.set(parsed.id, parsed)
      }
    }
  })
  // stderr 仅用于排障：不消费的话管道满了会阻塞子进程
  child.stderr.resume()
})

afterAll(async () => {
  child?.kill()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('MCP stdio server', () => {
  it('initialize：返回协议版本、tools 能力与 serverInfo', async () => {
    call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
    const response = (await waitForId(1)) as {
      result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } }
    }
    expect(response.result.protocolVersion).toBe('2025-06-18')
    expect(response.result.capabilities.tools).toBeTruthy()
    expect(response.result.serverInfo.name).toBe('socut')
    // 通知不需要回包：发完直接继续
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })

  it('tools/list：至少 30 个工具，且带 inputSchema', async () => {
    call(2, 'tools/list')
    const response = (await waitForId(2)) as { result: { tools: { name: string; inputSchema: unknown }[] } }
    expect(response.result.tools.length).toBeGreaterThanOrEqual(30)
    const preview = response.result.tools.find((tool) => tool.name === 'preview_frame')
    expect(preview).toBeTruthy()
    expect(preview!.inputSchema).toBeTruthy()
    // 内部字段不外泄
    expect(JSON.stringify(response.result.tools)).not.toContain('fixedParams')
  })

  it('tools/call：普通工具映射到对应 CLI 命令并透传参数', async () => {
    call(3, 'tools/call', { name: 'clip_add', arguments: { at: 1.5, content: { title: '今日头条' } } })
    const response = (await waitForId(3)) as {
      result: { content: { type: string; text: string }[] }
    }
    const payload = JSON.parse(response.result.content[0]!.text) as {
      command: string
      params: { at: number; content: { title: string } }
    }
    expect(payload.command).toBe('clip.add')
    expect(payload.params.at).toBe(1.5)
    expect(payload.params.content.title).toBe('今日头条')
  })

  it('tools/call：fixedParams 生效（transition_remove 传 transition:null）', async () => {
    call(4, 'tools/call', { name: 'transition_remove', arguments: { id: 'clip-1' } })
    const response = (await waitForId(4)) as { result: { content: { text: string }[] } }
    const payload = JSON.parse(response.result.content[0]!.text) as { command: string; params: { transition: null } }
    expect(payload.command).toBe('clip.transition')
    expect(payload.params.transition).toBeNull()
  })

  it('tools/call：preview_frame 返回 MCP image content', async () => {
    call(5, 'tools/call', { name: 'preview_frame', arguments: { at: 0 } })
    const response = (await waitForId(5)) as {
      result: { content: { type: string; data?: string; mimeType?: string; text?: string }[] }
    }
    expect(response.result.content[0]!.type).toBe('image')
    expect(response.result.content[0]!.mimeType).toBe('image/png')
    expect(response.result.content[0]!.data).toBe(PNG_1PX)
  })

  it('tools/call：export_wait 轮询到 done 后返回最终结果', async () => {
    call(6, 'tools/call', { name: 'export_wait', arguments: { jobId: 'job-1', timeoutMs: 5000 } })
    const response = (await waitForId(6)) as { result: { content: { text: string }[] } }
    const payload = JSON.parse(response.result.content[0]!.text) as { progress: { phase: string } }
    expect(payload.progress.phase).toBe('done')
  })

  it('未知工具：返回 isError 的 tool 结果（不是协议错误）', async () => {
    call(7, 'tools/call', { name: 'no_such_tool', arguments: {} })
    const response = (await waitForId(7)) as { result: { isError: boolean; content: { text: string }[] } }
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0]!.text).toContain('TOOL_NOT_FOUND')
  })

  it('未知方法：JSON-RPC -32601；坏 JSON：-32700', async () => {
    call(8, 'no/such/method')
    const unknown = (await waitForId(8)) as { error: { code: number } }
    expect(unknown.error.code).toBe(-32601)

    sendRaw('{bad json')
    // 坏 JSON 的 id 是 null，不在 waiters 里；用后续 ping 证明进程仍然活着
    call(9, 'ping')
    const ping = (await waitForId(9)) as { result: unknown }
    expect(ping.result).toEqual({})
  })
})
