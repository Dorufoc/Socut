#!/usr/bin/env node
/**
 * M10：Socut MCP Server（stdio，零依赖）。
 *
 * 作用：让 Claude Code / Claude Desktop / 任何 MCP 客户端直接操作 Socut ——
 * 建工程、导入素材、加新闻字幕条、加文本元素、导出、取帧，全程不需要点鼠标。
 *
 * 运行方式（三选一）：
 *   1. `node cli/socut-mcp.mjs`（开发环境，需 Node 22+）
 *   2. 打包版：`socut.cmd mcp`（内部用 ELECTRON_RUN_AS_NODE 以 Node 模式跑本脚本）
 *   3. MCP 客户端配置里直接指向 `Socut.exe` + args `["cli/socut-mcp.mjs"]`（环境变量 ELECTRON_RUN_AS_NODE=1）
 *
 * 协议：MCP over stdio —— 换行分隔的 JSON-RPC 2.0；stdout 只放协议，日志一律写 stderr。
 *
 * 命令来源：每个工具都映射到 Socut CLI 的**同一条命令**（`src/shared/cliProtocol.ts` 唯一真值），
 * 通过本地 HTTP 控制服务（127.0.0.1 + token）执行 —— 所以 MCP 与 CLI 永远不会出现两套业务逻辑。
 * 应用没在跑时会自动拉起一个隐藏窗口实例（`--cli-server`），与 CLI 客户端同一套自动拉起逻辑。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { MCP_TOOLS, findMcpTool } from './lib/mcpTools.mjs'

const PROTOCOL_VERSION = 1
const HEALTH_TIMEOUT_MS = 2_500
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const POLL_INTERVAL_MS = 400
const RENDERER_READY_WAIT_MS = 60_000
const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_VERSION = '0.1.0'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

class SocutError extends Error {
  constructor(message, code = 'MCP_ERROR', detail) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 参数 / 发现 / 自动拉起（与 socut-cli.mjs 同一套策略）
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const config = { serverFile: '', tokenOverride: '', noLaunch: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--server') config.serverFile = argv[++index] ?? ''
    else if (arg === '--token') config.tokenOverride = argv[++index] ?? ''
    else if (arg === '--no-launch') config.noLaunch = true
  }
  return config
}

function candidateServerFiles(config) {
  const candidates = []
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0 && !candidates.includes(value)) candidates.push(value)
  }
  add(config.serverFile)
  add(process.env.SOCUT_CLI_SERVER_FILE)
  if (process.env.SOCUT_USER_DATA) add(path.join(process.env.SOCUT_USER_DATA, 'cli', 'server.json'))

  const appData = process.env.APPDATA
  if (appData) {
    for (const name of ['Socut', 'socut', 'Electron']) add(path.join(appData, name, 'cli', 'server.json'))
  }
  const home = os.homedir()
  if (process.platform === 'darwin') {
    for (const name of ['Socut', 'socut']) add(path.join(home, 'Library', 'Application Support', name, 'cli', 'server.json'))
  } else if (process.platform !== 'win32') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    for (const name of ['Socut', 'socut']) add(path.join(configHome, name, 'cli', 'server.json'))
  }
  return candidates
}

async function readServerInfo(file) {
  try {
    const info = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!info || typeof info !== 'object') return null
    if (info.protocolVersion !== PROTOCOL_VERSION) return null
    if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535) return null
    if (typeof info.token !== 'string' || info.token.length === 0) return null
    return {
      port: info.port,
      token: info.token,
      pid: typeof info.pid === 'number' ? info.pid : 0,
      appVersion: typeof info.appVersion === 'string' ? info.appVersion : '',
      file
    }
  } catch {
    return null
  }
}

async function healthOf(info) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/v1/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: controller.signal
    })
    if (!response.ok) return false
    const payload = await response.json()
    return Boolean(payload && payload.ok === true && payload.result)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function discoverHealthyServer(config) {
  for (const file of candidateServerFiles(config)) {
    const info = await readServerInfo(file)
    if (!info) continue
    if (config.tokenOverride) info.token = config.tokenOverride
    if (await healthOf(info)) return info
  }
  return null
}

function findRepoRoot(start) {
  let current = start
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed && parsed.name === 'socut') return current
      } catch {
        // 继续向上
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}

function electronBinary(repoRoot) {
  if (!repoRoot) return ''
  const dist = path.join(repoRoot, 'node_modules', 'electron', 'dist')
  if (process.platform === 'win32') return path.join(dist, 'electron.exe')
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return path.join(dist, 'electron')
}

function launchCandidates() {
  const candidates = []
  const add = (exe, args, cwd) => {
    if (!existsSync(exe)) return
    const key = `${exe}\u0000${args.join('\u0000')}`
    if (candidates.some((item) => item.key === key)) return
    candidates.push({ key, exe, args, cwd })
  }
  if (process.env.SOCUT_EXE) add(process.env.SOCUT_EXE, ['--cli-server'], path.dirname(process.env.SOCUT_EXE))
  const packagedName = process.platform === 'win32' ? 'Socut.exe' : 'Socut'
  add(path.resolve(SCRIPT_DIR, '..', packagedName), ['--cli-server'], path.resolve(SCRIPT_DIR, '..'))
  if (process.env.SOCUT_ELECTRON) {
    const root = findRepoRoot(SCRIPT_DIR) || path.resolve(SCRIPT_DIR, '..')
    add(process.env.SOCUT_ELECTRON, [root, '--cli-server'], root)
  }
  const repoRoot = findRepoRoot(SCRIPT_DIR) || findRepoRoot(process.cwd())
  if (repoRoot) {
    const electron = electronBinary(repoRoot)
    if (electron) add(electron, [repoRoot, '--cli-server'], repoRoot)
  }
  if (path.basename(process.execPath).toLowerCase().includes('socut')) {
    add(process.execPath, ['--cli-server'], path.dirname(process.execPath))
  }
  return candidates
}

function childEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function launchAndWait(config) {
  if (config.noLaunch) throw new SocutError('未发现运行中的 Socut，且指定了 --no-launch', 'CLI_CONNECT_FAILED')
  const candidates = launchCandidates()
  if (candidates.length === 0) {
    throw new SocutError('未发现运行中的 Socut，也找不到可自动拉起的可执行文件（可设 SOCUT_EXE）', 'CLI_LAUNCH_FAILED')
  }
  const errors = []
  for (const candidate of candidates) {
    try {
      const child = spawn(candidate.exe, candidate.args, {
        cwd: candidate.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: childEnv()
      })
      child.unref()
    } catch (error) {
      errors.push(`${candidate.exe}: ${String(error)}`)
      continue
    }
    const deadline = Date.now() + RENDERER_READY_WAIT_MS
    while (Date.now() < deadline) {
      const info = await discoverHealthyServer(config)
      if (info) return info
      await sleep(POLL_INTERVAL_MS)
    }
    errors.push(`${candidate.exe}: 启动后 60 秒内未发现控制服务`)
  }
  throw new SocutError(`Socut 自动拉起失败：${errors.join('；')}`, 'CLI_LAUNCH_FAILED')
}

let cachedServer = null

async function ensureServer(config) {
  // 先复用已发现的实例（工具调用很密集，每次都读 server.json 是浪费）；
  // 健康检查失败（应用被关掉/重启换了 token）再重新发现/拉起。
  if (cachedServer && (await healthOf(cachedServer))) return cachedServer
  const existing = await discoverHealthyServer(config)
  if (existing) {
    cachedServer = existing
    return existing
  }
  const launched = await launchAndWait(config)
  cachedServer = launched
  return launched
}

async function postCommand(server, command, params, timeout = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ command, params }),
      signal: controller.signal
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text.length > 0 ? JSON.parse(text) : null
    } catch {
      throw new SocutError(`服务返回非 JSON：${text.slice(0, 300)}`, 'CLI_PROTOCOL_ERROR')
    }
    if (!response.ok) {
      const error = payload && typeof payload === 'object' ? payload.error : null
      throw new SocutError(error?.message || `HTTP ${response.status}`, error?.code || 'CLI_HTTP_ERROR', error?.detail)
    }
    if (!payload || payload.ok !== true) {
      const error = payload?.error ?? {}
      throw new SocutError(error.message || '命令失败', error.code || 'CLI_ERROR', error.detail)
    }
    return payload.result
  } catch (error) {
    if (error instanceof SocutError) throw error
    if (error && error.name === 'AbortError') throw new SocutError(`命令超时：${command}`, 'CLI_TIMEOUT')
    throw new SocutError(`${command} 失败：${String(error)}`, 'CLI_ERROR')
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// MCP 处理器
// ---------------------------------------------------------------------------

/** 给工具调用补固定参数（例如 transition_remove 的 transition:null）。 */
function paramsOfTool(tool, args) {
  return { ...(args ?? {}), ...(tool.fixedParams ?? {}) }
}

/** tools/list 只暴露 MCP 字段（内部 command/fixedParams 不外泄）。 */
function publicTools() {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}

async function callTool(config, name, args) {
  const tool = findMcpTool(name)
  if (!tool) throw new SocutError(`未知工具：${name}`, 'TOOL_NOT_FOUND', '调 tools/list 看全部工具')
  if (!tool.command) return callSpecialTool(config, name, args)
  const server = await ensureServer(config)
  const result = await postCommand(server, tool.command, paramsOfTool(tool, args))
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

async function callSpecialTool(config, name, args) {
  if (name === 'preview_frame') {
    const server = await ensureServer(config)
    const result = await postCommand(server, 'preview.frame', args ?? {}, 120_000)
    if (!result || typeof result.pngBase64 !== 'string') {
      throw new SocutError('渲染帧失败：没有拿到 PNG 数据', 'PREVIEW_FAILED')
    }
    return {
      content: [
        { type: 'image', data: result.pngBase64, mimeType: 'image/png' },
        {
          type: 'text',
          text: JSON.stringify({ width: result.width, height: result.height, frame: result.frame, atSec: result.atSec })
        }
      ]
    }
  }
  if (name === 'export_wait') {
    const jobId = args?.jobId
    if (typeof jobId !== 'string' || jobId.length === 0) throw new SocutError('缺少 jobId', 'BAD_PARAMS')
    const timeoutMs = Number.isFinite(args?.timeoutMs) ? Math.max(1_000, args.timeoutMs) : DEFAULT_TIMEOUT_MS
    const server = await ensureServer(config)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const status = await postCommand(server, 'export.status', { jobId }, 60_000)
      const phase = status?.progress?.phase ?? status?.phase ?? ''
      if (phase === 'done' || phase === 'failed' || phase === 'cancelled') {
        return { content: [{ type: 'text', text: JSON.stringify(status) }] }
      }
      await sleep(POLL_INTERVAL_MS)
    }
    throw new SocutError(`等待导出超时：${jobId}`, 'TIMEOUT')
  }
  throw new SocutError(`未实现的特殊工具：${name}`, 'TOOL_NOT_FOUND')
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }
}

async function handleMessage(config, message) {
  if (!message || typeof message !== 'object') return rpcError(null, -32600, '请求必须是 JSON 对象')
  const id = message.id ?? null
  const method = message.method
  if (typeof method !== 'string') return rpcError(id, -32600, '缺少 method')
  // 通知：不回包
  if (message.id === undefined) return null

  if (method === 'initialize') {
    const requested = message.params?.protocolVersion
    const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0]
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'socut', version: SERVER_VERSION },
      instructions:
        'Socut 是离线广播新闻字幕条/叠层导出工具。推荐流程：project_get 看现状 → clip_add / text_add 加内容 → preview_frame 看一眼 → export_start 导出 → export_wait 等结果。'
    })
  }
  if (method === 'ping') return rpcResult(id, {})
  if (method === 'tools/list') return rpcResult(id, { tools: publicTools() })
  if (method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    try {
      const result = await callTool(config, name, args)
      return rpcResult(id, result)
    } catch (error) {
      const messageText = error instanceof SocutError ? error.message : String(error)
      const detail = error instanceof SocutError ? error.detail : undefined
      console.error(`[socut-mcp] 工具失败 ${name}: ${messageText}`)
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, code: error.code ?? 'MCP_ERROR', message: messageText, detail }) }],
        isError: true
      })
    }
  }
  return rpcError(id, -32601, `未知方法：${method}`)
}

async function main() {
  const config = parseArgs(process.argv.slice(2))
  const send = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  let queue = Promise.resolve()
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    queue = queue
      .then(async () => {
        let parsed
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          send(rpcError(null, -32700, '不是合法 JSON'))
          return
        }
        const response = await handleMessage(config, parsed)
        if (response) send(response)
      })
      .catch((error) => {
        console.error(`[socut-mcp] 处理失败：${String(error)}`)
        send(rpcError(null, -32603, String(error)))
      })
  })
  rl.on('close', () => {
    process.exitCode = 0
  })
  console.error('[socut-mcp] 已启动（stdio JSON-RPC；日志走 stderr）')
}

main().catch((error) => {
  console.error(`[socut-mcp] 启动失败：${String(error)}`)
  process.exitCode = 1
})
