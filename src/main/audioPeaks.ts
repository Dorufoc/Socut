import { promises as fs } from 'node:fs'
import {
  SPECTRUM_BUCKETS_MAX,
  SPECTRUM_BUCKETS_MIN,
  SPECTRUM_MAX_BYTES,
  pickSpectrumSampleRate,
  spectrumCacheKey,
  spectrumCachePrefix,
  spectrumPeaksFromPcm,
  type SpectrumRequestInput
} from '../shared/audioPeaks'
import { buildAudioPeaksArgs } from '../shared/ffmpegArgs'
import type { AudioPeaksRequest, AudioPeaksResult } from '../shared/types'
import { spawnJob, terminateJob } from './procRegistry'
import { resolveFfmpegBinaries } from './paths'
import { log } from './log'

/**
 * 频谱条（v9）的幅度取样：一次 FFmpeg 调用把片段源区间解成单声道 PCM，主进程折成等分桶峰值。
 *
 * 分工与纪律（与预览条 `stripProtocol` 同一套）：
 * - **绝不在渲染层解码**：时间轴一屏可能有十几条卡片，逐条起 WebAudio 解码会把预览拖垮；
 * - **内存缓存 + 同键合并**：结果是几个浮点数（不是图片），不值得落盘，
 *   但同一 key 的重复请求必须不起第二个子进程（拖入出点时每帧都在请求同一个键）；
 * - **并发闸门**：与预览条共用「排队而不是打满 CPU」的判断；
 * - **失败即无条**：源文件不在 / FFmpeg 缺失 / 没有音轨 → `peaks: []`，
 *   卡片退回不画频谱，不打断时间轴任何交互。
 */

/** 内存里最多保留多少条取样结果（超出按插入顺序淘汰最旧的）。 */
const CACHE_MAX_ENTRIES = 240

/** 同时最多几个取样任务在跑（其余排队）；与预览条同一量级，频谱条更轻但仍要排队。 */
const MAX_CONCURRENT = 2

const cache = new Map<string, AudioPeaksResult>()
const inflight = new Map<string, Promise<AudioPeaksResult>>()
const queue: Array<() => void> = []

/** 子进程注册表用的递增 id（不拿缓存键拼，因为键里含盘符冒号与中文素材名）。 */
let jobSequence = 0

let running = 0

function acquireSlot(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      running += 1
      resolve()
    })
  })
}

function releaseSlot(): void {
  running -= 1
  queue.shift()?.()
}

function emptyResult(input: { key: string; buckets: number; hasAudio: boolean }): AudioPeaksResult {
  return { peaks: [], buckets: input.buckets, key: input.key, cached: false, hasAudio: input.hasAudio }
}

/** 只缓存成功结果；失败不占席位（源文件补回来了要能重试）。 */
function remember(key: string, result: AudioPeaksResult): AudioPeaksResult {
  if (result.peaks.length === 0) return result
  cache.set(key, result)
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return result
}

/** 请求校验 + 桶数夹心（主进程不信任渲染层给的 buckets）。 */
function normalizeRequest(request: AudioPeaksRequest): SpectrumRequestInput | null {
  if (typeof request?.mediaId !== 'string' || request.mediaId.length === 0) return null
  if (typeof request.path !== 'string' || request.path.length === 0) return null
  const sourceInSec = Number(request.sourceInSec)
  const sourceOutSec = Number(request.sourceOutSec)
  if (!Number.isFinite(sourceInSec) || !Number.isFinite(sourceOutSec)) return null
  if (sourceInSec < 0 || sourceOutSec <= sourceInSec) return null
  const buckets = Math.min(SPECTRUM_BUCKETS_MAX, Math.max(SPECTRUM_BUCKETS_MIN, Math.round(Number(request.buckets) || 0)))
  return { mediaId: request.mediaId, path: request.path, sourceInSec, sourceOutSec, buckets }
}

/**
 * 读取（或生成）一条片段的频谱。
 * `peaks: []` 表示「这条画不出频谱」，渲染层据此不画柱子而不是画一条空槽。
 */
export async function generateAudioPeaks(request: AudioPeaksRequest): Promise<AudioPeaksResult> {
  const input = normalizeRequest(request)
  if (!input) return emptyResult({ key: 'invalid', buckets: SPECTRUM_BUCKETS_MIN, hasAudio: false })

  const key = spectrumCacheKey(input)
  const hit = cache.get(key)
  if (hit) return { ...hit, cached: true }

  const pending = inflight.get(key)
  if (pending) return pending

  const task = runPeaks(input, key)
  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

async function runPeaks(input: SpectrumRequestInput, key: string): Promise<AudioPeaksResult> {
  const buckets = input.buckets
  try {
    const stat = await fs.stat(input.path).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) return emptyResult({ key, buckets, hasAudio: false })

    const durationSec = input.sourceOutSec - input.sourceInSec
    const sampleRate = pickSpectrumSampleRate(durationSec, buckets)
    // 区间长到连最低采样率都装不进内存：不试了（渲染层不画频谱条）
    if (sampleRate <= 0) return emptyResult({ key, buckets, hasAudio: false })

    const binaries = await resolveFfmpegBinaries()
    if (!binaries.available) return emptyResult({ key, buckets, hasAudio: false })

    await acquireSlot()
    try {
      const chunks: Buffer[] = []
      let received = 0
      let overflow = false
      jobSequence = (jobSequence + 1) % 4096
      const jobId = `peaks-${Date.now().toString(36)}-${jobSequence.toString(36)}`
      const job = spawnJob({
        jobId,
        label: '频谱取样',
        binary: binaries.ffmpeg,
        args: buildAudioPeaksArgs({
          inputPath: input.path,
          sourceInSec: input.sourceInSec,
          sourceOutSec: input.sourceOutSec,
          sampleRate
        }),
        onStdoutChunk: (chunk) => {
          // stdout 就是 PCM 字节流：超上限立即止损，不再往里灌
          if (overflow) return
          received += chunk.byteLength
          if (received > SPECTRUM_MAX_BYTES) {
            overflow = true
            void terminateJob(jobId)
            return
          }
          chunks.push(chunk)
        }
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        job.child.once('error', (error) => reject(error))
        job.child.once('close', (exitCode) => resolve(exitCode))
      })
      if (overflow) {
        await log('warn', `频谱取样超出字节上限（${input.path} ${durationSec.toFixed(2)}s），已中止子进程`)
        return emptyResult({ key, buckets, hasAudio: true })
      }
      if (code !== 0) {
        // 没有音轨 / 解码失败：都归一为「不画频谱」，不向上抛（时间轴不该被一次取样打断）
        await log('warn', `频谱取样失败（${input.path}）：退出码 ${code} ${job.stderr.tail(200)}`)
        return emptyResult({ key, buckets, hasAudio: false })
      }
      const bytes = Buffer.concat(chunks)
      const peaks = spectrumPeaksFromPcm(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), buckets)
      return remember(key, { peaks, buckets, key, cached: false, hasAudio: peaks.length > 0 })
    } finally {
      releaseSlot()
    }
  } catch (error) {
    await log('warn', `频谱取样异常（${input.path}）：${String(error)}`)
    return emptyResult({ key, buckets, hasAudio: false })
  }
}

/** 素材移出池时回收它的取样结果（与 removeStripsFor 同一纪律：不留过期派生数据）。 */
export function removePeaksFor(mediaId: string): void {
  const prefix = spectrumCachePrefix(mediaId)
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}
