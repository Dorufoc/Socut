import { BrowserWindow, ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipcChannels'
import { FRAME_REQUEST_TIMEOUT_MS } from '../../shared/constants'
import type { FrameEnd, FrameRequest, FrameResponse } from '../../shared/types'

/**
 * 帧通道（主进程侧，pull 背压）。
 *
 * 传输选型说明（实测决定，不凭想当然）：
 * 最初用 `MessageChannelMain` + `webContents.postMessage` 把端口交给渲染侧，
 * 但 contextIsolation 下端口需经 contextBridge 二次代理，实测第 0 帧请求得不到应答
 * （应用内端到端冒烟 spikes/app-smoke/report.json：「第 0 帧渲染超时」）。
 * 因此改为普通 IPC 通道：主进程请求第 N 帧、渲染侧回传 PNG 字节。
 * 代价是每帧一次结构化克隆拷贝；收益是隔离世界下可靠工作，
 * 且「只有写盘成功才请求下一帧」的背压与不丢帧特性完全保留。
 */

interface Pending {
  resolve: (buffer: Buffer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Channel {
  jobId: string
  window: BrowserWindow
  pending: Map<number, Pending>
  closed: boolean
}

const channels = new Map<string, Channel>()
let installed = false

export class FrameTimeoutError extends Error {
  constructor(readonly index: number) {
    super(`第 ${index} 帧渲染超时`)
  }
}

/** 注册一次性的帧回执监听（在 registerIpc 中调用）。 */
export function installFrameIpc(): void {
  if (installed) return
  installed = true
  ipcMain.on(CHANNELS.frameResponse, (_event, payload: unknown) => {
    const data = payload as FrameResponse | undefined
    if (!data || typeof data.jobId !== 'string') return
    const channel = channels.get(data.jobId)
    if (!channel || channel.closed) return
    if (typeof data.index !== 'number') return
    const entry = channel.pending.get(data.index)
    if (!entry) return
    channel.pending.delete(data.index)
    clearTimeout(entry.timer)
    if (data.error) {
      entry.reject(new Error(`渲染侧帧错误（第 ${data.index} 帧）：${data.error}`))
      return
    }
    entry.resolve(toBuffer(data.buffer))
  })
}

export interface FrameChannelHandle {
  jobId: string
  request(index: number): Promise<Buffer>
  cancel(reason: 'cancelled' | 'failed'): void
  close(): void
}

export function openFrameChannel(window: BrowserWindow, jobId: string): FrameChannelHandle {
  const channel: Channel = { jobId, window, pending: new Map(), closed: false }
  channels.set(jobId, channel)

  const request = (index: number): Promise<Buffer> =>
    new Promise<Buffer>((resolve, reject) => {
      if (channel.closed) {
        reject(new Error('帧通道已关闭'))
        return
      }
      if (window.isDestroyed()) {
        reject(new Error('窗口已关闭'))
        return
      }
      const timer = setTimeout(() => {
        channel.pending.delete(index)
        reject(new FrameTimeoutError(index))
      }, FRAME_REQUEST_TIMEOUT_MS)
      channel.pending.set(index, { resolve, reject, timer })
      const message: FrameRequest = { jobId, index }
      window.webContents.send(CHANNELS.frameRequest, message)
    })

  return {
    jobId,
    request,
    cancel(reason: 'cancelled' | 'failed'): void {
      if (!window.isDestroyed()) {
        const message: FrameEnd = { jobId, reason }
        window.webContents.send(CHANNELS.frameRequest, message)
      }
      for (const [, entry] of channel.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(reason === 'cancelled' ? '任务已取消' : '任务失败'))
      }
      channel.pending.clear()
    },
    close(): void {
      channel.closed = true
      for (const [, entry] of channel.pending) clearTimeout(entry.timer)
      channel.pending.clear()
      channels.delete(jobId)
    }
  }
}

/** 应用退出前统一断开，避免残留 pending 定时器。 */
export function closeAllFrameChannels(): void {
  for (const [, channel] of channels) {
    for (const [, entry] of channel.pending) clearTimeout(entry.timer)
    channel.pending.clear()
    channel.closed = true
  }
  channels.clear()
}

export function openFrameChannelCount(): number {
  return channels.size
}

function toBuffer(payload: ArrayBuffer | Uint8Array | undefined): Buffer {
  if (payload === undefined) throw new Error('帧数据为空')
  if (payload instanceof Uint8Array) return Buffer.from(payload)
  return Buffer.from(payload)
}
