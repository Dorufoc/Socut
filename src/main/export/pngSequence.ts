import fs from 'node:fs/promises'
import path from 'node:path'
import { buildTransparentMovFromSeq, buildTransparentMovQtrleFromSeq } from '../../shared/ffmpegArgs'
import type { Fps, TransparentCodec } from '../../shared/types'
import { spawnJob, terminateJob } from '../procRegistry'
import type { FfmpegBinaries } from '../paths'
import { frameFileName } from '../tempWorkspace'
import { ProgressParser } from '../progressParser'
import type { FrameChannelHandle } from './frameChannel'
import type { JobState } from './jobs'
import { pumpFrames } from './framePump'
import { assertNoAlphaDrop } from './verify'
import { FFmpegExitError, waitForClose } from './transparentMov'

/**
 * PNG 序列（规格 §2.3 可选出口 + §5.1 image2pipe 失败时的回退）。
 * 两条用途共用同一个帧泵：
 *  - 出口=PNG：帧直接落到输出目录，不做二次编码（Canvas 产物已是 RGBA PNG）；
 *  - 出口=MOV 且回退：帧落到临时工作区，再由 FFmpeg 编成 ProRes 4444。
 */

export interface PngWriteCtx {
  state: JobState
  /** 帧文件目录（工作区或输出目录） */
  dir: string
  fps: Fps
  startFrame: number
  framesTotal: number
  isCancelled: () => boolean
  onTick: () => void
}

/** PNG 签名（文件头 8 字节）。落盘帧必须是真 PNG，不能是 raw RGBA。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export async function writePngSequence(ctx: PngWriteCtx, channel: FrameChannelHandle): Promise<'done' | 'cancelled'> {
  await fs.mkdir(ctx.dir, { recursive: true })
  let bytes = 0
  const result = await pumpFrames({
    channel,
    startFrame: ctx.startFrame,
    framesTotal: ctx.framesTotal,
    isCancelled: ctx.isCancelled,
    onFrame: async (absolute, buffer) => {
      /**
       * 硬校验：之前这里不加区别地写盘，而 C17 把帧形式默认改成 raw 后，
       * PNG 序列出口写出的是 921600B 的裸 RGBA 假 PNG（ffprobe：Invalid PNG signature）。
       * 宁可现在抱一个说人话的错，也不能静默产出任何工具都读不了的文件。
       */
      if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error(
          `第 ${absolute} 帧不是 PNG（文件头 0x${buffer.subarray(0, 4).toString('hex')}，` +
            `长度 ${buffer.length}B）：渲染侧的 frameFormat 必须是 'png'`
        )
      }
      // 帧序号从 0 开始编号，供 -start_number 0 消费
      const localIndex = absolute - ctx.startFrame
      await fs.writeFile(path.join(ctx.dir, frameFileName(localIndex)), buffer)
      bytes += buffer.length
      ctx.state.bytesWritten = bytes
    },
    onProgress: (framesDone) => {
      ctx.state.framesDone = framesDone
      ctx.onTick()
    }
  })
  if (result === 'cancelled') channel.cancel('cancelled')
  channel.close()
  return result
}

export interface EncodeCtx {
  state: JobState
  binaries: FfmpegBinaries
  dir: string
  outputPath: string
  fps: Fps
  framesTotal: number
  codec: TransparentCodec
  isCancelled: () => boolean
  onTick: () => void
}

export async function encodePngToMov(ctx: EncodeCtx): Promise<void> {
  const pattern = path.join(ctx.dir, 'frame_%06d.png')
  const args =
    ctx.codec === 'qtrle'
      ? buildTransparentMovQtrleFromSeq(ctx.fps, pattern, ctx.outputPath, 0)
      : buildTransparentMovFromSeq(ctx.fps, pattern, ctx.outputPath, 0)

  const parser = new ProgressParser()
  const job = spawnJob({
    jobId: ctx.state.id,
    label: 'PNG 序列 → MOV',
    binary: ctx.binaries.ffmpeg,
    args,
    stdin: false,
    onStdoutChunk: (chunk) => {
      const snapshot = parser.feed(chunk)
      if (snapshot) {
        ctx.state.outTimeUs = snapshot.outTimeUs
        ctx.onTick()
      }
    }
  })

  if (ctx.isCancelled()) {
    await terminateJob(ctx.state.id)
    throw new Error('任务已取消')
  }

  const closeWatch = setInterval(() => {
    if (ctx.isCancelled()) {
      void terminateJob(ctx.state.id)
      clearInterval(closeWatch)
    }
  }, 200)

  try {
    const code = await waitForClose(job)
    assertNoAlphaDrop(job.stderr.tail())
    if (code !== 0) {
      throw new FFmpegExitError(code, job.stderr.tail(4096), job.argv)
    }
  } finally {
    clearInterval(closeWatch)
  }
}
