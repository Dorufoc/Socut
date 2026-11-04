import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobState } from '../src/main/export/jobs'
import type { SpawnedJob } from '../src/main/procRegistry'

/**
 * 验收第 7 条后半句（计划 C4）：`-c:a copy` 运行期失败时，
 * 必须「只重试一次 AAC」并且把回退事实作为 notice 交给用户。
 *
 * 为什么用注入失败而不是找一个真实文件：本机实测 alac 与 pcm_s16le 都能
 * 直接 copy 进 MP4（`-c:a copy` 退出码 0），也就是说常见素材根本触发不了这条分支；
 * 靠"找一个会失败的容器组合"来取证既脆弱又不可解释。注入退出码才是对**这段逻辑**的直接测试。
 */

interface SpawnCall {
  args: string[]
  label: string
}

const spawnCalls: SpawnCall[] = []
const queue: Array<number | null> = []

class FakeExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly stderrTail: string,
    readonly argv: string[]
  ) {
    super(`FFmpeg 退出码 ${code ?? '未知'}`)
  }
}

vi.mock('../src/main/procRegistry', () => ({
  spawnJob: (request: { jobId: string; label: string; binary: string; args: string[] }): SpawnedJob => {
    spawnCalls.push({ args: request.args, label: request.label })
    const code = queue.length > 0 ? queue.shift() : 0
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean }
    child.kill = () => true
    const job: SpawnedJob = {
      jobId: request.jobId,
      child: child as unknown as SpawnedJob['child'],
      label: request.label,
      startedAt: Date.now(),
      argv: [request.binary, ...request.args],
      stderr: {
        tail: () => (code === 0 ? '' : "Codec is not supported for output format / doesn't contain any stream"),
        push: () => undefined,
        pushText: () => undefined
      } as unknown as SpawnedJob['stderr']
    }
    // composite() 先 await waitForClose，再读 stderr/argv：close 必须异步发出
    setTimeout(() => child.emit('close', code), 0)
    return job
  },
  terminateJob: vi.fn(async () => 'absent' as const)
}))

/** 阶段一（透明 MOV）不是本测试的对象：直接判定成功。 */
vi.mock('../src/main/export/transparentMov', () => ({
  FFmpegExitError: FakeExitError,
  runTransparentMov: vi.fn(async () => 'done' as const),
  waitForClose: (job: SpawnedJob) =>
    new Promise<number | null>((resolve) => {
      job.child.once('close', (code: number | null) => resolve(code))
    })
}))

vi.mock('../src/main/export/framePump', () => ({
  pumpFrames: vi.fn(async () => 'done' as const),
  writeWithBackpressure: vi.fn(async () => undefined)
}))

const { runOverlayMp4 } = await import('../src/main/export/overlayMp4')

function makeState(): JobState {
  return {
    id: 'job-audio',
    kind: 'overlayMp4',
    windowId: 1,
    phase: 'rendering',
    framesDone: 12,
    framesTotal: 12,
    timeTotalSec: 0.4,
    outTimeUs: 0,
    bytesWritten: 0,
    startedAt: Date.now(),
    notices: [],
    cancelRequested: false,
    outputs: []
  }
}

function makeCtx(state: JobState) {
  const binaries = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'bundled' as const, available: true }
  const refMeta = {
    path: 'D:/ref.mov',
    containerName: 'mov',
    width: 1920,
    height: 1080,
    sar: { num: 1, den: 1 },
    displayRatio: 16 / 9,
    rFrameRate: { num: 25, den: 1 },
    avgFrameRate: { num: 25, den: 1 },
    pixFmt: 'yuv420p',
    colorPrimaries: 'bt709',
    colorSpace: 'bt709',
    colorTransfer: 'bt709',
    colorRange: 'tv',
    videoCodec: 'h264',
    audioCodec: 'pcm_s16le',
    audioChannels: 2,
    durationSec: 6,
    nbFrames: 150,
    bitRateKbps: null
  }
  const transparentCtx = {
    // 阶段一已被 mock，不会真的碰窗口；仅为满足类型形状
    window: {} as never,
    state,
    binaries,
    fps: { num: 25, den: 1 },
    width: 1920,
    height: 1080,
    startFrame: 12,
    framesTotal: 100,
    outputPath: 'D:/tmp/overlay.mov',
    codec: 'prores4444' as const,
    frameFormat: 'raw' as const,
    isCancelled: () => false,
    onTick: () => undefined
  }
  return {
    state,
    binaries,
    transparentCtx,
    channel: { cancel: () => undefined, close: () => undefined } as never,
    refVideoPath: 'D:/ref.mov',
    refMeta,
    audioMode: 'copy' as const,
    fpsMode: 'cfr' as const,
    spanStartSec: 0.5,
    spanEndSec: 4.5,
    outputPath: 'D:/out.mp4',
    overlayPath: 'D:/tmp/overlay.mov',
    codec: 'prores4444' as const,
    frameFormat: 'raw' as const,
    frameSize: { width: 1920, height: 1080 },
    directPipe: false,
    isCancelled: () => false,
    onTick: () => undefined
  }
}

function hasSequence(args: string[], sequence: string[]): boolean {
  for (let i = 0; i + sequence.length <= args.length; i++) {
    if (sequence.every((token, offset) => args[i + offset] === token)) return true
  }
  return false
}

beforeEach(() => {
  spawnCalls.length = 0
  queue.length = 0
})

describe('叠加导出的音频回退（计划 C4 / 验收第 7 条）', () => {
  it('copy 运行期失败 → 只重试一次 AAC，并留下用户可见的 notice', async () => {
    queue.push(227, 0)
    const state = makeState()
    const result = await runOverlayMp4(makeCtx(state))

    expect(result).toBe('done')
    expect(spawnCalls).toHaveLength(2)
    expect(hasSequence(spawnCalls[0]!.args, ['-c:a', 'copy'])).toBe(true)
    expect(hasSequence(spawnCalls[1]!.args, ['-c:a', 'aac', '-b:a', '192k'])).toBe(true)
    expect(state.notices).toHaveLength(1)
    expect(state.notices[0]).toMatch(/AAC 192k/)
    // 重试轮次必须仍在 stderr 里带上失败原因可追溯的 argv（这里由第二次调用体现）
    expect(spawnCalls[1]!.label).toContain('叠加合成')
  })

  it('重试也失败时不再无限重试：抛出 FFmpegExitError，且总共只调用两次', async () => {
    queue.push(227, 227)
    const state = makeState()
    await expect(runOverlayMp4(makeCtx(state))).rejects.toBeInstanceOf(FakeExitError)
    expect(spawnCalls).toHaveLength(2)
    expect(state.notices).toHaveLength(1)
  })

  it('copy 直接成功时不应产生任何回退提示（避免误导用户）', async () => {
    queue.push(0)
    const state = makeState()
    const result = await runOverlayMp4(makeCtx(state))
    expect(result).toBe('done')
    expect(spawnCalls).toHaveLength(1)
    expect(state.notices).toHaveLength(0)
  })

  it('预检就判定不可 copy 时：直接 AAC 且必须告知用户原音轨（计划 C4“并在 UI 提示已转码”）', async () => {
    queue.push(0)
    const state = makeState()
    const ctx = makeCtx(state)
    const result = await runOverlayMp4({ ...ctx, audioMode: 'aac' })

    expect(result).toBe('done')
    expect(spawnCalls).toHaveLength(1)
    expect(hasSequence(spawnCalls[0]!.args, ['-c:a', 'aac', '-b:a', '192k'])).toBe(true)
    // pcm_s16le 是有音轨的，必须提示；无音轨那么不该谎称转码
    expect(state.notices).toHaveLength(1)
    expect(state.notices[0]).toContain('已转码为 AAC 192k')
    expect(state.notices[0]).toContain('pcm_s16le')
  })

  it('参考视频无音轨时不应谎称“已转码”', async () => {
    queue.push(0)
    const state = makeState()
    const ctx = makeCtx(state)
    const result = await runOverlayMp4({
      ...ctx,
      audioMode: 'aac',
      refMeta: { ...ctx.refMeta, audioCodec: null, audioChannels: null }
    })
    expect(result).toBe('done')
    expect(state.notices).toHaveLength(0)
  })
})
