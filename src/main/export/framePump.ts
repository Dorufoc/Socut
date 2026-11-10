import { Writable } from 'node:stream'
import type { FrameChannelHandle } from './frameChannel'

/**
 * 帧泵：按帧序号向渲染进程索取帧，并直接交给消费方（编码器 stdin）。
 *
 * 内存纪律（专业剪辑软件的导出口径）：
 * - 帧只在内存里停留，绝不落盘成中间图片；
 * - 在飞帧数由**字节预算**决定，而不是写死 3：
 *   1080p RGBA 一帧 8.3MB、4K 一帧 33MB、8K 一帧 132MB，
 *   固定窗口会让高分辨率导出把内存吃穿；这里按预算反算窗口，
 *   内存在任何分辨率下都不超过 `FRAME_BUFFER_BUDGET_BYTES`；
 * - 窗口是固定的环形槽位：消费完一帧才补一帧，天然形成背压，不丢帧也不空转。
 */

/** 在飞帧的内存预算（渲染进程舞台池另有 4 个画布，两者相乘才是峰值）。 */
export const FRAME_BUFFER_BUDGET_BYTES = 192 * 1024 * 1024

/** 渲染侧舞台缓冲池大小（STAGE_POOL_SIZE）；超过它必然触发池饥饿。 */
export const MAX_INFLIGHT_FRAMES = 3

/**
 * 按帧字节数与内存预算算出在飞窗口。
 * 单帧超过预算时至少保留 1 帧（否则导出无法推进）。
 */
export function frameWindowSize(frameBytes?: number, budget = FRAME_BUFFER_BUDGET_BYTES): number {
  if (!frameBytes || !Number.isFinite(frameBytes) || frameBytes <= 0) return MAX_INFLIGHT_FRAMES
  const fit = Math.floor(budget / frameBytes)
  return Math.max(1, Math.min(MAX_INFLIGHT_FRAMES, fit))
}

export interface PumpInput {
  channel: FrameChannelHandle
  /** 绝对起始帧（消息里携带绝对帧号，渲染进程据此算局部进度） */
  startFrame: number
  framesTotal: number
  /** 单帧字节数（raw = w*h*4）；用于反算内存窗口 */
  frameBytes?: number
  onFrame: (absoluteIndex: number, buffer: Buffer) => Promise<void>
  isCancelled: () => boolean
  /** 每交付一帧回调（用于进度） */
  onProgress?: (framesDone: number) => void
}

export type PumpResult = 'done' | 'cancelled'

export async function pumpFrames(input: PumpInput): Promise<PumpResult> {
  const windowSize = frameWindowSize(input.frameBytes)
  const inflight = new Map<number, Promise<Buffer>>()
  const requestFrame = (absolute: number): Promise<Buffer> => {
    const promise = input.channel.request(absolute)
    // 避免取消/失败路径下无人 await 导致 unhandledRejection
    promise.catch(() => undefined)
    inflight.set(absolute, promise)
    return promise
  }

  const last = input.startFrame + input.framesTotal - 1
  try {
    for (let absolute = input.startFrame; absolute <= Math.min(last, input.startFrame + windowSize - 1); absolute++) {
      requestFrame(absolute)
    }

    for (let i = 0; i < input.framesTotal; i++) {
      if (input.isCancelled()) {
        input.channel.cancel('cancelled')
        return 'cancelled'
      }
      const absolute = input.startFrame + i
      const buffer = await (inflight.get(absolute) ?? requestFrame(absolute))
      inflight.delete(absolute)
      await input.onFrame(absolute, buffer)
      input.onProgress?.(i + 1)
      const nextAbsolute = absolute + windowSize
      if (nextAbsolute <= last) requestFrame(nextAbsolute)
    }
    return 'done'
  } finally {
    inflight.clear()
  }
}

/**
 * 带背压的管道写入：write() 返回 false 时等待 drain。
 * stdin 因 FFmpeg 提前退出而报错（EPIPE）时必须向上抛，交由 stderr 尾部定位原因。
 */
export function writeWithBackpressure(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error('FFmpeg stdin 已关闭（进程可能提前退出）'))
      return
    }
    const onError = (error: Error): void => {
      stream.off('drain', onDrain)
      reject(error)
    }
    const onDrain = (): void => {
      stream.off('error', onError)
      resolve()
    }
    const ok = stream.write(chunk, (error) => {
      if (error) {
        stream.off('drain', onDrain)
        reject(error)
      }
    })
    if (ok) {
      stream.off('error', onError)
      resolve()
    } else {
      stream.once('drain', onDrain)
      stream.once('error', onError)
    }
  })
}
