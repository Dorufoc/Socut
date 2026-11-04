import fs from 'node:fs/promises'
import { buildOverlayMp4, buildOverlayMp4DirectPipe } from '../../shared/ffmpegArgs'
import type { TransparentCodec, VideoMeta } from '../../shared/types'
import { spawnJob, terminateJob } from '../procRegistry'
import type { FfmpegBinaries } from '../paths'
import { ProgressParser } from '../progressParser'
import type { FrameChannelHandle } from './frameChannel'
import type { JobState } from './jobs'
import { pumpFrames, writeWithBackpressure } from './framePump'
import { awaitChildExit, FFmpegExitError, runTransparentMov, waitForClose } from './transparentMov'
import type { TransparentRunCtx } from './transparentMov'

/**
 * 导出 B：MP4 叠加压制（规格 §5.2）。
 * 关键纪律：字幕条按参考视频参数重新渲染，绝不复用透明 MOV 做缩放叠加。
 * 计划 C7：渲染区间限定为片段 span，合成时用 setpts 平移 + enable 时间窗。
 */

export interface OverlayRunCtx {
  state: JobState
  binaries: FfmpegBinaries
  transparentCtx: TransparentRunCtx
  channel: FrameChannelHandle
  refVideoPath: string
  refMeta: VideoMeta
  audioMode: 'copy' | 'aac'
  fpsMode: 'cfr' | 'vfr'
  spanStartSec: number
  spanEndSec: number
  outputPath: string
  /** 临时透明 MOV（两阶段法产物，任务结束即清理） */
  overlayPath: string
  codec: TransparentCodec
  /** 直接管道合成时的帧形式与尺寸 */
  frameFormat: 'raw' | 'png'
  frameSize: { width: number; height: number }
  directPipe: boolean
  isCancelled: () => boolean
  onTick: () => void
}

interface CompositeRun {
  code: number | null
  stderrTail: string
  argv: string[]
}

/** 阶段二：合成。返回退出码与 stderr 尾部，由上层决定音频回退重试。 */
async function composite(
  ctx: OverlayRunCtx,
  audioMode: 'copy' | 'aac'
): Promise<CompositeRun> {
  const parser = new ProgressParser()
  const args = ctx.directPipe
    ? buildOverlayMp4DirectPipe({
        refVideoPath: ctx.refVideoPath,
        outputPath: ctx.outputPath,
        fps: ctx.transparentCtx.fps,
        frameFormat: ctx.frameFormat,
        frameSize: ctx.frameSize,
        spanStartSec: ctx.spanStartSec,
        spanEndSec: ctx.spanEndSec,
        audioMode,
        fpsMode: ctx.fpsMode
      })
    : buildOverlayMp4({
        refVideoPath: ctx.refVideoPath,
        overlayPath: ctx.overlayPath,
        outputPath: ctx.outputPath,
        fps: ctx.transparentCtx.fps,
        spanStartSec: ctx.spanStartSec,
        spanEndSec: ctx.spanEndSec,
        audioMode,
        fpsMode: ctx.fpsMode
      })

  const job = spawnJob({
    jobId: ctx.state.id,
    label: `叠加合成 ${ctx.refMeta.width}x${ctx.refMeta.height} ${audioMode === 'copy' ? 'copy' : 'aac'}`,
    binary: ctx.binaries.ffmpeg,
    args,
    stdin: ctx.directPipe,
    onStdoutChunk: (chunk) => {
      const snapshot = parser.feed(chunk)
      if (snapshot) {
        ctx.state.outTimeUs = snapshot.outTimeUs
        ctx.onTick()
      }
    }
  })

  const cancelWatch = setInterval(() => {
    if (ctx.isCancelled()) void terminateJob(ctx.state.id)
  }, 200)

  try {
    if (ctx.directPipe) {
      const stdin = job.child.stdin
      if (!stdin) throw new Error('FFmpeg stdin 不可用')
      try {
        const result = await pumpFrames({
          channel: ctx.channel,
          startFrame: ctx.transparentCtx.startFrame,
          framesTotal: ctx.transparentCtx.framesTotal,
          isCancelled: ctx.isCancelled,
          onFrame: async (_absolute, buffer) => {
            await writeWithBackpressure(stdin, buffer)
            ctx.state.bytesWritten += buffer.length
          },
          onProgress: (framesDone) => {
            ctx.state.framesDone = framesDone
            ctx.onTick()
          }
        })
        if (result === 'cancelled') {
          ctx.channel.cancel('cancelled')
          ctx.channel.close()
          await terminateJob(ctx.state.id)
          return { code: null, stderrTail: 'cancelled', argv: job.argv }
        }
      } catch (error) {
        // 与透明出口同理：先报错的是本地 stdin 写入，真正原因在 FFmpeg 的 stderr 里。
        // 把它归一成 {code, stderrTail, argv}，上层才能给出可复现的错误。
        if (ctx.isCancelled()) {
          ctx.channel.cancel('cancelled')
          ctx.channel.close()
          await terminateJob(ctx.state.id)
          return { code: null, stderrTail: 'cancelled', argv: job.argv }
        }
        const code = await awaitChildExit(job, 5000)
        const tail = job.stderr.tail(4096)
        const original = error instanceof Error ? error.message : String(error)
        throw new FFmpegExitError(code, tail.length > 0 ? tail : original, job.argv, `${original}（FFmpeg 退出码 ${code ?? '未知'}）`)
      }
      stdin.end()
      ctx.channel.close()
    }
    const code = await waitForClose(job)
    return { code, stderrTail: job.stderr.tail(4096), argv: job.argv }
  } finally {
    clearInterval(cancelWatch)
  }
}

export async function runOverlayMp4(ctx: OverlayRunCtx): Promise<'done' | 'cancelled'> {
  if (!ctx.directPipe) {
    // 阶段一：按参考视频参数重新渲染透明 MOV（规格 §11 纪律 2）
    const transparent = await runTransparentMov(ctx.transparentCtx, ctx.channel)
    if (transparent === 'cancelled') {
      await fs.rm(ctx.overlayPath, { force: true }).catch(() => undefined)
      return 'cancelled'
    }
  }

  /**
   * 计划 C4：预检判定不可 copy 而直接走 AAC 时，**必须告知用户**（“并在 UI 提示已转码”）。
   * 没有这条提示，用户只会发现导出音频码率变了，却不知道是自己那条音轨不被容器接受。
   * 无音轨（audioCodec === null）不算转码，不提示。
   */
  if (ctx.audioMode === 'aac' && ctx.refMeta.audioCodec !== null) {
    ctx.state.notices.push(`音频已转码为 AAC 192k（原音轨 ${ctx.refMeta.audioCodec} 不能直接复制）。`)
    ctx.onTick()
  }

  ctx.state.phase = 'muxing'
  ctx.state.timeTotalSec = Math.max(0, ctx.spanEndSec - ctx.spanStartSec)
  ctx.onTick()

  let run = await composite(ctx, ctx.audioMode)

  // 计划 C4：copy 运行期失败（无音轨 / 不兼容编码）→ 单次 AAC 重试
  if (ctx.audioMode === 'copy' && run.code !== null && run.code !== 0) {
    ctx.state.notices.push('音频直接复制失败，已改用 AAC 192k 重新合成。')
    await fs.rm(ctx.outputPath, { force: true }).catch(() => undefined)
    run = await composite(ctx, 'aac')
  }

  if (ctx.isCancelled()) {
    await terminateJob(ctx.state.id)
    await cleanup(ctx)
    return 'cancelled'
  }
  if (run.code === null) {
    // 取消路径
    await cleanup(ctx)
    return 'cancelled'
  }
  if (run.code !== 0) {
    await cleanup(ctx)
    throw new FFmpegExitError(run.code, run.stderrTail, run.argv)
  }
  if (!ctx.directPipe) {
    await fs.rm(ctx.overlayPath, { force: true }).catch(() => undefined)
  }
  return 'done'
}

async function cleanup(ctx: OverlayRunCtx): Promise<void> {
  await fs.rm(ctx.overlayPath, { force: true }).catch(() => undefined)
  await fs.rm(ctx.outputPath, { force: true }).catch(() => undefined)
}
