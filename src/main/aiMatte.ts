import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app, type BrowserWindow } from 'electron'
import { fpsToArg, fpsRatio } from '../shared/fps'
import type { Fps, JobResult } from '../shared/types'
import { spawnJob, terminateJob } from './procRegistry'
import { writeWithBackpressure } from './export/framePump'
import { emitProgress, emitResult, toProgress } from './export/jobs'
import type { JobState } from './export/jobs'
import { FFmpegExitError, awaitChildExit } from './export/transparentMov'
import { resolveFfmpegBinaries } from './paths'
import { log } from './log'
import { inferMatteKind } from '../shared/ffmpegArgs'

/**
 * M8-P1：AI 人像抠像（生成灰度 matte 视频）。
 *
 * 链路：FFmpeg 解码片段源窗口 → 逐帧 ONNX 推理（Selfie Segmenter 256²）→ alpha 帧
 * 写成 gray rawvideo 喂 FFmpeg 编码成 FFV1 matte（userData/matte/<cacheKey>.mkv）→
 * 渲染侧把路径写进 `MediaClip.mattePath`（matteKind='video'），导出直接复用 M8-P0 段链。
 *
 * 设计纪律：
 * - 原生依赖 onnxruntime-node 是**可选加载**：DLL 缺失/绑定加载失败都只返回可读原因，
 *   UI/CLI 显示「AI 运行时未安装」，绝不崩溃、绝不静默退回别的算法。
 * - 推理只依赖模型输入尺寸（256²），与源分辨率无关；matte 输出尺寸独立（长边 512，偶数）。
 * - 缓存键含源指纹（路径/大小/mtime）+ 源区间 + fps + 模型 sha256 + matte 尺寸，命中不启推理。
 * - 进度/取消复用现有 job 事件与 `export.cancel` 入口（jobId 前缀 `matte-`）。
 */

export const MATTE_MODEL_FILE = 'selfie_segmenter.onnx'
/** 模型输入边长（MediaPipe Selfie Segmenter 固定 256×256）。 */
export const MATTE_INPUT_SIZE = 256
/** matte 输出长边（导出段链会再缩放到画布；512 足够人像边缘）。 */
export const MATTE_LONG_EDGE = 512
/** jobId 前缀（与 stab-/proxy- 同一套 export.cancel 路由）。 */
export const MATTE_JOB_PREFIX = 'matte-'

/** 可读错误（UI/CLI 直接展示 message；code 供测试/自动化断言）。 */
export class MatteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// 运行时可选加载（onnxruntime-node 是 optionalDependency）
// ---------------------------------------------------------------------------

interface OrtTensor {
  data: Float32Array
  dims: number[]
}
interface OrtSession {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
}
interface OrtModule {
  InferenceSession: { create(modelPath: string): Promise<OrtSession> }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor
}
export type RuntimeLoadResult = { ok: true; ort: OrtModule } | { ok: false; reason: string }

/** 默认加载器：require 原生模块（DLL 缺失/ABI 不匹配都在这里变成可读原因）。 */
export function loadOnnxRuntime(): RuntimeLoadResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ort = require('onnxruntime-node') as OrtModule
    if (!ort?.InferenceSession || !ort?.Tensor) {
      return { ok: false, reason: 'onnxruntime-node 模块缺少 InferenceSession/Tensor' }
    }
    return { ok: true, ort }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: `AI 运行时未安装或加载失败（onnxruntime-node）：${reason}。请重新安装完整包或执行 npm install onnxruntime-node`
    }
  }
}

export interface MatteDetector {
  detect(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array>
}

export interface DetectContext {
  modelPath: string
  runtimeLoader?: () => RuntimeLoadResult
}

/** 模型缺失/不可读时的可读错误。 */
async function assertModelReadable(modelPath: string): Promise<void> {
  const stat = await fs.stat(modelPath).catch(() => null)
  if (!stat?.isFile() || stat.size === 0) {
    throw new MatteError(
      'AI_MODEL_MISSING',
      `AI matte 模型缺失：${modelPath}（请执行 npm run fetch:matte:model，或重新安装完整包）`
    )
  }
}

/**
 * 创建可注入的 detector（测试可传假实现/假运行时，不需要下载模型）。
 * 真实推理：RGBA → 256² 双线性缩放 → RGB/255 NCHW float32 → session.run → alpha 256²
 * → 双线性放回源帧尺寸（灰度 0..255）。
 */
export async function createMatteDetector(context: DetectContext): Promise<MatteDetector> {
  const loaded = (context.runtimeLoader ?? loadOnnxRuntime)()
  if (!loaded.ok) throw new MatteError('AI_RUNTIME_MISSING', loaded.reason)
  const ort = loaded.ort
  await assertModelReadable(context.modelPath)
  let session: OrtSession
  try {
    session = await ort.InferenceSession.create(context.modelPath)
  } catch (error) {
    throw new MatteError(
      'AI_MODEL_LOAD_FAILED',
      `AI matte 模型加载失败：${error instanceof Error ? error.message : String(error)}`
    )
  }
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  if (!inputName || !outputName) {
    throw new MatteError('AI_MODEL_LOAD_FAILED', 'AI matte 模型没有可用的输入/输出张量')
  }
  return {
    async detect(rgba, width, height) {
      const scaled = resizeRgba(rgba, width, height, MATTE_INPUT_SIZE, MATTE_INPUT_SIZE)
      const tensor = new ort.Tensor('float32', rgbaToNchwF32(scaled), [
        1,
        3,
        MATTE_INPUT_SIZE,
        MATTE_INPUT_SIZE
      ])
      const outputs = await session.run({ [inputName]: tensor })
      const alpha = outputs[outputName]
      if (!alpha) throw new MatteError('AI_INFER_FAILED', 'AI matte 推理没有输出 alpha')
      return alphaPlaneToGray(alpha.data, MATTE_INPUT_SIZE, MATTE_INPUT_SIZE, width, height)
    }
  }
}

// ---------------------------------------------------------------------------
// 纯函数（预处理/后处理/尺寸/缓存键）
// ---------------------------------------------------------------------------

/** matte 输出尺寸：长边 = MATTE_LONG_EDGE，保持宽高比，宽高都取偶数。 */
export function matteSizeFor(
  sourceWidth: number,
  sourceHeight: number,
  longEdge = MATTE_LONG_EDGE
): { width: number; height: number } {
  const w = Math.max(2, Math.round(sourceWidth))
  const h = Math.max(2, Math.round(sourceHeight))
  const edge = Math.max(64, Math.round(longEdge))
  const factor = edge / Math.max(w, h)
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)
  return { width: even(w * factor), height: even(h * factor) }
}

/** RGBA 双线性缩放（返回同格式 RGBA；alpha 一并缩放，供测试/预览用）。 */
export function resizeRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return new Uint8Array(src)
  const out = new Uint8Array(dstWidth * dstHeight * 4)
  const sx = srcWidth / dstWidth
  const sy = srcHeight / dstHeight
  for (let y = 0; y < dstHeight; y += 1) {
    const fy = Math.min(srcHeight - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(srcHeight - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dstWidth; x += 1) {
      const fx = Math.min(srcWidth - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(srcWidth - 1, x0 + 1)
      const wx = fx - x0
      const o = (y * dstWidth + x) * 4
      for (let c = 0; c < 4; c += 1) {
        const p00 = src[(y0 * srcWidth + x0) * 4 + c] ?? 0
        const p10 = src[(y0 * srcWidth + x1) * 4 + c] ?? 0
        const p01 = src[(y1 * srcWidth + x0) * 4 + c] ?? 0
        const p11 = src[(y1 * srcWidth + x1) * 4 + c] ?? 0
        const top = p00 + (p10 - p00) * wx
        const bottom = p01 + (p11 - p01) * wx
        out[o + c] = Math.round(top + (bottom - top) * wy)
      }
    }
  }
  return out
}

/** RGBA（8bit）→ RGB/255 的 NCHW float32（模型输入 order: 1×3×H×W）。 */
export function rgbaToNchwF32(rgba: Uint8Array, size = MATTE_INPUT_SIZE): Float32Array {
  const plane = size * size
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i += 1) {
    out[i] = (rgba[i * 4] ?? 0) / 255
    out[plane + i] = (rgba[i * 4 + 1] ?? 0) / 255
    out[2 * plane + i] = (rgba[i * 4 + 2] ?? 0) / 255
  }
  return out
}

/** 模型 alpha 平面（0..1）→ 目标尺寸灰度（0..255，双线性）。 */
export function alphaPlaneToGray(
  alpha: ArrayLike<number>,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  const out = new Uint8Array(dstWidth * dstHeight)
  const sx = srcWidth / dstWidth
  const sy = srcHeight / dstHeight
  const at = (x: number, y: number): number => {
    const value = alpha[y * srcWidth + x] ?? 0
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  }
  for (let y = 0; y < dstHeight; y += 1) {
    const fy = Math.min(srcHeight - 1, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(srcHeight - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dstWidth; x += 1) {
      const fx = Math.min(srcWidth - 1, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(srcWidth - 1, x0 + 1)
      const wx = fx - x0
      const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * wx
      const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * wx
      out[y * dstWidth + x] = Math.round(Math.min(1, Math.max(0, top + (bottom - top) * wy)) * 255)
    }
  }
  return out
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export interface MatteCacheKeyInput {
  sourcePath: string
  sourceSize: number
  sourceMtimeMs: number
  sourceInSec: number
  sourceOutSec: number
  fps: Fps
  modelSha256: string
  width: number
  height: number
}

/** 缓存键：源指纹 + 源区间 + fps + 模型 sha + matte 尺寸（任一变化都换新缓存）。 */
export function matteCacheKey(input: MatteCacheKeyInput): string {
  return sha256Hex(
    [
      input.sourcePath,
      String(input.sourceSize),
      String(Math.round(input.sourceMtimeMs)),
      input.sourceInSec.toFixed(6),
      input.sourceOutSec.toFixed(6),
      fpsToArg(input.fps),
      input.modelSha256,
      `${input.width}x${input.height}`
    ].join('|')
  )
}

/** matte 缓存目录：userData/matte（与 proxy / stab-preview 同级惯例）。 */
export function matteCacheDir(): string {
  return path.join(app.getPath('userData'), 'matte')
}

export function matteCachePath(key: string): string {
  return path.join(matteCacheDir(), `${key}.mkv`)
}

/** 模型路径：打包 → resources/models/matte；开发 → 仓库 resources/models/matte。
 *  `SOCUT_MATTE_MODEL_PATH` 是测试/离线部署的显式覆盖（不参与正常路径推断）。 */
export function resolveMatteModelPath(): string {
  const override = process.env.SOCUT_MATTE_MODEL_PATH
  if (override && override.trim().length > 0) return override
  const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
  return path.join(root, 'models', 'matte', MATTE_MODEL_FILE)
}

// ---------------------------------------------------------------------------
// argv（AI matte 只在本模块内拼，避免污染已冻结的 ffmpegArgs.ts）
// ---------------------------------------------------------------------------

export function buildMatteDecodeArgs(input: {
  sourcePath: string
  sourceInSec: number
  sourceOutSec: number
  fps: Fps
  width: number
  height: number
}): string[] {
  const duration = Math.max(0.01, input.sourceOutSec - input.sourceInSec)
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    input.sourceInSec.toFixed(6),
    '-t',
    duration.toFixed(6),
    '-i',
    input.sourcePath,
    '-an',
    '-vf',
    `fps=${fpsToArg(input.fps)},scale=${input.width}:${input.height}:flags=bicubic`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1'
  ]
}

export function buildMatteEncodeArgs(input: {
  outputPath: string
  width: number
  height: number
  fps: Fps
}): string[] {
  return [
    '-hide_banner',
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-s',
    `${input.width}x${input.height}`,
    '-r',
    fpsToArg(input.fps),
    '-i',
    'pipe:0',
    '-c:v',
    'ffv1',
    '-pix_fmt',
    'gray',
    input.outputPath
  ]
}

// ---------------------------------------------------------------------------
// 任务编排（进度/取消复用 export job 事件；jobId 前缀 matte-）
// ---------------------------------------------------------------------------

export interface AiMatteRequest {
  clipId: string
  sourcePath: string
  sourceInSec: number
  sourceOutSec: number
  fps: Fps
  sourceWidth: number
  sourceHeight: number
}

export interface AiMatteJobResult {
  status: 'queued' | 'cached'
  jobId: string
  /** 命中缓存时直接可用；排队时为 null（完成后经 jobResult 的 outputs[0] 回传） */
  path: string | null
}

export interface AiMatteRuntimeStatus {
  ok: boolean
  reason?: string
}
export interface AiMatteModelStatus {
  ok: boolean
  path: string
  sizeBytes?: number
  sha256?: string
  reason?: string
}
export interface AiMatteStatusResult {
  runtime: AiMatteRuntimeStatus
  model: AiMatteModelStatus
  ready: boolean
}

const registry = new Map<string, JobState>()
const modelShaCache = new Map<string, string>()

/**
 * 测试注入点：假 detector（不加载 ORT/模型）。生产代码绝不设置；
 * `run()` 优先用它，使「真 FFmpeg 解码 + 假 alpha + 真编码/缓存/进度」能在 verify 里跑通。
 */
let detectorFactory: ((context: DetectContext) => Promise<MatteDetector>) | null = null
export function setMatteDetectorFactoryForTests(
  factory: ((context: DetectContext) => Promise<MatteDetector>) | null
): void {
  detectorFactory = factory
}

/** 测试/自动化等待 job 终态（UI 走 job 事件；CLI 用 jobEvents.waitForResult）。 */
const resultWaiters = new Map<string, (result: JobResult) => void>()
export function waitForAiMatteJob(jobId: string): Promise<JobResult> {
  return new Promise((resolve) => {
    resultWaiters.set(jobId, resolve)
  })
}
function settleResult(result: JobResult): void {
  const waiter = resultWaiters.get(result.jobId)
  if (waiter) {
    resultWaiters.delete(result.jobId)
    waiter(result)
  }
}

async function modelSha256(modelPath: string): Promise<string> {
  const cached = modelShaCache.get(modelPath)
  if (cached) return cached
  const bytes = await fs.readFile(modelPath)
  const sha = sha256Hex(bytes)
  modelShaCache.set(modelPath, sha)
  return sha
}

/** 运行时/模型体检（UI 按钮可用性；失败不抛错）。 */
export async function aiMatteStatus(): Promise<AiMatteStatusResult> {
  const runtime = loadOnnxRuntime()
  const modelPath = resolveMatteModelPath()
  let model: AiMatteModelStatus = { ok: false, path: modelPath }
  try {
    const stat = await fs.stat(modelPath)
    if (stat.isFile() && stat.size > 0) {
      model = {
        ok: true,
        path: modelPath,
        sizeBytes: stat.size,
        sha256: await modelSha256(modelPath)
      }
    } else {
      model = { ...model, reason: '模型文件为空' }
    }
  } catch {
    model = { ...model, reason: '模型文件缺失（npm run fetch:matte:model）' }
  }
  return {
    runtime: runtime.ok ? { ok: true } : { ok: false, reason: runtime.reason },
    model,
    ready: runtime.ok && model.ok
  }
}

export async function cancelAiMatte(jobId: string): Promise<void> {
  const state = registry.get(jobId)
  if (!state) return
  state.cancelRequested = true
  await terminateJob(jobId)
  await terminateJob(`${jobId}-decode`)
}

function toErrorInfo(error: unknown): JobState['error'] {
  const anyError = error as { message?: string; code?: string; stderrTail?: string; argv?: string[] }
  const code =
    error instanceof MatteError
      ? error.code
      : typeof anyError?.code === 'string'
        ? anyError.code
        : 'AI_MATTE_FAILED'
  return {
    code,
    message: anyError?.message ?? String(error),
    stderrTail: anyError?.stderrTail ?? '',
    ...(anyError?.argv ? { argv: anyError.argv } : {}),
    fatal: true
  }
}

/**
 * 生成（或命中缓存）某个片段的 AI matte。
 * 返回 jobId 后由渲染侧 `waitForResult(jobId)` 等完成，再 `setMediaClipMatte` 落库。
 */
export async function applyAiMatte(
  request: AiMatteRequest,
  window: BrowserWindow | null
): Promise<AiMatteJobResult> {
  if (!(request.sourceOutSec > request.sourceInSec)) {
    throw new MatteError('BAD_REQUEST', 'AI 抠像区间无效（出点必须大于入点）')
  }
  const sourceStat = await fs.stat(request.sourcePath).catch(() => null)
  if (!sourceStat?.isFile() || sourceStat.size === 0) {
    throw new MatteError('MEDIA_NOT_FOUND', `AI 抠像素材不可用：${request.sourcePath}`)
  }
  if (inferMatteKind(request.sourcePath) !== 'video') {
    throw new MatteError('MEDIA_NOT_VIDEO', `AI 抠像只支持视频素材：${request.sourcePath}`)
  }
  const modelPath = resolveMatteModelPath()
  const modelSha = await modelSha256(modelPath).catch(() => null)
  if (!modelSha) {
    throw new MatteError(
      'AI_MODEL_MISSING',
      `AI matte 模型缺失：${modelPath}（请执行 npm run fetch:matte:model）`
    )
  }
  const size = matteSizeFor(request.sourceWidth, request.sourceHeight)
  const key = matteCacheKey({
    sourcePath: request.sourcePath,
    sourceSize: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceInSec: request.sourceInSec,
    sourceOutSec: request.sourceOutSec,
    fps: request.fps,
    modelSha256: modelSha,
    width: size.width,
    height: size.height
  })
  const outputPath = matteCachePath(key)
  const jobId = `${MATTE_JOB_PREFIX}${request.clipId}`

  // 1) 缓存命中：不启推理、不起进程
  const cached = await fs.stat(outputPath).catch(() => null)
  if (cached?.isFile() && cached.size > 0) {
    return { status: 'cached', jobId, path: outputPath }
  }
  // 2) 同片段作业已在跑：复用（与 proxy 同语义）
  if (registry.has(jobId)) {
    return { status: 'queued', jobId, path: null }
  }

  const framesTotal = Math.max(1, Math.round((request.sourceOutSec - request.sourceInSec) * fpsRatio(request.fps)))
  const state: JobState = {
    id: jobId,
    kind: 'overlayMp4',
    windowId: window?.id ?? -1,
    phase: 'queued',
    framesDone: 0,
    framesTotal,
    timeTotalSec: request.sourceOutSec - request.sourceInSec,
    outTimeUs: 0,
    bytesWritten: 0,
    startedAt: Date.now(),
    notices: [],
    cancelRequested: false,
    outputs: [outputPath]
  }
  registry.set(jobId, state)
  emitProgress(window, state)
  void run(state, request, modelPath, size, outputPath, window).catch(async (error: unknown) => {
    registry.delete(jobId)
    await fs.rm(outputPath, { force: true }).catch(() => undefined)
    state.phase = state.cancelRequested ? 'cancelled' : 'failed'
    const info = state.cancelRequested
      ? { code: 'CANCELLED', message: 'AI 抠像已取消', stderrTail: '', fatal: false }
      : toErrorInfo(error)
    state.error = info
    const result: JobResult = {
      jobId,
      ok: false,
      outputs: [],
      error: info,
      progress: toProgress(state)
    }
    emitResult(window, result)
    settleResult(result)
    await log('error', `AI 抠像失败 ${jobId}：${info?.message ?? '未知错误'}`)
  })
  return { status: 'queued', jobId, path: null }
}

async function run(
  state: JobState,
  request: AiMatteRequest,
  modelPath: string,
  size: { width: number; height: number },
  outputPath: string,
  window: BrowserWindow | null
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const binaries = await resolveFfmpegBinaries()
  if (!binaries.available) throw new MatteError('FFMPEG_MISSING', `未找到可用的 FFmpeg：${binaries.ffmpeg}`)
  state.phase = 'preparing'
  emitProgress(window, state)
  const detector = detectorFactory
    ? await detectorFactory({ modelPath })
    : await createMatteDetector({ modelPath })
  if (state.cancelRequested) throw new Error('cancelled')

  const frameBytes = size.width * size.height * 4
  const decode = spawnJob({
    jobId: `${state.id}-decode`,
    label: 'AI 抠像 · 解码',
    binary: binaries.ffmpeg,
    args: buildMatteDecodeArgs({
      sourcePath: request.sourcePath,
      sourceInSec: request.sourceInSec,
      sourceOutSec: request.sourceOutSec,
      fps: request.fps,
      width: size.width,
      height: size.height
    }),
    stdin: false
  })
  const encode = spawnJob({
    jobId: state.id,
    label: 'AI 抠像 · 编码',
    binary: binaries.ffmpeg,
    args: buildMatteEncodeArgs({ outputPath, width: size.width, height: size.height, fps: request.fps }),
    stdin: true
  })
  const watch = setInterval(() => {
    if (state.cancelRequested) {
      void terminateJob(state.id)
      void terminateJob(`${state.id}-decode`)
    }
  }, 200)
  state.phase = 'rendering'
  emitProgress(window, state)

  const stdin = encode.child.stdin
  const stdout = decode.child.stdout
  if (!stdin || !stdout) throw new Error('FFmpeg 管道不可用（decode.stdout / encode.stdin）')

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let queue = Promise.resolve()
  let frames = 0
  let bytes = 0
  const onFrame = async (frame: Uint8Array): Promise<void> => {
    if (state.cancelRequested) return
    const alpha = await detector.detect(frame, size.width, size.height)
    await writeWithBackpressure(stdin, Buffer.from(alpha))
    frames += 1
    bytes += alpha.length
    state.framesDone = frames
    state.bytesWritten = bytes
    state.outTimeUs = Math.round((frames / Math.max(1, state.framesTotal)) * (request.sourceOutSec - request.sourceInSec) * 1e6)
    emitProgress(window, state)
  }
  try {
    await new Promise<void>((resolve, reject) => {
      stdout.on('data', (chunk: Buffer) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
        while (pending.length >= frameBytes) {
          const frame = new Uint8Array(pending.subarray(0, frameBytes))
          pending = pending.subarray(frameBytes)
          queue = queue.then(() => onFrame(frame))
        }
      })
      stdout.on('error', reject)
      decode.child.once('close', () => resolve())
      encode.child.once('error', reject)
    })
    await queue
    if (state.cancelRequested) throw new Error('cancelled')
    stdin.end()
    const [decodeCode, encodeCode] = await Promise.all([
      awaitChildExit(decode, 5000),
      awaitChildExit(encode, 5000)
    ])
    if (decodeCode !== 0) throw new FFmpegExitError(decodeCode, decode.stderr.tail(2048), decode.argv)
    if (encodeCode !== 0) throw new FFmpegExitError(encodeCode, encode.stderr.tail(2048), encode.argv)
  } finally {
    clearInterval(watch)
  }
  const stat = await fs.stat(outputPath).catch(() => null)
  if (!stat?.isFile() || stat.size === 0) throw new Error(`AI matte 产物为空：${outputPath}`)
  state.framesDone = state.framesTotal
  state.phase = 'done'
  registry.delete(state.id)
  const result: JobResult = {
    jobId: state.id,
    ok: true,
    outputs: [outputPath],
    outputPath,
    progress: toProgress(state)
  }
  emitResult(window, result)
  settleResult(result)
  await log('info', `AI matte 完成：${outputPath}（${frames} 帧，${(bytes / 1024 / 1024).toFixed(1)}MB alpha）`)
}
