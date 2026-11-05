import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ALPHA_DROPPED_MARKER,
  buildAudioPeaksArgs,
  buildCfrArgs,
  buildOverlayMp4,
  buildOverlayMp4DirectPipe,
  buildOverlayMp4MultiInput,
  buildProbeArgs,
  buildStabDetectArgs,
  buildStabPreviewArgs,
  buildTransparentMovFromPipe,
  buildVerifyArgs,
  buildVfrSampleArgs,
  computeWatermarkGeometry,
  formatSec
} from '@shared/ffmpegArgs'
import type { AudioMixClip, ConcatSegment } from '@shared/ffmpegArgs'
import { defaultMediaStab } from '@shared/mediaStab'
import { spectrumPeaksFromPcm } from '@shared/audioPeaks'
import type { MediaClipStab } from '@shared/types'
import {
  analyzeVfrSample,
  detectCompat,
  frameRateMatches,
  isDeliveryYuv420p,
  isProres4444WithAlpha,
  parseProbeJson,
  parseVerifyJson
} from '@shared/probe'
import { FPS_29_97, FPS_30 } from '@shared/constants'
import { encodeRgbaPng, rgbaFrame } from './helpers/png'

/** 生成一帧未压缩 RGBA（主路径 rawvideo 消费），与 alphaFrames 使用同一画法。 */
function rgbaBufferFor(width: number, height: number, frame: number): Buffer {
  return rgbaFrame(width, height, (x, y) => {
    if (y < Math.round(height * 0.35)) return x < Math.round(width * (0.2 + 0.05 * frame)) ? [20, 58, 107, 255] : null
    if (y >= Math.round(height * 0.5) && y < Math.round(height * 0.8)) {
      return x < Math.round(width * 0.6) ? [255, 255, 255, 128] : null
    }
    return null
  })
}

/**
 * FFmpeg 集成测试（计划「测试计划 · 集成」与各验收条的机器化部分）。
 * 全部使用生产同一套 argv 构造函数（@shared/ffmpegArgs）与解析函数（@shared/probe），
 * 因此这里通过即等于导出管线口径正确。缺少 FFmpeg 时整组跳过并显式提示。
 *
 * 覆盖：
 *  - 规格 §5.1 透明 MOV 主路径 + 计划 C1（profile=4 / alpha 未丢失 / fourcc=ap4h）
 *  - 规格 §5.2 叠加合成 + 计划 C2（alpha=straight）/ C3（链尾 yuv420p）/ C4（-map 0:a?）/ C7（span+enable）
 *  - 规格 §6.3/§6.4 VFR 检测与 CFR 转换后帧率一致（验收第 6 条）
 *  - 验收第 3/7 条的 FFmpeg 侧可验证部分（透明通道语义、音频 copy 成功）
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK_DIR = path.join(ROOT, 'spikes', 'tmp-integration')
const EXE = process.platform === 'win32' ? '.exe' : ''
const BUNDLED_FFMPEG = path.join(ROOT, 'resources', 'ffmpeg', `ffmpeg${EXE}`)
const BUNDLED_FFPROBE = path.join(ROOT, 'resources', 'ffmpeg', `ffprobe${EXE}`)

let ffmpeg = ''
let ffprobe = ''

interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

function run(bin: string, args: string[], stdin?: Buffer, opts?: { cwd?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, cwd: opts?.cwd })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }))
    if (stdin && child.stdin) {
      child.stdin.on('error', () => {
        /* 由 close 的 stderr 归因 */
      })
      child.stdin.end(stdin)
    }
  })
}

async function probeJson(target: string): Promise<unknown> {
  const result = await run(ffprobe, buildProbeArgs(target))
  if (result.code !== 0) throw new Error(`ffprobe 失败：${result.stderr.slice(-500)}`)
  return JSON.parse(result.stdout.toString('utf8')) as unknown
}

async function verifyJson(target: string): Promise<ReturnType<typeof parseVerifyJson>> {
  const result = await run(ffprobe, buildVerifyArgs(target))
  if (result.code !== 0) throw new Error(`ffprobe 校验失败：${result.stderr.slice(-500)}`)
  return parseVerifyJson(JSON.parse(result.stdout.toString('utf8')) as unknown)
}

/** 把若干 PNG 帧通过 image2pipe 送进 ffmpeg stdin（与 framePump 同口径：写完再 end）。 */
async function runWithFrames(args: string[], frames: Buffer[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout: Buffer.alloc(0), stderr }))
    const stdin = child.stdin
    if (!stdin) {
      reject(new Error('stdin 不可用'))
      return
    }
    stdin.on('error', () => {
      /* 提前退出由 close 归因 */
    })
    let index = 0
    const pump = (): void => {
      for (;;) {
        if (index >= frames.length) {
          stdin.end()
          return
        }
        const frame = frames[index]!
        index += 1
        if (!stdin.write(frame)) {
          stdin.once('drain', pump)
          return
        }
      }
    }
    pump()
  })
}

function alphaFrames(width: number, height: number, count: number): Buffer[] {
  const frames: Buffer[] = []
  for (let f = 0; f < count; f++) {
    const rgba = rgbaFrame(width, height, (x, y) => {
      if (y < Math.round(height * 0.35)) return x < Math.round(width * (0.2 + 0.05 * f)) ? [20, 58, 107, 255] : null
      if (y >= Math.round(height * 0.5) && y < Math.round(height * 0.8)) {
        return x < Math.round(width * 0.6) ? [255, 255, 255, 128] : null
      }
      return null
    })
    frames.push(encodeRgbaPng(width, height, rgba))
  }
  return frames
}

async function singlePng(target: string, width: number, height: number, color: [number, number, number, number]): Promise<void> {
  const rgba = rgbaFrame(width, height, () => color)
  await fs.writeFile(target, encodeRgbaPng(width, height, rgba))
}

beforeAll(async () => {
  const candidates = [BUNDLED_FFMPEG, BUNDLED_FFPROBE]
  const present = await Promise.all(
    candidates.map(async (file) => {
      try {
        await fs.access(file)
        return true
      } catch {
        return false
      }
    })
  )
  if (present[0] && present[1]) {
    ffmpeg = BUNDLED_FFMPEG
    ffprobe = BUNDLED_FFPROBE
  } else {
    // 回退到系统 PATH（开发机常见），并记录来源
    const probe = await run('ffmpeg', ['-version'])
    if (probe.code !== 0) throw new Error('未找到 FFmpeg：请先执行 npm run fetch:ffmpeg')
    ffmpeg = 'ffmpeg'
    ffprobe = 'ffprobe'
  }
  await fs.mkdir(WORK_DIR, { recursive: true })
})

afterAll(async () => {
  // 保留产物便于人工核对；只清理由 CI 场景显式设置的环境变量控制
  if (process.env.FOCUSNEWS_CLEAN_TMP) await fs.rm(WORK_DIR, { recursive: true, force: true })
})

describe('透明 ProRes 4444 管线（规格 §5.1 / 计划 C1）', () => {
  const width = 160
  const height = 90
  const frames = alphaFrames(width, height, 12)

  it('image2pipe → MOV：帧数、分辨率、帧率、alpha 全部正确', async () => {
    const output = path.join(WORK_DIR, 'transparent-2997.mov')
    const result = await runWithFrames(
      buildTransparentMovFromPipe(FPS_29_97, output, 'png', { width, height }),
      frames
    )
    expect(result.stderr).not.toContain(ALPHA_DROPPED_MARKER)
    expect(result.code).toBe(0)

    const verified = await verifyJson(output)
    expect(verified).not.toBeNull()
    if (!verified) return
    expect(verified.width).toBe(width)
    expect(verified.height).toBe(height)
    // C11：解码侧像素格式报告为 12 位 yuva，不能死磕 yuva444p10le
    expect(isProres4444WithAlpha(verified)).toBe(true)
    expect(frameRateMatches(verified, FPS_29_97)).toBe(true)
    expect(Number(verified.nbFrames)).toBe(frames.length)
  }, 180_000)

  it('未压缩 RGBA 帧流主路径（rawvideo）同样产出合规 ProRes 4444', async () => {
    const output = path.join(WORK_DIR, 'transparent-raw.mov')
    const rawFrames = Array.from({ length: 12 }, (_, i) => rgbaBufferFor(width, height, i))
    const result = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, output, 'raw', { width, height }),
      rawFrames
    )
    expect(result.stderr).not.toContain(ALPHA_DROPPED_MARKER)
    expect(result.code).toBe(0)
    const verified = await verifyJson(output)
    expect(verified).not.toBeNull()
    if (!verified) return
    expect(isProres4444WithAlpha(verified)).toBe(true)
    expect(Number(verified.nbFrames)).toBe(12)
  }, 180_000)

  it('错误 profile 会被检测出来（C1 的负向验证：断言串与 FFmpeg 实际输出一致）', async () => {
    // 直接用 -profile:v 3 复现「静默丢 alpha」，确认检测串命中
    const output = path.join(WORK_DIR, 'wrong-profile.mov')
    const args = buildTransparentMovFromPipe(FPS_30, output, 'png', { width, height }).map((arg) =>
      arg === '4' ? '3' : arg
    )
    const result = await runWithFrames(args, frames.slice(0, 3))
    expect(result.stderr).toContain(ALPHA_DROPPED_MARKER)
  }, 180_000)
})

describe('MP4 叠加合成（规格 §5.2 / 计划 C2–C4、C7）', () => {
  const refPath = path.join(WORK_DIR, 'ref.mp4')
  const overlayPath = path.join(WORK_DIR, 'overlay.mov')
  const outputPath = path.join(WORK_DIR, 'composited.mp4')

  beforeAll(async () => {
    // 参考视频：4:3、30fps、含 aac 音轨（触发 -c:a copy 路径）
    const gen = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        refPath
      ],
      undefined
    )
    expect(gen.code).toBe(0)
    const mov = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, overlayPath, 'png', { width: 320, height: 240 }),
      alphaFrames(320, 240, 30)
    )
    expect(mov.code).toBe(0)
  }, 240_000)

  it('输出跟随参考视频：分辨率/帧率一致、像素格式回到 yuv420p、音频 copy 成功', async () => {
    const refProbe = parseProbeJson(await probeJson(refPath), refPath)
    expect(refProbe).not.toBeNull()
    if (!refProbe) return

    const result = await run(
      ffmpeg,
      buildOverlayMp4({
        refVideoPath: refPath,
        overlayPath,
        outputPath,
        fps: FPS_30,
        spanStartSec: 0.2,
        spanEndSec: 0.8,
        audioMode: 'copy',
        fpsMode: 'cfr'
      })
    )
    expect(result.stderr).not.toContain(ALPHA_DROPPED_MARKER)
    expect(result.code).toBe(0)

    const outProbe = parseProbeJson(await probeJson(outputPath), outputPath)
    expect(outProbe).not.toBeNull()
    if (!outProbe) return
    // 跟随参考视频（规格 §2.3）
    expect(outProbe.width).toBe(refProbe.width)
    expect(outProbe.height).toBe(refProbe.height)
    expect(outProbe.rFrameRate).toEqual(refProbe.rFrameRate)
    // 验收第 7 条：-c:a copy 生效
    expect(outProbe.audioCodec).toBe('aac')
    expect(outProbe.durationSec).toBeGreaterThan(0.8)

    const verified = await verifyJson(outputPath)
    // 计划 C3：链尾强制 8-bit 4:2:0
    expect(verified).not.toBeNull()
    if (verified) expect(isDeliveryYuv420p(verified)).toBe(true)
  }, 300_000)

  it('无音轨参考视频也不失败（计划 C4 的 -map 0:a?）', async () => {
    const silentRef = path.join(WORK_DIR, 'ref-silent.mp4')
    const gen = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        silentRef
      ],
      undefined
    )
    expect(gen.code).toBe(0)
    const probe = parseProbeJson(await probeJson(silentRef), silentRef)
    expect(probe ? probe.audioCodec : 'unexpected').toBeNull()
    const out = path.join(WORK_DIR, 'composited-silent.mp4')
    const result = await run(
      ffmpeg,
      buildOverlayMp4({
        refVideoPath: silentRef,
        overlayPath,
        outputPath: out,
        fps: FPS_30,
        spanStartSec: 0,
        spanEndSec: 1,
        audioMode: 'copy',
        fpsMode: 'cfr'
      })
    )
    expect(result.stderr).not.toContain('does not contain any stream')
    expect(result.code).toBe(0)
  }, 300_000)
})

describe('水印叠加合成（1080P 基准 → 原图 32% → 左上角 30px）', () => {
  const refPath = path.join(WORK_DIR, 'wm-ref.mp4')
  const layerPath = path.join(WORK_DIR, 'wm-layer.mov')
  const logoPath = path.join(WORK_DIR, 'wm-logo.png')
  const OUT_W = 320
  const OUT_H = 240
  const LOGO_W = 200
  const LOGO_H = 100

  /**
   * 基座用纯绿底 + aac 音轨，字幕层全透明，水印用纯红 PNG：
   * 于是「画面里出现红色」只能来自水印本身，不会与其他层串扰。
   */
  beforeAll(async () => {
    const gen = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=green:s=${OUT_W}x${OUT_H}:r=30:d=1`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        refPath
      ],
      undefined
    )
    expect(gen.code).toBe(0)
    const transparent = Array.from({ length: 30 }, () =>
      encodeRgbaPng(OUT_W, OUT_H, rgbaFrame(OUT_W, OUT_H, () => null))
    )
    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, layerPath, 'png', { width: OUT_W, height: OUT_H }),
      transparent
    )
    expect(layer.code).toBe(0)
    await singlePng(logoPath, LOGO_W, LOGO_H, [255, 0, 0, 255])
  }, 240_000)

  /** 取输出某一时刻的一帧原始 RGB（输出寻址，不用输入寻址，否则只能回到关键帧） */
  async function frameAt(target: string, atSec: number): Promise<Buffer> {
    const result = await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      target,
      '-ss',
      formatSec(atSec),
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    expect(result.code, result.stderr.slice(-400)).toBe(0)
    expect(result.stdout.length).toBeGreaterThanOrEqual(OUT_W * OUT_H * 3)
    return result.stdout
  }

  function pixelAt(frame: Buffer, x: number, y: number): [number, number, number] {
    const offset = (y * OUT_W + x) * 3
    return [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0]
  }

  const isRed = (p: [number, number, number]): boolean => p[0] > 120 && p[1] < 60 && p[2] < 60
  const isGreen = (p: [number, number, number]): boolean => p[1] > 100 && p[0] < 60

  it('两阶段单输入：水印按换算矩形出现在左上角，并保持到最后一帧', async () => {
    // 320x240 相对 1080P 的因子 = 240/1080；200x100 的红图 → 14x7 @ (7,7)
    const box = computeWatermarkGeometry(
      { path: logoPath, sourceWidth: LOGO_W, sourceHeight: LOGO_H },
      { width: OUT_W, height: OUT_H }
    )
    expect(box).toEqual({ width: 14, height: 7, x: 7, y: 7 })

    const output = path.join(WORK_DIR, 'wm-single.mp4')
    const result = await run(
      ffmpeg,
      buildOverlayMp4({
        refVideoPath: refPath,
        overlayPath: layerPath,
        outputPath: output,
        fps: FPS_30,
        frameSize: { width: OUT_W, height: OUT_H },
        spanStartSec: 0,
        spanEndSec: 1,
        audioMode: 'copy',
        fpsMode: 'cfr',
        watermark: { path: logoPath, sourceWidth: LOGO_W, sourceHeight: LOGO_H }
      })
    )
    expect(result.stderr).not.toContain(ALPHA_DROPPED_MARKER)
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    const first = await frameAt(output, 0)
    expect(isRed(pixelAt(first, box.x + 3, box.y + 3)), `水印中心像素 ${pixelAt(first, box.x + 3, box.y + 3)}`).toBe(true)
    // 左上角边距之外（30px@1080p 换算后 = 7px）仍是绿底
    expect(isGreen(pixelAt(first, 1, 1))).toBe(true)
    expect(isGreen(pixelAt(first, box.x + box.width + 6, box.y + 3))).toBe(true)
    expect(isGreen(pixelAt(first, OUT_W - 20, OUT_H - 20))).toBe(true)

    // 循环输入要盖住整段：最后一帧仍在（只出现一瞬的写法会在这里报错）
    const tail = await frameAt(output, 0.9)
    expect(isRed(pixelAt(tail, box.x + 3, box.y + 3)), `末帧水印像素 ${pixelAt(tail, box.x + 3, box.y + 3)}`).toBe(true)

    const verified = await verifyJson(output)
    expect(verified).not.toBeNull()
    if (verified) {
      expect(verified.width).toBe(OUT_W)
      expect(verified.height).toBe(OUT_H)
      // 水印加了一层 overlay，链尾仍必须回到 8-bit 4:2:0（计划 C3 不回退）
      expect(isDeliveryYuv420p(verified)).toBe(true)
    }

    // 对照组：同一条命令不带水印，同一位置就是绿底（证明红色只能来自水印输入）
    const plainOut = path.join(WORK_DIR, 'wm-single-plain.mp4')
    const plain = await run(
      ffmpeg,
      buildOverlayMp4({
        refVideoPath: refPath,
        overlayPath: layerPath,
        outputPath: plainOut,
        fps: FPS_30,
        frameSize: { width: OUT_W, height: OUT_H },
        spanStartSec: 0,
        spanEndSec: 1,
        audioMode: 'copy',
        fpsMode: 'cfr'
      })
    )
    expect(plain.code).toBe(0)
    const plainFrame = await frameAt(plainOut, 0)
    expect(isGreen(pixelAt(plainFrame, box.x + 3, box.y + 3))).toBe(true)
  }, 300_000)

  it('多输入 trim+concat 基座：水印序号接在透明层之后，真实 FFmpeg 可解', async () => {
    const seg = (timelineStartSec: number, sourceInSec: number): ConcatSegment => ({
      refVideoPath: refPath,
      timelineStartSec,
      timelineEndSec: timelineStartSec + 0.5,
      sourceInSec,
      sourceOutSec: sourceInSec + 0.5,
      hasAudio: true
    })
    const output = path.join(WORK_DIR, 'wm-multi.mp4')
    const result = await run(
      ffmpeg,
      buildOverlayMp4MultiInput({
        segments: [seg(0, 0), seg(0.5, 0.5)],
        spanStartSec: 0,
        spanEndSec: 1,
        overlayLabel: '2',
        overlayPath: layerPath,
        outputPath: output,
        fps: FPS_30,
        frameSize: { width: OUT_W, height: OUT_H },
        audioMode: 'aac',
        fpsMode: 'cfr',
        watermark: { path: logoPath, sourceWidth: LOGO_W, sourceHeight: LOGO_H }
      })
    )
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    const box = computeWatermarkGeometry(
      { path: logoPath, sourceWidth: LOGO_W, sourceHeight: LOGO_H },
      { width: OUT_W, height: OUT_H }
    )
    const frame = await frameAt(output, 0.25)
    expect(isRed(pixelAt(frame, box.x + 3, box.y + 3)), `拼接路径水印像素 ${pixelAt(frame, box.x + 3, box.y + 3)}`).toBe(true)
    expect(isGreen(pixelAt(frame, OUT_W - 20, OUT_H - 20))).toBe(true)
    const meta = parseProbeJson(await probeJson(output), output)
    expect(meta ? `${meta.width}x${meta.height}` : null).toBe(`${OUT_W}x${OUT_H}`)
  }, 300_000)

  it('直接管道合成 + 水印：stdin 帧流与图片输入并存，输出仍完整落尾帧', async () => {
    const output = path.join(WORK_DIR, 'wm-direct.mp4')
    // 全透明的未压缩 RGBA 帧流（与 framePump 主路径同一形式）
    const frames = Array.from({ length: 30 }, () => rgbaFrame(OUT_W, OUT_H, () => null))
    const result = await runWithFrames(
      buildOverlayMp4DirectPipe({
        refVideoPath: refPath,
        outputPath: output,
        fps: FPS_30,
        frameFormat: 'raw',
        frameSize: { width: OUT_W, height: OUT_H },
        spanStartSec: 0,
        spanEndSec: 1,
        audioMode: 'copy',
        fpsMode: 'cfr',
        watermark: { path: logoPath, sourceWidth: LOGO_W, sourceHeight: LOGO_H }
      }),
      frames
    )
    expect(result.stderr).not.toContain('Option not found')
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    const box = computeWatermarkGeometry(
      { path: logoPath, sourceWidth: LOGO_W, sourceHeight: LOGO_H },
      { width: OUT_W, height: OUT_H }
    )
    const first = await frameAt(output, 0)
    expect(isRed(pixelAt(first, box.x + 3, box.y + 3)), `直管道水印像素 ${pixelAt(first, box.x + 3, box.y + 3)}`).toBe(true)
    const tail = await frameAt(output, 0.9)
    expect(isRed(pixelAt(tail, box.x + 3, box.y + 3))).toBe(true)
    expect(isGreen(pixelAt(tail, OUT_W - 20, OUT_H - 20))).toBe(true)
  }, 300_000)
})

describe('VFR 检测与 CFR 转换（规格 §6.3 / 验收第 6 条）', () => {
  const vfrPath = path.join(WORK_DIR, 'vfr.mp4')
  const cfrPath = path.join(WORK_DIR, 'vfr-to-cfr.mp4')

  beforeAll(async () => {
    // PTS 间隔逐帧递增（monotonic 但非均匀）→ 真·变帧率
    const gen = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x90:rate=30:duration=1',
        '-vf',
        'setpts=(N/60+N*N/1200)/TB',
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-an',
        vfrPath
      ],
      undefined
    )
    expect(gen.code).toBe(0)
    expect(gen.stderr).toEqual(expect.not.stringContaining('Unrecognized option'))
  }, 180_000)

  it('r_frame_rate 与 avg_frame_rate 不一致，且抽样 PTS 间隔超阈值', async () => {
    const probe = await probeJson(vfrPath)
    const meta = parseProbeJson(probe, vfrPath)
    expect(meta).not.toBeNull()
    if (!meta) return
    const mismatch =
      meta.rFrameRate.num / meta.rFrameRate.den !== meta.avgFrameRate.num / meta.avgFrameRate.den
    const sample = (await run(ffprobe, buildVfrSampleArgs(vfrPath, 60))).stdout.toString('utf8')
    const packets = (JSON.parse(sample) as { packets?: unknown[] }).packets ?? []
    const analysis = analyzeVfrSample(packets, FPS_30)
    expect(mismatch || analysis.vfr, `r=${meta.rFrameRate.num}/${meta.rFrameRate.den} avg=${meta.avgFrameRate.num}/${meta.avgFrameRate.den} maxGap=${analysis.evidence.maxGapSec}`).toBe(true)
    expect(detectCompat(meta, analysis.evidence).vfr).toBe(true)
  }, 180_000)

  it('转 CFR 后帧间隔完全均匀（验收第 6 条的硬判据）', async () => {
    const result = await run(ffmpeg, buildCfrArgs(vfrPath, cfrPath, FPS_30, 'copy'))
    expect(result.code).toBe(0)
    const meta = parseProbeJson(await probeJson(cfrPath), cfrPath)
    expect(meta).not.toBeNull()
    if (!meta) return
    // avg_frame_rate 是实际平均帧率；r_frame_rate 在部分容器里是时间基启发式值，
    // 所以下面用 PTS 实测作为「帧率一致」的权威判据。
    expect(meta.avgFrameRate.num / meta.avgFrameRate.den).toBeCloseTo(30, 1)

    const sample = (await run(ffprobe, buildVfrSampleArgs(cfrPath, 60))).stdout.toString('utf8')
    const packets = (JSON.parse(sample) as { packets?: unknown[] }).packets ?? []
    const times: number[] = []
    for (const item of packets) {
      const value = item as { pts_time?: string }
      const t = Number(value.pts_time)
      if (Number.isFinite(t)) times.push(t)
    }
    expect(times.length).toBeGreaterThan(4)
    times.sort((a, b) => a - b)
    const expected = 1 / 30
    let maxDeviation = 0
    for (let i = 1; i < times.length; i++) {
      maxDeviation = Math.max(maxDeviation, Math.abs((times[i] ?? 0) - (times[i - 1] ?? 0) - expected))
    }
    // 所有帧间隔与 1/30 的偏差 < 1ms → 真 CFR
    expect(maxDeviation, `最大偏差 ${maxDeviation}s`).toBeLessThan(0.001)
    expect(analyzeVfrSample(packets, FPS_30).vfr).toBe(false)
  }, 240_000)
})

describe('alpha 语义与选项取值（计划 C2）', () => {
  const grayPath = path.join(WORK_DIR, 'gray.png')
  const halfRedPath = path.join(WORK_DIR, 'half-red.png')

  beforeAll(async () => {
    await singlePng(grayPath, 4, 4, [128, 128, 128, 255])
    await singlePng(halfRedPath, 4, 4, [255, 0, 0, 128])
  })

  async function compositePixel(alpha: 'straight' | 'premultiplied' | 'auto'): Promise<{ r: number; g: number; b: number }> {
    const result = await run(ffmpeg, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-i',
      grayPath,
      '-i',
      halfRedPath,
      '-filter_complex',
      `[0:v][1:v]overlay=0:0:alpha=${alpha}:format=rgb,format=rgb24`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1'
    ])
    expect(result.code).toBe(0)
    return { r: result.stdout[0] ?? 0, g: result.stdout[1] ?? 0, b: result.stdout[2] ?? 0 }
  }

  it('overlay 的 alpha 枚举：1 = premultiplied、2 = straight（规格书原文 alpha=1 含义错误）', async () => {
    const help = await run(ffmpeg, ['-hide_banner', '-h', 'filter=overlay'])
    const text = help.stdout.toString('utf8')
    const block = text.slice(text.indexOf('alpha'))
    expect(block).toContain('premultiplied   1')
    expect(block).toContain('straight        2')
    // 我们生产代码写的是枚举名而非数字
    expect(buildOverlayMp4({
      refVideoPath: 'r.mp4',
      overlayPath: 'o.mov',
      outputPath: 'o.mp4',
      fps: FPS_30,
      spanStartSec: 0,
      spanEndSec: 1,
      audioMode: 'copy',
      fpsMode: 'cfr'
    }).join(' ')).toContain('alpha=straight')
  }, 120_000)

  it('合成结果与直通 alpha 的数学期望一致（无预乘失真、无黑边）', async () => {
    const straight = await compositePixel('straight')
    const a = 128 / 255
    const expectedR = Math.round(255 * a + 128 * (1 - a)) // ≈ 192
    const expectedG = Math.round(0 * a + 128 * (1 - a)) // ≈ 64
    expect(Math.abs(straight.r - expectedR)).toBeLessThanOrEqual(2)
    expect(Math.abs(straight.g - expectedG)).toBeLessThanOrEqual(2)
    expect(Math.abs(straight.b - expectedG)).toBeLessThanOrEqual(2)
    // auto 与 straight 一致 → 声明式写 straight 不会引入差异，但语义明确不依赖启发式
    const auto = await compositePixel('auto')
    expect(auto.r).toBe(straight.r)
  }, 180_000)
})

/**
 * v8 防抖全链（vidstab 两段式）：用生产同一套 argv 构造函数跑真 FFmpeg。
 * 夹具是正弦 pan/tilt 抖动（运动特征充分），验证三件事：
 *  1. pass 1 在本机滤镜上可用（参数名全部实证过：result/shakiness/accuracy）；
 *  2. 合成段链里注入 vidstabtransform 后整条 filter_complex 可解、交付规格不变；
 *  3. 防抖真实改变了画面（与不防抖对照的 PSNR 在「明显补偿」区间）。
 * 缺少捆绑二进制时本组直接跳过（计划步骤 12 的 skipIf 口径；不依赖 PATH 回退）。
 */
const HAS_BUNDLED_FFMPEG = fsSync.existsSync(BUNDLED_FFMPEG) && fsSync.existsSync(BUNDLED_FFPROBE)
describe.skipIf(!HAS_BUNDLED_FFMPEG)('视频防抖 vidstab 全链（v8）', () => {
  const OUT_W = 320
  const OUT_H = 240
  const SHAKE_FRAMES = 60 // 2s × 30fps
  const shakePath = path.join(WORK_DIR, 'stab-shake.mp4')
  const layerPath = path.join(WORK_DIR, 'stab-layer.mov')
  const trfFile = 'stab_0.trf'
  const trfPath = path.join(WORK_DIR, trfFile)
  const stabOn: MediaClipStab = { ...defaultMediaStab(), enabled: true }

  const seg = (over: Partial<ConcatSegment> = {}): ConcatSegment => ({
    refVideoPath: shakePath,
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 0,
    sourceOutSec: 2,
    hasAudio: true,
    ...over
  })

  const detectArgs = () =>
    buildStabDetectArgs({
      inputPath: shakePath,
      sourceInSec: 0,
      sourceOutSec: 2,
      fps: FPS_30,
      stab: stabOn,
      resultFile: trfFile
    })

  const compositeArgs = (segments: ConcatSegment[], output: string) =>
    buildOverlayMp4MultiInput({
      segments,
      spanStartSec: 0,
      spanEndSec: 2,
      overlayLabel: '1',
      overlayPath: layerPath,
      outputPath: output,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })

  beforeAll(async () => {
    // 抖动夹具：大画面裁内框，x/y 做不同频率的正弦平移 → 真抖动 + 充分纹理
    const gen = await run(
      ffmpeg,
      [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${OUT_W + 32}x${OUT_H + 24}:rate=30:duration=2`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-vf',
        `crop=${OUT_W}:${OUT_H}:16+14*sin(2*PI*t*3):12+10*cos(2*PI*t*2)`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        shakePath
      ],
      undefined
    )
    expect(gen.code, gen.stderr.slice(-600)).toBe(0)
    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, layerPath, 'png', { width: OUT_W, height: OUT_H }),
      alphaFrames(OUT_W, OUT_H, SHAKE_FRAMES)
    )
    expect(layer.code).toBe(0)
  }, 240_000)

  it('pass 1：detect 退出码 0，.trf 落在 cwd 且非空', async () => {
    await fs.rm(trfPath, { force: true }).catch(() => undefined)
    const result = await run(ffmpeg, detectArgs(), undefined, { cwd: WORK_DIR })
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const stat = await fs.stat(trfPath)
    expect(stat.size).toBeGreaterThan(0)
  }, 240_000)

  it('pass 2：注入 transform 的合成链可解，交付尺寸/帧率/像素格式不回退', async () => {
    await run(ffmpeg, detectArgs(), undefined, { cwd: WORK_DIR })
    const stabOut = path.join(WORK_DIR, 'stab-composited.mp4')
    const plainOut = path.join(WORK_DIR, 'stab-plain.mp4')

    const stabRun = await run(ffmpeg, compositeArgs([seg({ stab: stabOn, stabFile: trfFile })], stabOut), undefined, { cwd: WORK_DIR })
    expect(stabRun.code, stabRun.stderr.slice(-600)).toBe(0)
    const plainRun = await run(ffmpeg, compositeArgs([seg()], plainOut), undefined)
    expect(plainRun.code, plainRun.stderr.slice(-600)).toBe(0)

    const verified = await verifyJson(stabOut)
    expect(verified).not.toBeNull()
    if (verified) {
      expect(verified.width).toBe(OUT_W)
      expect(verified.height).toBe(OUT_H)
      expect(frameRateMatches(verified, FPS_30)).toBe(true)
      // 防抖不改画幅也不改帧数：crop=keep + optzoom 内缩，输出尺寸恒定
      expect(Number(verified.nbFrames)).toBeGreaterThanOrEqual(SHAKE_FRAMES - 2)
      expect(Number(verified.nbFrames)).toBeLessThanOrEqual(SHAKE_FRAMES + 2)
      expect(isDeliveryYuv420p(verified)).toBe(true)
    }

    // 「真实生效」判据：防抖输出与不防抖输出的逐帧 PSNR：
    // 补偿改变了画面 → 远低于同一素材两次编码的水平（>45），又不至于面目全非（>5）
    const psnr = await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      stabOut,
      '-i',
      plainOut,
      '-lavfi',
      'psnr',
      '-f',
      'null',
      '-'
    ])
    const match = /average:\s*([0-9.inf]+)/i.exec(psnr.stderr)
    expect(match, psnr.stderr.slice(-400)).not.toBeNull()
    const avg = Number.parseFloat(match?.[1] ?? 'NaN')
    expect(Number.isFinite(avg)).toBe(true)
    expect(avg).toBeLessThan(40)
    expect(avg).toBeGreaterThan(5)
  }, 300_000)

  /**
   * v8.1 预览代理：与主进程 stabPreview.ts 同一条两进程链（detect 后 transform），
   * 锁代理的交付口径：源区间 1:1（帧数 = 时长×fps）、尺寸不回退、带裁过的音轨、可流式播放。
   */
  it('v8.1 预览代理：detect+transform 产出的 mp4 = 源区间 1:1 + 音频裁到区间', async () => {
    await run(ffmpeg, detectArgs(), undefined, { cwd: WORK_DIR })
    const proxyOut = path.join(WORK_DIR, 'stab-proxy.mp4')
    await fs.rm(proxyOut, { force: true }).catch(() => undefined)
    const result = await run(
      ffmpeg,
      buildStabPreviewArgs({
        inputPath: shakePath,
        sourceInSec: 0,
        sourceOutSec: 2,
        fps: FPS_30,
        stab: stabOn,
        stabFile: trfFile,
        hasAudio: true,
        outputPath: proxyOut
      }),
      undefined,
      { cwd: WORK_DIR }
    )
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const stat = await fs.stat(proxyOut)
    expect(stat.size).toBeGreaterThan(0)

    const verified = await verifyJson(proxyOut)
    expect(verified).not.toBeNull()
    if (verified) {
      expect(verified.width).toBe(OUT_W)
      expect(verified.height).toBe(OUT_H)
      expect(frameRateMatches(verified, FPS_30)).toBe(true)
      // 代理就是源区间的 1:1 内容：预览的坐标换算（源时 − 入点）才成立
      expect(Number(verified.nbFrames)).toBeGreaterThanOrEqual(SHAKE_FRAMES - 2)
      expect(Number(verified.nbFrames)).toBeLessThanOrEqual(SHAKE_FRAMES + 2)
      expect(isDeliveryYuv420p(verified)).toBe(true)
    }

    // 带声：-af atrim 裁过音轨（主进程 hasAudio 分支的真实产物形态）
    const probe = await run(ffprobe, buildProbeArgs(proxyOut))
    expect(probe.code, probe.stderr.slice(-300)).toBe(0)
    const parsed = JSON.parse(probe.stdout.toString('utf8')) as { streams?: { codec_type?: string }[] }
    expect((parsed.streams ?? []).some((s) => s.codec_type === 'audio')).toBe(true)

    // faststart：moov 在前，focusnews-media:// 的 Range 流才能边下边播
    const head = (await fs.readFile(proxyOut)).subarray(0, 64 * 1024).toString('latin1')
    expect(head).toContain('moov')
  }, 300_000)

  /**
   * v8.2 缺陷护栏：用户实测「强防抖 + 虚拟三脚架」后高频抖动反而愈演愈烈。
   * 真机定位到根因：vidstabtransform `tripod=1` = `relative=0:smoothing=0`，在实拍平移素材上
   * 会把每帧拽回参考帧 1 且不低通，实测放大到原片的 ~194%。修复后改为超长窗相对平滑。
   * 本用例用二阶差分能量（画面内部区，避开游动黑边）度量残余抖动，断言**防抖后不得高于原片**。
   */
  it('虚拟三脚架不得放大抖动（high+tripod 残余高频抖动 < 原片）', async () => {
    const pan = path.join(WORK_DIR, 'stab-pan-guard.mp4')
    // 机位持续平移 + 7~8Hz 高频抖动（用户手持实拍的代理场景）
    const gen = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${OUT_W + 80}x${OUT_H + 80}:rate=30:duration=4`,
      '-vf', `crop=${OUT_W}:${OUT_H}:40+25*t+5*sin(2*PI*t*7):40+6*sin(2*PI*t*0.4)+5*cos(2*PI*t*8)`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', pan
    ])
    expect(gen.code, gen.stderr.slice(-400)).toBe(0)

    const stabTripod: MediaClipStab = { ...defaultMediaStab(), enabled: true, level: 'high', tripod: true }
    const trf = 'stab_guard.trf'
    const detect = await run(
      ffmpeg,
      buildStabDetectArgs({ inputPath: pan, sourceInSec: 0, sourceOutSec: 4, fps: FPS_30, stab: stabTripod, resultFile: trf }),
      undefined,
      { cwd: WORK_DIR }
    )
    expect(detect.code, detect.stderr.slice(-400)).toBe(0)

    const out = path.join(WORK_DIR, 'stab-pan-guard-tripod.mp4')
    const tr = await run(
      ffmpeg,
      buildStabPreviewArgs({ inputPath: pan, sourceInSec: 0, sourceOutSec: 4, fps: FPS_30, stab: stabTripod, stabFile: trf, hasAudio: false, outputPath: out }),
      undefined,
      { cwd: WORK_DIR }
    )
    expect(tr.code, tr.stderr.slice(-400)).toBe(0)

    // 内部 180x130 区域（居中）逐帧二阶差分 mean|f[i+1]-2f[i]+f[i-1]| = 高频抖动能量
    const jitter = async (file: string): Promise<number> => {
      const r = await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', file,
        '-vf', 'crop=180:130:70:55,format=gray,fps=30', '-f', 'rawvideo', '-'
      ])
      expect(r.code, r.stderr.slice(-300)).toBe(0)
      const fb = 180 * 130
      const n = Math.floor(r.stdout.length / fb)
      expect(n).toBeGreaterThan(30)
      let sum = 0
      let count = 0
      for (let i = 1; i < n - 1; i += 1) {
        const a = r.stdout.subarray((i - 1) * fb, i * fb)
        const b = r.stdout.subarray(i * fb, (i + 1) * fb)
        const c = r.stdout.subarray((i + 1) * fb, (i + 2) * fb)
        for (let p = 0; p < fb; p += 1) {
          sum += Math.abs((c[p] ?? 0) - 2 * (b[p] ?? 0) + (a[p] ?? 0))
          count += 1
        }
      }
      return sum / count
    }
    const base = await jitter(pan)
    const after = await jitter(out)
    // 关键：修复后残余抖动必须低于原片；若退回 vidstab tripod 宏会放大到 ~190% 而使本断言失败
    expect(after, `虚拟三脚架把抖动放大了：after=${after.toFixed(3)} base=${base.toFixed(3)}`).toBeLessThan(base)
  }, 300_000)
})

// alpha 语义的量化断言已归入上方「alpha 语义与选项取值」块（旧版此处重复了两个同名的
// describe，且其中「premultiplied 与 straight 像素结果不同」的断言与 FFmpeg 8.1.1 实测不符，
// 已删除：实测两种写法在 RGBA 直通素材上得到相同像素，真正可靠的证据是枚举定义与期望混合值）。

/**
 * v9 音频与变速的实机验收（随包 FFmpeg，与导出走同一套 argv 构造函数）。
 *
 * 只断言「滤镜串能解析」不够，必须量化结果：
 * 1. 频谱取样的 argv 真能从声轨里折出桶，且无音轨时只给空字节（不抛异常）；
 * 2. 2x / 0.5x 变速后的**交付时长与帧数**按倍速收缩（画面 setpts 与音频 atempo 对齐）；
 * 3. volume=0.5 与 afade 在输出文件的音频上留下可测痕迹（峰值电平下降、首尾柱低于中段）；
 * 4. 音高连动的 asetrate 链与音频轨混音的 atempo+volume 链都真实可解。
 */
describe.skipIf(!HAS_BUNDLED_FFMPEG)('音频与变速滤镜链（v9 · 实机 FFmpeg）', () => {
  const OUT_W = 320
  const OUT_H = 240
  const SRC_SEC = 6
  const srcPath = path.join(WORK_DIR, 'fx-audio-source.mp4')
  const silentPath = path.join(WORK_DIR, 'fx-silent-source.mp4')
  const layerPath = path.join(WORK_DIR, 'fx-layer.mov')

  const seg = (over: Partial<ConcatSegment> = {}): ConcatSegment => ({
    refVideoPath: srcPath,
    timelineStartSec: 0,
    timelineEndSec: SRC_SEC,
    sourceInSec: 0,
    sourceOutSec: SRC_SEC,
    hasAudio: true,
    ...over
  })

  const compositeArgs = (
    segments: ConcatSegment[],
    output: string,
    spanEndSec: number,
    extra: { audioClips?: AudioMixClip[] } = {}
  ): string[] =>
    buildOverlayMp4MultiInput({
      segments,
      spanStartSec: 0,
      spanEndSec,
      overlayLabel: '1',
      overlayPath: layerPath,
      outputPath: output,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      audioMode: 'aac',
      fpsMode: 'cfr',
      ...extra
    })

  /** 取一个文件的频谱柱（与时间轴卡片同一条代码路径）。 */
  const barsOf = async (target: string, from: number, to: number, buckets: number): Promise<number[]> => {
    const sampled = await run(ffmpeg, buildAudioPeaksArgs({ inputPath: target, sourceInSec: from, sourceOutSec: to, sampleRate: 4000 }))
    return spectrumPeaksFromPcm(sampled.stdout, buckets)
  }

  beforeAll(async () => {
    // 有音轨夹具：6s 画面 + 6s 连续 440Hz 正弦（本机构建输出约 -18dBFS，断言只看相对差）
    const withAudio = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${OUT_W}x${OUT_H}:rate=30:duration=${SRC_SEC}`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', srcPath
    ])
    expect(withAudio.code, withAudio.stderr.slice(-600)).toBe(0)

    // 无音轨夹具：频谱必须得不出任何东西
    const noAudio = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${OUT_W}x${OUT_H}:rate=30:duration=${SRC_SEC}`,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentPath
    ])
    expect(noAudio.code, noAudio.stderr.slice(-600)).toBe(0)

    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, layerPath, 'png', { width: OUT_W, height: OUT_H }),
      alphaFrames(OUT_W, OUT_H, SRC_SEC * 30)
    )
    expect(layer.code, layer.stderr.slice(-600)).toBe(0)
  }, 240_000)

  it('频谱取样：argv 折得出包络；-ss 只解需要的那一段；无音轨时给空字节', async () => {
    const full = await run(ffmpeg, buildAudioPeaksArgs({ inputPath: srcPath, sourceInSec: 0, sourceOutSec: SRC_SEC, sampleRate: 2000 }))
    expect(full.code, full.stderr.slice(-600)).toBe(0)
    expect(full.stdout.length).toBeGreaterThan(4000)
    const bars = spectrumPeaksFromPcm(full.stdout, 48)
    expect(bars).toHaveLength(48)
    // 连续正弦：每一桶都接近满刻度（dB 折算后不会有的贴底）
    expect(Math.min(...bars)).toBeGreaterThan(0.6)

    // 只取后一半：输出字节量跟着减半（-ss/-t 在 -i 之前才会）
    const half = await run(ffmpeg, buildAudioPeaksArgs({ inputPath: srcPath, sourceInSec: 3, sourceOutSec: SRC_SEC, sampleRate: 2000 }))
    expect(half.code, half.stderr.slice(-600)).toBe(0)
    expect(half.stdout.length).toBeLessThan(full.stdout.length)

    // 无音轨：不报错也不给任何 PCM（主进程据此判 hasAudio=false → 卡片不画频谱）
    const silent = await run(ffmpeg, buildAudioPeaksArgs({ inputPath: silentPath, sourceInSec: 0, sourceOutSec: SRC_SEC, sampleRate: 2000 }))
    expect(silent.stdout.length).toBe(0)
  }, 240_000)

  it('2x 变速：交付时长与帧数按倍速收缩，声轨不消失', async () => {
    const out = path.join(WORK_DIR, 'fx-speed2.mp4')
    const result = await run(ffmpeg, compositeArgs([seg({ timelineEndSec: 3, speed: { speed: 2, maintainPitch: true } })], out, 3))
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    const verified = await verifyJson(out)
    expect(Number(verified?.nbFrames)).toBeGreaterThanOrEqual(85)
    expect(Number(verified?.nbFrames)).toBeLessThanOrEqual(95)
    const probe = parseProbeJson(await probeJson(out), out)
    expect(probe?.durationSec).toBeGreaterThan(2.6)
    expect(probe?.durationSec).toBeLessThan(3.4)
    expect(probe?.audioCodec).toBeTruthy()
  }, 300_000)

  it('0.5x 慢放：时间轴长度翻倍（画面与音频一起拉长）', async () => {
    const out = path.join(WORK_DIR, 'fx-speed05.mp4')
    const result = await run(
      ffmpeg,
      compositeArgs([seg({ timelineEndSec: 12, speed: { speed: 0.5, maintainPitch: true } })], out, 12)
    )
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const verified = await verifyJson(out)
    expect(Number(verified?.nbFrames)).toBeGreaterThanOrEqual(350)
    expect(Number(verified?.nbFrames)).toBeLessThanOrEqual(372)
  }, 300_000)

  it('音量 50%：峰值电平正好比不动增益时低 6dB；淡入淡出让首尾柱低于中段', async () => {
    const plain = path.join(WORK_DIR, 'fx-gain-plain.mp4')
    const halved = path.join(WORK_DIR, 'fx-gain-half.mp4')
    const base = { timelineEndSec: 3, speed: { speed: 2, maintainPitch: true } }
    const plainRun = await run(ffmpeg, compositeArgs([seg(base)], plain, 3))
    expect(plainRun.code, plainRun.stderr.slice(-600)).toBe(0)
    const halfRun = await run(
      ffmpeg,
      compositeArgs([seg({ ...base, audio: { volumePercent: 50, fadeInSec: 0.5, fadeOutSec: 0.5 } })], halved, 3)
    )
    expect(halfRun.code, halfRun.stderr.slice(-600)).toBe(0)

    const maxDbOf = async (target: string): Promise<number> => {
      const detect = await run(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-i', target, '-af', 'volumedetect', '-f', 'null', '-'])
      const match = /max_volume:\s*(-?[0-9.]+) dB/i.exec(detect.stderr)
      expect(match, detect.stderr.slice(-400)).not.toBeNull()
      return Number.parseFloat(match?.[1] ?? 'NaN')
    }

    // 用**相对差**而不是绝对电平：本机构 lavfi `sine` 源输出约 -18dBFS，
    // 但体积滤镜只关心比例：半增益 = -6.02dB（afade 不动中段，所以差值就是增益差）
    const delta = (await maxDbOf(halved)) - (await maxDbOf(plain))
    expect(delta).toBeLessThan(-4)
    expect(delta).toBeGreaterThan(-8)

    // 淡入淡出真的落在声音上：首尾柱明显低于中段
    const bars = await barsOf(halved, 0, 3, 48)
    const middle = Math.max(...bars.slice(12, 36))
    expect(middle).toBeGreaterThan(0.3)
    expect(bars[0]).toBeLessThan(middle * 0.6)
    expect(bars[bars.length - 1]).toBeLessThan(middle * 0.6)
  }, 300_000)

  it('关掉保持音高（asetrate）：链可解且时长仍按倍速收缩', async () => {
    const out = path.join(WORK_DIR, 'fx-speed2-pitch.mp4')
    const result = await run(ffmpeg, compositeArgs([seg({ timelineEndSec: 3, speed: { speed: 2, maintainPitch: false } })], out, 3))
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const probe = parseProbeJson(await probeJson(out), out)
    expect(probe?.durationSec).toBeGreaterThan(2.6)
    expect(probe?.durationSec).toBeLessThan(3.4)
  }, 300_000)

  it('音频轨带倍速与音量：混音链（atempo + volume + adelay）与基座原声一起可解', async () => {
    const out = path.join(WORK_DIR, 'fx-audio-track.mp4')
    const bed: AudioMixClip = {
      path: srcPath,
      timelineStartSec: 1,
      timelineEndSec: 4,
      sourceInSec: 0,
      sourceOutSec: 6,
      audio: { volumePercent: 80, fadeInSec: 0.5, fadeOutSec: 0 },
      speed: { speed: 2, maintainPitch: true }
    }
    const argv = compositeArgs([seg()], out, SRC_SEC, { audioClips: [bed] })
    expect(argv.join(' ')).toContain('atempo=2')
    const result = await run(ffmpeg, argv, undefined, { cwd: WORK_DIR })
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const probe = parseProbeJson(await probeJson(out), out)
    expect(probe?.audioCodec).toBeTruthy()
    expect(probe?.durationSec).toBeGreaterThan(5.5)
  }, 300_000)
})
