import type { JobProgress, JobResult } from './types'

/**
 * CLI 控制协议（主进程本地 HTTP 服务 ↔ 外部 CLI/Agent）。
 *
 * 设计口径：
 * - 只绑定 127.0.0.1，随机端口 + 一次性 token，发现文件写在 userData/cli/server.json；
 * - 命令统一走 `{ command, params }`，返回 `{ ok, result | error }`；
 * - 编辑类命令由主进程转交给渲染进程执行（工程状态唯一真值在 zustand），
 *   文件/ffprobe/导出任务状态这类主进程能力直接在服务里处理。
 *
 * 本文件保持纯函数 + 纯类型：主进程、preload、渲染进程与 CLI 共用同一份命令清单。
 */

export const CLI_PROTOCOL_VERSION = 1
/** userData 下的发现目录 / 文件名（<userData>/cli/server.json）。 */
export const CLI_SERVER_DIR = 'cli'
export const CLI_SERVER_FILE = 'server.json'
/** 单条请求体上限：整工程 apply 可能带几十 MB 的 JSON，但不接受无上限。 */
export const CLI_MAX_BODY_BYTES = 64 * 1024 * 1024
/** 渲染进程执行命令的硬超时（导出本身是异步任务，不会占住这里）。 */
export const CLI_RENDERER_TIMEOUT_MS = 30 * 60_000

/** server.json 内容：CLI 用 port + token 连本地服务，pid 用于判断陈旧发现文件。 */
export interface CliServerInfo {
  protocolVersion: number
  port: number
  token: string
  pid: number
  appVersion: string
  startedAt: string
  userDataPath: string
}

export interface CliCommandRequest {
  id: string
  command: string
  params: Record<string, unknown>
}

export interface CliErrorInfo {
  code: string
  message: string
  detail?: string
}

export type CliResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: CliErrorInfo }

/** 主进程任务快照（GET /v1/jobs/:id）：进度 + 已结束任务的结果。 */
export interface CliJobSnapshot {
  progress: JobProgress
  result: JobResult | null
}

export type CliCommandHost = 'main' | 'renderer'

export interface CliCommandSpec {
  name: string
  host: CliCommandHost
  group: string
  summary: string
  /** 参数说明（供 `focusnews-cli app commands` / 文档使用，服务端不做严格 schema 校验）。 */
  params: string
  /** 需要用户显式确认的危险/长任务（CLI 帮助里标注）。 */
  longRunning?: boolean
}

/**
 * 命令清单唯一真值。
 * host=main 的命令不依赖窗口（文件、探测、任务状态）；host=renderer 的命令转交渲染进程。
 */
export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  // ---------------------------------------------------------------- app
  { name: 'app.info', host: 'main', group: 'app', summary: '应用版本、路径与 FFmpeg 可用性', params: '{}' },
  { name: 'app.health', host: 'main', group: 'app', summary: '控制服务健康检查', params: '{}' },
  { name: 'app.commands', host: 'main', group: 'app', summary: '列出全部命令', params: '{}' },
  { name: 'app.gpu', host: 'main', group: 'app', summary: '显卡与编码器体检', params: '{}' },
  { name: 'app.shutdown', host: 'main', group: 'app', summary: '退出应用（会先落盘自动存档）', params: '{}' },

  // ---------------------------------------------------------------- project
  { name: 'project.new', host: 'main', group: 'project', summary: '新建工程并加载到编辑器', params: '{ name?: string, path?: string }' },
  { name: 'project.open', host: 'main', group: 'project', summary: '按路径打开工程文件', params: '{ path: string }' },
  { name: 'project.openRecent', host: 'main', group: 'project', summary: '按最近工程 id 打开', params: '{ id: string }' },
  { name: 'project.recent', host: 'main', group: 'project', summary: '列出最近工程', params: '{}' },
  { name: 'project.get', host: 'renderer', group: 'project', summary: '读取当前工程与选择状态', params: '{}' },
  { name: 'project.save', host: 'renderer', group: 'project', summary: '保存到指定路径（缺省用当前路径）', params: '{ path?: string }' },
  { name: 'project.apply', host: 'renderer', group: 'project', summary: '用完整工程 JSON 覆盖当前工程（通用逃生口）', params: '{ project: Project }' },
  { name: 'project.load', host: 'renderer', group: 'project', summary: '内部：加载已解析工程', params: '{ project: Project, path?: string, entryId?: string }' },
  { name: 'project.rename', host: 'renderer', group: 'project', summary: '修改工程名', params: '{ name: string }' },
  { name: 'project.resolution', host: 'renderer', group: 'project', summary: '修改工程分辨率', params: '{ width: number, height: number }' },
  { name: 'project.fps', host: 'renderer', group: 'project', summary: '修改工程帧率', params: '{ num: number, den: number }' },
  { name: 'project.audioMastering', host: 'renderer', group: 'project', summary: '响度标准化（social/broadcast/off）', params: '{ mastering?: "social" | "broadcast" }' },
  { name: 'project.undo', host: 'renderer', group: 'project', summary: '撤销', params: '{}' },
  { name: 'project.redo', host: 'renderer', group: 'project', summary: '重做', params: '{}' },

  // ---------------------------------------------------------------- media
  { name: 'media.probe', host: 'main', group: 'media', summary: 'ffprobe 探测任意媒体文件', params: '{ path: string }' },
  { name: 'media.exists', host: 'main', group: 'media', summary: '检查文件是否存在', params: '{ path: string }' },
  { name: 'media.import', host: 'renderer', group: 'media', summary: '导入素材（含门禁确认/可选 VFR 转 CFR）', params: '{ path: string, ackNon169?: boolean, ackHdr?: boolean, vfr?: "none"|"raw"|"convert", name?: string, tags?: string[], binId?: string }' },
  { name: 'media.list', host: 'renderer', group: 'media', summary: '列出素材池、分组与轨道', params: '{}' },
  { name: 'media.remove', host: 'renderer', group: 'media', summary: '移出素材池（默认连带删除时间轴引用）', params: '{ id: string, removeClips?: boolean }' },
  { name: 'media.relocate', host: 'renderer', group: 'media', summary: '重新定位素材（换源不换轨）', params: '{ id: string, path: string }' },
  { name: 'media.rename', host: 'renderer', group: 'media', summary: '重命名素材', params: '{ id: string, name: string }' },
  { name: 'media.tags', host: 'renderer', group: 'media', summary: '设置素材标签', params: '{ id: string, tags: string[] }' },
  { name: 'media.compactMode', host: 'renderer', group: 'media', summary: '设置字幕条紧凑模式', params: '{ id: string, mode: "auto"|"compact"|"ultrawide"|"standard" }' },
  { name: 'media.vfrPolicy', host: 'renderer', group: 'media', summary: '设置 VFR 策略', params: '{ id: string, policy: "none"|"converted"|"raw" }' },
  { name: 'media.ackNon169', host: 'renderer', group: 'media', summary: '确认/撤销非 16:9 提示', params: '{ id: string, value: boolean }' },
  { name: 'media.ackHdr', host: 'renderer', group: 'media', summary: '确认/撤销 HDR 降级提示', params: '{ id: string, value: boolean }' },
  { name: 'media.bin.add', host: 'renderer', group: 'media', summary: '新建素材分组', params: '{ name: string }' },
  { name: 'media.bin.rename', host: 'renderer', group: 'media', summary: '重命名素材分组', params: '{ id: string, name: string }' },
  { name: 'media.bin.remove', host: 'renderer', group: 'media', summary: '删除素材分组', params: '{ id: string }' },
  { name: 'media.bin.assign', host: 'renderer', group: 'media', summary: '把素材归入分组', params: '{ id: string, binId: string | null }' },

  // ---------------------------------------------------------------- watermark
  { name: 'watermark.probe', host: 'main', group: 'watermark', summary: '探测水印图片原始尺寸', params: '{ path: string }' },
  { name: 'watermark.set', host: 'renderer', group: 'watermark', summary: '设置/替换水印', params: '{ path: string, sourceWidth?: number, sourceHeight?: number, enabled?: boolean }' },
  { name: 'watermark.enable', host: 'renderer', group: 'watermark', summary: '启用/停用水印', params: '{ enabled: boolean }' },
  { name: 'watermark.remove', host: 'renderer', group: 'watermark', summary: '移除水印', params: '{}' },

  // ---------------------------------------------------------------- subtitle clips
  { name: 'clip.add', host: 'renderer', group: 'clip', summary: '新增字幕条', params: '{ at?: number, duration?: number, content?: object, presetId?: string, fontId?: string, animation?: object, styleOverrides?: object }' },
  { name: 'clip.update', host: 'renderer', group: 'clip', summary: '更新字幕条（文字/预设/字体/动画/样式覆盖）', params: '{ id: string, patch: object }' },
  { name: 'clip.remove', host: 'renderer', group: 'clip', summary: '删除字幕条', params: '{ id: string }' },
  { name: 'clip.duplicate', host: 'renderer', group: 'clip', summary: '复制字幕条', params: '{ id: string }' },
  { name: 'clip.select', host: 'renderer', group: 'clip', summary: '选中字幕条', params: '{ id: string }' },
  { name: 'clip.split', host: 'renderer', group: 'clip', summary: '在指定时间拆分当前/指定片段', params: '{ at?: number, id?: string }' },
  { name: 'clip.applyStyleToAll', host: 'renderer', group: 'clip', summary: '把一条字幕样式应用到全部', params: '{ id: string }' },
  { name: 'clip.resetStyle', host: 'renderer', group: 'clip', summary: '恢复该条预设默认样式', params: '{ id: string }' },
  { name: 'clip.setTimes', host: 'renderer', group: 'clip', summary: '设置字幕条入出点', params: '{ id: string, startTime: number, endTime: number }' },

  // ---------------------------------------------------------------- media timeline
  { name: 'timeline.media.insert', host: 'renderer', group: 'timeline', summary: '把素材放到媒体轨', params: '{ mediaId: string, at: number, duration?: number, sourceIn?: number, trackId?: string }' },
  { name: 'timeline.media.move', host: 'renderer', group: 'timeline', summary: '平移媒体段（可跨轨）', params: '{ id: string, at: number, trackId?: string }' },
  { name: 'timeline.media.trim', host: 'renderer', group: 'timeline', summary: '裁剪媒体段入/出点', params: '{ id: string, start?: number, end?: number }' },
  { name: 'timeline.media.remove', host: 'renderer', group: 'timeline', summary: '删除媒体段', params: '{ id: string }' },
  { name: 'timeline.media.split', host: 'renderer', group: 'timeline', summary: '在指定时间拆分媒体段', params: '{ at: number, id?: string }' },
  { name: 'timeline.media.select', host: 'renderer', group: 'timeline', summary: '选中媒体段', params: '{ id: string | null }' },
  { name: 'timeline.media.removeSelected', host: 'renderer', group: 'timeline', summary: '删除当前选中的段', params: '{}' },
  { name: 'timeline.media.removeAt', host: 'renderer', group: 'timeline', summary: '删除播放头处最上层目标段', params: '{ at: number }' },
  { name: 'timeline.compact', host: 'renderer', group: 'timeline', summary: '媒体轨从左到右紧贴排列', params: '{}' },

  // ---------------------------------------------------------------- media clip effects
  { name: 'clip.video', host: 'renderer', group: 'clip', summary: '媒体段画面变换/调色（增量）', params: '{ id: string, patch: object }' },
  { name: 'clip.video.reset', host: 'renderer', group: 'clip', summary: '媒体段画面处理回默认', params: '{ id: string }' },
  { name: 'clip.stab', host: 'renderer', group: 'clip', summary: '媒体段防抖参数（增量）', params: '{ id: string, patch: object }' },
  { name: 'clip.audio', host: 'renderer', group: 'clip', summary: '媒体段原声音量/渐变（增量）', params: '{ id: string, patch: object }' },
  { name: 'clip.speed', host: 'renderer', group: 'clip', summary: '媒体段变速', params: '{ id: string, patch: object }' },
  { name: 'clip.transition', host: 'renderer', group: 'clip', summary: '设置/移除入场转场', params: '{ id: string, transition: object | null }' },

  // ---------------------------------------------------------------- audio timeline
  { name: 'timeline.audio.insert', host: 'renderer', group: 'timeline', summary: '把音频素材放到音频轨', params: '{ mediaId: string, at: number, duration?: number, sourceIn?: number, trackId?: string }' },
  { name: 'timeline.audio.move', host: 'renderer', group: 'timeline', summary: '平移音频段', params: '{ id: string, at: number, trackId?: string }' },
  { name: 'timeline.audio.trim', host: 'renderer', group: 'timeline', summary: '裁剪音频段', params: '{ id: string, start?: number, end?: number }' },
  { name: 'timeline.audio.remove', host: 'renderer', group: 'timeline', summary: '删除音频段', params: '{ id: string }' },
  { name: 'timeline.audio.split', host: 'renderer', group: 'timeline', summary: '拆分音频段', params: '{ at: number, id?: string }' },
  { name: 'timeline.audio.select', host: 'renderer', group: 'timeline', summary: '选中音频段', params: '{ id: string | null }' },
  { name: 'audio.fx', host: 'renderer', group: 'audio', summary: '音频段音量/渐变（增量）', params: '{ id: string, patch: object }' },
  { name: 'audio.speed', host: 'renderer', group: 'audio', summary: '音频段变速', params: '{ id: string, patch: object }' },
  { name: 'audio.role', host: 'renderer', group: 'audio', summary: '音频段角色（voice/bgm）', params: '{ id: string, role: "voice"|"bgm" }' },
  { name: 'audio.ducking', host: 'renderer', group: 'audio', summary: 'BGM 自动压低档位', params: '{ id: string, level?: string }' },
  { name: 'audio.reset', host: 'renderer', group: 'audio', summary: '音频段处理回默认', params: '{ id: string }' },

  // ---------------------------------------------------------------- tracks
  { name: 'track.addMedia', host: 'renderer', group: 'track', summary: '新增媒体轨', params: '{}' },
  { name: 'track.addAudio', host: 'renderer', group: 'track', summary: '新增音频轨', params: '{}' },
  { name: 'track.removeMedia', host: 'renderer', group: 'track', summary: '删除媒体轨（连同片段）', params: '{ id: string }' },
  { name: 'track.removeAudio', host: 'renderer', group: 'track', summary: '删除音频轨（连同片段）', params: '{ id: string }' },
  { name: 'track.moveMedia', host: 'renderer', group: 'track', summary: '调整媒体轨层级', params: '{ id: string, toIndex: number }' },
  { name: 'track.moveAudio', host: 'renderer', group: 'track', summary: '调整音频轨层级', params: '{ id: string, toIndex: number }' },
  { name: 'track.rename', host: 'renderer', group: 'track', summary: '重命名轨道', params: '{ id: string, name: string }' },
  { name: 'track.mute', host: 'renderer', group: 'track', summary: '轨道静音开关', params: '{ id: string, muted: boolean }' },
  { name: 'track.hidden', host: 'renderer', group: 'track', summary: '轨道隐藏开关', params: '{ id: string, hidden: boolean }' },
  { name: 'track.locked', host: 'renderer', group: 'track', summary: '轨道锁定开关', params: '{ id: string, locked: boolean }' },
  { name: 'track.select', host: 'renderer', group: 'track', summary: '选中轨道', params: '{ id: string | null }' },

  // ---------------------------------------------------------------- export
  { name: 'export.start', host: 'renderer', group: 'export', summary: '发起导出任务（立即返回 jobId）', params: '{ kind: "overlayMp4"|"transparentMov"|"pngSequence", outputDir: string, fileName: string, canvas?: object, quality?: "high"|"standard"|"small", codec?: "prores4444"|"qtrle", frameDelivery?: "pipe"|"pngSequence", pipeTransport?: "raw"|"png", directPipe?: boolean }', longRunning: true },
  { name: 'export.cover', host: 'renderer', group: 'export', summary: '导出当前帧封面 PNG', params: '{ outputDir: string, canvas?: object, atSec?: number }', longRunning: true },
  { name: 'export.status', host: 'main', group: 'export', summary: '查询任务进度/结果', params: '{ jobId: string }' },
  { name: 'export.jobs', host: 'main', group: 'export', summary: '列出本次会话的任务', params: '{}' },
  { name: 'export.cancel', host: 'main', group: 'export', summary: '取消导出任务', params: '{ jobId: string }' },
  { name: 'export.estimate', host: 'main', group: 'export', summary: '预估输出体积与磁盘是否充足', params: '{ width: number, height: number, fps: { num: number, den: number }, frames: number, outputDir: string }' },

  // ---------------------------------------------------------------- ui
  { name: 'ui.set', host: 'renderer', group: 'ui', summary: '切换视图/左侧 Tab/导出范围', params: '{ view?: "launcher"|"editor"|"settings", leftTab?: "media"|"wrap"|"export"|"progress", exportScope?: "timeline"|"selected" }' }
] as const

export const CLI_COMMAND_NAMES: readonly string[] = CLI_COMMANDS.map((command) => command.name)

export function findCliCommand(name: string): CliCommandSpec | undefined {
  return CLI_COMMANDS.find((command) => command.name === name)
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const CLI_ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  BAD_PARAMS: 'BAD_PARAMS',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'NOT_FOUND',
  GATE_BLOCKED: 'GATE_BLOCKED',
  MEDIA_PROBE_FAILED: 'MEDIA_PROBE_FAILED',
  RENDERER_UNAVAILABLE: 'RENDERER_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  EXPORT_FAILED: 'EXPORT_FAILED',
  INTERNAL: 'INTERNAL'
} as const

export type CliErrorCode = (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES]

/** 业务错误（跨 IPC 时由路由层序列化成 CliErrorInfo）。 */
export class CliCommandError extends Error {
  readonly code: string
  readonly detail: string | undefined

  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'CliCommandError'
    this.code = code
    this.detail = detail
  }
}

export function toCliErrorInfo(error: unknown): CliErrorInfo {
  if (error instanceof CliCommandError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {})
    }
  }
  if (error instanceof Error) {
    return {
      code: CLI_ERROR_CODES.INTERNAL,
      message: error.message,
      ...(error.stack && error.stack !== error.message ? { detail: error.stack.slice(0, 8000) } : {})
    }
  }
  return { code: CLI_ERROR_CODES.INTERNAL, message: String(error) }
}

// ---------------------------------------------------------------------------
// 参数读取（宽松但类型安全；渲染侧路由与主进程服务共用）
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function requireString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `缺少字符串参数：${key}`)
  return value
}

export function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function requireNumber(params: Record<string, unknown>, key: string): number {
  const value = optionalNumber(params, key)
  if (value === undefined) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `缺少数字参数：${key}`)
  return value
}

export function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}

export function requireBoolean(params: Record<string, unknown>, key: string): boolean {
  const value = optionalBoolean(params, key)
  if (value === undefined) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `缺少布尔参数：${key}`)
  return value
}

export function optionalRecord(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return asRecord(params[key]) ?? undefined
}

export function requireRecord(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = asRecord(params[key])
  if (!value) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `缺少对象参数：${key}`)
  return value
}

export function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

export function requireStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = optionalStringArray(params, key)
  if (value === undefined) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `缺少字符串数组参数：${key}`)
  return value
}

/** 枚举夹取：非法值直接抛 BAD_PARAMS，不静默落回默认。 */
export function requireEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = optionalString(params, key)
  if (value === undefined) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `缺少枚举参数：${key}`)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CliCommandError(
      CLI_ERROR_CODES.BAD_PARAMS,
      `参数 ${key} 非法：${value}（可选：${allowed.join(' / ')}）`
    )
  }
  return value as T
}

export function optionalEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = optionalString(params, key)
  if (value === undefined) return undefined
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}
