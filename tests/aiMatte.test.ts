import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildMediaBasisFilterComplex } from '@shared/ffmpegArgs'
import { FPS_30 } from '@shared/constants'
import { encodeRgbaPng, rgbaFrame } from './helpers/png'

/**
 * M8-P1：AI 人像抠像（可注入 detector）。
 * - 纯函数：尺寸/缩放/NCHW/alpha 后处理/缓存键稳定性；
 * - 可选加载：运行时缺失/模型缺失给可读错误码；
 * - 真 FFmpeg + 假 detector 端到端：生成 matte 视频 → 帧数一致 → M8-P0 段链导出左隐右显；
 * - 缓存命中第二次不推理；取消可读返回。
 * 真模型用例 skipIf（缺 onnxruntime-node/模型），不把下载带进 verify。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = process.platform === 'win32' ? '.exe' : ''
const FFMPEG = path.join(ROOT, 'resources', 'ffmpeg', `ffmpeg${EXE}`)
const HAS_FFMPEG = fsSync.existsSync(FFMPEG)
const TEST_ROOT = fsSync.mkdtempSync(path.join(os.tmpdir(), 'socut-ai-matte-'))
const USER_DATA = path.join(TEST_ROOT, 'userData')
const MODEL_PATH = path.join(TEST_ROOT, 'selfie_segmenter.onnx')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => (name === 'userData' ? USER_DATA : path.join(TEST_ROOT, name)),
    getAppPath: () => ROOT
  },
  // 进度广播会走 BrowserWindow.getAllWindows()（window 传 null 时），桩里必须有静态方法
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
  }
}))

const ai = await import('../src/main/aiMatte')

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
async function countFrames(input: string): Promise<number> {
  const result = await run(FFMPEG, ['-hide_banner', '-i', input, '-map', '0:v', '-f', 'null', '-'])
  expect(result.code, result.stderr).toBe(0)
  const matches = [...result.stderr.matchAll(/frame=\s*(\d+)/g)]
  const last = matches.at(-1)
  return last ? Number(last[1]) : Number.NaN
}
async function grayMean(input: string, crop: string): Promise<number> {
  const result = await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-vf',
    `crop=${crop},format=gray`,
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

beforeAll(async () => {
  await fs.mkdir(USER_DATA, { recursive: true })
  // 假模型（只用于算模型 sha；真加载发生在真模型用例里）
  await fs.writeFile(MODEL_PATH, Buffer.from('fake-onnx-model-for-cache-key'))
  process.env.SOCUT_MATTE_MODEL_PATH = MODEL_PATH
})

afterAll(async () => {
  delete process.env.SOCUT_MATTE_MODEL_PATH
  ai.setMatteDetectorFactoryForTests(null)
  await fs.rm(TEST_ROOT, { recursive: true, force: true })
})

describe('M8-P1 纯函数：尺寸/缩放/NCHW/alpha', () => {
  it('matte 尺寸：长边 512、偶数、保持比例', () => {
    expect(ai.matteSizeFor(1920, 1080)).toEqual({ width: 512, height: 288 })
    expect(ai.matteSizeFor(1080, 1920)).toEqual({ width: 288, height: 512 })
    expect(ai.matteSizeFor(320, 180)).toEqual({ width: 512, height: 288 })
    for (const size of [ai.matteSizeFor(640, 480), ai.matteSizeFor(100, 1000)]) {
      expect(size.width % 2).toBe(0)
      expect(size.height % 2).toBe(0)
    }
  })

  it('RGBA 双线性缩放保持四通道与 2×2 中值', () => {
    const src = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
    const up = ai.resizeRgba(src, 2, 2, 4, 4)
    expect(up).toHaveLength(4 * 4 * 4)
    // 左上区域仍偏红
    expect(up[0]).toBeGreaterThan(200)
    expect(up[1]).toBeLessThan(60)
    expect(up[3]).toBe(255)
    expect([...ai.resizeRgba(src, 2, 2, 2, 2)]).toEqual([...src])
  })

  it('RGBA → NCHW float32：三平面、/255、通道顺序 R/G/B', () => {
    const rgba = new Uint8Array(4 * 4 * 4)
    rgba[0] = 255
    rgba[1] = 128
    rgba[2] = 0
    rgba[3] = 255
    const nchw = ai.rgbaToNchwF32(ai.resizeRgba(rgba, 2, 2, 4, 4), 4)
    expect(nchw).toHaveLength(3 * 4 * 4)
    expect(nchw[0]).toBeCloseTo(1, 5)
    expect(nchw[16]).toBeCloseTo(128 / 255, 5)
    expect(nchw[32]).toBeCloseTo(0, 5)
  })

  it('alpha 平面 → 目标尺寸灰度：0..1 夹取、0/255 边界、缩小取邻域', () => {
    const alpha = new Float32Array(4 * 4)
    // 左半 0，右半 1
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) alpha[y * 4 + x] = x < 2 ? 0 : 1
    const gray = ai.alphaPlaneToGray(alpha, 4, 4, 8, 8)
    expect(gray).toHaveLength(64)
    expect(gray[4 * 8 + 1]).toBeLessThan(10)
    expect(gray[4 * 8 + 6]).toBeGreaterThan(245)
    // 越界值夹取
    const dirty = new Float32Array([2, -1, 0.5, 0.5])
    expect([...ai.alphaPlaneToGray(dirty, 2, 2, 2, 2)]).toEqual([255, 0, 128, 128])
  })

  it('缓存键：同源同参数稳定；mtime/区间/fps/模型/尺寸任一变化都换键', () => {
    const base = {
      sourcePath: 'D:/media/a.mp4',
      sourceSize: 1000,
      sourceMtimeMs: 123456789,
      sourceInSec: 0,
      sourceOutSec: 2,
      fps: FPS_30,
      modelSha256: 'a'.repeat(64),
      width: 512,
      height: 288
    }
    const key = ai.matteCacheKey(base)
    expect(ai.matteCacheKey({ ...base })).toBe(key)
    expect(ai.matteCacheKey({ ...base, sourceMtimeMs: 123456790 })).not.toBe(key)
    expect(ai.matteCacheKey({ ...base, sourceOutSec: 3 })).not.toBe(key)
    expect(ai.matteCacheKey({ ...base, fps: { num: 25, den: 1 } })).not.toBe(key)
    expect(ai.matteCacheKey({ ...base, modelSha256: 'b'.repeat(64) })).not.toBe(key)
    expect(ai.matteCacheKey({ ...base, width: 640, height: 360 })).not.toBe(key)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('M8-P1 运行时/模型可选加载（可读错误）', () => {
  it('运行时缺失 → AI_RUNTIME_MISSING；模型缺失 → AI_MODEL_MISSING', async () => {
    await expect(
      ai.createMatteDetector({
        modelPath: MODEL_PATH,
        runtimeLoader: () => ({ ok: false, reason: 'onnxruntime-node 未安装' })
      })
    ).rejects.toMatchObject({ code: 'AI_RUNTIME_MISSING' })
    await expect(
      ai.createMatteDetector({
        modelPath: path.join(TEST_ROOT, 'missing.onnx'),
        runtimeLoader: () => ({ ok: true, ort: {} as never })
      })
    ).rejects.toMatchObject({ code: 'AI_MODEL_MISSING' })
  })

  it('假运行时 + 假模型：detector.detect 走 NCHW/输出 alpha 路径', async () => {
    let fed: { dims: number[]; len: number } | null = null
    const fakeOrt = {
      Tensor: class {
        constructor(
          readonly type: string,
          readonly data: Float32Array,
          readonly dims: number[]
        ) {}
      },
      InferenceSession: {
        create: async () => ({
          inputNames: ['pixel_values'],
          outputNames: ['alphas'],
          run: async (feeds: Record<string, { data: Float32Array; dims: number[] }>) => {
            const input = feeds['pixel_values']!
            fed = { dims: input.dims, len: input.data.length }
            const alpha = new Float32Array(256 * 256)
            for (let y = 0; y < 256; y += 1) {
              for (let x = 0; x < 256; x += 1) alpha[y * 256 + x] = x < 128 ? 0 : 1
            }
            return { alphas: new fakeOrt.Tensor('float32', alpha, [1, 1, 256, 256]) as never }
          }
        })
      }
    }
    const detector = await ai.createMatteDetector({
      modelPath: MODEL_PATH,
      runtimeLoader: () => ({ ok: true, ort: fakeOrt as never })
    })
    const rgba = new Uint8Array(64 * 36 * 4).fill(128)
    const gray = await detector.detect(rgba, 64, 36)
    expect(fed).toEqual({ dims: [1, 3, 256, 256], len: 3 * 256 * 256 })
    expect(gray).toHaveLength(64 * 36)
    expect(gray[18 * 64 + 2]).toBeLessThan(10)
    expect(gray[18 * 64 + 60]).toBeGreaterThan(245)
  })
})

describe.skipIf(!HAS_FFMPEG)('M8-P1 假 detector 端到端（真 FFmpeg）', () => {
  let source = ''
  let detectCalls = 0
  const frames30 = path.join(TEST_ROOT, 'frames_%03d.png')
  const WIDTH = 320
  const HEIGHT = 180
  const DURATION = 0.3
  const FRAMES = Math.round(DURATION * 30)

  beforeAll(async () => {
    source = path.join(TEST_ROOT, 'src.mp4')
    const made = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=red:s=${WIDTH}x${HEIGHT}:r=30:d=${DURATION}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source
    ])
    expect(made.code, made.stderr).toBe(0)
    const empty = encodeRgbaPng(WIDTH, HEIGHT, rgbaFrame(WIDTH, HEIGHT, () => [0, 0, 0, 0]))
    await Promise.all(
      Array.from({ length: FRAMES }, (_, i) =>
        fs.writeFile(path.join(TEST_ROOT, `frames_${String(i + 1).padStart(3, '0')}.png`), empty)
      )
    )
    ai.setMatteDetectorFactoryForTests(async () => ({
      async detect(_rgba, width, height) {
        detectCalls += 1
        const gray = new Uint8Array(width * height)
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) gray[y * width + x] = x < width / 2 ? 0 : 255
        }
        return gray
      }
    }))
  })

  it('生成 matte（帧数一致）→ M8-P0 段链导出左隐右显 → 二次缓存命中不推理', async () => {
    const request = {
      clipId: 'clip-ai-1',
      sourcePath: source,
      sourceInSec: 0,
      sourceOutSec: DURATION,
      fps: FPS_30,
      sourceWidth: WIDTH,
      sourceHeight: HEIGHT
    }
    const queued = await ai.applyAiMatte(request, null)
    expect(queued.status).toBe('queued')
    const result = await ai.waitForAiMatteJob(queued.jobId)
    expect(result.ok, result.error?.message).toBe(true)
    const mattePath = result.outputPath!
    expect(fsSync.existsSync(mattePath)).toBe(true)
    expect(await countFrames(mattePath)).toBe(FRAMES)
    expect(detectCalls).toBe(FRAMES)

    // M8-P0 段链：用生成的视频 matte 跑一次真实合成（透明帧替身 = 字幕层）
    const graph = buildMediaBasisFilterComplex({
      segments: [
        {
          refVideoPath: source,
          timelineStartSec: 0,
          timelineEndSec: DURATION,
          sourceInSec: 0,
          sourceOutSec: DURATION,
          hasAudio: false,
          mattePath,
          matteKind: 'video'
        }
      ],
      spanStartSec: 0,
      spanEndSec: DURATION,
      overlayLabel: '2',
      outputPath: '',
      fps: FPS_30,
      frameSize: { width: WIDTH, height: HEIGHT },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    const output = path.join(TEST_ROOT, 'export.mp4')
    const exported = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-i',
      mattePath,
      '-framerate',
      '30',
      '-i',
      frames30,
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
    expect(exported.code, exported.stderr).toBe(0)
    expect(await countFrames(output)).toBe(FRAMES)
    expect(await grayMean(output, '160:180:0:0')).toBeLessThan(5)
    expect(await grayMean(output, '160:180:160:0')).toBeGreaterThan(40)

    // 缓存命中：同请求第二次 → cached，且不再调用 detector
    const callsBefore = detectCalls
    const again = await ai.applyAiMatte(request, null)
    expect(again.status).toBe('cached')
    expect(again.path).toBe(mattePath)
    expect(detectCalls).toBe(callsBefore)
  })

  it('媒体不存在 → MEDIA_NOT_FOUND；取消 → CANCELLED 且不留半成品', async () => {
    await expect(
      ai.applyAiMatte(
        {
          clipId: 'clip-missing',
          sourcePath: path.join(TEST_ROOT, 'missing.mp4'),
          sourceInSec: 0,
          sourceOutSec: 1,
          fps: FPS_30,
          sourceWidth: WIDTH,
          sourceHeight: HEIGHT
        },
        null
      )
    ).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' })

    // 取消用例必须用「缓存里没有」的区间：0..DURATION 已被上一个用例缓存命中，那时不会真起作业
    const request = {
      clipId: 'clip-cancel',
      sourcePath: source,
      sourceInSec: 0,
      sourceOutSec: 0.1,
      fps: FPS_30,
      sourceWidth: WIDTH,
      sourceHeight: HEIGHT
    }
    const queued = await ai.applyAiMatte(request, null)
    expect(queued.status).toBe('queued')
    const resultPromise = ai.waitForAiMatteJob(queued.jobId)
    await ai.cancelAiMatte(queued.jobId)
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('CANCELLED')
    // 取消不留半成品：缓存目录里不应留这个区间的产物
    expect(result.outputs).toEqual([])
  })
})

/** 真模型用例：缺 onnxruntime-node 或模型时 skip（不假绿）。 */
const realRuntime = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('onnxruntime-node')
    return fsSync.existsSync(path.join(ROOT, 'resources', 'models', 'matte', 'selfie_segmenter.onnx'))
  } catch {
    return false
  }
})()

describe.skipIf(!realRuntime)('M8-P1 真模型（onnxruntime-node + Selfie Segmenter）', () => {
  it('256² 模型可加载并对合成人像帧产出中心高 alpha / 背景低 alpha', async () => {
    const modelPath = path.join(ROOT, 'resources', 'models', 'matte', 'selfie_segmenter.onnx')
    const detector = await ai.createMatteDetector({ modelPath })
    // 合成「人像」：椭圆头部 + 躯干色块压在纯色背景上（真模型对纯色帧会合法地给全 0，不能拿它当断言）
    const size = 256
    const rgba = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const o = (y * size + x) * 4
        const head = (x - 128) ** 2 + (y - 70) ** 2 < 54 ** 2
        const body = y > 110 && Math.abs(x - 128) < 46 + (y - 110) * 0.35
        const color = head ? [235, 190, 160] : body ? [60, 70, 120] : [40, 90, 160]
        rgba[o] = color[0]!
        rgba[o + 1] = color[1]!
        rgba[o + 2] = color[2]!
        rgba[o + 3] = 255
      }
    }
    const gray = await detector.detect(rgba, size, size)
    expect(gray).toHaveLength(size * size)
    // 中心（头部）保留，四角（背景）隐藏；再跑一次同输入必须同输出（CPU EP 确定性）
    expect(gray[128 * size + 128]).toBeGreaterThan(200)
    expect(gray[10 * size + 10]).toBeLessThan(20)
    const again = await detector.detect(rgba, size, size)
    expect([...again]).toEqual([...gray])
  })
})
