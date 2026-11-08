#!/usr/bin/env node
/**
 * FocusNews CLI —— 无依赖 Node 客户端。
 *
 * 设计目标：给 AI Agent 一个稳定的 JSON 控制面。命令通过本机 HTTP 服务
 * 驱动已经运行的 FocusNews；若应用未启动，则自动以 `--cli-server` 模式拉起。
 *
 * 用法：
 *   node cli/focusnews-cli.mjs app health --pretty
 *   node cli/focusnews-cli.mjs project open --path D:\work\demo.focusnews
 *   node cli/focusnews-cli.mjs export run --kind overlayMp4 --output-dir D:\out --file-name demo
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROTOCOL_VERSION = 1
const CLI_VERSION = '0.1.0'
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const HEALTH_TIMEOUT_MS = 2_500
const RENDERER_READY_WAIT_MS = 60_000
const POLL_INTERVAL_MS = 300

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

class CliError extends Error {
  constructor(message, code = 'CLI_ERROR', detail) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const config = {
    pretty: false,
    progress: false,
    noLaunch: false,
    help: false,
    version: false,
    timeout: DEFAULT_TIMEOUT_MS,
    serverFile: '',
    tokenOverride: '',
    baseParams: {},
    flagParams: {},
    positionals: []
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      config.positionals.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith('--') || arg === '-') {
      config.positionals.push(arg)
      continue
    }

    const raw = arg.slice(2)
    const equals = raw.indexOf('=')
    let key = equals >= 0 ? raw.slice(0, equals) : raw
    let value = equals >= 0 ? raw.slice(equals + 1) : undefined

    if (key === 'help') {
      config.help = true
      continue
    }
    if (key === 'version') {
      config.version = true
      continue
    }
    if (key === 'pretty') {
      config.pretty = true
      continue
    }
    if (key === 'progress') {
      config.progress = true
      continue
    }
    if (key === 'no-launch') {
      config.noLaunch = true
      continue
    }
    if (key === 'timeout') {
      const next = takeValue(argv, index, value)
      index = next.index
      if (next.value === undefined) throw new CliError('--timeout 需要毫秒数', 'CLI_USAGE')
      const timeout = Number(next.value)
      if (!Number.isFinite(timeout) || timeout <= 0) {
        throw new CliError(`--timeout 非法：${next.value}`, 'CLI_USAGE')
      }
      config.timeout = Math.floor(timeout)
      continue
    }
    if (key === 'server') {
      const next = takeValue(argv, index, value)
      index = next.index
      if (next.value === undefined) throw new CliError('--server 需要 server.json 路径', 'CLI_USAGE')
      config.serverFile = next.value
      continue
    }
    if (key === 'token') {
      const next = takeValue(argv, index, value)
      index = next.index
      if (next.value === undefined) throw new CliError('--token 需要 token', 'CLI_USAGE')
      config.tokenOverride = next.value
      continue
    }
    if (key === 'params') {
      const next = takeValue(argv, index, value)
      index = next.index
      if (next.value === undefined) throw new CliError('--params 需要 JSON 对象', 'CLI_USAGE')
      config.baseParams = { ...config.baseParams, ...parseJsonObject(next.value, '--params') }
      continue
    }

    let negative = false
    if (key.startsWith('no-')) {
      negative = true
      key = key.slice(3)
    }
    const next = takeValue(argv, index, value)
    index = next.index
    const coerced = next.value === undefined ? true : coerce(next.value)
    config.flagParams[toCamel(key)] = negative && next.value === undefined ? false : coerced
  }

  return config
}

function takeValue(argv, index, inlineValue) {
  if (inlineValue !== undefined) return { value: inlineValue, index }
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) return { value: undefined, index }
  return { value: next, index: index + 1 }
}

function toCamel(key) {
  return key.replace(/-([a-z0-9])/g, (_match, char) => char.toUpperCase())
}

function coerce(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

function parseJsonObject(text, label) {
  try {
    const value = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('不是对象')
    }
    return value
  } catch (error) {
    throw new CliError(`${label} 不是合法 JSON 对象：${error instanceof Error ? error.message : String(error)}`, 'CLI_USAGE')
  }
}

function paramsOf(config) {
  return { ...config.baseParams, ...config.flagParams }
}

// ---------------------------------------------------------------------------
// 发现 / 自动拉起
// ---------------------------------------------------------------------------

function candidateServerFiles(config) {
  const candidates = []
  const add = (value) => {
    if (typeof value === 'string' && value.length > 0 && !candidates.includes(value)) candidates.push(value)
  }

  add(config.serverFile)
  add(process.env.FOCUSNEWS_CLI_SERVER_FILE)
  if (process.env.FOCUSNEWS_USER_DATA) {
    add(path.join(process.env.FOCUSNEWS_USER_DATA, 'cli', 'server.json'))
  }

  const appData = process.env.APPDATA
  if (appData) {
    for (const name of ['FocusNews', 'focusnews', 'Electron']) {
      add(path.join(appData, name, 'cli', 'server.json'))
    }
  }

  const home = os.homedir()
  if (process.platform === 'darwin') {
    for (const name of ['FocusNews', 'focusnews']) {
      add(path.join(home, 'Library', 'Application Support', name, 'cli', 'server.json'))
    }
  } else if (process.platform !== 'win32') {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    for (const name of ['FocusNews', 'focusnews']) {
      add(path.join(configHome, name, 'cli', 'server.json'))
    }
  }

  return candidates
}

async function readServerInfo(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const info = JSON.parse(raw)
    if (
      typeof info !== 'object' ||
      info === null ||
      info.protocolVersion !== PROTOCOL_VERSION ||
      !Number.isInteger(info.port) ||
      info.port <= 0 ||
      info.port > 65535 ||
      typeof info.token !== 'string' ||
      info.token.length === 0
    ) {
      return null
    }
    return {
      protocolVersion: info.protocolVersion,
      port: info.port,
      token: info.token,
      pid: typeof info.pid === 'number' ? info.pid : 0,
      appVersion: typeof info.appVersion === 'string' ? info.appVersion : '',
      startedAt: typeof info.startedAt === 'string' ? info.startedAt : '',
      userDataPath: typeof info.userDataPath === 'string' ? info.userDataPath : '',
      file
    }
  } catch {
    return null
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
    return Boolean(payload && payload.ok === true && payload.result && payload.result.protocolVersion === PROTOCOL_VERSION)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function findRepoRoot(start) {
  let current = start
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        if (parsed && parsed.name === 'focusnews') return current
      } catch {
        // 继续向上找
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
    const key = `${exe}\u0000${args.join('\u0000')}`
    if (candidates.some((candidate) => candidate.key === key)) return
    if (!existsSync(exe)) return
    candidates.push({ key, exe, args, cwd })
  }

  if (process.env.FOCUSNEWS_EXE) {
    add(process.env.FOCUSNEWS_EXE, ['--cli-server'], path.dirname(process.env.FOCUSNEWS_EXE))
  }

  const packagedName = process.platform === 'win32' ? 'FocusNews.exe' : 'FocusNews'
  const sibling = path.resolve(SCRIPT_DIR, '..', packagedName)
  add(sibling, ['--cli-server'], path.resolve(SCRIPT_DIR, '..'))

  if (process.env.FOCUSNEWS_ELECTRON) {
    const root = findRepoRoot(SCRIPT_DIR) || path.resolve(SCRIPT_DIR, '..')
    add(process.env.FOCUSNEWS_ELECTRON, [root, '--cli-server'], root)
  }

  const repoRoot = findRepoRoot(SCRIPT_DIR) || findRepoRoot(process.cwd())
  if (repoRoot) {
    const electron = electronBinary(repoRoot)
    if (electron) add(electron, [repoRoot, '--cli-server'], repoRoot)
  }

  // 打包版 .cmd 用 FocusNews.exe + ELECTRON_RUN_AS_NODE 运行本脚本：
  // 此时 process.execPath 就是 GUI exe，可直接作为自动拉起入口。
  const execName = path.basename(process.execPath).toLowerCase()
  if (execName.includes('focusnews')) {
    add(process.execPath, ['--cli-server'], path.dirname(process.execPath))
  }

  return candidates
}

async function launchAndWait(config) {
  if (config.noLaunch) {
    throw new CliError(
      '未发现运行中的 FocusNews，且已指定 --no-launch。请先启动应用，或去掉 --no-launch。',
      'CLI_CONNECT_FAILED'
    )
  }
  const candidates = launchCandidates()
  if (candidates.length === 0) {
    throw new CliError(
      '未发现运行中的 FocusNews，也找不到可自动拉起的可执行文件。请设置 FOCUSNEWS_EXE 指向 FocusNews.exe。',
      'CLI_LAUNCH_FAILED'
    )
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
      errors.push(`${candidate.exe}: ${error instanceof Error ? error.message : String(error)}`)
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

  throw new CliError(`FocusNews 自动拉起失败：${errors.join('；')}`, 'CLI_LAUNCH_FAILED')
}

function childEnv() {
  const env = { ...process.env }
  // 打包版 .cmd 会设置 ELECTRON_RUN_AS_NODE=1；继承给 GUI 子进程会让它不启动 Electron。
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function connect(config) {
  const existing = await discoverHealthyServer(config)
  if (existing) return existing
  return launchAndWait(config)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function apiRequest(server, pathname, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text.length > 0 ? JSON.parse(text) : null
    } catch {
      throw new CliError(`服务返回非 JSON：${text.slice(0, 500)}`, 'CLI_PROTOCOL_ERROR')
    }
    if (!response.ok) {
      const error = payload && typeof payload === 'object' ? payload.error : null
      throw new CliError(
        (error && error.message) || `HTTP ${response.status} ${response.statusText}`,
        (error && error.code) || `HTTP_${response.status}`,
        error && error.detail
      )
    }
    if (!payload || typeof payload !== 'object') {
      throw new CliError('服务返回空响应', 'CLI_PROTOCOL_ERROR')
    }
    return payload
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CliError(`请求超时（${timeout}ms）`, 'CLI_TIMEOUT')
    }
    throw new CliError(error instanceof Error ? error.message : String(error), 'CLI_CONNECT_FAILED')
  } finally {
    clearTimeout(timer)
  }
}

async function postCommand(server, command, params, config) {
  const payload = await apiRequest(server, '/v1/command', {
    method: 'POST',
    body: { command, params },
    timeout: config.timeout
  })
  if (payload.ok !== true) {
    const error = payload.error ?? {}
    throw new CliError(error.message ?? `命令失败：${command}`, error.code ?? 'CLI_ERROR', error.detail)
  }
  return payload.result
}

async function getJobs(server, config) {
  const payload = await apiRequest(server, '/v1/jobs', { timeout: config.timeout })
  if (payload.ok !== true) {
    const error = payload.error ?? {}
    throw new CliError(error.message ?? '读取任务失败', error.code ?? 'CLI_ERROR', error.detail)
  }
  return payload.result
}

async function getJob(server, jobId, config) {
  const payload = await apiRequest(server, `/v1/jobs/${encodeURIComponent(jobId)}`, { timeout: config.timeout })
  if (payload.ok !== true) {
    const error = payload.error ?? {}
    throw new CliError(error.message ?? `任务不存在：${jobId}`, error.code ?? 'CLI_ERROR', error.detail)
  }
  return payload.result
}

async function waitForJob(server, jobId, config) {
  const deadline = Date.now() + config.timeout
  let lastPercent = -1
  while (Date.now() < deadline) {
    const snapshot = await getJob(server, jobId, config)
    const percent = snapshot?.progress?.percent
    if (config.progress && typeof percent === 'number' && percent !== lastPercent) {
      lastPercent = percent
      process.stderr.write(`\r${jobId} ${(percent * 100).toFixed(1)}%`)
    }
    if (snapshot?.result) {
      if (config.progress) process.stderr.write('\n')
      if (snapshot.result.ok !== true) {
        const error = snapshot.result.error ?? {}
        throw new CliError(
          error.message ?? '导出失败',
          error.code ?? 'EXPORT_FAILED',
          error.stderrTail || undefined
        )
      }
      return snapshot.result
    }
    await sleep(POLL_INTERVAL_MS)
  }
  if (config.progress) process.stderr.write('\n')
  throw new CliError(`等待导出任务超时：${jobId}`, 'TIMEOUT')
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

const ALIASES = {
  health: 'app.health',
  info: 'app.info',
  commands: 'app.commands',
  gpu: 'app.gpu',
  shutdown: 'app.shutdown',
  open: 'project.open',
  save: 'project.save',
  new: 'project.new',
  recent: 'project.recent',
  import: 'media.import',
  probe: 'media.probe',
  run: 'export.run',
  wait: 'export.wait'
}

function normalizeCommand(config) {
  if (config.positionals.length === 0) return ''
  const joined = config.positionals.join('.')
  return joined.includes('.') ? joined : ALIASES[joined] ?? joined
}

async function execute(config) {
  const command = normalizeCommand(config)

  if (config.version) {
    return { name: 'focusnews-cli', version: CLI_VERSION, protocolVersion: PROTOCOL_VERSION }
  }
  if (config.help || command === '' || command === 'help') {
    printHelp()
    return null
  }

  const params = paramsOf(config)
  const server = await connect(config)

  if (command === 'jobs') return getJobs(server, config)
  if (command === 'job') {
    const jobId = requiredString(params, 'jobId', '--job-id')
    return getJob(server, jobId, config)
  }
  if (command === 'export.run') {
    const started = await postCommand(server, 'export.start', params, config)
    const jobId = started && started.jobId
    if (!jobId) throw new CliError('export.start 未返回 jobId', 'CLI_PROTOCOL_ERROR')
    return waitForJob(server, jobId, config)
  }
  if (command === 'export.wait') {
    const jobId = requiredString(params, 'jobId', '--job-id')
    return waitForJob(server, jobId, config)
  }

  return postCommand(server, command, params, config)
}

function requiredString(params, key, flag) {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliError(`缺少参数 ${flag}`, 'CLI_USAGE')
  }
  return value
}

function printHelp() {
  process.stdout.write(
    [
      'FocusNews CLI',
      '',
      '用法：',
      '  focusnews-cli <命令> [参数...]',
      '',
      '常用命令：',
      '  app info | app health | app commands | app gpu | app shutdown',
      '  project new | open | save | get | apply | recent | undo | redo',
      '  media import | list | remove | probe | exists | relocate',
      '  timeline media insert/move/trim/remove/split/select | audio insert/move/trim/remove/split',
      '  clip add | update | remove | duplicate | split | video | stab | audio | speed | transition',
      '  audio fx | speed | role | ducking | reset',
      '  track addMedia | addAudio | removeMedia | removeAudio | moveMedia | moveAudio | rename',
      '  watermark set | enable | remove | probe',
      '  export run | wait | start | status | cover | cancel | estimate',
      '  jobs | job | ui.set',
      '',
      '选项：',
      '  --params <json>     以 JSON 对象传参（命令行 flag 会覆盖同名参数）',
      '  --pretty            格式化输出 JSON',
      '  --progress          导出等待时把进度写到 stderr',
      '  --timeout <ms>      请求/等待超时，默认 1800000（30 分钟）',
      '  --server <file>     指定 server.json 路径',
      '  --no-launch         不自动拉起 FocusNews',
      '  --token <token>     覆盖 server.json 中的 token（调试用）',
      '  --help              显示本帮助',
      '  --version           显示 CLI 版本',
      '',
      '参数示例：',
      '  focusnews-cli project open --path D:\\\\work\\\\demo.focusnews',
      '  focusnews-cli media import --path D:\\\\media\\\\a.mp4 --ack-non169 --vfr convert',
      '  focusnews-cli export run --kind overlayMp4 --output-dir D:\\\\out --file-name demo',
      '  focusnews-cli clip update --id clip-1 --patch \'{"content":{"main":"标题"}}\'',
      '',
      '完整命令清单：focusnews-cli app commands --pretty',
      ''
    ].join('\n')
  )
}

// ---------------------------------------------------------------------------
// 输出 / 入口
// ---------------------------------------------------------------------------

function output(payload, pretty) {
  process.stdout.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`)
  if (payload && payload.ok === false) process.exitCode = 1
}

function errorEnvelope(error) {
  if (error instanceof CliError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.detail ? { detail: String(error.detail).slice(0, 8000) } : {})
      }
    }
  }
  if (error instanceof Error) {
    return { ok: false, error: { code: 'CLI_ERROR', message: error.message } }
  }
  return { ok: false, error: { code: 'CLI_ERROR', message: String(error) } }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  let config
  try {
    config = parseArgs(process.argv.slice(2))
    const result = await execute(config)
    if (result === null) return
    output({ ok: true, result }, config.pretty)
  } catch (error) {
    output(errorEnvelope(error), config ? config.pretty : false)
  }
}

void main()
