import { spawnJob, terminateJob } from './procRegistry'
import { resolveFfmpegBinaries } from './paths'
import type { FfmpegBinaries } from './paths'
import { TEXT } from '../shared/i18n'

/** ffprobe / 短任务的异步执行封装（严格：只用 spawnJob，不触碰任何同步族）。 */

export class ProbeError extends Error {
  constructor(message: string, readonly stderrTail: string, readonly argv: string[]) {
    super(message)
  }
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

/** 运行一个会自然结束的命令并收集完整输出（ffprobe、版本探测等）。 */
export async function runToEnd(
  binary: string,
  args: string[],
  jobId: string,
  label: string
): Promise<RunResult> {
  const chunks: Buffer[] = []
  const job = spawnJob({
    jobId,
    label,
    binary,
    args,
    stdin: false,
    onStdoutChunk: (chunk) => {
      chunks.push(chunk)
    }
  })
  const result = await new Promise<RunResult>((resolve, reject) => {
    job.child.once('error', (error) => reject(new ProbeError(error.message, job.stderr.tail(), job.argv)))
    job.child.once('close', (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: job.stderr.tail(8192),
        code
      })
    })
  })
  return result
}

/** 解析 JSON 输出；失败时抛出带 stderr 尾部的错误（规格 §5.3 错误尾部输出）。 */
export async function runFfprobeJson<T = unknown>(
  args: string[],
  jobId: string,
  binaries?: FfmpegBinaries
): Promise<T> {
  const resolved = binaries ?? (await resolveFfmpegBinaries())
  if (!resolved.available) throw new ProbeError(TEXT.errors.ffmpegMissing(resolved.ffprobe), '', args)
  const result = await runToEnd(resolved.ffprobe, args, jobId, 'ffprobe')
  if (result.code !== 0) {
    throw new ProbeError(`ffprobe 退出码 ${result.code}`, result.stderr, [resolved.ffprobe, ...args])
  }
  const text = result.stdout.trim()
  if (text.length === 0) throw new ProbeError('ffprobe 无输出', result.stderr, [resolved.ffprobe, ...args])
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new ProbeError(`ffprobe 输出无法解析为 JSON：${String(error)}`, result.stderr.slice(0, 512), [
      resolved.ffprobe,
      ...args
    ])
  }
}

/** 取消一个已在注册表中的任务（供 engine 复用）。 */
export async function kill(jobId: string): Promise<'exited' | 'killed' | 'absent'> {
  return terminateJob(jobId)
}

let cachedVersion: string | null = null

/** 读取随包 FFmpeg 版本（启动自检与 UI 展示；异步 spawn，失败不阻断启动）。 */
export async function ffmpegVersion(binaries: FfmpegBinaries): Promise<string> {
  if (cachedVersion !== null) return cachedVersion
  if (!binaries.available) return ' unavailable'
  try {
    const result = await runToEnd(binaries.ffmpeg, ['-version'], 'ffmpeg-version', 'ffmpeg --version')
    const firstLine = result.stdout.split('\n')[0] ?? ''
    cachedVersion = firstLine.startsWith('ffmpeg version') ? firstLine.slice('ffmpeg version'.length).trim() : firstLine.trim()
    return cachedVersion
  } catch {
    cachedVersion = ''
    return binaries.hint ?? 'FFmpeg 不可用'
  }
}
