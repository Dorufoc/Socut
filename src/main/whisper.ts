import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildWhisperArgs,
  parseWhisperJson,
  planCuesFromSegments,
  type WhisperResult,
  type WhisperSegment
} from '../shared/whisper'

/**
 * M11：whisper.cpp sidecar 的主进程封装（进程管理 / 配置 / 进度 / 取消）。
 *
 * 离线纪律：**不下载、不联网**。二进制与模型都由安装包或用户提供：
 * - 二进制候选：`SOCUT_WHISPER_BIN` → `resources/whisper/whisper-cli(.exe)` → `main`/`whisper`；
 * - 模型候选：配置里的路径 → `userData/whisper/models/*.bin` → `resources/models/whisper/ggml-*.bin`。
 *
 * 测试可注入 `binaryArgsPrefix`（让 `binaryPath = process.execPath` + 假脚本作为 sidecar），
 * 这样进程管理、进度回调、JSON 读取、取消都能真机验证，不依赖用户机器上有没有 whisper。
 */

export class WhisperError extends Error {
  readonly code: string

  constructor(message: string, code = 'WHISPER_ERROR') {
    super(message)
    this.code = code
  }
}

export interface WhisperConfig {
  binaryPath?: string
  modelPath?: string
  language?: string
  threads?: number
}

/** 配置补丁：`null` = 清除该项（设置页「自动检测」「忘记已选」用）。 */
export interface WhisperConfigPatch {
  binaryPath?: string | null
  modelPath?: string | null
  language?: string | null
  threads?: number | null
}

export interface WhisperStatus {
  ready: boolean
  binaryPath: string | null
  modelPath: string | null
  language: string | null
  configPath: string
  candidates: {
    binaries: string[]
    models: string[]
  }
}

export interface WhisperTranscribeRequest {
  mediaPath: string
  modelPath?: string
  language?: string
  translate?: boolean
  threads?: number
  minDurationSec?: number
  onProgress?: (percent: number) => void
  /** M11：抽音阶段进度（0..99）；没有 ffprobe/时长未知时不回调 */
  onPrepareProgress?: (percent: number) => void
  signal?: AbortSignal
}

export interface WhisperTranscribeResult {
  cues: Array<{ startSec: number; endSec: number; text: string }>
  language?: string
  segments: number
  dropped: number
  binaryPath: string
  modelPath: string
}

/**
 * 随包 FFmpeg 的定位方式。
 *
 * 官方 Windows 构建的 whisper-cli **只能读 16-bit WAV**（喂 mp4 会 `failed to read audio
 * data as wav`），所以转写前必须先用 FFmpeg 抽 16k 单声道 WAV —— 这是真机验收抓到的坑。
 * 传函数是为了让主进程按需解析（FFmpeg 路径解析是异步的，且可能在设置里切换）。
 */
export type WhisperFfmpegResolver = string | (() => Promise<string | undefined>)

export interface WhisperManagerOptions {
  userDataDir: string
  resourcesDir: string
  env?: NodeJS.ProcessEnv
  /** 测试用：在二进制后追加的参数前缀（例如 `[fakeScript]` + process.execPath） */
  binaryArgsPrefix?: string[]
  /** 随包 FFmpeg；缺省时不做抽音（把原文件直接交给 whisper，非 WAV 会失败） */
  ffmpegPath?: WhisperFfmpegResolver
  /** 随包 ffprobe；抽音进度需要它读媒体时长（缺省时抽音阶段仍会报告 0% 而不动） */
  ffprobePath?: WhisperFfmpegResolver
}

function exists(file: string): Promise<boolean> {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

function exeNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`, `${base}.cmd`, base] : [base, `${base}.exe`]
}

const PROGRESS_RE = /progress\s*=\s*(\d{1,3})\s*%/gi

/**
 * 解析 FFmpeg `-progress pipe:1` 的单行键值里的输出时间（秒）。
 *
 * 真机口径：`out_time_us` 与 `out_time_ms` **都是微秒**（FFmpeg 历史命名遗留），
 * 另有 `out_time=HH:MM:SS.ffffff` 可读形式。抽音进度用这个时间 / 媒体总时长换算百分比。
 */
export function parseFfmpegOutTimeSeconds(line: string): number | null {
  const micros = line.match(/^out_time_(?:us|ms)=(\d+)\s*$/m)
  if (micros) {
    const value = Number(micros[1]) / 1_000_000
    return Number.isFinite(value) ? value : null
  }
  const clock = line.match(/^out_time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\s*$/m)
  if (!clock) return null
  const value = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  return Number.isFinite(value) ? value : null
}

export function createWhisperManager(options: WhisperManagerOptions) {
  const env = options.env ?? process.env
  const configPath = path.join(options.userDataDir, 'whisper.json')

  const candidateBinaries = (): string[] => {
    const list: string[] = []
    const add = (value: string | undefined): void => {
      if (value && value.length > 0 && !list.includes(value)) list.push(value)
    }
    add(env.SOCUT_WHISPER_BIN)
    const dir = path.join(options.resourcesDir, 'whisper')
    for (const name of ['whisper-cli', 'whisper', 'main']) {
      for (const file of exeNames(name)) add(path.join(dir, file))
    }
    return list
  }

  const candidateModels = async (config: WhisperConfig): Promise<string[]> => {
    const list: string[] = []
    const add = (value: string | undefined): void => {
      if (value && value.length > 0 && !list.includes(value)) list.push(value)
    }
    add(config.modelPath)
    const userModels = path.join(options.userDataDir, 'whisper', 'models')
    try {
      const entries = await fs.readdir(userModels)
      for (const entry of entries.sort()) if (entry.endsWith('.bin')) add(path.join(userModels, entry))
    } catch {
      // 目录不存在 = 没有候选
    }
    const bundled = path.join(options.resourcesDir, 'models', 'whisper')
    try {
      const entries = await fs.readdir(bundled)
      for (const entry of entries.sort()) if (entry.endsWith('.bin')) add(path.join(bundled, entry))
    } catch {
      // 同上
    }
    return list
  }

  async function readConfig(): Promise<WhisperConfig> {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
      return {
        ...(typeof parsed['binaryPath'] === 'string' ? { binaryPath: parsed['binaryPath'] } : {}),
        ...(typeof parsed['modelPath'] === 'string' ? { modelPath: parsed['modelPath'] } : {}),
        ...(typeof parsed['language'] === 'string' ? { language: parsed['language'] } : {}),
        ...(typeof parsed['threads'] === 'number' ? { threads: parsed['threads'] } : {})
      }
    } catch {
      return {}
    }
  }

  /**
   * 保存配置（增量合并）。**`null` 表示清除该项**（设置页的"自动检测/忘记已选"）：
   * `binaryPath/modelPath` 给值时必须真实存在，否则直接拒绝（离线导入不接受假路径）。
   */
  async function saveConfig(patch: WhisperConfigPatch): Promise<WhisperConfig> {
    const current = await readConfig()
    const next: WhisperConfig = { ...current }
    if (patch.binaryPath !== undefined) {
      if (patch.binaryPath === null) delete next.binaryPath
      else next.binaryPath = patch.binaryPath
    }
    if (patch.modelPath !== undefined) {
      if (patch.modelPath === null) delete next.modelPath
      else next.modelPath = patch.modelPath
    }
    if (patch.language !== undefined) {
      const language = patch.language === null ? '' : patch.language.trim()
      if (language.length === 0) delete next.language
      else next.language = language
    }
    if (patch.threads !== undefined) {
      if (patch.threads === null) delete next.threads
      else if (Number.isFinite(patch.threads) && patch.threads > 0) next.threads = Math.round(patch.threads)
    }
    if (next.binaryPath !== undefined && !(await exists(next.binaryPath))) {
      throw new WhisperError(`whisper 可执行文件不存在：${next.binaryPath}`, 'WHISPER_BINARY_MISSING')
    }
    if (next.modelPath !== undefined && !(await exists(next.modelPath))) {
      throw new WhisperError(`whisper 模型文件不存在：${next.modelPath}`, 'WHISPER_MODEL_MISSING')
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return next
  }

  async function firstExisting(paths: string[]): Promise<string | null> {
    for (const candidate of paths) if (await exists(candidate)) return candidate
    return null
  }

  async function resolveFfmpeg(): Promise<string | null> {
    const source = options.ffmpegPath
    if (!source) return null
    const resolved = typeof source === 'string' ? source : await source().catch(() => undefined)
    if (!resolved || !(await exists(resolved))) return null
    return resolved
  }

  async function resolveFfprobe(): Promise<string | null> {
    const source = options.ffprobePath
    if (!source) return null
    const resolved = typeof source === 'string' ? source : await source().catch(() => undefined)
    if (!resolved || !(await exists(resolved))) return null
    return resolved
  }

  /** 读媒体时长（秒）：ffprobe `format=duration`；读不到返回 null（抽音进度退化为不动）。 */
  async function probeDurationSec(mediaPath: string): Promise<number | null> {
    const ffprobe = await resolveFfprobe()
    if (!ffprobe) return null
    return new Promise<number | null>((resolve) => {
      const child = spawn(
        ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mediaPath],
        { windowsHide: true }
      )
      let stdout = ''
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr.on('data', () => undefined)
      child.on('error', () => resolve(null))
      child.on('close', () => {
        const value = Number.parseFloat(stdout.trim())
        resolve(Number.isFinite(value) && value > 0 ? value : null)
      })
    })
  }

  /**
   * 抽音：任意媒体 → 16kHz 单声道 s16 WAV（whisper-cli 只认这种输入）。
   * 没有 FFmpeg 可用时原样返回（fake sidecar / 用户直接给 16k wav 的场景）。
   *
   * M11：带 `-progress pipe:1`，用 `out_time_us`（微秒）/时长换算抽音百分比，
   * 让「准备音频…」阶段的长素材不再看起来卡死。
   */
  async function extractAudio(
    mediaPath: string,
    dir: string,
    onPrepareProgress?: (percent: number) => void
  ): Promise<string> {
    const ffmpeg = await resolveFfmpeg()
    if (!ffmpeg) return mediaPath
    const target = path.join(dir, 'audio.wav')
    const duration = onPrepareProgress ? await probeDurationSec(mediaPath) : null
    let reported = -1
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostats',
          '-i',
          mediaPath,
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-progress',
          'pipe:1',
          target
        ],
        { windowsHide: true }
      )
      let stderrTail = ''
      child.stderr.on('data', (chunk) => {
        stderrTail = `${stderrTail}${String(chunk)}`.slice(-800)
      })
      child.stdout.on('data', (chunk) => {
        if (!duration || !onPrepareProgress) return
        for (const line of String(chunk).split(/\r?\n/)) {
          const seconds = parseFfmpegOutTimeSeconds(line.trim())
          if (seconds === null) continue
          // 抽音阶段最多报 99%：100% 留给转写阶段，避免进度条先满后回退
          const percent = Math.min(99, Math.max(0, Math.round((seconds / duration) * 100)))
          if (percent !== reported) {
            reported = percent
            onPrepareProgress(percent)
          }
        }
      })
      child.on('error', (error) => {
        reject(new WhisperError(`ffmpeg 启动失败：${String(error)}`, 'WHISPER_AUDIO_FAILED'))
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else {
          reject(
            new WhisperError(
              `抽音失败（ffmpeg 退出码 ${code}，媒体有音轨吗？）：${stderrTail.slice(-300)}`,
              'WHISPER_AUDIO_FAILED'
            )
          )
        }
      })
    })
    return target
  }

  async function status(): Promise<WhisperStatus> {
    const config = await readConfig()
    const binaries = candidateBinaries()
    const models = await candidateModels(config)
    const binaryPath = await firstExisting(binaries)
    const modelPath = await firstExisting(models)
    return {
      ready: binaryPath !== null && modelPath !== null,
      binaryPath,
      modelPath,
      language: config.language ?? null,
      configPath,
      candidates: { binaries, models }
    }
  }

  async function transcribe(request: WhisperTranscribeRequest): Promise<WhisperTranscribeResult> {
    const statusNow = await status()
    const binaryPath = statusNow.binaryPath
    if (!binaryPath) {
      throw new WhisperError(
        `未找到 whisper.cpp 可执行文件（候选：${statusNow.candidates.binaries.join(' / ')}；可用 SOCUT_WHISPER_BIN 指定）`,
        'WHISPER_BINARY_MISSING'
      )
    }
    const modelPath = request.modelPath ?? statusNow.modelPath
    if (!modelPath || !(await exists(modelPath))) {
      throw new WhisperError('未找到 whisper 模型（ggml-*.bin）；请用 whisper.config 指定 modelPath', 'WHISPER_MODEL_MISSING')
    }
    if (!(await exists(request.mediaPath))) {
      throw new WhisperError(`媒体文件不存在：${request.mediaPath}`, 'WHISPER_MEDIA_MISSING')
    }

    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-whisper-'))
    const outputBase = path.join(outputDir, 'transcript')

    try {
      // whisper-cli 只读 16k 单声道 WAV，所以先抽音再转写（没有 FFmpeg 时退回原文件）
      const inputPath = await extractAudio(request.mediaPath, outputDir, request.onPrepareProgress)
      const args = [
        ...(options.binaryArgsPrefix ?? []),
        ...buildWhisperArgs({
          modelPath,
          mediaPath: inputPath,
          ...(request.language ? { language: request.language } : {}),
          ...(request.translate === true ? { translate: true } : {}),
          ...(request.threads !== undefined ? { threads: request.threads } : {}),
          outputBase
        })
      ]
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binaryPath, args, { windowsHide: true })
        let stderrTail = ''
        const onAbort = (): void => {
          child.kill()
          reject(new WhisperError('转写已取消', 'CANCELLED'))
        }
        if (request.signal?.aborted) {
          child.kill()
          reject(new WhisperError('转写已取消', 'CANCELLED'))
          return
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        child.stderr.on('data', (chunk) => {
          const text = String(chunk)
          stderrTail = `${stderrTail}${text}`.slice(-2000)
          // 一次 chunk 里可能有多条进度（如 40% → 100%），必须取**最后一条**
          const matches = [...stderrTail.matchAll(PROGRESS_RE)]
          const last = matches[matches.length - 1]
          if (last) request.onProgress?.(Math.min(100, Number(last[1])))
        })
        // stdout 也读掉，避免管道填满（whisper 正常把结果写文件，stdout 多为日志）
        child.stdout.on('data', () => undefined)
        child.on('error', (error) => {
          request.signal?.removeEventListener('abort', onAbort)
          reject(new WhisperError(`whisper 进程启动失败：${String(error)}`, 'WHISPER_SPAWN_FAILED'))
        })
        child.on('close', (code) => {
          request.signal?.removeEventListener('abort', onAbort)
          if (code === 0) resolve()
          else reject(new WhisperError(`whisper 退出码 ${code}：${stderrTail.slice(-400)}`, 'WHISPER_FAILED'))
        })
      })

      const jsonPath = `${outputBase}.json`
      let raw: string
      try {
        raw = await fs.readFile(jsonPath, 'utf8')
      } catch {
        throw new WhisperError('whisper 没有产出 JSON（-oj 输出缺失）', 'WHISPER_NO_OUTPUT')
      }
      const result: WhisperResult = parseWhisperJson(raw)
      const cues = planCuesFromSegments(result.segments, {
        ...(request.minDurationSec !== undefined ? { minDurationSec: request.minDurationSec } : {})
      })
      return {
        cues,
        ...(result.language ? { language: result.language } : {}),
        segments: result.segments.length,
        dropped: result.dropped,
        binaryPath,
        modelPath
      }
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** 供单元测试与诊断：清掉配置（相当于"忘记已选模型"）。 */
  async function resetConfig(): Promise<void> {
    await fs.rm(configPath, { force: true }).catch(() => undefined)
  }

  return { status, saveConfig, readConfig, transcribe, resetConfig, configPath, candidateBinaries, candidateModels }
}

export type WhisperManager = ReturnType<typeof createWhisperManager>

export interface FakeWhisperOptions {
  /** 测试用：生成一个会写 JSON + 打进度到 stderr 的 sidecar 脚本，返回路径。 */
  dir: string
}

/** 测试辅助：写一个假 sidecar（Node 脚本），返回脚本路径与其 JSON 内容构造器。 */
export async function writeFakeWhisperSidecar(options: FakeWhisperOptions): Promise<{ script: string; segments: WhisperSegment[] }> {
  const segments: WhisperSegment[] = [
    { startSec: 0.2, endSec: 2.4, text: '今日头条' },
    { startSec: 2.6, endSec: 4.8, text: '省发展改革委发布' }
  ]
  const script = path.join(options.dir, `fake-whisper-${randomUUID()}.mjs`)
  // 两条进度之间**留 80ms**：同一 chunk 里到两条时主进程只会报最后一条（真实行为），
  // 不留间隔的话断言 `progress` 含 40 会随机失败（曾把 verify 弄成"1 failed"的偶发）。
  // offsets 用**数字毫秒**，与真 whisper-cli 1.8.2 的输出形态一致。
  const body = `import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const base = args[args.indexOf('-of') + 1]
process.stderr.write('whisper_print_progress_callback: progress = 40%\\n')
setTimeout(() => {
  process.stderr.write('whisper_print_progress_callback: progress = 100%\\n')
  writeFileSync(base + '.json', JSON.stringify({
    result: { language: 'zh' },
    transcription: ${JSON.stringify(segments)}.map((segment) => ({
      timestamps: { from: '', to: '' },
      offsets: { from: segment.startSec * 1000, to: segment.endSec * 1000 },
      text: ' ' + segment.text
    }))
  }))
}, 80)
`
  await fs.writeFile(script, body, 'utf8')
  return { script, segments }
}