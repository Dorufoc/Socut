import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildMaskInputArgs,
  buildMatteInputArgs,
  buildMediaBasisFilterComplex,
  inferMatteKind,
  maskInputIndexFor,
  matteInputIndexFor,
  resolveMatteKind,
  segmentWantsMatte
} from '@shared/ffmpegArgs'
import type { ConcatSegment } from '@shared/ffmpegArgs'
import { FPS_30 } from '@shared/constants'
import { assertMatteInputs } from '../src/main/export/overlayMp4'
import { encodeRgbaPng, rgbaFrame } from './helpers/png'

/**
 * M8-P0：外部 matte（静态图/视频）导出链路。
 *
 * argv 层锁：输入参数、输入编号（段 → mask → matte → 帧流）、视频 matte 的帧索引对齐语句、
 * mask+matte 并存顺序、无水印/有水印的 overlayLabel。
 * 预检锁：绝对路径/不存在/类型无法判断/变速/转场 → 可读错误。
 * e2e（随包 FFmpeg）：视频 matte 等长不多 1 帧、短 matte repeatlast、mask+matte 叠加。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = process.platform === 'win32' ? '.exe' : ''
const FFMPEG = path.join(ROOT, 'resources', 'ffmpeg', `ffmpeg${EXE}`)

const seg = (over: Partial<ConcatSegment> = {}): ConcatSegment => ({
  refVideoPath: 'D:/media/a.mp4',
  timelineStartSec: 0,
  timelineEndSec: 1,
  sourceInSec: 0,
  sourceOutSec: 1,
  hasAudio: false,
  ...over
})

const basis = (segments: ConcatSegment[], overlayLabel = '2') => ({
  segments,
  spanStartSec: 0,
  spanEndSec: 4,
  overlayLabel,
  outputPath: 'D:/out/comp.mp4',
  fps: FPS_30,
  frameSize: { width: 1920, height: 1080 },
  audioMode: 'aac' as const,
  fpsMode: 'cfr' as const
})

describe('M8-P0 matte：类型判定与输入参数', () => {
  it('扩展名推断：图片/视频/未知；显式 kind 优先', () => {
    expect(inferMatteKind('D:/m/a.png')).toBe('image')
    expect(inferMatteKind('D:/m/a.JPG')).toBe('image')
    expect(inferMatteKind('D:/m/a.mp4')).toBe('video')
    expect(inferMatteKind('D:/m/a.mkv')).toBe('video')
    expect(inferMatteKind('D:/m/a.xyz')).toBeNull()
    expect(resolveMatteKind({ mattePath: 'D:/m/a.png', matteKind: 'video' })).toBe('video')
    expect(resolveMatteKind({ mattePath: 'D:/m/a.xyz' })).toBeNull()
  })

  it('静态图 matte = 循环 1 帧；视频 matte = 普通 -i', () => {
    expect(buildMatteInputArgs(seg({ mattePath: 'D:/m/a.png' }), FPS_30)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30/1',
      '-t',
      '0.033333',
      '-i',
      'D:/m/a.png'
    ])
    expect(buildMatteInputArgs(seg({ mattePath: 'D:/m/a.mp4' }), FPS_30)).toEqual(['-i', 'D:/m/a.mp4'])
    expect(segmentWantsMatte(seg())).toBe(false)
    expect(segmentWantsMatte(seg({ mattePath: 'D:/m/a.mp4' }))).toBe(true)
  })

  it('输入编号：段媒体 → mask → matte → 帧流；overlayLabel = 段数 + mask 数 + matte 数', () => {
    const segments = [
      seg({ maskPath: 'D:/m/mask.png', mattePath: 'D:/m/a.mp4' }),
      seg({ timelineStartSec: 1, timelineEndSec: 2, sourceInSec: 1, sourceOutSec: 2, mattePath: 'D:/m/b.mp4' }),
      seg({ timelineStartSec: 2, timelineEndSec: 3, sourceInSec: 2, sourceOutSec: 3 })
    ]
    // N=3；mask 只有 1 个 → 3；matte 排在全部 mask 后：第一段 4、第二段 5
    expect(maskInputIndexFor(segments, 0)).toBe(3)
    expect(matteInputIndexFor(segments, 0)).toBe(4)
    expect(matteInputIndexFor(segments, 1)).toBe(5)

    const graph = buildMediaBasisFilterComplex(basis(segments, '6'))
    // 视频 matte 的帧索引对齐：fps → trim 帧索引 → setpts → gray/scale
    expect(graph).toContain(
      '[4:v]fps=30/1,trim=start_frame=0:end_frame=30,setpts=PTS-STARTPTS,format=gray,scale=1920:1080[mmt0]'
    )
    expect(graph).toContain(
      '[5:v]fps=30/1,trim=start_frame=30:end_frame=60,setpts=PTS-STARTPTS,format=gray,scale=1920:1080[mmt1]'
    )
    // mask 先、matte 后（matte 链的输入是 mask 链的输出 mons0）
    expect(graph).toContain('[mbs0][mams0]alphamerge[mons0]')
    expect(graph).toContain('[mons0]format=rgba[mbt0]')
  })

  it('有水印时 overlayLabel 只影响水印/帧流编号，matte 编号不变', () => {
    const args = buildMediaBasisFilterComplex(
      basis([seg({ mattePath: 'D:/m/a.mp4' })], '2')
    )
    expect(args).toContain('[1:v]fps=30/1,trim=start_frame=0:end_frame=30')
    expect(args).toContain('[2:v]setpts=PTS+0.000000/TB[ov]')
  })

  it('无 matte 时基座滤镜图与旧版逐字节一致', () => {
    const baseline = buildMediaBasisFilterComplex(basis([seg()]))
    expect(buildMediaBasisFilterComplex(basis([seg({ mattePath: '' })]))).toBe(baseline)
    expect(baseline).not.toContain('mmt')
    expect(baseline).not.toContain('start_frame')
  })

  it('多轨透明图层：matte 链保留 RGBA（不合黑底）', () => {
    const graph = buildMediaBasisFilterComplex({
      ...basis(
        [seg({ mattePath: 'D:/m/a.mp4', trackIndex: 0 }), seg({ mattePath: 'D:/m/b.mp4', trackIndex: 1 })],
        '4'
      )
    })
    expect(graph).toContain('[mbt1][mamt1]alphamerge[mont1]')
    expect(graph).not.toContain('[mbgt1]')
  })
})

describe('M8-P0 matte：导出前预检（可读错误）', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-matte-pre-'))
    await fs.writeFile(path.join(dir, 'matte.mp4'), Buffer.from('not-a-real-video'))
    await fs.writeFile(path.join(dir, 'matte.png'), Buffer.from('not-a-real-png'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('相对路径被拒绝', async () => {
    await expect(
      assertMatteInputs([seg({ mattePath: 'relative/matte.mp4', matteKind: 'video' })])
    ).rejects.toThrow(/绝对路径/)
  })

  it('文件不存在/为空被拒绝', async () => {
    await expect(
      assertMatteInputs([seg({ mattePath: path.join(dir, 'missing.mp4'), matteKind: 'video' })])
    ).rejects.toThrow(/文件不可用/)
  })

  it('扩展名无法判断且没有显式 kind 被拒绝', async () => {
    const unknown = path.join(dir, 'matte.xyz')
    await fs.writeFile(unknown, 'x')
    await expect(assertMatteInputs([seg({ mattePath: unknown })])).rejects.toThrow(/无法判断/)
  })

  it('视频 matte + 变速被拒绝', async () => {
    await expect(
      assertMatteInputs([
        seg({
          mattePath: path.join(dir, 'matte.mp4'),
          matteKind: 'video',
          speed: { speed: 2, maintainPitch: true }
        })
      ])
    ).rejects.toThrow(/变速/)
  })

  it('视频 matte + 转场切点被拒绝', async () => {
    const target = path.join(dir, 'matte.mp4')
    await expect(
      assertMatteInputs([seg({ mattePath: target, matteKind: 'video', transitionIn: { type: 'dissolve', durationSec: 0.5 } })])
    ).rejects.toThrow(/转场/)
    await expect(
      assertMatteInputs([
        seg({ mattePath: target, matteKind: 'video', timelineStartSec: 0, timelineEndSec: 1 }),
        seg({
          timelineStartSec: 1,
          timelineEndSec: 2,
          sourceInSec: 1,
          sourceOutSec: 2,
          transitionIn: { type: 'dissolve', durationSec: 0.5 }
        })
      ])
    ).rejects.toThrow(/转场/)
  })

  it('静态图 matte 不触发视频限制；文件可读即通过', async () => {
    await expect(
      assertMatteInputs([
        seg({ mattePath: path.join(dir, 'matte.png'), matteKind: 'image', speed: { speed: 2, maintainPitch: true } })
      ])
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 真机 e2e（缺随包 FFmpeg 时整组 skip）
// ---------------------------------------------------------------------------

const HAS_FFMPEG = fsSync.existsSync(FFMPEG)

interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }))
  })
}

const WIDTH = 320
const HEIGHT = 180

async function grayMean(input: string, crop: string, frameIndex?: number): Promise<number> {
  const select = frameIndex === undefined ? '' : `select=eq(n\\,${frameIndex}),`
  const result = await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `${select}crop=${crop},format=gray`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    'pipe:1'
  ])
  expect(result.code, result.stderr).toBe(0)
  if (result.stdout.length === 0) return Number.NaN
  let sum = 0
  for (const byte of result.stdout) sum += byte
  return sum / result.stdout.length
}

async function countFrames(input: string): Promise<number> {
  const result = await run(FFMPEG, ['-hide_banner', '-i', input, '-map', '0:v', '-f', 'null', '-'])
  expect(result.code, result.stderr).toBe(0)
  const matches = [...result.stderr.matchAll(/frame=\s*(\d+)/g)]
  const last = matches.at(-1)
  return last ? Number(last[1]) : Number.NaN
}

function maskPng(leftCut: number): Buffer {
  const rgba = rgbaFrame(WIDTH, HEIGHT, (x) =>
    x < leftCut ? [0, 0, 0, 255] : [255, 255, 255, 255]
  )
  return encodeRgbaPng(WIDTH, HEIGHT, rgba)
}

describe.skipIf(!HAS_FFMPEG)('M8-P0 matte 真机 e2e', () => {
  let dir = ''
  let source = ''
  let source2 = ''
  let matteVideo = ''
  let matteShort = ''
  let framesPattern = ''
  let frames60Pattern = ''

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-matte-e2e-'))
    source = path.join(dir, 'src1.mp4')
    source2 = path.join(dir, 'src2.mp4')
    matteVideo = path.join(dir, 'matte30.mp4')
    matteShort = path.join(dir, 'matte10.mp4')
    // 源：1s / 2s 纯红（30fps）
    for (const [target, duration] of [
      [source, 1],
      [source2, 2]
    ] as const) {
      const made = await run(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=red:s=${WIDTH}x${HEIGHT}:r=30:d=${duration}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        target
      ])
      expect(made.code, made.stderr).toBe(0)
    }
    // 等长视频 matte（30fps、1s）：左黑右白
    const made30 = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${WIDTH}x${HEIGHT}:r=30:d=1`,
      '-vf',
      `drawbox=x=${WIDTH / 2}:y=0:w=${WIDTH / 2}:h=${HEIGHT}:color=white:t=fill,format=gray`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'gray',
      matteVideo
    ])
    expect(made30.code, made30.stderr).toBe(0)
    // 短 matte（10fps 网格、1s）：左黑右白（源 2s → 后半靠 repeatlast 补齐）
    const made10 = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=black:s=${WIDTH}x${HEIGHT}:r=10:d=1`,
      '-vf',
      `drawbox=x=${WIDTH / 2}:y=0:w=${WIDTH / 2}:h=${HEIGHT}:color=white:t=fill,format=gray`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'gray',
      matteShort
    ])
    expect(made10.code, made10.stderr).toBe(0)
    // 透明字幕帧替身（30/60 帧）
    framesPattern = path.join(dir, 'f30_%03d.png')
    frames60Pattern = path.join(dir, 'f60_%03d.png')
    const empty = encodeRgbaPng(WIDTH, HEIGHT, rgbaFrame(WIDTH, HEIGHT, () => [0, 0, 0, 0]))
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        fs.writeFile(path.join(dir, `f30_${String(i + 1).padStart(3, '0')}.png`), empty)
      )
    )
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        fs.writeFile(path.join(dir, `f60_${String(i + 1).padStart(3, '0')}.png`), empty)
      )
    )
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('等长视频 matte：帧数与源一致（不多 1 帧）、左半隐藏/右半可见', async () => {
    const graph = buildMediaBasisFilterComplex({
      segments: [
        {
          refVideoPath: source,
          timelineStartSec: 0,
          timelineEndSec: 1,
          sourceInSec: 0,
          sourceOutSec: 1,
          hasAudio: false,
          mattePath: matteVideo,
          matteKind: 'video'
        }
      ],
      spanStartSec: 0,
      spanEndSec: 1,
      overlayLabel: '2',
      outputPath: '',
      fps: FPS_30,
      frameSize: { width: WIDTH, height: HEIGHT },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    const output = path.join(dir, 'matte-equal.mp4')
    const result = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-i',
      matteVideo,
      '-framerate',
      '30',
      '-i',
      framesPattern,
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-map',
      '[ab]',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-c:a',
      'aac',
      output
    ])
    expect(result.code, result.stderr).toBe(0)
    // 研究结论回归锁：等长 matte 不能把 1s 段变成 31 帧
    expect(await countFrames(output)).toBe(30)
    expect(await grayMean(output, `160:180:0:0`)).toBeLessThan(5)
    expect(await grayMean(output, `160:180:160:0`)).toBeGreaterThan(40)
  })

  it('mask + matte 并存：先 mask（左半隐藏）再 matte（右半隐藏），中间可见', async () => {
    const mask = path.join(dir, 'mask-left.png')
    await fs.writeFile(mask, maskPng(80))
    const matte = path.join(dir, 'matte-right.mp4')
    // 右半黑（隐藏）、左半白：与 mask 的左侧隐藏叠加后只剩中间可见
    const made = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=white:s=${WIDTH}x${HEIGHT}:r=30:d=1`,
      '-vf',
      `drawbox=x=${WIDTH - 80}:y=0:w=80:h=${HEIGHT}:color=black:t=fill,format=gray`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'gray',
      matte
    ])
    expect(made.code, made.stderr).toBe(0)
    const graph = buildMediaBasisFilterComplex({
      segments: [
        {
          refVideoPath: source,
          timelineStartSec: 0,
          timelineEndSec: 1,
          sourceInSec: 0,
          sourceOutSec: 1,
          hasAudio: false,
          maskPath: mask,
          mattePath: matte,
          matteKind: 'video'
        }
      ],
      spanStartSec: 0,
      spanEndSec: 1,
      overlayLabel: '3',
      outputPath: '',
      fps: FPS_30,
      frameSize: { width: WIDTH, height: HEIGHT },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    expect(graph).toContain('[1:v]format=gray,scale=320:180[mms0]')
    expect(graph).toContain('[2:v]fps=30/1,trim=start_frame=0:end_frame=30')
    expect(graph).toContain('[mons0]format=rgba[mbt0]')
    const output = path.join(dir, 'mask-matte.mp4')
    const result = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      ...buildMaskInputArgs(mask, FPS_30),
      '-i',
      matte,
      '-framerate',
      '30',
      '-i',
      framesPattern,
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-map',
      '[ab]',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-c:a',
      'aac',
      output
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(await countFrames(output)).toBe(30)
    expect(await grayMean(output, `40:180:0:0`)).toBeLessThan(5) // mask 隐藏左半
    expect(await grayMean(output, `80:180:120:0`)).toBeGreaterThan(40) // 中间可见
    expect(await grayMean(output, `40:180:280:0`)).toBeLessThan(5) // matte 隐藏右半
  })

  it('短 matte（10fps 1s vs 源 2s）：帧数仍是 60，后半靠 repeatlast 保持遮罩', async () => {
    const graph = buildMediaBasisFilterComplex({
      segments: [
        {
          refVideoPath: source2,
          timelineStartSec: 0,
          timelineEndSec: 2,
          sourceInSec: 0,
          sourceOutSec: 2,
          hasAudio: false,
          mattePath: matteShort,
          matteKind: 'video'
        }
      ],
      spanStartSec: 0,
      spanEndSec: 2,
      overlayLabel: '2',
      outputPath: '',
      fps: FPS_30,
      frameSize: { width: WIDTH, height: HEIGHT },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    const output = path.join(dir, 'matte-short.mp4')
    const result = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source2,
      '-i',
      matteShort,
      '-framerate',
      '30',
      '-i',
      frames60Pattern,
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-map',
      '[ab]',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-c:a',
      'aac',
      output
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(await countFrames(output)).toBe(60)
    // 末帧（第 60 帧）左半仍被短 matte 遮住（repeatlast）
    expect(await grayMean(output, `160:180:0:0`, 59)).toBeLessThan(5)
    expect(await grayMean(output, `160:180:160:0`, 59)).toBeGreaterThan(40)
  })
})
