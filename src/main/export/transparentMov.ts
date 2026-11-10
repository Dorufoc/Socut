import { BrowserWindow } from 'electron'
import { buildTransparentMovFromPipe, buildTransparentMovQtrle } from '../../shared/ffmpegArgs'
import type { TransparentAudioOptions } from '../../shared/ffmpegArgs'
import type { AudioMastering, Fps, TransparentCodec } from '../../shared/types'
import { spawnJob, terminateJob } from '../procRegistry'
import type { SpawnedJob } from '../procRegistry'
import { ProgressParser } from '../progressParser'
import type { FfmpegBinaries } from '../paths'
import type { JobState } from './jobs'
import type { FrameChannelHandle } from './frameChannel'
import { pumpFrames, writeWithBackpressure } from './framePump'
import { assertNoAlphaDrop } from './verify'

/**
 * 导出 A：透明 ProRes 4444 MOV（image2pipe 主路径，规格 §5.1）。
 * 渲染循环以帧序号驱动，绝不依赖 vsync；预览 Canvas 不参与此处任何坐标计算。
 */

export interface TransparentRunCtx {
  window: BrowserWindow
  state: JobState
  binaries: FfmpegBinaries
  fps: Fps
  width: number
  height: number
  startFrame: number
  framesTotal: number
  outputPath: string
  codec: TransparentCodec
  /** 管道内帧形式（默认 raw） */
  frameFormat: 'raw' | 'png'
  /** v7：音频轨（不传 = 保持 `-an`，argv 与旧版一致） */
  audio?: TransparentAudioOptions
  /** v10：成片响度标准化（音频段的 loudnorm 在混音计划里注入） */
  audioMastering?: AudioMastering
  isCancelled: () => boolean
  /** 进度节流由引擎统一调度 */
  onTick: () => void
}

export function waitForClose(job: SpawnedJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    job.child.once('error', (error) => reject(error))
    job.child.once('close', (code) => resolve(code))
  })
}

export async function runTransparentMov(ctx: TransparentRunCtx, channel: FrameChannelHandle): Promise<'done' | 'cancelled'> {
  const audio = ctx.audio
    ? { ...ctx.audio, ...(ctx.audioMastering ? { mastering: ctx.audioMastering } : {}) }
    : undefined
  const args =
    ctx.codec === 'qtrle'
      ? buildTransparentMovQtrle(
          ctx.fps,
          ctx.outputPath,
          ctx.frameFormat,
          { width: ctx.width, height: ctx.height },
          audio
        )
      : buildTransparentMovFromPipe(
          ctx.fps,
          ctx.outputPath,
          ctx.frameFormat,
          { width: ctx.width, height: ctx.height },
          audio
        )

  const parser = new ProgressParser()
  const job = spawnJob({
    jobId: ctx.state.id,
    label: `透明 MOV ${ctx.width}x${ctx.height} ${ctx.fps.num}/${ctx.fps.den}`,
    binary: ctx.binaries.ffmpeg,
    args,
    stdin: true,
    onStdoutChunk: (chunk) => {
      const snapshot = parser.feed(chunk)
      if (snapshot) {
        ctx.state.outTimeUs = snapshot.outTimeUs
        ctx.onTick()
      }
    }
  })

  const stdin = job.child.stdin
  if (!stdin) {
    channel.cancel('failed')
    channel.close()
    throw new Error('FFmpeg stdin 不可用')
  }

  let bytes = 0
  try {
    const result = await pumpFrames({
      channel,
      startFrame: ctx.startFrame,
      framesTotal: ctx.framesTotal,
      // raw 帧按 RGBA 尺寸反算内存窗口；PNG 管道是压缩流，按默认窗口即可
      frameBytes: ctx.frameFormat === 'raw' ? ctx.width * ctx.height * 4 : undefined,
      isCancelled: ctx.isCancelled,
      onFrame: async (_absolute, buffer) => {
        await writeWithBackpressure(stdin, buffer)
        bytes += buffer.length
        ctx.state.bytesWritten = bytes
      },
      onProgress: (framesDone) => {
        ctx.state.framesDone = framesDone
        ctx.onTick()
      }
    })

    if (result === 'cancelled') {
      await terminateJob(ctx.state.id)
      channel.close()
      return 'cancelled'
    }
    // 帧全部交付后关闭 stdin，让 FFmpeg 收尾（mux + moov）
    stdin.end()
    const code = await waitForClose(job)
    channel.close()
    assertNoAlphaDrop(job.stderr.tail())
    if (code !== 0) {
      throw new FFmpegExitError(code, job.stderr.tail(4096), job.argv)
    }
    ctx.state.outTimeUs = Math.max(ctx.state.outTimeUs, parser.current().outTimeUs)
    return 'done'
  } catch (error) {
    // 取消会让 pending 帧请求被 reject（背压中断）：这是预期路径，不能报为导出失败
    if (ctx.isCancelled()) {
      channel.cancel('cancelled')
      channel.close()
      await terminateJob(ctx.state.id)
      return 'cancelled'
    }
    channel.cancel('failed')
    channel.close()
    /**
     * 不能直接 `throw error`：FFmpeg 因打不开输出文件/磁盘满而不存在时，
     * 先报错的是本地 stdin 写入（`write EOF` / EPIPE），而**真正的原因在 stderr 里**。
     * 直接上抛会让用户只看到“write EOF”，把规格 §9 要求的 stderr 尾部与完整命令行丢干净
     *（应用内错误取证实捕：errorCode=EOF / stderrTailBytes=0 / argvSegments=0）。
     */
    const code = await awaitChildExit(job, 5000)
    await terminateJob(ctx.state.id)
    if (error instanceof FFmpegExitError) throw error
    const stderrTail = job.stderr.tail(4096)
    const original = error instanceof Error ? error.message : String(error)
    throw new FFmpegExitError(
      code,
      stderrTail.length > 0 ? stderrTail : original,
      job.argv,
      `${original}（FFmpeg 退出码 ${code ?? '未知'}）`
    )
  }
}

/**
 * 子进程是否已退出；已退出时 `once('close')` 不会再触发，
 * 所以上层想拿退出码时必须先看 exitCode/signalCode，否则会永远等下去。
 */
export async function awaitChildExit(job: SpawnedJob, timeoutMs: number): Promise<number | null> {
  if (job.child.exitCode !== null) return job.child.exitCode
  if (job.child.signalCode !== null) return null
  return Promise.race<number | null>([
    new Promise<number | null>((resolve) => job.child.once('close', (code: number | null) => resolve(code))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ])
}

export class FFmpegExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly stderrTail: string,
    readonly argv: string[],
    /** 默认文案只有退出码；由写入错误引发时要保留原始原因 */
    message?: string
  ) {
    super(message ?? `FFmpeg 退出码 ${code ?? '未知'}`)
  }
}
