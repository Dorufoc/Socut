import { Writable } from 'node:stream'
import type { FrameChannelHandle } from './frameChannel'

/** 帧泵：按帧序号向渲染进程索取 PNG，并交给消费方（stdin 或磁盘）。 */

export interface PumpInput {
  channel: FrameChannelHandle
  /** 绝对起始帧（消息里携带绝对帧号，渲染进程据此算局部进度） */
  startFrame: number
  framesTotal: number
  onFrame: (absoluteIndex: number, buffer: Buffer) => Promise<void>
  isCancelled: () => boolean
  /** 每交付一帧回调（用于进度） */
  onProgress?: (framesDone: number) => void
  /**
   * 并发窗口：同时在飞的帧数。窗口=1 会把「渲染 → PNG 编码 → IPC 往返 → 写盘」完全串行化，
   * 实测每帧多出一个往返的延迟；窗口≥ 2 时编码与消费重叠，吞吐接近线性提升。
   * 上限受渲染侧舞台缓冲池（默认 4）约束，取 3 留一颗余量。
   */
  windowSize?: number
}

export type PumpResult = 'done' | 'cancelled'

export async function pumpFrames(input: PumpInput): Promise<PumpResult> {
  const windowSize = Math.max(1, Math.min(4, input.windowSize ?? 3))
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
