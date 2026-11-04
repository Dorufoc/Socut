import { ChildProcess, spawn } from 'node:child_process'
import { SIGTERM_GRACE_MS } from '../shared/constants'
import { StderrTail } from './stderrTail'

/**
 * 子进程纪律（规格 §5.3 / §11）：
 * - 只使用异步 spawn，禁止任何同步调用族；
 * - 全局注册表跟踪活跃进程，取消时 SIGTERM、超时强杀；
 * - stderr 必须收集，失败时输出尾部；
 * - 应用退出前统一清理。
 */

export interface SpawnedJob {
  jobId: string
  child: ChildProcess
  label: string
  startedAt: number
  stderr: StderrTail
  argv: string[]
}

export interface SpawnRequest {
  jobId: string
  label: string
  binary: string
  args: string[]
  /** stdin 由调用方负责写入（image2pipe 场景） */
  stdin?: boolean
  /** 原始 stdout 块交给调用方（进度解析器自带行缓冲，不得共享实例） */
  onStdoutChunk?: (chunk: Buffer) => void
  cwd?: string
}

const registry = new Map<string, SpawnedJob>()

/** 异步 spawn + 注册 + stderr 收集。 */
export function spawnJob(request: SpawnRequest): SpawnedJob {
  const child = spawn(request.binary, request.args, {
    cwd: request.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  })
  const stderr = new StderrTail()
  const job: SpawnedJob = {
    jobId: request.jobId,
    child,
    label: request.label,
    startedAt: Date.now(),
    stderr,
    argv: [request.binary, ...request.args]
  }
  registry.set(request.jobId, job)

  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdout?.on('data', (chunk: Buffer) => {
    request.onStdoutChunk?.(chunk)
  })
  // FFmpeg 提前退出后写 stdin 会 EPIPE：挂被动监听防未捕获异常，
  // 错误本身由 writeWithBackpressure 的 reject 向上归因（规格 §5.3）
  child.stdin?.on('error', () => {
    /* no-op */
  })
  child.on('error', (error) => {
    stderr.pushText(`\n[spawn error] ${error.message}\n`)
  })
  child.on('exit', () => {
    registry.delete(request.jobId)
  })

  // 调用方若不需要 stdin（如 ffprobe），立即关闭避免子进程等待
  if (!request.stdin) child.stdin?.end()
  return job
}

export function getJob(jobId: string): SpawnedJob | undefined {
  return registry.get(jobId)
}

export function activeJobs(): Array<{ jobId: string; label: string; pid: number | undefined; elapsedMs: number }> {
  return [...registry.values()].map((job) => ({
    jobId: job.jobId,
    label: job.label,
    pid: job.child.pid,
    elapsedMs: Date.now() - job.startedAt
  }))
}

export function activeCount(): number {
  return registry.size
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

/**
 * 取消：SIGTERM → 等待 → SIGKILL。
 * Windows 下 Node 会把 SIGTERM 映射为 TerminateProcess，因此仍需 SIGKILL 兜底与注册表清理。
 */
export async function terminateJob(jobId: string, graceMs = SIGTERM_GRACE_MS): Promise<'exited' | 'killed' | 'absent'> {
  const job = registry.get(jobId)
  if (!job) return 'absent'
  const child = job.child
  if (child.exitCode !== null || child.signalCode !== null) {
    registry.delete(jobId)
    return 'exited'
  }
  child.kill('SIGTERM')
  const exited = await waitForExit(child, graceMs)
  if (exited) {
    registry.delete(jobId)
    return 'exited'
  }
  child.kill('SIGKILL')
  await waitForExit(child, graceMs)
  registry.delete(jobId)
  return 'killed'
}

/** 应用退出前统一清理（返回处理条数用于日志）。 */
export async function terminateAll(graceMs = SIGTERM_GRACE_MS): Promise<number> {
  const ids = [...registry.keys()]
  await Promise.all(ids.map((id) => terminateJob(id, graceMs)))
  return ids.length
}
