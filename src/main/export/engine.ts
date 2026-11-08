import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { buildSizeEstimate, diskPrecheck } from '../../shared/sizeEstimate'
import { frameIntervalSec, frameTimeSec } from '../../shared/fps'
import { TEXT } from '../../shared/i18n'
import type {
  ExportRequest,
  JobErrorInfo,
  JobProgress,
  JobResult,
  SizeEstimate,
  TransparentCodec
} from '../../shared/types'
import type { EstimateInput } from '../../shared/api'
import { resolveFfmpegBinaries } from '../paths'
import { resolveExportEncoder } from '../gpu'
import { createWorkspace, diskFreeBytes, disposeWorkspace } from '../tempWorkspace'
import type { Workspace } from '../tempWorkspace'
import { terminateJob } from '../procRegistry'
import { log } from '../log'
import { closeAllFrameChannels, openFrameChannel } from './frameChannel'
import type { FrameChannelHandle } from './frameChannel'
import { JobRegistry, emitProgress, emitResult, toProgress } from './jobs'
import type { JobState } from './jobs'
import { runTransparentMov } from './transparentMov'
import type { TransparentRunCtx } from './transparentMov'
import { encodePngToMov, writePngSequence } from './pngSequence'
import { runOverlayMp4 } from './overlayMp4'
import { watermarkInputOf } from '../../shared/ffmpegArgs'
import { verifyOverlayMp4, verifyTransparentMov } from './verify'

/** 导出任务编排（规格 §4.2 主进程职责：任务队列、取消、临时目录清理、进度回传）。 */

const PROGRESS_THROTTLE_MS = 100
/** 控制面查询用的历史上限；超出按插入顺序淘汰最旧的一条。 */
const JOB_SNAPSHOT_LIMIT = 50

interface Pending {
  request: ExportRequest
  windowId: number
}

export interface EngineJobSnapshot {
  progress: JobProgress
  result: JobResult | null
}

export class ExportEngine {
  private readonly registry = new JobRegistry()
  private readonly queue: Pending[] = []
  private runningId: string | null = null
  private readonly channels = new Map<string, FrameChannelHandle>()
  /** CLI/控制面查询用：最近一次进度快照（任务结束后 registry 会移除，快照仍保留）。 */
  private readonly snapshots = new Map<string, JobProgress>()
  /** 终态结果（成功/失败/取消），供 `export.status` 在完成后仍能查到原因。 */
  private readonly results = new Map<string, JobResult>()

  async estimate(input: EstimateInput): Promise<SizeEstimate> {
    const freeBytes = await diskFreeBytes(input.outputDir)
    return buildSizeEstimate({
      width: input.width,
      height: input.height,
      fps: input.fps,
      frames: input.frames,
      freeBytes
    })
  }

  /** 入队；并发固定为 1（渲染与编码共用 CPU/IO，提高并发只会拖慢整体）。 */
  async submit(request: ExportRequest, window: BrowserWindow): Promise<{ jobId: string }> {
    const framesTotal = Math.max(0, request.frameSpec.endFrame - request.frameSpec.startFrame)
    this.registry.create(
      request.jobId,
      request.target.kind,
      window.id,
      framesTotal,
      framesTotal * frameIntervalSec(request.frameSpec.fps)
    )
    const created = this.registry.get(request.jobId)
    if (created) this.remember(created)
    this.queue.push({ request, windowId: window.id })
    void this.drain()
    return { jobId: request.jobId }
  }

  async cancel(jobId: string): Promise<void> {
    const state = this.registry.get(jobId)
    if (!state) return
    state.cancelRequested = true
    const index = this.queue.findIndex((item) => item.request.jobId === jobId)
    if (index >= 0 && this.runningId !== jobId) {
      // 尚在排队：直接出队并结束
      const [removed] = this.queue.splice(index, 1)
      this.finalizeCancelled(removed?.request, state)
      return
    }
    this.channels.get(jobId)?.cancel('cancelled')
    await terminateJob(jobId)
  }

  activeJobs(): JobState[] {
    return this.registry.active()
  }

  /** 单个任务的最新进度 / 终态结果（未知任务返回 null）。 */
  jobStatus(jobId: string): EngineJobSnapshot | null {
    const progress = this.snapshots.get(jobId)
    const result = this.results.get(jobId) ?? null
    if (!progress && !result) return null
    return { progress: progress ?? result!.progress, result }
  }

  /** 本次进程内见过的任务（含已结束），按开始时间从旧到新。 */
  listJobs(): EngineJobSnapshot[] {
    const ids = new Set<string>([...this.snapshots.keys(), ...this.results.keys()])
    return [...ids]
      .map((id) => this.jobStatus(id))
      .filter((item): item is EngineJobSnapshot => item !== null)
  }

  /** 应用退出前调用：取消所有排队任务并断开帧通道。 */
  async shutdown(): Promise<void> {
    this.queue.length = 0
    for (const [jobId, channel] of this.channels) {
      channel.cancel('cancelled')
      channel.close()
      await terminateJob(jobId)
    }
    this.channels.clear()
    closeAllFrameChannels()
  }

  private async drain(): Promise<void> {
    if (this.runningId !== null) return
    const next = this.queue.shift()
    if (!next) return
    this.runningId = next.request.jobId
    try {
      await this.runJob(next)
    } finally {
      this.runningId = null
      void this.drain()
    }
  }

  private windowOf(id: number): BrowserWindow | null {
    return BrowserWindow.getAllWindows().find((w) => w.id === id && !w.isDestroyed()) ?? null
  }

  private async runJob(pending: Pending): Promise<void> {
    const { request } = pending
    const state = this.registry.get(request.jobId)
    if (!state) return
    const window = this.windowOf(pending.windowId)
    if (!window) {
      await this.fail(state, request, {
        code: 'NO_WINDOW',
        message: '窗口已关闭，任务取消',
        stderrTail: '',
        fatal: true
      })
      return
    }

    const binaries = await resolveFfmpegBinaries()
    if (!binaries.available) {
      await this.fail(state, request, {
        code: 'FFMPEG_MISSING',
        message: TEXT.errors.ffmpegMissing(binaries.ffmpeg),
        stderrTail: '',
        argv: [],
        fatal: true
      })
      return
    }

    const emit = this.makeTickerFor(state)
    let workspace: Workspace | null = null
    let channel: FrameChannelHandle | null = null
    /** 半成品产物：未成功结束时一律删除（计划 §9 取消语义、验收第 8 条） */
    let artifact: { path: string; kind: 'file' | 'dir' } | null = null

    try {
      state.phase = 'preparing'
      emit()
      workspace = await createWorkspace(request.jobId)
      const outputPath = await this.resolveOutputPath(request)
      artifact = {
        path: outputPath,
        kind: request.target.kind === 'pngSequence' ? 'dir' : 'file'
      }
      channel = openFrameChannel(window, request.jobId)
      this.channels.set(request.jobId, channel)

      const spec = request.frameSpec
      const framesTotal = spec.endFrame - spec.startFrame

      /**
       * 写盘前硬预检（计划 §5）：不能只靠 UI 弹窗——绕过 UI 的发起（自动化、重试）
       * 会在写满的盘上跑到一半才抛一个归因不到的 FFmpeg 错误。
       */
      const freeBytes = await diskFreeBytes(request.target.outputDir)
      const precheck = diskPrecheck({
        kind: request.target.kind,
        directPipe: request.overlay?.directPipe === true,
        width: spec.width,
        height: spec.height,
        fps: spec.fps,
        frames: framesTotal,
        freeBytes
      })
      if (!precheck.ok) {
        await log('warn', `磁盘预检拒绝任务 ${request.jobId}：${precheck.reason ?? ''}`)
        await this.fail(state, request, {
          code: 'DISK_INSUFFICIENT',
          message: precheck.reason ?? '目标磁盘空间不足',
          stderrTail: '',
          fatal: true
        })
        return
      }
      if (precheck.enforced && precheck.freeBytes === undefined) {
        state.notices.push(precheck.reason ?? '无法读取目标卷可用空间，已跳过硬预检。')
      }
      const codec: TransparentCodec = request.codec ?? 'prores4444'
      /**
       * 叠加导出的阶段一产物是**中间文件**（任务结束即删），
       * 不能跟最终 MP4 共用路径——应用内 overlay 冒烟实捕：
       * 阶段一渲染到最终输出路径，阶段二去读 overlay.mov（从未存过）而失败。
       */
      const overlayPath = path.join(workspace.dir, 'overlay.mov')
      const transparentOutput =
        request.target.kind === 'overlayMp4' ? overlayPath : outputPath
      const transparentCtx: TransparentRunCtx = {
        window,
        state,
        binaries,
        fps: spec.fps,
        width: spec.width,
        height: spec.height,
        startFrame: spec.startFrame,
        framesTotal,
        outputPath: transparentOutput,
        codec,
        frameFormat: spec.frameFormat,
        audioMastering: request.audioMastering,
        isCancelled: () => state.cancelRequested,
        onTick: emit
      }

      /**
       * v7：透明出口的音频。
       * 只给 `transparentMov`：叠加导出的阶段一是**无声中间件**，
       * 在这里带音轨会与阶段二的混音叠成双份（而且会提前出声）。
       */
      const transparentAudio =
        request.target.kind === 'transparentMov' && (request.audioClips?.length ?? 0) > 0
          ? {
              clips: request.audioClips ?? [],
              spanStartSec: frameTimeSec(spec.startFrame, spec.fps),
              spanEndSec: frameTimeSec(spec.startFrame + framesTotal, spec.fps),
              ...(request.audioMastering ? { mastering: request.audioMastering } : {})
            }
          : undefined

      state.phase = 'rendering'
      emit()

      if (request.target.kind === 'pngSequence') {
        // PNG 出口：帧直接落到输出目录，不做二次编码
        const dir = outputPath
        const wrote = await writePngSequence(
          {
            state,
            dir,
            fps: spec.fps,
            startFrame: spec.startFrame,
            framesTotal,
            isCancelled: () => state.cancelRequested,
            onTick: emit
          },
          channel
        )
        if (wrote === 'cancelled') {
          this.finalizeCancelled(request, state)
          return
        }
        state.outputs = [dir]
        await this.succeed(state, request)
        return
      }

      if (request.target.kind === 'transparentMov') {
        if (request.frameDelivery === 'pngSequence') {
          const framesDir = path.join(workspace.dir, 'frames')
          const wrote = await writePngSequence(
            {
              state,
              dir: framesDir,
              fps: spec.fps,
              startFrame: spec.startFrame,
              framesTotal,
              isCancelled: () => state.cancelRequested,
              onTick: emit
            },
            channel
          )
          if (wrote === 'cancelled') {
            this.finalizeCancelled(request, state)
            return
          }
          state.phase = 'muxing'
          emit()
          await encodePngToMov({
            state,
            binaries,
            dir: framesDir,
            outputPath,
            fps: spec.fps,
            framesTotal,
            codec,
            audio: transparentAudio,
            isCancelled: () => state.cancelRequested,
            onTick: emit
          })
        } else {
          const done = await runTransparentMov({ ...transparentCtx, audio: transparentAudio }, channel)
          if (done === 'cancelled') {
            this.finalizeCancelled(request, state)
            return
          }
        }
        state.phase = 'verifying'
        emit()
        await verifyTransparentMov(
          outputPath,
          { width: spec.width, height: spec.height, fps: spec.fps, frames: framesTotal },
          binaries,
          { codec }
        )
        state.outputs = [outputPath]
        await this.succeed(state, request)
        return
      }

      // 叠加压制
      const overlay = request.overlay
      if (!overlay) throw new Error('叠加导出缺少参考视频参数')
      // 硬件编码器只解析一次：失败/不可用一律回落 libx264，导出照常进行
      let videoEncoder: string | null = null
      try {
        videoEncoder = await resolveExportEncoder()
      } catch {
        videoEncoder = null
      }
      const done = await runOverlayMp4({
        state,
        binaries,
        transparentCtx,
        channel,
        refVideoPath: overlay.refVideoPath,
        // v2：媒体时间轴；单段整段覆盖时主进程仍走旧单输入（argv 不变）
        segments: overlay.segments,
        frameSize: { width: spec.width, height: spec.height },
        refMeta: overlay.refMeta,
        audioMode: overlay.audioMode,
        fpsMode: overlay.fpsMode,
        spanStartSec: overlay.spanStartSec,
        spanEndSec: overlay.spanEndSec,
        outputPath,
        overlayPath: transparentOutput,
        codec,
        frameFormat: spec.frameFormat,
        directPipe: overlay.directPipe,
        // 硬件编码器（null = libx264）；合成失败会自动回退软件编码
        videoEncoder,
        // 水印：尺寸不可用/路径缺失时归一为 undefined，合成链退回无水印的旧参数
        watermark: watermarkInputOf(overlay.watermark),
        // v7：音频轨；有它就与参考视频原声 amix（渲染侧已按 span 裁剪）
        audioClips: request.audioClips,
        // v10：目标画布与画质档（缺省 = 旧行为，argv 逐字节不变）
        canvas: overlay.canvas,
        quality: overlay.quality,
        audioMastering: request.audioMastering,
        // v8：防抖 .trf 落盘与 detect/合成 ffmpeg 的 cwd
        workspaceDir: workspace.dir,
        isCancelled: () => state.cancelRequested,
        onTick: emit
      })
      if (done === 'cancelled') {
        this.finalizeCancelled(request, state)
        return
      }
      state.phase = 'verifying'
      emit()
      await verifyOverlayMp4(
        outputPath,
        { width: spec.width, height: spec.height, fps: spec.fps, frames: framesTotal },
        overlay.refMeta,
        binaries
      )
      state.outputs = [outputPath]
      await this.succeed(state, request)
    } catch (error) {
      // 任何阶段发现已请求取消，都按「已取消」而不是「失败」收尾
      // （取消会连带 EPIPE / 帧请求 reject 等副作用，不该当成缺陷）
      if (state.cancelRequested) {
        this.finalizeCancelled(request, state)
      } else {
        const info = toErrorInfo(error)
        await this.fail(state, request, info)
        await log('error', `任务 ${request.jobId} 失败：${info.message}\n${info.stderrTail}`)
      }
    } finally {
      if (channel) {
        channel.close()
        this.channels.delete(request.jobId)
      }
      // 只有真正走完校验并产出成功结果的任务才保留产物
      if (artifact && state.phase !== 'done') {
        await fs
          .rm(artifact.path, { recursive: artifact.kind === 'dir', force: true })
          .catch(() => undefined)
        await log('info', `已删除未完成产物（${state.phase}）：${artifact.path}`)
      }
      if (workspace) await disposeWorkspace(workspace)
    }
  }

  private makeTickerFor(state: JobState): () => void {
    let last = 0
    return () => {
      const now = Date.now()
      const terminal = state.framesDone >= state.framesTotal
      if (now - last < PROGRESS_THROTTLE_MS && !terminal) return
      last = now
      this.remember(state)
      emitProgress(this.windowOf(state.windowId), state)
    }
  }

  /** 记录进度快照（节流由调用方保证；终态也会走到这里）。 */
  private remember(state: JobState): void {
    this.snapshots.set(state.id, toProgress(state))
    trimOldest(this.snapshots, JOB_SNAPSHOT_LIMIT)
  }

  private rememberResult(result: JobResult): void {
    this.results.set(result.jobId, result)
    trimOldest(this.results, JOB_SNAPSHOT_LIMIT)
  }

  /** 输出路径：MOV/MP4 为文件，PNG 出口为目录。 */
  private async resolveOutputPath(request: ExportRequest): Promise<string> {
    const dir = request.target.outputDir
    const name = request.target.fileName
    if (request.target.kind === 'pngSequence') {
      const target = path.join(dir, name.replace(/\.[^.]+$/i, ''))
      return target
    }
    const expectedExt = request.target.kind === 'overlayMp4' ? '.mp4' : '.mov'
    const withExt = /\.[a-z0-9]+$/i.test(name) ? name : `${name}${expectedExt}`
    return path.join(dir, withExt)
  }

  private async succeed(state: JobState, request: ExportRequest): Promise<void> {
    state.phase = 'done'
    const result: JobResult = {
      jobId: state.id,
      ok: true,
      outputs: state.outputs,
      outputPath: state.outputs[0],
      progress: toProgress(state)
    }
    emitResult(this.windowOf(state.windowId), result)
    this.rememberResult(result)
    await log('info', `任务 ${state.id} 完成：${state.outputs.join(', ')}`)
    this.registry.remove(state.id)
    void request
  }

  private async fail(state: JobState, request: ExportRequest, error: JobErrorInfo): Promise<void> {
    state.phase = 'failed'
    state.error = error
    const result: JobResult = {
      jobId: state.id,
      ok: false,
      outputs: state.outputs,
      error,
      progress: toProgress(state)
    }
    emitResult(this.windowOf(state.windowId), result)
    this.rememberResult(result)
    this.registry.remove(state.id)
    void request
  }

  private finalizeCancelled(request: ExportRequest | undefined, state: JobState): void {
    state.phase = 'cancelled'
    const result: JobResult = {
      jobId: state.id,
      ok: false,
      outputs: [],
      error: { code: 'CANCELLED', message: '任务已取消', stderrTail: '', fatal: false },
      progress: toProgress(state)
    }
    emitResult(this.windowOf(state.windowId), result)
    this.rememberResult(result)
    this.registry.remove(state.id)
    void request
  }
}

/** Map 按插入顺序淘汰；只用于进度/结果缓存，不影响运行中的任务对象。 */
function trimOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

function toErrorInfo(error: unknown): JobErrorInfo {
  const anyError = error as {
    message?: string
    code?: string | number | null
    stderrTail?: string
    argv?: string[]
    detail?: string
    index?: number
  }
  // FFmpegExitError 的 code 是退出码（数字），不能当成稳定的错误标识上报给 UI
  const rawCode = anyError?.code
  const code =
    typeof rawCode === 'string' && rawCode.length > 0
      ? rawCode
      : typeof rawCode === 'number'
        ? 'FFMPEG_EXIT'
        : 'EXPORT_FAILED'
  return {
    code,
    message: anyError?.message ?? String(error),
    stderrTail: anyError?.stderrTail ?? anyError?.detail ?? '',
    argv: anyError?.argv,
    fatal: true
  }
}
