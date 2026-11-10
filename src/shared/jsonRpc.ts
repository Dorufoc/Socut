import type { CliErrorInfo } from './cliProtocol'
import type { JobProgress } from './types'

/**
 * M10：JSON-RPC 2.0 行协议（纯函数 + 纯类型）。
 *
 * 口径（与 Concat 的 JSON-RPC 行协议同思路，命令沿用 Socut 自己的注册表）：
 * - 一行一个 JSON 对象（换行分帧）；响应带同一个 id；
 * - 首行必须是 `{"jsonrpc":"2.0","id":0,"method":"auth","params":{"token":"…"}}`；
 * - 方法名 = `CLI_COMMANDS` 里的命令名（`project.get` / `clip.add` …），
 *   外加少量协议方法（`version` / `commands.list` / `auth` / `events.*`）；
 * - 业务错误用 JSON-RPC 错误对象承载，`data.code` 保留 Socut 自己的错误码，
 *   这样客户端既能走标准错误分支，也能拿到可判的稳定字符串。
 * - 事件流：客户端 `events.subscribe` 后，服务端用**无 id 的 notification** 推送
 *   `{"jsonrpc":"2.0","method":"event","params":{topic,data,seq}}`（见文件末节）。
 *
 * 本文件不 import 任何 Node/Electron 能力：主进程服务器、测试、将来的 MCP 适配层共用。
 */

export const JSON_RPC_VERSION = '2.0'

/** 单行长度上限（含帧图 base64 结果；超过即认为是坏客户端/坏数据） */
export const JSON_RPC_MAX_LINE_BYTES = 32 * 1024 * 1024

/** JSON-RPC 标准错误码 + Socut 扩展（-32001 起为服务器自定义区间）。 */
export const RPC_ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** token 无效 / 首行不是 auth */
  unauthorized: -32001,
  /** 项目被锁、或者当前模式拒绝该操作 */
  refused: -32002,
  /** 渲染进程未就绪 / 忙 */
  unavailable: -32003,
  /** 目标不存在 */
  notFound: -32004,
  /** 超时 */
  timeout: -32005,
  /** 取消 */
  cancelled: -32006,
  /** 执行失败（导出失败等） */
  failed: -32007,
  /** 事件流：单连接订阅主题数超过上限 */
  subscriptionLimit: -32008
} as const

export type JsonRpcId = number | string | null

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  /** Socut 稳定错误码 + 细节（`{ code: 'BAD_PARAMS', detail?: string }`） */
  data?: { code?: string; detail?: string }
}

export type JsonRpcSuccess = {
  jsonrpc: typeof JSON_RPC_VERSION
  id: JsonRpcId
  result: unknown
}

export type JsonRpcFailure = {
  jsonrpc: typeof JSON_RPC_VERSION
  id: JsonRpcId
  error: JsonRpcErrorObject
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** id 只接受数字/字符串/null（缺省按 null，即"通知"，但本协议要求必须有 id）。 */
function normalizeId(value: unknown): JsonRpcId | undefined {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

export type ParseResult =
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; id: JsonRpcId; error: JsonRpcErrorObject }

/** 解析一行 JSON-RPC 请求；非法输入返回可直接回写的错误对象（id 尽量保留）。 */
export function parseJsonRpcRequest(line: string): ParseResult {
  const fail = (id: JsonRpcId, code: number, message: string): ParseResult => ({
    ok: false,
    id,
    error: { code, message }
  })
  const trimmed = line.trim()
  if (trimmed.length === 0) return fail(null, RPC_ERROR_CODES.parse, '空行不是合法请求')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return fail(null, RPC_ERROR_CODES.parse, '不是合法 JSON')
  }
  if (!isRecord(parsed)) return fail(null, RPC_ERROR_CODES.invalidRequest, '请求必须是 JSON 对象')
  const id = normalizeId(parsed['id'])
  if (id === undefined) return fail(null, RPC_ERROR_CODES.invalidRequest, 'id 必须是数字/字符串/null')
  if (parsed['jsonrpc'] !== JSON_RPC_VERSION) {
    return fail(id, RPC_ERROR_CODES.invalidRequest, `jsonrpc 必须是 "${JSON_RPC_VERSION}"`)
  }
  const method = parsed['method']
  if (typeof method !== 'string' || method.length === 0) {
    return fail(id, RPC_ERROR_CODES.invalidRequest, 'method 必须是非空字符串')
  }
  const params = parsed['params']
  if (params !== undefined && !isRecord(params) && !Array.isArray(params)) {
    return fail(id, RPC_ERROR_CODES.invalidRequest, 'params 必须是对象或数组')
  }
  return { ok: true, request: { jsonrpc: JSON_RPC_VERSION, id, method, ...(params !== undefined ? { params } : {}) } }
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSON_RPC_VERSION, id, result }
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: JsonRpcErrorObject['data']
): JsonRpcFailure {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data ? { data } : {}) } }
}

/** Socut CLI 错误码 → JSON-RPC 错误码（保证两类客户端看到同一套语义）。 */
export function rpcCodeOf(cliCode: string): number {
  switch (cliCode) {
    case 'BAD_PARAMS':
    case 'BAD_REQUEST':
      return RPC_ERROR_CODES.invalidParams
    case 'NOT_FOUND':
      return RPC_ERROR_CODES.notFound
    case 'UNAUTHORIZED':
      return RPC_ERROR_CODES.unauthorized
    case 'GATE_BLOCKED':
    case 'RENDERER_UNAVAILABLE':
      return RPC_ERROR_CODES.unavailable
    case 'TIMEOUT':
      return RPC_ERROR_CODES.timeout
    case 'CANCELLED':
      return RPC_ERROR_CODES.cancelled
    case 'EXPORT_FAILED':
    case 'MEDIA_PROBE_FAILED':
      return RPC_ERROR_CODES.failed
    default:
      return RPC_ERROR_CODES.internal
  }
}

/** 把 CLI 的错误信息包装成 JSON-RPC 错误对象。 */
export function jsonRpcErrorFromCli(id: JsonRpcId, error: CliErrorInfo): JsonRpcFailure {
  return jsonRpcError(id, rpcCodeOf(error.code), error.message, {
    code: error.code,
    ...(error.detail ? { detail: error.detail } : {})
  })
}

/** 按行分帧：把 socket 收到的块切成完整行（保留未闭合尾巴供下次拼接）。 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map((part) => part.replace(/\r$/, '')), rest }
}

// ---------------------------------------------------------------------------
// M10 事件流：events.subscribe / events.unsubscribe + event notification
// ---------------------------------------------------------------------------

/**
 * 事件推送的协议形状（只走 JSON-RPC，HTTP CLI / MCP 不新增工具）：
 *
 * 1. 请求 `{"jsonrpc":"2.0","id":1,"method":"events.subscribe","params":{"topics":["export.progress"]}}`
 *    → 结果 `{ ok, subscribed, topics, available, limit, nextSeq }`；
 * 2. 之后服务端按订阅推送 **notification**（无 id，客户端不能当响应配对）：
 *    `{"jsonrpc":"2.0","method":"event","params":{"topic":"export.progress","data":{…},"seq":1}}`
 * 3. 请求 `events.unsubscribe {"topics":[…]}`（省略 topics = 全部退订）→ `{ ok, unsubscribed, topics }`；
 * 4. 连接断开自动清理订阅；`seq` 按连接从 1 递增，**被丢弃的事件也占号**，
 *    因此收到跳号就说明中间因背压丢过事件（见 MAX_PENDING_EVENTS）。
 */

/** 服务端推送事件用的固定方法名。 */
export const EVENT_NOTIFICATION_METHOD = 'event'

/** 主题表：新增主题必须同时在这里登记（客户端从 subscribe 响应里拿 available 列表）。 */
export const EVENT_TOPICS = {
  /** 导出任务进度：与 `export.status` 的 job 快照同口径（JobProgress） */
  exportProgress: 'export.progress',
  /** 工程变更：当前工程路径切换 / 保存成功 / 工程锁变化 */
  projectChanged: 'project.changed'
} as const

export type EventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS]

/** 当前可用主题（`events.subscribe` 响应里原样返回，避免客户端猜名字）。 */
export const EVENT_TOPIC_LIST: readonly EventTopic[] = [
  EVENT_TOPICS.exportProgress,
  EVENT_TOPICS.projectChanged
]

/** 单连接最多订阅的主题数（防滥用；服务端可用 options.maxSubscriptions 覆盖，测试会调小）。 */
export const MAX_EVENT_SUBSCRIPTIONS = 32

/** 单连接待发事件队列上限：慢客户端丢最旧事件，保证服务端内存有界。 */
export const MAX_PENDING_EVENTS = 256

/** 待发字节高水位：socket 缓冲超过它就等内核排空（背压），不无限 write。 */
export const EVENT_OUTBOUND_HIGH_WATER_BYTES = 256 * 1024

export interface JsonRpcEventNotification {
  jsonrpc: typeof JSON_RPC_VERSION
  /** 固定 `event`；没有 id，是 notification 而不是响应 */
  method: typeof EVENT_NOTIFICATION_METHOD
  params: {
    topic: string
    data: unknown
    /** 该连接上的事件序号（1 起）；跳号 = 有事件被丢弃 */
    seq: number
  }
}

export function jsonRpcEvent(topic: string, data: unknown, seq: number): JsonRpcEventNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: EVENT_NOTIFICATION_METHOD,
    params: { topic, data, seq }
  }
}

/** `export.progress` 主题的数据：与 `export.status` 的 job 快照同口径（含 phase/percent…）。 */
export type ExportProgressEventData = JobProgress

/** `project.changed` 主题的数据。 */
export interface ProjectChangedEventData {
  /** 当前工程绝对路径（新建但尚未落盘时为 null） */
  path: string | null
  /** 工程名（主进程知道时才有） */
  name: string | null
  /** 变更来源：主进程可观测点（CLI 工程命令 / 工程锁） */
  reason: 'new' | 'open' | 'openRecent' | 'save' | 'lock' | 'unlock'
  /**
   * 渲染侧 revision。主进程没有干净的观测点（唯一真值是渲染进程 zustand store，
   * 自动保存 IPC 也不带 revision），因此当前恒为 null——宁可缺字段也不臆造。
   */
  revision: number | null
  /** 工程锁模式（reason 为 lock / unlock 时才带） */
  mode?: 'window' | 'agent'
  /** ISO 时间戳 */
  at: string
}

/** 构造 `project.changed` 数据（主进程业务侧调用；纯函数便于单测）。 */
export function projectChangedEvent(input: {
  path: string | null
  name?: string | null
  reason: ProjectChangedEventData['reason']
  revision?: number | null
  mode?: 'window' | 'agent'
  /** 便于测试固定时间戳；缺省取当前时间 */
  at?: string
}): ProjectChangedEventData {
  return {
    path: input.path,
    name: input.name ?? null,
    reason: input.reason,
    revision: input.revision ?? null,
    ...(input.mode ? { mode: input.mode } : {}),
    at: input.at ?? new Date().toISOString()
  }
}

/** 进程内事件总线的一条事件。 */
export interface ControlEvent {
  topic: string
  data: unknown
}

export type ControlEventListener = (event: ControlEvent) => void

/** 事件源接口：主进程业务侧（engine / CLI 分派器）发布，控制面订阅分发。 */
export interface JsonRpcEventSource {
  /** 订阅进程内事件；返回取消函数（断连/停止时必须调用）。 */
  subscribe(listener: ControlEventListener): () => void
}

/**
 * 进程内事件总线。
 *
 * 业务侧 publish、JSON-RPC 控制面按连接订阅分发；两边只依赖本协议模块，
 * 不互相 import（将来入口若要显式注入，可给 `JsonRpcServerOptions.events` 传独立实例）。
 */
export class ControlEventBus implements JsonRpcEventSource {
  private readonly listeners = new Set<ControlEventListener>()

  subscribe(listener: ControlEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 广播；返回投递到的监听者数量（0 = 当前没有控制面在听，纯 no-op）。 */
  publish(topic: string, data: unknown): number {
    for (const listener of this.listeners) {
      try {
        listener({ topic, data })
      } catch {
        // 单个订阅者抛错不能影响其它订阅者，也不能打断业务侧（导出不能因推送失败而失败）
      }
    }
    return this.listeners.size
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

/**
 * 主进程内的事件总线单例（渲染进程不 import 本文件，不存在跨进程共享问题）。
 * `main/index.ts` 不需要额外接线：engine 进度钩子与 CLI 命令在业务侧直接 publish。
 */
export const controlEventBus = new ControlEventBus()

/**
 * 有界事件队列：满了丢最旧的一条。
 *
 * 慢客户端（不再 read）不能让服务端内存无界增长：待发事件进这个队列，
 * 超限时丢最旧的（新事件更有价值——进度事件天然是「最新态覆盖」语义）。
 */
export class BoundedEventQueue<T> {
  private readonly items: T[] = []
  private droppedCount = 0

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('事件队列上限必须是 >= 1 的整数')
  }

  /** 入队；超限丢最旧，返回本次是否发生了丢弃。 */
  push(item: T): boolean {
    this.items.push(item)
    let dropped = false
    while (this.items.length > this.limit) {
      this.items.shift()
      this.droppedCount += 1
      dropped = true
    }
    return dropped
  }

  /** 取出最旧的一条（无事件时返回 undefined）。 */
  take(): T | undefined {
    return this.items.shift()
  }

  clear(): void {
    this.items.length = 0
  }

  get size(): number {
    return this.items.length
  }

  /** 累计丢弃数（诊断用：正常导出节奏下应恒为 0）。 */
  get dropped(): number {
    return this.droppedCount
  }
}

