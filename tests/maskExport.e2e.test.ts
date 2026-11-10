import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMaskInputArgs, buildMediaBasisFilterComplex, buildMediaMaskFilterChain } from '@shared/ffmpegArgs'
import { FPS_30 } from '@shared/constants'
import { encodeRgbaPng, rgbaFrame } from './helpers/png'

/**
 * M8 手绘遮罩 · 真机 e2e（真 FFmpeg）。
 *
 * 口径与生产完全一致：
 * - 遮罩 PNG 用与 Canvas `destination-out` 等价的数据（白底不透明；hide 区 RGB=黑、alpha=0）；
 * - 滤镜串直接来自 `buildMediaMaskFilterChain`（单轨黑底 / 多轨透明两条分支各跑一次）；
 * - mask 输入参数直接来自 `buildMaskInputArgs`（静态图只喂 1 帧，靠 framesync repeatlast 补齐）。
 *
 * 断言：
 * 1. 单轨不透明：左半（hide）像素真的变黑、右半保持原画面；输出帧数 = 段长帧数（循环输入没把段拖长）；
 * 2. 多轨透明：左半 alpha=0（透出下层）、右半 alpha=255。
 *
 * 缺随包 FFmpeg 时整组 skip（不假绿）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = process.platform === 'win32' ? '.exe' : ''
const FFMPEG = path.join(ROOT, 'resources', 'ffmpeg', `ffmpeg${EXE}`)
const HAS_FFMPEG = fsSync.existsSync(FFMPEG)
const WIDTH = 320
const HEIGHT = 180
/** 左半 hide、右半可见的遮罩（与预览 maskCapture 的 destination-out 输出同数据）。 */
function makeMaskPng(): Buffer {
  const rgba = rgbaFrame(WIDTH, HEIGHT, (x) => (x < WIDTH / 2 ? [0, 0, 0, 0] : [255, 255, 255, 255]))
  return encodeRgbaPng(WIDTH, HEIGHT, rgba)
}

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

/** 解一帧 → 灰度原始字节（crop + format=gray），返回均值与样本数。 */
async function grayMean(input: string, crop: string, frameIndex?: number): Promise<{ mean: number; count: number }> {
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
  const bytes = result.stdout
  if (bytes.length === 0) return { mean: Number.NaN, count: 0 }
  let sum = 0
  for (const byte of bytes) sum += byte
  return { mean: sum / bytes.length, count: bytes.length }
}

async function countFrames(input: string): Promise<number> {
  const result = await run(FFMPEG, ['-hide_banner', '-i', input, '-map', '0:v', '-f', 'null', '-'])
  expect(result.code, result.stderr).toBe(0)
  const matches = [...result.stderr.matchAll(/frame=\s*(\d+)/g)]
  const last = matches.at(-1)
  return last ? Number(last[1]) : Number.NaN
}

describe.skipIf(!HAS_FFMPEG)('M8 遮罩真机 e2e（滤镜串 + 黑底/透明两条分支）', () => {
  let dir = ''
  let source = ''
  let source2 = ''
  let mask = ''

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-mask-e2e-'))
    source = path.join(dir, 'src.mp4')
    source2 = path.join(dir, 'src2.mp4')
    mask = path.join(dir, 'mask.png')
    for (const [target, color] of [
      [source, 'red'],
      [source2, 'blue']
    ] as const) {
      const made = await run(FFMPEG, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=${WIDTH}x${HEIGHT}:r=30:d=1`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        target
      ])
      expect(made.code, made.stderr).toBe(0)
    }
    await fs.writeFile(mask, makeMaskPng())
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('单轨基座：hide 区真的黑、可见区保持原画面、帧数不变', async () => {
    const chain = buildMediaMaskFilterChain({
      id: 0,
      sourceLabel: 'src',
      maskInputIndex: 1,
      frameSize: { width: WIDTH, height: HEIGHT },
      fps: FPS_30,
      durationSec: 1,
      opaqueBackground: true
    })
    const filter = [`[0:v]fps=30,setsar=1,format=yuv420p[src]`, ...chain.statements].join(';')
    const output = path.join(dir, 'opaque.mp4')
    const result = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      ...buildMaskInputArgs(mask, FPS_30),
      '-filter_complex',
      filter,
      '-map',
      `[${chain.outputLabel}]`,
      '-c:v',
      'libx264',
      '-crf',
      '18',
      output
    ])
    expect(result.code, result.stderr).toBe(0)

    // 循环的 mask 输入不能把段拖长：输出必须仍是 1s @30fps = 30 帧
    expect(await countFrames(output)).toBe(30)
    const left = await grayMean(output, `160:180:0:0`)
    const right = await grayMean(output, `160:180:160:0`)
    // 左半（hide）：黑（y≈16 为 limited range 的全黑；取 < 5 更保险）
    expect(left.mean).toBeLessThan(5)
    // 右半（可见）：纯红在 yuv420p 下 luma ≈ 76，必须明显大于黑
    expect(right.mean).toBeGreaterThan(40)
  })

  it('多轨透明图层：hide 区 alpha=0（透出下层）、可见区 alpha=255', async () => {
    const chain = buildMediaMaskFilterChain({
      id: 0,
      sourceLabel: 'src',
      maskInputIndex: 1,
      frameSize: { width: WIDTH, height: HEIGHT },
      fps: FPS_30,
      durationSec: 1,
      opaqueBackground: false
    })
    const filter = [`[0:v]fps=30,setsar=1,format=rgba[src]`, ...chain.statements].join(';')
    const output = path.join(dir, 'rgba_%03d.png')
    const result = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      ...buildMaskInputArgs(mask, FPS_30),
      '-filter_complex',
      filter,
      '-map',
      `[${chain.outputLabel}]`,
      '-frames:v',
      '1',
      output
    ])
    expect(result.code, result.stderr).toBe(0)

    const png = path.join(dir, 'rgba_001.png')
    const left = await grayMeanAlpha(png, `160:180:0:0`)
    const right = await grayMeanAlpha(png, `160:180:160:0`)
    expect(left.mean).toBeLessThan(5)
    expect(right.mean).toBeGreaterThan(250)
  })

  it('真实 builder 接线：mask 输入序号 / concat / 字幕叠加之后 hide 区仍黑', async () => {
    // 输入顺序：0=媒体、1=mask、2=stdin 帧流（这里用 30 张全透明 PNG 顶替渲染帧，
    // 必须与生产同样是 30 帧，否则测到的是“单帧字幕层”而不是真实叠加）
    const framesPattern = path.join(dir, 'empty_%03d.png')
    const emptyFrame = encodeRgbaPng(WIDTH, HEIGHT, rgbaFrame(WIDTH, HEIGHT, () => [0, 0, 0, 0]))
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        fs.writeFile(path.join(dir, `empty_${String(index + 1).padStart(3, '0')}.png`), emptyFrame)
      )
    )

    const graph = buildMediaBasisFilterComplex({
      segments: [
        {
          refVideoPath: source,
          timelineStartSec: 0,
          timelineEndSec: 1,
          sourceInSec: 0,
          sourceOutSec: 1,
          hasAudio: false,
          maskPath: mask
        }
      ],
      spanStartSec: 0,
      spanEndSec: 1,
      // 1 段 + 1 个遮罩 → 帧流是 2 号输入（mask 是 1 号）
      overlayLabel: '2',
      outputPath: '',
      fps: FPS_30,
      frameSize: { width: WIDTH, height: HEIGHT },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    // 生产段链的最终标签就是 mouts0（遮罩 → 黑底 → yuv420p）
    expect(graph).toContain('[1:v]format=gray,scale=320:180[mms0]')
    expect(graph).toContain('[mouts0]null[vs0]')

    const output = path.join(dir, 'builder.mp4')
    const result = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      ...buildMaskInputArgs(mask, FPS_30),
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
    const left = await grayMean(output, `160:180:0:0`)
    const right = await grayMean(output, `160:180:160:0`)
    expect(left.mean).toBeLessThan(5)
    expect(right.mean).toBeGreaterThan(40)
  })

  it('两段拼接：遮罩段不多不少一帧（后一段入点不因 trim/fps 错位）', async () => {
    const framesPattern = path.join(dir, 'two_%03d.png')
    const emptyFrame = encodeRgbaPng(WIDTH, HEIGHT, rgbaFrame(WIDTH, HEIGHT, () => [0, 0, 0, 0]))
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        fs.writeFile(path.join(dir, `two_${String(index + 1).padStart(3, '0')}.png`), emptyFrame)
      )
    )
    const graph = buildMediaBasisFilterComplex({
      segments: [
        {
          refVideoPath: source,
          timelineStartSec: 0,
          timelineEndSec: 1,
          sourceInSec: 0,
          sourceOutSec: 1,
          hasAudio: false,
          maskPath: mask
        },
        {
          refVideoPath: source2,
          timelineStartSec: 1,
          timelineEndSec: 2,
          sourceInSec: 0,
          sourceOutSec: 1,
          hasAudio: false
        }
      ],
      spanStartSec: 0,
      spanEndSec: 2,
      // 2 段 + 1 个遮罩 → 帧流是 3 号输入（0/1 是两段媒体、2 是 mask）
      overlayLabel: '3',
      outputPath: '',
      fps: FPS_30,
      frameSize: { width: WIDTH, height: HEIGHT },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    const output = path.join(dir, 'two-seg.mp4')
    const result = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-i',
      source2,
      ...buildMaskInputArgs(mask, FPS_30),
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
    // 2s @30fps = 60 帧：遮罩段（trim/black/trim）没有把后一段推后一帧
    expect(await countFrames(output)).toBe(60)

    // 第 0 帧：左半被遮罩（黑）、右半是红
    const firstLeft = await grayMean(output, `160:180:0:0`, 0)
    const firstRight = await grayMean(output, `160:180:160:0`, 0)
    expect(firstLeft.mean).toBeLessThan(5)
    expect(firstRight.mean).toBeGreaterThan(40)
    // 第 30 帧（第二段入点）：整幅都是蓝（蓝的 luma 明显低于红）
    const secondLeft = await grayMean(output, `160:180:0:0`, 30)
    expect(secondLeft.mean).toBeGreaterThan(15)
    expect(secondLeft.mean).toBeLessThan(60)
    // 末帧仍是蓝（没有被裁掉/错位）
    const lastLeft = await grayMean(output, `160:180:0:0`, 59)
    expect(lastLeft.mean).toBeGreaterThan(15)
    expect(lastLeft.mean).toBeLessThan(60)
  })
})

/** 取 alpha 平面均值（alphaextract + crop）。 */
async function grayMeanAlpha(input: string, crop: string): Promise<{ mean: number; count: number }> {
  const result = await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `alphaextract,crop=${crop}`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    'pipe:1'
  ])
  expect(result.code, result.stderr).toBe(0)
  const bytes = result.stdout
  if (bytes.length === 0) return { mean: Number.NaN, count: 0 }
  let sum = 0
  for (const byte of bytes) sum += byte
  return { mean: sum / bytes.length, count: bytes.length }
}
