import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { BrowserWindow, app } from 'electron'
import {
  CLI_COMMANDS,
  CLI_ERROR_CODES,
  CLI_MAX_BODY_BYTES,
  CLI_PROTOCOL_VERSION,
  CLI_RENDERER_TIMEOUT_MS,
  CLI_SERVER_DIR,
  CLI_SERVER_FILE,
  CliCommandError,
  asRecord,
  findCliCommand,
  optionalString,
  requireNumber,
  requireRecord,
  requireString,
  toCliErrorInfo,
  type CliCommandRequest,
  type CliResponse,
  type CliServerInfo
} from '../shared/cliProtocol'
import { APP_NAME, WINDOW_TITLE } from '../shared/constants'
import {
  EVENT_TOPICS,
  controlEventBus,
  projectChangedEvent,
  type ProjectChangedEventData
} from '../shared/jsonRpc'
import { APP_VERSION } from './appVersion'
import { validateAllPresets } from '../shared/presets'
import { CHANNELS } from '../shared/ipcChannels'
import type { GpuDiagnostics } from '../shared/gpu'
import type { ExportEngine } from './export/engine'
import { describeBinarySource, resolveFfmpegBinaries, resourcesRoot, userFontsDir } from './paths'
import { ffmpegVersion } from './ffrun'
import { getGpuDiagnostics } from './gpu'
import { log } from './log'
import { fileExists, readProjectFile, writeProjectFile } from './projectStore'
import {
  createRecentProject,
  listRecentProjects,
  openRecentProject,
  registerFileProject
} from './recentProjectStore'
import { probeVideo } from './videoImport'
import { probeImageSize } from './watermark'
import { createDefaultProject } from '../shared/projectSchema'
import type { ExportKind, Fps } from '../shared/types'
import { cancelCfr } from './cfrTranscode'
import { cancelStabPreview } from './stabPreview'
import { cancelMediaProxy } from './mediaProxy'
import { parseSubtitleFile } from '../shared/subtitleFormats'
import { createWhisperManager, type WhisperManager } from './whisper'
import { acquireProjectLock, projectLockPath, readProjectLock, releaseProjectLock } from './projectLock'

/**
 * CLI 本地控制服务。
 *
 * 只监听 127.0.0.1，token 每次启动随机生成并写入 userData/cli/server.json。
 * 编辑类命令必须交给渲染进程执行（工程状态唯一真值在 zustand），
 * 文件/ffprobe/任务状态在主进程直接处理。
 */

/** 渲染进程首次加载可能慢于服务启动；超时后明确报 RENDERER_UNAVAILABLE。 */
const RENDERER_READY_TIMEOUT_MS = 60_000

interface PendingCommand {
  resolve: (value: CliResponse) => void
  reject: (reason: unknown) => void
  timer: NodeJS.Timeout
}

interface RendererWaiter {
  resolve: () => void
  timer: NodeJS.Timeout
}

export class CliControlServer {
  private readonly engine: ExportEngine
  private server: http.Server | null = null
  private token = ''
  private port = 0
  private startedAt = ''
  private rendererReady = false
  private readonly readyWaiters: RendererWaiter[] = []
  private readonly pending = new Map<string, PendingCommand>()
  /** M11：whisper.cpp 运行时（懒创建；配置落在 userData/whisper.json） */
  private whisper: WhisperManager | null = null
  /** M10 事件流：导出进度 → controlEventBus 的取消函数（start 订阅、stop 解除） */
  private detachEngineProgress: (() => void) | null = null

  constructor(engine: ExportEngine) {
    this.engine = engine
  }

  async start(): Promise<CliServerInfo> {
    if (this.server) {
      return this.info()
    }
    this.token = randomBytes(32).toString('hex')
    this.startedAt = new Date().toISOString()
    const server = http.createServer((request, response) => {
      void this.handleHttp(request, response)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.stop()
      throw new Error('CLI 控制服务未取得监听端口')
    }
    this.port = address.port
    const info = this.info()
    await this.writeDiscovery(info)
    await log('info', `CLI 控制服务已启动：http://127.0.0.1:${this.port}（pid ${process.pid}）`)
    // M10 事件流：导出进度直接进控制面事件总线，JSON-RPC 订阅者按 export.progress 主题收；
    // 没有订阅者时 publish 是纯 no-op（总线按监听者数量分发）。
    this.detachEngineProgress ??= this.engine.onProgress((progress) => {
      controlEventBus.publish(EVENT_TOPICS.exportProgress, progress)
    })
    return info
  }

  info(): CliServerInfo {
    return {
      protocolVersion: CLI_PROTOCOL_VERSION,
      port: this.port,
      token: this.token,
      pid: process.pid,
      appVersion: APP_VERSION,
      startedAt: this.startedAt,
      userDataPath: app.getPath('userData')
    }
  }

  /**
   * M10：传输无关的命令入口 —— HTTP CLI 与 JSON-RPC 行协议共用同一个分派器。
   * 调用方（传输层）自己负责鉴权与分帧，这里只管 { command, params } → result | error。
   */
  async dispatch(request: CliCommandRequest): Promise<unknown> {
    return this.handleCommand(request)
  }

  /** M10：JSON-RPC 服务起来后把入口写进发现文件（供 Agent 发现）。 */
  async attachJsonRpc(rpc: NonNullable<CliServerInfo['rpc']>): Promise<void> {
    await this.writeDiscovery({ ...this.info(), rpc })
  }

  /** preload 注册好命令处理器后调用；此后才允许把命令转发进渲染进程。 */
  notifyRendererReady(): void {
    this.rendererReady = true
    while (this.readyWaiters.length > 0) {
      const waiter = this.readyWaiters.shift()
      if (!waiter) continue
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  /** 窗口 reload/关闭时调用，避免向尚未挂载路由的渲染进程发命令。 */
  notifyRendererGone(): void {
    this.rendererReady = false
  }

  handleResponse(id: string, response: CliResponse): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.detachEngineProgress?.()
    this.detachEngineProgress = null
    this.rendererReady = false
    for (const waiter of this.readyWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CliCommandError(CLI_ERROR_CODES.RENDERER_UNAVAILABLE, 'CLI 控制服务已关闭'))
    }
    this.pending.clear()
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    await this.removeDiscovery()
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async handleHttp(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (!this.authorized(request)) {
        this.sendJson(response, 401, {
          ok: false,
          error: { code: CLI_ERROR_CODES.UNAUTHORIZED, message: 'token 无效' }
        })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        this.sendJson(response, 200, {
          ok: true,
          result: {
            appName: APP_NAME,
            title: WINDOW_TITLE,
            version: APP_VERSION,
            protocolVersion: CLI_PROTOCOL_VERSION,
            port: this.port,
            pid: process.pid,
            rendererReady: this.rendererReady,
            activeJobs: this.engine.activeJobs().length
          }
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/commands') {
        this.sendJson(response, 200, { ok: true, result: { protocolVersion: CLI_PROTOCOL_VERSION, commands: CLI_COMMANDS } })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/jobs') {
        this.sendJson(response, 200, { ok: true, result: { jobs: this.engine.listJobs() } })
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/jobs/')) {
        const jobId = decodeURIComponent(url.pathname.slice('/v1/jobs/'.length))
        const status = this.engine.jobStatus(jobId)
        if (!status) {
          this.sendJson(response, 404, {
            ok: false,
            error: { code: CLI_ERROR_CODES.NOT_FOUND, message: `导出任务不存在：${jobId}` }
          })
          return
        }
        this.sendJson(response, 200, { ok: true, result: status })
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/command') {
        await this.handleCommandHttp(request, response)
        return
      }
      if (request.method === 'POST' && url.pathname === '/v1/shutdown') {
        this.sendJson(response, 200, { ok: true, result: { closing: true } })
        setTimeout(() => app.quit(), 250).unref?.()
        return
      }
      this.sendJson(response, 404, {
        ok: false,
        error: { code: CLI_ERROR_CODES.NOT_FOUND, message: `未知路由：${request.method ?? '?'} ${url.pathname}` }
      })
    } catch (error) {
      const info = toCliErrorInfo(error)
      const status = info.code === CLI_ERROR_CODES.BAD_REQUEST ? 400 : 500
      this.sendJson(response, status, { ok: false, error: info })
    }
  }

  private async handleCommandHttp(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const body = await this.readJsonBody(request)
    const record = asRecord(body)
    if (!record) {
      throw new CliCommandError(CLI_ERROR_CODES.BAD_REQUEST, '请求体必须是 JSON 对象')
    }
    const command = requireString(record, 'command')
    const params = asRecord(record['params']) ?? {}
    const requestId = optionalString(record, 'id') ?? randomUUID()
    const envelope: CliCommandRequest = { id: requestId, command, params }
    try {
      const result = await this.handleCommand(envelope)
      this.sendJson(response, 200, { ok: true, result })
    } catch (error) {
      this.sendJson(response, 200, { ok: false, error: toCliErrorInfo(error) })
    }
  }

  private async handleCommand(request: CliCommandRequest): Promise<unknown> {
    const spec = findCliCommand(request.command)
    if (!spec) {
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知命令：${request.command}`)
    }
    if (spec.host === 'main') {
      return this.handleMainCommand(request)
    }
    const result = await this.dispatchToRenderer(request)
    // M10 事件流：渲染侧保存成功后广播工程变更（主进程只知道落盘路径，revision 观测不到）
    if (request.command === 'project.save') {
      const saved = asRecord(result)
      const savedPath = typeof saved?.['path'] === 'string' ? saved['path'] : null
      this.emitProjectChanged({ path: savedPath, reason: 'save' })
    }
    return result
  }

  /**
   * 广播 `project.changed`（M10 事件流）。
   *
   * 只从主进程可观测点发：CLI 工程命令切换当前工程（new / open / openRecent）、
   * 渲染侧保存成功（save）、工程锁申请/释放（lock / unlock）。
   * revision 不在主进程：渲染进程 zustand store 才是唯一真值，自动保存 IPC 也不带它，
   * 因此事件里 revision 恒为 null——宁可缺字段也不在主进程臆造一个假版本号。
   */
  private emitProjectChanged(input: {
    path: string | null
    name?: string | null
    reason: ProjectChangedEventData['reason']
    mode?: 'window' | 'agent'
  }): void {
    controlEventBus.publish(
      EVENT_TOPICS.projectChanged,
      projectChangedEvent({
        path: input.path,
        name: input.name ?? null,
        reason: input.reason,
        ...(input.mode ? { mode: input.mode } : {})
      })
    )
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      request.on('data', (chunk: Buffer) => {
        if (settled) return
        size += chunk.length
        if (size > CLI_MAX_BODY_BYTES) {
          fail(new CliCommandError(CLI_ERROR_CODES.BAD_REQUEST, `请求体超过 ${CLI_MAX_BODY_BYTES} 字节上限`))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('error', fail)
      request.on('end', () => {
        if (settled) return
        settled = true
        if (chunks.length === 0) {
          resolve({})
          return
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new CliCommandError(CLI_ERROR_CODES.BAD_REQUEST, '请求体不是合法 JSON'))
        }
      })
    })
  }

  private authorized(request: http.IncomingMessage): boolean {
    const authorization = request.headers.authorization
    const bearer =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : ''
    const header = request.headers['x-socut-token']
    const fallback = Array.isArray(header) ? header[0] ?? '' : typeof header === 'string' ? header : ''
    const candidate = bearer || fallback
    if (!candidate) return false
    const left = Buffer.from(candidate)
    const right = Buffer.from(this.token)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  private sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
    if (response.writableEnded) return
    const body = JSON.stringify(payload)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store'
    })
    response.end(body)
  }

  // -------------------------------------------------------------------------
  // 主进程命令
  // -------------------------------------------------------------------------

  private async handleMainCommand(request: CliCommandRequest): Promise<unknown> {
    const { command, params } = request
    switch (command) {
      case 'app.info':
        return this.appInfo()
      case 'app.health':
        return {
          ok: true,
          version: APP_VERSION,
          protocolVersion: CLI_PROTOCOL_VERSION,
          port: this.port,
          pid: process.pid,
          rendererReady: this.rendererReady,
          activeJobs: this.engine.activeJobs().length
        }
      case 'app.commands':
        return { protocolVersion: CLI_PROTOCOL_VERSION, commands: CLI_COMMANDS }
      case 'app.gpu':
        return this.gpuInfo()
      case 'app.shutdown':
        setTimeout(() => app.quit(), 250).unref?.()
        return { closing: true }
      case 'project.new': {
        const created = await this.newProject(params)
        this.emitProjectChanged({ path: created.path, name: created.name, reason: 'new' })
        return created
      }
      case 'project.open': {
        const opened = await this.openProject(params)
        this.emitProjectChanged({ path: opened.path, name: opened.name, reason: 'open' })
        return opened
      }
      case 'project.openRecent': {
        const opened = await this.openRecent(params)
        this.emitProjectChanged({ path: opened.path, name: opened.name, reason: 'openRecent' })
        return opened
      }
      case 'project.recent':
        return { projects: await listRecentProjects() }
      // M10：工程锁（窗口 / Agent 互斥）
      case 'project.lock': {
        const target = requireString(params, 'path')
        const mode = params['mode'] === 'window' ? 'window' : 'agent'
        const result = await acquireProjectLock(target, mode)
        if (!result.ok) {
          throw new CliCommandError(
            CLI_ERROR_CODES.GATE_BLOCKED,
            result.holder
              ? `工程已被占用（pid ${result.holder.pid}，${result.holder.mode}）`
              : '工程锁申请失败'
          )
        }
        this.emitProjectChanged({ path: target, reason: 'lock', mode })
        return {
          path: projectLockPath(target),
          mode,
          token: result.handle.info.token,
          holder: result.handle.info
        }
      }
      case 'project.unlock': {
        const target = requireString(params, 'path')
        const token = requireString(params, 'token')
        const released = await releaseProjectLock(target, token)
        if (!released) throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, '工程锁不存在或 token 不匹配')
        this.emitProjectChanged({ path: target, reason: 'unlock' })
        return { path: target, released: true }
      }
      case 'project.lockStatus': {
        const target = requireString(params, 'path')
        const holder = await readProjectLock(target)
        return { path: projectLockPath(target), locked: holder !== null, holder }
      }
      case 'media.probe': {
        const target = requireString(params, 'path')
        const probe = await probeVideo(target)
        if (!probe) {
          throw new CliCommandError(CLI_ERROR_CODES.MEDIA_PROBE_FAILED, `无法探测媒体文件：${target}`)
        }
        return probe
      }
      case 'media.exists': {
        const target = requireString(params, 'path')
        return { path: target, exists: await fileExists(target) }
      }      // ---------------------------------------------------------------- M11 Whisper 转写
      case 'whisper.status':
        return this.whisperManager().status()
      case 'whisper.config': {
        const patch: { binaryPath?: string; modelPath?: string; language?: string; threads?: number } = {}
        if (typeof params['binaryPath'] === 'string' && params['binaryPath'].length > 0) patch.binaryPath = params['binaryPath']
        if (typeof params['modelPath'] === 'string' && params['modelPath'].length > 0) patch.modelPath = params['modelPath']
        if (typeof params['language'] === 'string' && params['language'].length > 0) patch.language = params['language']
        if (typeof params['threads'] === 'number') patch.threads = params['threads']
        await this.whisperManager().saveConfig(patch)
        return this.whisperManager().status()
      }
      case 'caption.transcribe': {
        const target = requireString(params, 'path')
        const result = await this.whisperManager().transcribe({
          mediaPath: target,
          ...(typeof params['modelPath'] === 'string' ? { modelPath: params['modelPath'] } : {}),
          ...(typeof params['language'] === 'string' ? { language: params['language'] } : {}),
          ...(params['translate'] === true ? { translate: true } : {}),
          ...(typeof params['threads'] === 'number' ? { threads: params['threads'] } : {}),
          ...(typeof params['minDuration'] === 'number' ? { minDurationSec: params['minDuration'] } : {})
        })
        return result
      }      case 'caption.parse': {
        const target = requireString(params, 'path')
        if (!(await fileExists(target))) {
          throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `字幕文件不存在：${target}`)
        }
        const raw = await fs.readFile(target, 'utf8')
        const format = params['format'] === 'ass' ? 'ass' : params['format'] === 'srt' ? 'srt' : undefined
        const report = parseSubtitleFile(raw, format)
        return { path: target, cues: report.cues, dropped: report.dropped, count: report.cues.length }
      }
      case 'caption.write': {
        const target = requireString(params, 'path')
        const text = requireString(params, 'text')
        if (!/\.(srt|ass|ssa)$/i.test(target)) {
          throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '字幕文件扩展名必须是 .srt / .ass')
        }
        await fs.writeFile(target, text, 'utf8')
        return { path: target, bytes: Buffer.byteLength(text, 'utf8'), format: /\.ass$|\.ssa$/i.test(target) ? 'ass' : 'srt' }
      }
      case 'watermark.probe': {
        const target = requireString(params, 'path')
        const size = await probeImageSize(target)
        return { path: target, ...size }
      }
      case 'export.status': {
        const jobId = requireString(params, 'jobId')
        const status = this.engine.jobStatus(jobId)
        if (!status) {
          throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `导出任务不存在：${jobId}`)
        }
        return status
      }
      case 'export.jobs':
        return { jobs: this.engine.listJobs() }
      case 'export.cancel': {
        const jobId = requireString(params, 'jobId')
        await this.engine.cancel(jobId)
        await cancelCfr(jobId)
        await cancelStabPreview(jobId)
        await cancelMediaProxy(jobId)
        return { jobId, cancelled: true }
      }
      case 'export.estimate': {
        const fpsRecord = requireRecord(params, 'fps')
        const fps: Fps = { num: requireNumber(fpsRecord, 'num'), den: requireNumber(fpsRecord, 'den') }
        return this.engine.estimate({
          width: requireNumber(params, 'width'),
          height: requireNumber(params, 'height'),
          fps,
          frames: requireNumber(params, 'frames'),
          outputDir: requireString(params, 'outputDir'),
          ...(typeof params.kind === 'string' ? { kind: params.kind as ExportKind } : {})
        })
      }
      default:
        throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `主进程未实现命令：${command}`)
    }
  }

  private async appInfo(): Promise<Record<string, unknown>> {
    const binaries = await resolveFfmpegBinaries()
    const version = await ffmpegVersion(binaries)
    return {
      appName: APP_NAME,
      title: WINDOW_TITLE,
      version: APP_VERSION,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      platform: process.platform,
      packaged: app.isPackaged,
      ffmpegVersion: version,
      ffmpegPath: binaries.ffmpeg,
      ffprobePath: binaries.ffprobe,
      ffmpegSource: describeBinarySource(binaries),
      ffmpegAvailable: binaries.available,
      ffmpegHint: binaries.hint ?? '',
      userDataPath: app.getPath('userData'),
      fontsPath: userFontsDir(),
      presetIssues: validateAllPresets().map((issue) => `${issue.presetId} · ${issue.path}：${issue.message}`),
      cli: { protocolVersion: CLI_PROTOCOL_VERSION, port: this.port, pid: process.pid, rendererReady: this.rendererReady }
    }
  }

  private async gpuInfo(): Promise<GpuDiagnostics> {
    return getGpuDiagnostics()
  }

  private async newProject(
    params: Record<string, unknown>
  ): Promise<{ path: string | null; entryId: string | null; name: string }> {
    const target = optionalString(params, 'path')
    const requestedName = optionalString(params, 'name')
    let filePath = ''
    let project
    let entryId = ''

    if (target) {
      project = createDefaultProject(requestedName ?? path.basename(target).replace(/\.[^.]+$/, ''))
      filePath = await writeProjectFile(target, project)
      const entry = await registerFileProject(filePath, project, { touchOpened: true })
      entryId = entry.id
    } else {
      const created = await createRecentProject()
      project = created.project
      filePath = created.entry.filePath ?? ''
      entryId = created.entry.id
      if (requestedName) {
        project = { ...project, name: requestedName }
        if (filePath) filePath = await writeProjectFile(filePath, project)
        if (filePath) {
          const entry = await registerFileProject(filePath, project, { touchOpened: true })
          entryId = entry.id
        }
      }
    }

    await this.dispatchToRenderer({
      id: randomUUID(),
      command: 'project.load',
      params: { project, ...(filePath ? { path: filePath } : {}), ...(entryId ? { entryId } : {}) }
    })
    return { path: filePath || null, entryId: entryId || null, name: project.name }
  }

  private async openProject(
    params: Record<string, unknown>
  ): Promise<{ path: string; entryId: string; name: string }> {
    const target = requireString(params, 'path')
    const project = await readProjectFile(target)
    if (!project) {
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `工程不存在或无法解析：${target}`)
    }
    const entry = await registerFileProject(target, project, { touchOpened: true })
    await this.dispatchToRenderer({
      id: randomUUID(),
      command: 'project.load',
      params: { project, path: target, entryId: entry.id }
    })
    return { path: target, entryId: entry.id, name: project.name }
  }

  private async openRecent(
    params: Record<string, unknown>
  ): Promise<{ path: string | null; entryId: string; name: string }> {
    const id = requireString(params, 'id')
    const opened = await openRecentProject(id)
    if (!opened) {
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `最近工程不存在：${id}`)
    }
    await this.dispatchToRenderer({
      id: randomUUID(),
      command: 'project.load',
      params: {
        project: opened.project,
        ...(opened.path ? { path: opened.path } : {}),
        entryId: opened.entryId
      }
    })
    return { path: opened.path || null, entryId: opened.entryId, name: opened.project.name }
  }

  // -------------------------------------------------------------------------
  // 渲染进程桥
  // -------------------------------------------------------------------------

  private async dispatchToRenderer(request: CliCommandRequest): Promise<unknown> {
    await this.waitForRenderer()
    const window = BrowserWindow.getAllWindows().find(
      (candidate) => !candidate.isDestroyed() && !candidate.webContents.isDestroyed()
    )
    if (!window) {
      throw new CliCommandError(CLI_ERROR_CODES.RENDERER_UNAVAILABLE, '没有可用的渲染窗口')
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(
          new CliCommandError(
            CLI_ERROR_CODES.TIMEOUT,
            `渲染进程执行命令超时：${request.command}`,
            `超过 ${CLI_RENDERER_TIMEOUT_MS}ms`
          )
        )
      }, CLI_RENDERER_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(request.id, {
        resolve: (response) => {
          if (response.ok) resolve(response.result)
          else reject(new CliCommandError(response.error.code, response.error.message, response.error.detail))
        },
        reject,
        timer
      })
      try {
        window.webContents.send(CHANNELS.cliCommand, request)
      } catch (error) {
        this.pending.delete(request.id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private waitForRenderer(): Promise<void> {
    if (this.rendererReady) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.readyWaiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) this.readyWaiters.splice(index, 1)
        reject(new CliCommandError(CLI_ERROR_CODES.RENDERER_UNAVAILABLE, '渲染进程尚未就绪'))
      }, RENDERER_READY_TIMEOUT_MS)
      timer.unref?.()
      this.readyWaiters.push({ resolve, timer })
    })
  }

  // -------------------------------------------------------------------------
  // 发现文件
  // -------------------------------------------------------------------------

  private whisperManager(): WhisperManager {
    if (!this.whisper) {
      this.whisper = createWhisperManager({
        userDataDir: app.getPath('userData'),
        resourcesDir: resourcesRoot(),
        // whisper-cli 只吃 16k 单声道 WAV：用随包 FFmpeg 先把视频/音频抽成 wav
        ffmpegPath: async () => (await resolveFfmpegBinaries()).ffmpeg,
        // 抽音阶段真实进度需要 ffprobe 读媒体时长
        ffprobePath: async () => (await resolveFfmpegBinaries()).ffprobe
      })
    }
    return this.whisper
  }
  private discoveryPath(): string {
    return path.join(app.getPath('userData'), CLI_SERVER_DIR, CLI_SERVER_FILE)
  }

  private async writeDiscovery(info: CliServerInfo): Promise<void> {
    const target = this.discoveryPath()
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
    await fs.rm(target, { force: true })
    await fs.rename(temp, target)
    await fs.chmod(target, 0o600).catch(() => undefined)
  }

  private async removeDiscovery(): Promise<void> {
    const target = this.discoveryPath()
    try {
      const text = await fs.readFile(target, 'utf8')
      const info = JSON.parse(text) as Partial<CliServerInfo>
      if (info.pid !== process.pid || info.token !== this.token) return
    } catch {
      return
    }
    await fs.rm(target, { force: true }).catch(() => undefined)
  }
}
