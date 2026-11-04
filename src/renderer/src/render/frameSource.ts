import type { FrameEnd, FrameRequest, FrameResponse, FrameSpec, RenderJobSpec } from '@shared/types'
import { NativeStage } from './stage'

/**
 * 导出帧供给端（规格 §5.1：渲染引擎以帧序号驱动，逐帧输出带 alpha 的 PNG）。
 * 主进程 pull：收到 {index} 才渲染并回传 PNG，天然形成背压，不丢帧也不空转。
 */

interface Prepared {
  jobId: string
  spec: RenderJobSpec
  /**
   * 舞台缓冲池：主进程可以提前若干帧发起请求，若共用单一 OffscreenCanvas，
   * 后一帧的 clearRect 会踩碎前一帧尚未编码完的内容。每个在飞帧独占一个画布。
   */
  pool: NativeStage[]
}

/** 同时在飞的帧上限（渲染侧上限；主进程的实际窗口由 framePump 控制）。 */
const STAGE_POOL_SIZE = 4

const prepared = new Map<string, Prepared>()

/** 帧耗时分解（供应用内冒烟与性能回归读数，不参与业务判断）。 */
const stats = { frames: 0, renderMs: 0, encodeMs: 0, poolStalls: 0 }

export function frameStats(): typeof stats {
  return { ...stats }
}

export function resetFrameStats(): void {
  stats.frames = 0
  stats.renderMs = 0
  stats.encodeMs = 0
  stats.poolStalls = 0
}

export function frameSpecOf(spec: RenderJobSpec): FrameSpec {
  return {
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    startFrame: spec.startFrame,
    endFrame: spec.endFrame,
    frameFormat: spec.frameFormat
  }
}

export function registerExportJob(jobId: string, spec: RenderJobSpec): void {
  const pool: NativeStage[] = []
  for (let i = 0; i < STAGE_POOL_SIZE; i++) pool.push(new NativeStage(spec.width, spec.height))
  prepared.set(jobId, { jobId, spec, pool })
}

export function releaseExportJob(jobId: string): void {
  prepared.delete(jobId)
}

export function preparedJobCount(): number {
  return prepared.size
}

/** 渲染并回传一帧；任何异常都以 error 字段回给主进程，由引擎判定任务失败。 */
async function serveFrame(request: FrameRequest): Promise<void> {
  const entry = prepared.get(request.jobId)
  const respond = (payload: FrameResponse): void => window.focusnews.export.sendFrame(payload)
  if (!entry) {
    respond({ jobId: request.jobId, index: request.index, error: '导出任务未就绪' })
    return
  }
  if (request.index < entry.spec.startFrame || request.index >= entry.spec.endFrame) {
    respond({
      jobId: request.jobId,
      index: request.index,
      error: `帧 ${request.index} 超出导出区间 [${entry.spec.startFrame}, ${entry.spec.endFrame})`
    })
    return
  }
  const stage = entry.pool.shift()
  if (!stage) {
    stats.poolStalls += 1
    // 在飞帧数超过缓冲池：主进程窗口过大，交给它重试而不是失败
    respond({ jobId: request.jobId, index: request.index, error: '渲染侧缓冲池已满，请降低并发窗口' })
    return
  }
  try {
    const renderStartedAt = performance.now()
    stage.resize(entry.spec.width, entry.spec.height)
    // 导出永不带预览辅助线
    stage.render(entry.spec, request.index, {})
    stats.renderMs += performance.now() - renderStartedAt
    const encodeStartedAt = performance.now()
    // 主路径：未压缩 RGBA（避开 PNG zlib 压缩瓶颈）；PNG 仅用于回退与 PNG 出口
    const buffer = entry.spec.frameFormat === 'png' ? await stage.pngBuffer() : stage.rawRgba()
    stats.encodeMs += performance.now() - encodeStartedAt
    stats.frames += 1
    respond({ jobId: request.jobId, index: request.index, buffer })
  } catch (error) {
    respond({
      jobId: request.jobId,
      index: request.index,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    // 本帧已完整编码并回传，画布可复用
    entry.pool.push(stage)
  }
}

/** 订阅主进程的帧请求；返回卸载函数。 */
export function attachFrameSource(): () => void {
  return window.focusnews.export.onFrameRequest((message: FrameRequest | FrameEnd) => {
    if (!message || typeof message !== 'object') return
    if ('reason' in message) {
      releaseExportJob(message.jobId)
      return
    }
    void serveFrame(message)
  })
}
