import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobState } from '../src/main/export/jobs'
import type { SpawnedJob } from '../src/main/procRegistry'
import type { MediaClipMask, OverlaySegment } from '../src/shared/types'
import type { OverlayRunCtx } from '../src/main/export/overlayMp4'
import { FPS_30 } from '../src/shared/constants'
import { encodeRgbaPng, rgbaFrame } from './helpers/png'

/**
 * M8：手绘遮罩的「主进程侧」契约。
 *
 * 覆盖：
 * - 渲染侧传来的 PNG 字节写进任务工作目录（文件名 mask-<clipId>.png，clipId 白名单过滤）；
 * - 写盘失败 / 非 PNG / 空字节都给出可读错误（绝不静默丢遮罩）；
 * - 遮罩按「带 mask 的段」顺序接 maskPath；数量不匹配直接报错（不允许错配）；
 * - 走完整 runOverlayMp4 时：mask 输入排在媒体之后、overlayLabel = 段数 + 遮罩数。
 */

const spawnCalls: Array<{ args: string[]; label: string }> = []

vi.mock('../src/main/procRegistry', () => ({
  spawnJob: (request: { jobId: string; label: string; binary: string; args: string[] }): SpawnedJob => {
    spawnCalls.push({ args: request.args, label: request.label })
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean }
    child.kill = () => true
    const stdin = { end: () => undefined, destroyed: false, write: () => true }
    ;(child as unknown as { stdin: typeof stdin }).stdin = stdin
    const job: SpawnedJob = {
      jobId: request.jobId,
      child: child as unknown as SpawnedJob['child'],
      label: request.label,
      startedAt: Date.now(),
      argv: [request.binary, ...request.args],
      stderr: {
        tail: () => '',
        push: () => undefined,
        pushText: () => undefined
      } as unknown as SpawnedJob['stderr']
    }
    // runOverlayMp4 先 pumpFrames(mock 立即 done) 再关 stdin、等 close
    setTimeout(() => child.emit('close', 0), 0)
    return job
  },
  terminateJob: vi.fn(async () => 'absent' as const)
}))

vi.mock('../src/main/export/framePump', () => ({
  pumpFrames: vi.fn(async () => 'done' as const),
  writeWithBackpressure: vi.fn(async () => undefined)
}))

vi.mock('../src/main/export/transparentMov', () => ({
  FFmpegExitError: class extends Error {
    constructor(
      readonly code: number | null,
      readonly stderrTail: string,
      readonly argv: string[]
    ) {
      super(`FFmpeg 退出码 ${code ?? '未知'}`)
    }
  },
  waitForClose: (job: SpawnedJob) =>
    new Promise<number | null>((resolve) => {
      job.child.once('close', (code: number | null) => resolve(code))
    }),
  awaitChildExit: async () => 0
}))

const { attachMaskPaths, sanitizeMaskClipId, writeMediaMaskFiles, runOverlayMp4 } = await import(
  '../src/main/export/overlayMp4'
)

/** 一张 2×2 全白 PNG（等价渲染侧 convertToBlob 的产物形状）。 */
function whitePng(): Uint8Array {
  return new Uint8Array(encodeRgbaPng(2, 2, rgbaFrame(2, 2, () => [255, 255, 255, 255])))
}

let dir = ''

beforeEach(async () => {
  spawnCalls.length = 0
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-mask-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function overlayed(over: Partial<OverlaySegment> & { mask?: MediaClipMask } = {}): OverlaySegment {
  return {
    refVideoPath: 'D:/media/a.mp4',
    timelineStartSec: 0,
    timelineEndSec: 1,
    sourceInSec: 0,
    sourceOutSec: 1,
    hasAudio: false,
    ...over
  }
}

describe('M8 遮罩写盘', () => {
  it('无遮罩时返回空数组（不产生任何文件）', async () => {
    expect(await writeMediaMaskFiles(undefined, dir)).toEqual([])
    expect(await writeMediaMaskFiles([], dir)).toEqual([])
  })

  it('按 mask-<clipId>.png 写盘并回传绝对路径', async () => {
    const png = whitePng()
    const files = await writeMediaMaskFiles([{ clipId: 'mclip-abc', png }], dir)
    expect(files).toHaveLength(1)
    expect(files[0]!.clipId).toBe('mclip-abc')
    expect(path.basename(files[0]!.path)).toBe('mask-mclip-abc.png')
    expect(files[0]!.path.startsWith(dir)).toBe(true)
    expect([...(await fs.readFile(files[0]!.path))]).toEqual([...png])
  })

  it('clipId 走白名单过滤（防目录穿越）', async () => {
    expect(sanitizeMaskClipId('../../evil')).toBe('______evil')
    expect(sanitizeMaskClipId('a/b:c')).toBe('a_b_c')
    expect(sanitizeMaskClipId('')).toBe('clip')
    const files = await writeMediaMaskFiles([{ clipId: '../../evil', png: whitePng() }], dir)
    expect(path.basename(files[0]!.path)).toBe('mask-______evil.png')
  })

  it('非 PNG 字节给出可读错误（不是静默失败）', async () => {
    await expect(
      writeMediaMaskFiles([{ clipId: 'mclip-x', png: new Uint8Array([1, 2, 3]) }], dir)
    ).rejects.toThrow(/不是 PNG/)
  })

  it('空字节给出可读错误', async () => {
    await expect(
      writeMediaMaskFiles([{ clipId: 'mclip-x', png: new Uint8Array() }], dir)
    ).rejects.toThrow(/为空/)
  })

  it('写盘失败给出可读错误（目标不是目录）', async () => {
    const notDir = path.join(dir, 'not-a-dir')
    await fs.writeFile(notDir, 'x')
    await expect(
      writeMediaMaskFiles([{ clipId: 'mclip-x', png: whitePng() }], notDir)
    ).rejects.toThrow(/遮罩写入失败/)
  })
})

describe('M8 遮罩接段（maskPath）', () => {
  it('无遮罩文件时原样返回同一引用（零回归）', () => {
    const segments = [overlayed()]
    expect(attachMaskPaths(segments, [])).toBe(segments)
  })

  it('按带 mask 的段顺序接 maskPath（无 mask 的段不动）', () => {
    const segments = [
      overlayed({ mask: { strokes: [] } }),
      overlayed({ timelineStartSec: 1, timelineEndSec: 2, sourceInSec: 1, sourceOutSec: 2 }),
      overlayed({ timelineStartSec: 2, timelineEndSec: 3, sourceInSec: 2, sourceOutSec: 3, mask: { strokes: [] } })
    ]
    const two = [
      { clipId: 'a', path: 'D:/ws/mask-a.png' },
      { clipId: 'b', path: 'D:/ws/mask-b.png' }
    ]
    const attached = attachMaskPaths(segments, two)!
    expect(attached[0]!.maskPath).toBe('D:/ws/mask-a.png')
    expect(attached[1]!.maskPath).toBeUndefined()
    expect(attached[2]!.maskPath).toBe('D:/ws/mask-b.png')
  })

  it('数量不匹配直接报错（不允许把遮罩错配到别的段）', () => {
    const segments = [overlayed({ mask: { strokes: [] } })]
    expect(() =>
      attachMaskPaths(segments, [
        { clipId: 'a', path: 'D:/ws/a.png' },
        { clipId: 'b', path: 'D:/ws/b.png' }
      ])
    ).toThrow(/遮罩数量与媒体段不匹配/)
  })
})

describe('M8 遮罩接线：runOverlayMp4 生成正确的 mask 输入与序号', () => {
  function makeState(): JobState {
    return {
      id: 'job-mask',
      kind: 'overlayMp4',
      windowId: 1,
      phase: 'rendering',
      framesDone: 0,
      framesTotal: 30,
      timeTotalSec: 1,
      outTimeUs: 0,
      bytesWritten: 0,
      startedAt: Date.now(),
      notices: [],
      cancelRequested: false,
      outputs: []
    }
  }

  function makeCtx(state: JobState): OverlayRunCtx {
    const refMeta = {
      path: 'D:/ref.mp4',
      containerName: 'mov',
      width: 1920,
      height: 1080,
      sar: { num: 1, den: 1 },
      displayRatio: 16 / 9,
      rFrameRate: { num: 30, den: 1 },
      avgFrameRate: { num: 30, den: 1 },
      pixFmt: 'yuv420p',
      colorPrimaries: 'bt709',
      colorSpace: 'bt709',
      colorTransfer: 'bt709',
      colorRange: 'tv',
      videoCodec: 'h264',
      audioCodec: null,
      audioChannels: 0,
      durationSec: 1,
      nbFrames: 30,
      bitRateKbps: null
    }
    return {
      state,
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'bundled', available: true },
      transparentCtx: {
        window: null,
        state,
        binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', source: 'bundled', available: true },
        fps: FPS_30,
        width: 1920,
        height: 1080,
        startFrame: 0,
        framesTotal: 30,
        outputPath: path.join(dir, 'out.mp4'),
        codec: 'prores4444',
        frameFormat: 'raw',
        isCancelled: () => false,
        onTick: () => undefined
      } as unknown as OverlayRunCtx['transparentCtx'],
      channel: {
        jobId: 'job-mask',
        request: async () => Buffer.alloc(0),
        cancel: () => undefined,
        close: () => undefined
      },
      refVideoPath: 'D:/media/a.mp4',
      segments: [
        overlayed({
          mask: { strokes: [{ mode: 'hide', radiusPct: 5, points: [{ x: 0.25, y: 0.5 }] }] }
        })
      ],
      frameSize: { width: 1920, height: 1080 },
      refMeta,
      audioMode: 'aac',
      fpsMode: 'cfr',
      spanStartSec: 0,
      spanEndSec: 1,
      outputPath: path.join(dir, 'out.mp4'),
      frameFormat: 'raw',
      mediaMasks: [{ clipId: 'mclip-mask', png: whitePng() }],
      workspaceDir: dir,
      isCancelled: () => false,
      onTick: () => undefined
    }
  }

  it('写入遮罩文件 → mask 输入在媒体之后 / 帧流之前，overlayLabel = 1 + 1', async () => {
    const state = makeState()
    const result = await runOverlayMp4(makeCtx(state))
    expect(result).toBe('done')
    expect(spawnCalls).toHaveLength(1)
    const args = spawnCalls[0]!.args
    const maskPath = path.join(dir, 'mask-mclip-mask.png')
    expect(args).toContain(maskPath)
    const maskAt = args.indexOf(maskPath)
    expect(maskAt).toBeGreaterThan(args.indexOf('D:/media/a.mp4'))
    expect(maskAt).toBeLessThan(args.indexOf('pipe:0'))
    expect([...(await fs.readFile(maskPath))]).toEqual([...whitePng()])

    const graph = args[args.indexOf('-filter_complex') + 1]!
    // 1 段 → mask 输入序号 1；帧流序号 2（overlayLabel）
    expect(graph).toContain('[1:v]format=gray,scale=1920:1080[mms0]')
    expect(graph).toContain('[mbs0][mams0]alphamerge[mons0]')
    expect(graph).toContain('[2:v]setpts=PTS+0.000000/TB[ov]')
    expect(state.notices.some((notice) => notice.includes('手绘遮罩'))).toBe(true)
  })

  it('遮罩数量与段数不匹配时导出直接失败（不跑合成）', async () => {
    const state = makeState()
    const ctx = makeCtx(state)
    ctx.segments = [overlayed()]
    ctx.mediaMasks = [{ clipId: 'mclip-mask', png: whitePng() }]
    await expect(runOverlayMp4(ctx)).rejects.toThrow(/遮罩数量与媒体段不匹配/)
    expect(spawnCalls).toHaveLength(0)
  })
})
