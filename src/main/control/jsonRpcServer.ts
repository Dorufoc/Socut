import { timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  CLI_COMMANDS,
  CLI_PROTOCOL_VERSION,
  findCliCommand,
  toCliErrorInfo,
  type CliCommandRequest
} from '../../shared/cliProtocol'
import {
  BoundedEventQueue,
  EVENT_OUTBOUND_HIGH_WATER_BYTES,
  EVENT_TOPIC_LIST,
  JSON_RPC_MAX_LINE_BYTES,
  MAX_EVENT_SUBSCRIPTIONS,
  MAX_PENDING_EVENTS,
  RPC_ERROR_CODES,
  controlEventBus,
  jsonRpcError,
  jsonRpcErrorFromCli,
  jsonRpcEvent,
  jsonRpcResult,
  parseJsonRpcRequest,
  splitLines,
  type JsonRpcEventNotification,
  type JsonRpcEventSource,
  type JsonRpcId,
  type JsonRpcResponse
} from '../../shared/jsonRpc'

/**
 * M10：JSON-RPC 行协议控制面（TCP 回环 + Windows 命名管道）。
 *
 * 为什么要有第二套传输：HTTP+token 的 CLI 面向"人/脚本"，而 Agent（Claude Code、
 * 自建流水线）更适合长连接 + 顺序请求 + 结构化错误。两者**共用同一份命令注册表与
 * 同一个分派器**（`dispatch`），所以不存在第二套业务逻辑。
 *
 * 事件流（M10 尾项）：认证后 `events.subscribe {topics}` 订阅主题，服务端按连接推送
 * **无 id 的 notification**（`{"jsonrpc":"2.0","method":"event","params":{topic,data,seq}}`），
 * `events.unsubscribe` 退订；断连自动清理。背压三级防线：
 * 1) 每连接待发事件有界队列（满了丢最旧，`MAX_PENDING_EVENTS`）；
 * 2) socket 待发字节高水位（`EVENT_OUTBOUND_HIGH_WATER_BYTES`）以上先等 drain；
 * 3) 慢客户端的丢弃会体现在 `seq` 跳号上，客户端能感知「中间丢过事件」。
 *
 * 安全边界：
 * - TCP 只绑 127.0.0.1（随机端口）；命名管道只允许本机用户；
 * - 每个连接首行必须是 `auth`，token 恒定时间比较；未认证前只允许 auth；
 * - 单行上限 32MB（帧图 base64 结果也在同一行返回）；
 * - 单连接最多 1 条在飞请求（按到达顺序串行执行，响应顺序可预测）；
 * - 事件只推给「本连接已订阅的主题」，别的连接订阅不影响本连接。
 */

export interface JsonRpcServerOptions {
  token: string
  /** 与 HTTP CLI 完全相同的分派器（主进程命令 + 转交渲染进程） */
  dispatch: (request: CliCommandRequest) => Promise<unknown>
  appVersion: string
  /** 同时允许的连接数上限（本地工具，默认 8） */
  maxConnections?: number
  /** 事件源（默认进程内单例 controlEventBus；测试可注入独立总线） */
  events?: JsonRpcEventSource
  /** 单连接订阅主题上限（默认 32；测试可调小以覆盖错误码） */
  maxSubscriptions?: number
  /** 单连接待发事件队列上限（默认 256；测试可调小以覆盖丢弃/seq 跳号） */
  maxPendingEvents?: number
  log?: (message: string) => Promise<void> | void
}

export interface JsonRpcTransportInfo {
  /** TCP 回环端口（0 表示未启动） */
  tcpPort: number
  /** 命名管道 / Unix socket 路径（Windows 为 `\\.\pipe\...`） */
  pipePath: string
}

/** 命名管道路径（Windows）或 Unix socket 路径（macOS/Linux），按 pid 区分实例。 */
export function controlPipePath(pid = process.pid): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\socut-${pid}`
  return path.join(os.tmpdir(), `socut-${pid}.sock`)
}

interface ConnectionState {
  authed: boolean
  buffer: string
  queue: Promise<void>
  socket: net.Socket
  /** 本连接订阅的主题（按订阅先后；退订即删） */
  topics: Set<string>
  /** 本连接的事件序号：从 1 起，被丢弃的事件也占号（跳号 = 中间丢过） */
  nextSeq: number
  /** 待发事件（有界；慢客户端丢最旧） */
  pending: BoundedEventQueue<JsonRpcEventNotification>
  /** 是否正在排空待发队列（合并同 tick 的多次 publish，保证单条写不交错） */
  draining: boolean
  /** 连接已关闭/服务已停止：阻止继续写，并让 drain 循环退出 */
  closed: boolean
}

export class JsonRpcControlServer {
  private readonly options: JsonRpcServerOptions
  private readonly eventSource: JsonRpcEventSource
  private detachEvents: (() => void) | null = null
  private tcpServer: net.Server | null = null
  private pipeServer: net.Server | null = null
  /** 连接 → 状态（断连即删；事件推送按这张表分发） */
  private readonly connections = new Map<net.Socket, ConnectionState>()
  private tcpPort = 0
  private pipePath = ''
  private stopped = false

  constructor(options: JsonRpcServerOptions) {
    this.options = options
    this.eventSource = options.events ?? controlEventBus
  }

  async start(): Promise<JsonRpcTransportInfo> {
    if (this.tcpServer) return { tcpPort: this.tcpPort, pipePath: this.pipePath }
    this.tcpServer = net.createServer((socket) => this.attach(socket))
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.tcpServer?.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.tcpServer?.off('error', onError)
        resolve()
      }
      this.tcpServer!.once('error', onError)
      this.tcpServer!.once('listening', onListening)
      this.tcpServer!.listen(0, '127.0.0.1')
    })
    const address = this.tcpServer.address()
    if (!address || typeof address === 'string') throw new Error('JSON-RPC 服务未取得监听端口')
    this.tcpPort = address.port

    // 命名管道：Windows 上删除同名管道文件不是必需（OS 管理）；Unix 上先清残留 socket
    this.pipePath = controlPipePath()
    if (process.platform !== 'win32') await import('node:fs/promises').then((fs) => fs.rm(this.pipePath, { force: true })).catch(() => undefined)
    this.pipeServer = net.createServer((socket) => this.attach(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          this.pipeServer?.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          this.pipeServer?.off('error', onError)
          resolve()
        }
        this.pipeServer!.once('error', onError)
        this.pipeServer!.once('listening', onListening)
        this.pipeServer!.listen(this.pipePath)
      })
    } catch (error) {
      // 管道起不来不影响 TCP（例如同名管道被另一个实例占用）
      await this.options.log?.(`JSON-RPC 命名管道不可用（${this.pipePath}）：${String(error)}`)
      this.pipePath = ''
    }
    // 事件源只订阅一次：publish 时按每个连接的主题表过滤（没有订阅者时是纯 no-op）
    this.detachEvents ??= this.eventSource.subscribe((event) => this.publishEvent(event))
    await this.options.log?.(
      `JSON-RPC 控制面已启动：tcp://127.0.0.1:${this.tcpPort}${this.pipePath ? ` / ${this.pipePath}` : ''}`
    )
    return { tcpPort: this.tcpPort, pipePath: this.pipePath }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.detachEvents?.()
    this.detachEvents = null
    for (const state of this.connections.values()) {
      state.closed = true
      state.topics.clear()
      state.pending.clear()
      state.socket.destroy()
    }
    this.connections.clear()
    const close = (server: net.Server | null): Promise<void> =>
      new Promise((resolve) => {
        if (!server) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    await Promise.all([close(this.tcpServer), close(this.pipeServer)])
    this.tcpServer = null
    this.pipeServer = null
    if (this.pipePath && process.platform !== 'win32') {
      await import('node:fs/promises')
        .then((fs) => fs.rm(this.pipePath, { force: true }))
        .catch(() => undefined)
    }
  }

  info(): JsonRpcTransportInfo {
    return { tcpPort: this.tcpPort, pipePath: this.pipePath }
  }

  private maxConnections(): number {
    return Math.max(1, this.options.maxConnections ?? 8)
  }

  private maxSubscriptions(): number {
    return Math.max(1, this.options.maxSubscriptions ?? MAX_EVENT_SUBSCRIPTIONS)
  }

  private maxPendingEvents(): number {
    return Math.max(1, this.options.maxPendingEvents ?? MAX_PENDING_EVENTS)
  }

  private attach(socket: net.Socket): void {
    if (this.stopped) {
      socket.destroy()
      return
    }
    if (this.connections.size >= this.maxConnections()) {
      socket.destroy()
      return
    }
    const state: ConnectionState = {
      authed: false,
      buffer: '',
      queue: Promise.resolve(),
      socket,
      topics: new Set(),
      nextSeq: 1,
      pending: new BoundedEventQueue<JsonRpcEventNotification>(this.maxPendingEvents()),
      draining: false,
      closed: false
    }
    this.connections.set(socket, state)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.onData(state, chunk))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.detachConnection(state))
  }

  /** 断连清理：清空主题与待发事件，从连接表里移除（事件不会再写向已销毁 socket）。 */
  private detachConnection(state: ConnectionState): void {
    state.closed = true
    state.topics.clear()
    state.pending.clear()
    this.connections.delete(state.socket)
  }

  private onData(state: ConnectionState, chunk: string): void {
    state.buffer += chunk
    if (Buffer.byteLength(state.buffer, 'utf8') > JSON_RPC_MAX_LINE_BYTES) {
      this.write(state.socket, jsonRpcError(null, RPC_ERROR_CODES.invalidRequest, '单行请求体过大'))
      state.socket.destroy()
      return
    }
    const { lines, rest } = splitLines(state.buffer)
    state.buffer = rest
    for (const line of lines) {
      if (line.trim().length === 0) continue
      state.queue = state.queue.then(() => this.handleLine(state, line)).catch(() => undefined)
    }
  }

  private async handleLine(state: ConnectionState, line: string): Promise<void> {
    const parsed = parseJsonRpcRequest(line)
    if (!parsed.ok) {
      this.write(state.socket, jsonRpcError(parsed.id, parsed.error.code, parsed.error.message))
      return
    }
    const request = parsed.request
    const id = request.id

    if (!state.authed) {
      const params = asParams(request.params)
      const token = typeof params['token'] === 'string' ? params['token'] : ''
      if (request.method !== 'auth') {
        this.write(state.socket, jsonRpcError(id, RPC_ERROR_CODES.unauthorized, '首行必须是 auth'))
        state.socket.end()
        return
      }
      if (!safeEqual(token, this.options.token)) {
        this.write(state.socket, jsonRpcError(id, RPC_ERROR_CODES.unauthorized, 'token 无效'))
        state.socket.end()
        return
      }
      state.authed = true
      this.write(
        state.socket,
        jsonRpcResult(id, {
          ok: true,
          protocolVersion: CLI_PROTOCOL_VERSION,
          capabilities: ['json-rpc', 'tcp', 'named-pipe', 'commands', 'events']
        })
      )
      return
    }

    if (request.method === 'auth') {
      this.write(state.socket, jsonRpcResult(id, { ok: true }))
      return
    }
    if (request.method === 'version') {
      this.write(
        state.socket,
        jsonRpcResult(id, {
          protocolVersion: CLI_PROTOCOL_VERSION,
          appVersion: this.options.appVersion,
          capabilities: ['json-rpc', 'tcp', 'named-pipe', 'commands', 'events']
        })
      )
      return
    }
    if (request.method === 'commands.list') {
      this.write(state.socket, jsonRpcResult(id, { protocolVersion: CLI_PROTOCOL_VERSION, commands: CLI_COMMANDS }))
      return
    }
    // 事件流协议方法（不属于 CLI 命令注册表，只走 JSON-RPC）
    if (request.method === 'events.subscribe') {
      this.handleSubscribe(state, id, request.params)
      return
    }
    if (request.method === 'events.unsubscribe') {
      this.handleUnsubscribe(state, id, request.params)
      return
    }
    if (!findCliCommand(request.method)) {
      this.write(state.socket, jsonRpcError(id, RPC_ERROR_CODES.methodNotFound, `未知方法：${request.method}`))
      return
    }
    if (request.params !== undefined && !isPlainParams(request.params)) {
      this.write(state.socket, jsonRpcError(id, RPC_ERROR_CODES.invalidParams, 'params 必须是对象'))
      return
    }
    try {
      const result = await this.options.dispatch({
        id: String(id ?? '0'),
        command: request.method,
        params: asParams(request.params)
      })
      this.write(state.socket, jsonRpcResult(id, result))
    } catch (error) {
      this.write(state.socket, jsonRpcErrorFromCli(id, toCliErrorInfo(error)))
    }
  }

  /**
   * `events.subscribe { topics: string[] }`：登记本连接的订阅主题。
   * 只接受已登记主题（拼错主题若静默成功，客户端会等一个永远不来的事件）。
   */
  private handleSubscribe(state: ConnectionState, id: JsonRpcId, params: unknown): void {
    const record = asParams(params)
    const raw = record['topics']
    if (!Array.isArray(raw) || raw.length === 0) {
      this.write(state.socket, jsonRpcError(id, RPC_ERROR_CODES.invalidParams, 'topics 必须是非空字符串数组'))
      return
    }
    const requested: string[] = []
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0) {
        this.write(state.socket, jsonRpcError(id, RPC_ERROR_CODES.invalidParams, 'topics 必须是非空字符串数组'))
        return
      }
      requested.push(item)
    }
    const unknown = requested.filter((topic) => !isKnownTopic(topic))
    if (unknown.length > 0) {
      this.write(
        state.socket,
        jsonRpcError(id, RPC_ERROR_CODES.invalidParams, `未知事件主题：${unknown.join(', ')}`, {
          code: 'BAD_PARAMS',
          detail: `可用主题：${EVENT_TOPIC_LIST.join(', ')}`
        })
      )
      return
    }
    // 去重 + 跳过已订阅（幂等：重复 subscribe 不报错也不重复计数）
    const fresh = [...new Set(requested)].filter((topic) => !state.topics.has(topic))
    const limit = this.maxSubscriptions()
    if (state.topics.size + fresh.length > limit) {
      this.write(
        state.socket,
        jsonRpcError(id, RPC_ERROR_CODES.subscriptionLimit, `订阅主题数超过上限 ${limit}`, {
          code: 'EVENT_SUBSCRIPTION_LIMIT',
          detail: `当前 ${state.topics.size} 个，本次新增 ${fresh.length} 个`
        })
      )
      return
    }
    for (const topic of fresh) state.topics.add(topic)
    this.write(
      state.socket,
      jsonRpcResult(id, {
        ok: true,
        subscribed: fresh,
        topics: [...state.topics],
        available: EVENT_TOPIC_LIST,
        limit,
        nextSeq: state.nextSeq
      })
    )
  }

  /** `events.unsubscribe { topics?: string[] }`：省略 topics = 全部退订；未知/未订阅主题忽略。 */
  private handleUnsubscribe(state: ConnectionState, id: JsonRpcId, params: unknown): void {
    const raw = asParams(params)['topics']
    let removed: string[]
    if (raw === undefined) {
      removed = [...state.topics]
      state.topics.clear()
    } else {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
        this.write(state.socket, jsonRpcError(id, RPC_ERROR_CODES.invalidParams, 'topics 必须是字符串数组'))
        return
      }
      removed = []
      for (const topic of new Set(raw as string[])) {
        if (state.topics.delete(topic)) removed.push(topic)
      }
    }
    this.write(state.socket, jsonRpcResult(id, { ok: true, unsubscribed: removed, topics: [...state.topics] }))
  }

  /**
   * 事件源回调：只投给「已认证且订阅了该主题」的连接。
   * 每个连接独立编号（seq 从 1 起），入有界队列后由 drain 写出。
   */
  private publishEvent(event: { topic: string; data: unknown }): void {
    if (this.stopped) return
    for (const state of this.connections.values()) {
      if (!state.authed || state.closed || !state.topics.has(event.topic)) continue
      const seq = state.nextSeq
      state.nextSeq += 1
      state.pending.push(jsonRpcEvent(event.topic, event.data, seq))
      this.scheduleDrain(state)
    }
  }

  /** 同一个 tick 里的多次 publish 合并成一次排空（避免每条事件一个宏任务）。 */
  private scheduleDrain(state: ConnectionState): void {
    if (state.draining || state.closed) return
    state.draining = true
    setImmediate(() => {
      void this.drainEvents(state)
    })
  }

  /** 排空待发事件：socket 缓冲超过高水位时等 drain，期间新事件进有界队列。 */
  private async drainEvents(state: ConnectionState): Promise<void> {
    try {
      while (!state.closed && !state.socket.destroyed) {
        if (state.pending.size === 0) return
        if (state.socket.writableLength > EVENT_OUTBOUND_HIGH_WATER_BYTES) {
          await waitForSocketDrain(state.socket)
          continue
        }
        const next = state.pending.take()
        if (!next) return
        this.write(state.socket, next)
      }
    } finally {
      state.draining = false
    }
  }

  /**
   * 供测试/诊断：当前连接的事件订阅表与丢弃计数（不包含 token 等敏感字段）。
   * 正常导出节奏下 dropped 应恒为 0；>0 只可能发生在慢客户端。
   */
  eventDiagnostics(): Array<{ topics: string[]; pending: number; dropped: number; nextSeq: number }> {
    return [...this.connections.values()]
      .filter((state) => state.authed)
      .map((state) => ({
        topics: [...state.topics],
        pending: state.pending.size,
        dropped: state.pending.dropped,
        nextSeq: state.nextSeq
      }))
  }

  private write(socket: net.Socket, payload: JsonRpcResponse | JsonRpcEventNotification): void {
    if (socket.destroyed || !socket.writable) return
    socket.write(`${JSON.stringify(payload)}\n`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPlainParams(value: unknown): boolean {
  return isRecord(value)
}

function asParams(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 主题名是否已在协议层登记（登记表见 shared/jsonRpc.ts 的 EVENT_TOPICS）。 */
function isKnownTopic(topic: string): boolean {
  return (EVENT_TOPIC_LIST as readonly string[]).includes(topic)
}

/** 等 socket 缓冲排空（drain）；关闭/出错也结束等待，由调用方检查 closed 后退出。 */
function waitForSocketDrain(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      socket.off('drain', done)
      socket.off('close', done)
      socket.off('error', done)
      resolve()
    }
    socket.once('drain', done)
    socket.once('close', done)
    socket.once('error', done)
  })
}

/** 供测试/诊断：给定 JSON-RPC 响应对象，取回它的 id（不改内容）。 */
export function responseIdOf(response: JsonRpcResponse): JsonRpcId {
  return response.id
}
