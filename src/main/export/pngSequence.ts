import fs from 'node:fs/promises'
import path from 'node:path'
import type { Fps } from '../../shared/types'
import type { FrameChannelHandle } from './frameChannel'
import type { JobState } from './jobs'
import { frameFileName } from '../tempWorkspace'
import { pumpFrames } from './framePump'

/**
 * PNG 序列出口（规格 §2.3 可选的**交付格式**）。
 *
 * 注意与「中间缓存」的区别：这里的 PNG 就是用户要的产物，直接落到输出目录，
 * 不做二次编码；导出流程内部不再产生任何 PNG 中间帧（v11 起叠加/透明出口都走内存直送）。
 */

export interface PngWriteCtx {
  state: JobState
  /** 帧文件目录（PNG 出口 = 输出目录） */
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
