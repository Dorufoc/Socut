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
  buildProxyArgs,
  buildStabDetectArgs,
  buildStabPreviewArgs,
  buildTransparentMovFromPipe,
  buildVerifyArgs,
  buildVfrSampleArgs,
  computeWatermarkGeometry,
  formatSec
} from '@shared/ffmpegArgs'
import type { AudioMixClip, ConcatSegment } from '@shared/ffmpegArgs'
import { buildMediaClipVideoFx } from '@shared/mediaClipVideoFfmpeg'
import { defaultMediaStab } from '@shared/mediaStab'
import { defaultMediaVideo, curveLookup, defaultCurves } from '@shared/mediaClipVideo'
import { spectrumPeaksFromPcm } from '@shared/audioPeaks'
import type { MediaClipStab, MediaClipVideo } from '@shared/types'
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
/**
 * v10 音频质量（Task 8 · 实机 FFmpeg）：降噪 / BGM ducking / 响度标准化。
 *
 * 全部走生产同一套 argv（`buildOverlayMp4` / `buildOverlayMp4MultiInput`）：
 * 1. loudnorm social/broadcast 用 ebur128 量整片积分响度（±1 LU）；
 * 2. ducking 用低通隔离 BGM 频段，比较「口播前 / 口播中 / 口播后」的 RMS（中段 ≥6dB 下降，后段恢复）；
 * 3. afftdn 链可解且输出底噪均值下降（噪声夹具 + 单音）。
 */
describe.skipIf(!HAS_BUNDLED_FFMPEG)('音频质量全链（v10 · 实机 FFmpeg）', () => {
  const OUT_W = 320
  const OUT_H = 240
  const SEC = 6
  const REF_WITH_AUDIO = path.join(WORK_DIR, 'aq-ref-audio.mp4')
  const REF_SILENT = path.join(WORK_DIR, 'aq-ref-silent.mp4')
  const LAYER = path.join(WORK_DIR, 'aq-layer.mov')

  const makeRef = async (target: string, withAudio: boolean): Promise<void> => {
    const args = [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${OUT_W}x${OUT_H}:rate=30:duration=${SEC}`
    ]
    if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${SEC}`)
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p')
    if (withAudio) args.push('-c:a', 'aac', '-shortest')
    else args.push('-an')
    args.push(target)
    const result = await run(ffmpeg, args)
    expect(result.code, result.stderr.slice(-600)).toBe(0)
  }

  const makeLayer = async (): Promise<void> => {
    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, LAYER, 'png', { width: OUT_W, height: OUT_H }),
      Array.from({ length: SEC * 30 }, () =>
        encodeRgbaPng(OUT_W, OUT_H, rgbaFrame(OUT_W, OUT_H, () => null))
      )
    )
    expect(layer.code, layer.stderr.slice(-600)).toBe(0)
  }

  beforeAll(async () => {
    await makeRef(REF_WITH_AUDIO, true)
    await makeRef(REF_SILENT, false)
    await makeLayer()
  }, 240_000)

  const integratedLufs = async (target: string): Promise<number> => {
    const result = await run(ffmpeg, [
      '-hide_banner', '-i', target, '-af', 'ebur128', '-f', 'null', '-'
    ])
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    // 只认最终 Summary 的整片积分响度：逐帧行里的 I: 会先出现 -70（起始静音）
    const match = /Integrated loudness:[\s\S]*?I:\s*(-?[0-9.]+)\s*LUFS/.exec(result.stderr)
    expect(match, result.stderr.slice(-600)).not.toBeNull()
    return Number.parseFloat(match?.[1] ?? 'NaN')
  }

  /**
   * 某一时间窗的电平：**必须从 0 解码到区间末尾**再用 atrim 截窗。
   * 若用 `-ss` 直接跳进窗口，侧链压缩器的增益状态会在窗口起点重置，
   * 量到的下降会被严重低估（实测 -2dB vs 真实 -9dB）。
   */
  const meanVolume = async (target: string, from: number, to: number, af: string): Promise<number> => {
    const result = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'info',
      '-i', target,
      '-af',
      `${af},atrim=start=${formatSec(from)}:end=${formatSec(to)},asetpts=PTS-STARTPTS,volumedetect`,
      '-f', 'null', '-'
    ])
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const match = /mean_volume:\s*(-?[0-9.]+)\s*dB/.exec(result.stderr)
    expect(match, result.stderr.slice(-600)).not.toBeNull()
    return Number.parseFloat(match?.[1] ?? 'NaN')
  }

  it('loudnorm social：输出整片响度 -14 ±1 LUFS', async () => {
    const out = path.join(WORK_DIR, 'aq-loudnorm-social.mp4')
    const result = await run(ffmpeg, buildOverlayMp4({
      refVideoPath: REF_WITH_AUDIO,
      overlayPath: LAYER,
      outputPath: out,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      spanStartSec: 0,
      spanEndSec: SEC,
      audioMode: 'copy',
      fpsMode: 'cfr',
      mastering: 'social'
    }))
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const lufs = await integratedLufs(out)
    expect(Math.abs(lufs - -14), `实测 ${lufs} LUFS`).toBeLessThanOrEqual(1)
  }, 300_000)

  it('loudnorm broadcast：输出整片响度 -23 ±1 LUFS', async () => {
    const out = path.join(WORK_DIR, 'aq-loudnorm-broadcast.mp4')
    const result = await run(ffmpeg, buildOverlayMp4({
      refVideoPath: REF_WITH_AUDIO,
      overlayPath: LAYER,
      outputPath: out,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      spanStartSec: 0,
      spanEndSec: SEC,
      audioMode: 'copy',
      fpsMode: 'cfr',
      mastering: 'broadcast'
    }))
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const lufs = await integratedLufs(out)
    expect(Math.abs(lufs - -23), `实测 ${lufs} LUFS`).toBeLessThanOrEqual(1)
  }, 300_000)

  it('ducking：口播区间 BGM 频段下降 ≥6dB，口播结束后恢复', async () => {
    const bgmPath = path.join(WORK_DIR, 'aq-bgm.wav')
    const voicePath = path.join(WORK_DIR, 'aq-voice.wav')
    const bgm = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=200:duration=${SEC}`,
      '-c:a', 'pcm_s16le', bgmPath
    ])
    expect(bgm.code).toBe(0)
    const voice = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=3000:duration=2',
      '-c:a', 'pcm_s16le', voicePath
    ])
    expect(voice.code).toBe(0)

    const out = path.join(WORK_DIR, 'aq-ducking.mp4')
    const result = await run(ffmpeg, buildOverlayMp4MultiInput({
      segments: [
        {
          refVideoPath: REF_SILENT,
          timelineStartSec: 0,
          timelineEndSec: SEC,
          sourceInSec: 0,
          sourceOutSec: SEC,
          hasAudio: false
        }
      ],
      spanStartSec: 0,
      spanEndSec: SEC,
      overlayLabel: '1',
      overlayPath: LAYER,
      outputPath: out,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      audioMode: 'aac',
      fpsMode: 'cfr',
      audioClips: [
        {
          path: bgmPath,
          timelineStartSec: 0,
          timelineEndSec: SEC,
          sourceInSec: 0,
          sourceOutSec: SEC,
          role: 'bgm',
          ducking: 'standard'
        },
        {
          path: voicePath,
          timelineStartSec: 2,
          timelineEndSec: 4,
          sourceInSec: 0,
          sourceOutSec: 2,
          role: 'voice',
          // 接近真实口播电平（lavfi sine 默认约 -18dBFS，抬到 -12dBFS）
          audio: { volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 }
        }
      ]
    }))
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    // 低通只留 200Hz BGM：500Hz 截止对 3kHz 口播衰减足够，比较各段 BGM 电平
    const before = await meanVolume(out, 0.5, 1.9, 'lowpass=frequency=500')
    const during = await meanVolume(out, 2.5, 3.9, 'lowpass=frequency=500')
    const after = await meanVolume(out, 4.3, 5.7, 'lowpass=frequency=500')
    expect(during - before, `before=${before} during=${during}`).toBeLessThanOrEqual(-6)
    expect(Math.abs(after - before), `before=${before} after=${after}`).toBeLessThanOrEqual(2)
  }, 300_000)

  it('降噪：afftdn 链可解，噪声夹具的底噪均值下降', async () => {
    const noisyPath = path.join(WORK_DIR, 'aq-noisy.mp4')
    // 单音 + 白噪声：降噪应压掉噪声，同时保留 1kHz 内容
    const gen = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${OUT_W}x${OUT_H}:rate=30:duration=2`,
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
      '-f', 'lavfi', '-i', 'anoisesrc=color=white:duration=2:amplitude=0.35',
      '-filter_complex', '[1:a][2:a]amix=inputs=2:duration=first:normalize=0[a]',
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', noisyPath
    ])
    expect(gen.code, gen.stderr.slice(-600)).toBe(0)

    const composite = (denoise: 'strong' | undefined, output: string): string[] =>
      buildOverlayMp4MultiInput({
        segments: [
          {
            refVideoPath: noisyPath,
            timelineStartSec: 0,
            timelineEndSec: 2,
            sourceInSec: 0,
            sourceOutSec: 2,
            hasAudio: true,
            ...(denoise
              ? { audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise } }
              : {})
          }
        ],
        spanStartSec: 0,
        spanEndSec: 2,
        overlayLabel: '1',
        overlayPath: LAYER,
        outputPath: output,
        fps: FPS_30,
        frameSize: { width: OUT_W, height: OUT_H },
        audioMode: 'aac',
        fpsMode: 'cfr'
      })

    const plainOut = path.join(WORK_DIR, 'aq-denoise-plain.mp4')
    const denoisedOut = path.join(WORK_DIR, 'aq-denoise-strong.mp4')
    const plain = await run(ffmpeg, composite(undefined, plainOut))
    expect(plain.code, plain.stderr.slice(-600)).toBe(0)
    const denoised = await run(ffmpeg, composite('strong', denoisedOut))
    expect(denoised.code, denoised.stderr.slice(-600)).toBe(0)
    expect(composite('strong', denoisedOut).join(' ')).toContain('afftdn=nr=20:nf=-20')

    const plainMean = await meanVolume(plainOut, 0.3, 1.7, 'anull')
    const denoisedMean = await meanVolume(denoisedOut, 0.3, 1.7, 'anull')
    expect(denoisedMean, `plain=${plainMean} denoised=${denoisedMean}`).toBeLessThan(plainMean - 1)
  }, 300_000)
})

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

/**
 * v10 片段画面变换与调色烧录（Task 3 · 实机 FFmpeg）。
 *
 * 走生产同一套 argv（`buildOverlayMp4MultiInput` → 单轨基座 → fx 链），
 * 断言两件事：
 * 1. 调色：亮度按乘性增益、对比度/饱和度按 eq 公式落在 YUV 通道上（±3/255），
 *    曲线中点按同一张采样表（±3/255）；
 * 2. 几何：150% + 20% 位移 + hflip 后，两色块的可见分界与包围盒一致（±2px）。
 */
describe.skipIf(!HAS_BUNDLED_FFMPEG)('片段几何/调色烧录（v10 · 实机 FFmpeg）', () => {
  const OUT_W = 320
  const OUT_H = 240
  const SOLID = path.join(WORK_DIR, 'fx-color-solid.mp4')
  const QUAD = path.join(WORK_DIR, 'fx-color-quad.mp4')
  const GRAY = path.join(WORK_DIR, 'fx-color-gray.mp4')
  const LAYER = path.join(WORK_DIR, 'fx-color-layer.mov')

  const videoOf = (over: Partial<MediaClipVideo> = {}): MediaClipVideo => ({
    ...defaultMediaVideo(),
    ...over
  })

  const composite = (video: MediaClipVideo | undefined, output: string): string[] =>
    buildOverlayMp4MultiInput({
      segments: [
        {
          refVideoPath: SOLID,
          timelineStartSec: 0,
          timelineEndSec: 1,
          sourceInSec: 0,
          sourceOutSec: 1,
          hasAudio: false,
          ...(video ? { video } : {})
        }
      ],
      spanStartSec: 0,
      spanEndSec: 1,
      overlayLabel: '1',
      overlayPath: LAYER,
      outputPath: output,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })

  const compositeFrom = (sourcePath: string, video: MediaClipVideo | undefined, output: string): string[] => {
    const argv = composite(video, output)
    // 夹具路径是检查函数的可变输入：替换 segments 里的第一路文件
    const index = argv.indexOf(SOLID)
    if (index >= 0) argv[index] = sourcePath
    return argv
  }

  async function frameRgb(target: string): Promise<Buffer> {
    const result = await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      target,
      '-ss',
      '0.500000',
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

  async function frameYuv(target: string): Promise<[number, number, number]> {
    const result = await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      target,
      '-ss',
      '0.500000',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'yuv420p',
      'pipe:1'
    ])
    expect(result.code, result.stderr.slice(-400)).toBe(0)
    const y = OUT_W * OUT_H
    const uv = Math.ceil(OUT_W / 2) * Math.ceil(OUT_H / 2)
    return [result.stdout[0] ?? 0, result.stdout[y] ?? 0, result.stdout[y + uv] ?? 0]
  }

  const pixelAt = (frame: Buffer, x: number, y: number): [number, number, number] => {
    const offset = (y * OUT_W + x) * 3
    return [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0]
  }

  const isRed = (p: [number, number, number]): boolean => p[0] > 150 && p[1] < 80 && p[2] < 80
  const isBlue = (p: [number, number, number]): boolean => p[2] > 150 && p[0] < 80 && p[1] < 80

  beforeAll(async () => {
    // 纯色源 / 灰源 / 双色分块源（左红右蓝）
    const solid = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x336699:s=${OUT_W}x${OUT_H}:r=30:d=1`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', SOLID
    ])
    expect(solid.code, solid.stderr.slice(-400)).toBe(0)
    const gray = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x808080:s=${OUT_W}x${OUT_H}:r=30:d=1`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', GRAY
    ])
    expect(gray.code, gray.stderr.slice(-400)).toBe(0)
    const quad = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x0000ff:s=${OUT_W}x${OUT_H}:r=30:d=1`,
      '-vf', `drawbox=x=0:y=0:w=${OUT_W / 2}:h=${OUT_H}:color=red:t=fill`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', QUAD
    ])
    expect(quad.code, quad.stderr.slice(-400)).toBe(0)
    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, LAYER, 'png', { width: OUT_W, height: OUT_H }),
      Array.from({ length: 30 }, () => encodeRgbaPng(OUT_W, OUT_H, rgbaFrame(OUT_W, OUT_H, () => null)))
    )
    expect(layer.code, layer.stderr.slice(-600)).toBe(0)
  }, 240_000)

  it('亮度/对比度/饱和度：按公式落在通道值上（亮度 RGB 乘性、对比度/饱和度 YUV 公式）', async () => {
    const baseOut = path.join(WORK_DIR, 'fx-grade-base.mp4')
    const brightOut = path.join(WORK_DIR, 'fx-grade-bright.mp4')
    const fullOut = path.join(WORK_DIR, 'fx-grade-full.mp4')
    const base = await run(ffmpeg, composite(undefined, baseOut))
    expect(base.code, base.stderr.slice(-600)).toBe(0)
    const bright = await run(ffmpeg, composite(videoOf({ brightness: 20 }), brightOut))
    expect(bright.code, bright.stderr.slice(-600)).toBe(0)
    const full = await run(
      ffmpeg,
      composite(videoOf({ brightness: 20, contrast: 15, saturation: 30 }), fullOut)
    )
    expect(full.code, full.stderr.slice(-600)).toBe(0)

    // 亮度：CSS brightness 同口径 = RGB × 1.2
    const baseRgb = pixelAt(await frameRgb(baseOut), 160, 120)
    const brightRgb = pixelAt(await frameRgb(brightOut), 160, 120)
    for (let c = 0; c < 3; c += 1) {
      expect(Math.abs((brightRgb[c] ?? 0) - (baseRgb[c] ?? 0) * 1.2)).toBeLessThanOrEqual(3)
    }

    // 对比度作用在 Y 上：(Y-128)×1.15+128；饱和度作用在 U/V 上：(C-128)×1.30+128
    const [brightY, brightU, brightV] = await frameYuv(brightOut)
    const [fullY, fullU, fullV] = await frameYuv(fullOut)
    const expectedY = (brightY - 128) * 1.15 + 128
    const expectedU = (brightU - 128) * 1.3 + 128
    const expectedV = (brightV - 128) * 1.3 + 128
    expect(Math.abs(fullY - expectedY)).toBeLessThanOrEqual(3)
    expect(Math.abs(fullU - expectedU)).toBeLessThanOrEqual(3)
    expect(Math.abs(fullV - expectedV)).toBeLessThanOrEqual(3)
  }, 300_000)

  it('主曲线：中点按 curveLookup 输出（灰源 ±3/255）', async () => {
    const master = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.6 },
      { x: 1, y: 1 }
    ]
    // 直接执行 fx 语句（与导出注入的是同一份滤镜串）；导出整链的 yuv/overlay 往返会额外引入 2-3 级误差
    const plan = buildMediaClipVideoFx({
      baseLabel: '0:v',
      outputLabel: 'out',
      video: videoOf({ curves: { ...defaultCurves(), master } }),
      frame: { width: OUT_W, height: OUT_H },
      fps: FPS_30,
      durationSec: 1,
      transparentBackground: false
    })
    const result = await run(ffmpeg, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-i',
      GRAY,
      '-filter_complex',
      plan.statements.join(';'),
      '-map',
      '[out]',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    expect(result.code, result.stderr.slice(-400)).toBe(0)
    const pixel = [result.stdout[0] ?? 0, result.stdout[1] ?? 0, result.stdout[2] ?? 0]
    const inputLevel = 128 / 255
    const expected = Math.round(curveLookup(master, inputLevel) * 255)
    for (const value of pixel) {
      expect(Math.abs(value - expected), `曲线中点 ${value} vs ${expected}`).toBeLessThanOrEqual(3)
    }
  }, 300_000)

  it('几何：150% 缩放 + 20% 水平位移 + hflip，两色块分界与包围盒 ±2px', async () => {
    const out = path.join(WORK_DIR, 'fx-geometry.mp4')
    const result = await run(
      ffmpeg,
      compositeFrom(QUAD, videoOf({ scalePercent: 150, offsetXPercent: 20, flipH: true }), out)
    )
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    const probe = parseProbeJson(await probeJson(out), out)
    expect(probe ? `${probe.width}x${probe.height}` : null).toBe(`${OUT_W}x${OUT_H}`)

    const frame = await frameRgb(out)
    // hflip 后红色在右：分界 = 480/2 (局部位) − 16 (overlay x) = 224
    let boundary = -1
    for (let x = 0; x < OUT_W; x += 1) {
      if (isRed(pixelAt(frame, x, 120))) {
        boundary = x
        break
      }
    }
    expect(boundary, '未找到红色色块').toBeGreaterThan(0)
    expect(Math.abs(boundary - 224)).toBeLessThanOrEqual(2)
    expect(isBlue(pixelAt(frame, boundary - 4, 120))).toBe(true)
    expect(isRed(pixelAt(frame, boundary + 4, 120))).toBe(true)
    // 缩放 150% 覆盖全高：上下边缘仍是画面内容（没有黑边）
    expect(isBlue(pixelAt(frame, 10, 10))).toBe(true)
    expect(isBlue(pixelAt(frame, 10, OUT_H - 10))).toBe(true)
  }, 300_000)
})

/**
 * v10 转场导出（Task 7 · 实机 FFmpeg）：
 * 两段 1s 纯色夹具 + 0.5s 溶解，走生产同一套 argv（`buildOverlayMp4MultiInput` → 单轨转场基座）。
 * 断言：
 * 1. 总帧数/总时长仍 = 两段核心长度之和（xfade 手柄不改变成片长度）；
 * 2. 切点中点确实是两色混合（不是纯色）；
 * 3. 音频仍是硬切 concat（时长 = 2s，音轨存在）；
 * 4. 方向性转场图可解；fadeblack 中点接近黑。
 */
describe.skipIf(!HAS_BUNDLED_FFMPEG)('转场导出 xfade（v10 · 实机 FFmpeg）', () => {
  const OUT_W = 320
  const OUT_H = 240
  const RED = path.join(WORK_DIR, 'tr-red.mp4')
  const BLUE = path.join(WORK_DIR, 'tr-blue.mp4')
  const LAYER = path.join(WORK_DIR, 'tr-layer.mov')

  const makeSolid = async (color: string, target: string): Promise<void> => {
    const result = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=${OUT_W}x${OUT_H}:r=30:d=2`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', target
    ])
    expect(result.code, result.stderr.slice(-600)).toBe(0)
  }

  const segments = (type: 'dissolve' | 'pushLeft' | 'windLeft' | 'fadeBlack'): ConcatSegment[] => [
    {
      refVideoPath: RED,
      timelineStartSec: 0,
      timelineEndSec: 1,
      sourceInSec: 0,
      sourceOutSec: 1,
      sourceDurationSec: 2,
      hasAudio: true
    },
    {
      refVideoPath: BLUE,
      timelineStartSec: 1,
      timelineEndSec: 2,
      sourceInSec: 0.5,
      sourceOutSec: 1.5,
      sourceDurationSec: 2,
      hasAudio: true,
      transitionIn: { type, durationSec: 0.5 }
    }
  ]

  const compositeArgs = (type: 'dissolve' | 'pushLeft' | 'windLeft' | 'fadeBlack', output: string): string[] =>
    buildOverlayMp4MultiInput({
      segments: segments(type),
      spanStartSec: 0,
      spanEndSec: 2,
      overlayLabel: '2',
      overlayPath: LAYER,
      outputPath: output,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })

  const rgbAt = async (target: string, atSec: number): Promise<Buffer> => {
    const result = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', target,
      '-ss', atSec.toFixed(6),
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ])
    expect(result.code, result.stderr.slice(-400)).toBe(0)
    return result.stdout
  }

  const center = (frame: Buffer): [number, number, number] => {
    const offset = (Math.floor(OUT_H / 2) * OUT_W + Math.floor(OUT_W / 2)) * 3
    return [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0]
  }

  beforeAll(async () => {
    await makeSolid('red', RED)
    await makeSolid('blue', BLUE)
    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, LAYER, 'png', { width: OUT_W, height: OUT_H }),
      Array.from({ length: 60 }, () => encodeRgbaPng(OUT_W, OUT_H, rgbaFrame(OUT_W, OUT_H, () => null)))
    )
    expect(layer.code, layer.stderr.slice(-600)).toBe(0)
  }, 240_000)

  it('0.5s 溶解：总 60 帧 / 2s，切点中点是混合色，音频仍 2s 硬切', async () => {
    const out = path.join(WORK_DIR, 'tr-dissolve.mp4')
    const result = await run(ffmpeg, compositeArgs('dissolve', out))
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    const verified = await verifyJson(out)
    expect(verified).not.toBeNull()
    if (verified) expect(Number(verified.nbFrames)).toBe(60)
    const probe = parseProbeJson(await probeJson(out), out)
    expect(probe?.durationSec).toBeGreaterThan(1.9)
    expect(probe?.durationSec).toBeLessThan(2.1)
    expect(probe?.audioCodec).toBeTruthy()

    const before = center(await rgbAt(out, 0.5))
    const mid = center(await rgbAt(out, 1.0))
    const after = center(await rgbAt(out, 1.5))
    // 前/后是硬切端点色
    expect(before[0]).toBeGreaterThan(150)
    expect(before[2]).toBeLessThan(90)
    expect(after[2]).toBeGreaterThan(150)
    expect(after[0]).toBeLessThan(90)
    // 切点中点是混合：红蓝都明显存在，且都不是纯色
    expect(mid[0]).toBeGreaterThan(35)
    expect(mid[2]).toBeGreaterThan(35)
    expect(Math.min(mid[0], mid[2])).toBeGreaterThan(20)
  }, 300_000)

  it('方向性转场（推入/风感）图可解，总帧数仍正确', async () => {
    for (const type of ['pushLeft', 'windLeft'] as const) {
      const out = path.join(WORK_DIR, `tr-${type}.mp4`)
      const result = await run(ffmpeg, compositeArgs(type, out))
      expect(result.code, `${type}: ${result.stderr.slice(-600)}`).toBe(0)
      const verified = await verifyJson(out)
      expect(Number(verified?.nbFrames), type).toBe(60)
    }
  }, 300_000)

  it('fadeblack 切点中点接近黑（颜色峰值符合所选效果）', async () => {
    const out = path.join(WORK_DIR, 'tr-fadeblack.mp4')
    const result = await run(ffmpeg, compositeArgs('fadeBlack', out))
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const mid = center(await rgbAt(out, 1.0))
    expect(Math.max(...mid)).toBeLessThan(60)
  }, 300_000)
})

/**
 * v10 预览代理（Task 10 · 实机 FFmpeg）：
 * 用生产同一套 `buildProxyArgs` 把一条 1920×1080 / 25fps 的 MXF 转成代理，
 * 断言「短边 ≤720、长边 ≤1280、30fps、H.264、AAC 128k、时长保持、faststart」。
 */
describe.skipIf(!HAS_BUNDLED_FFMPEG)('4K / MXF 预览代理（v10 · 实机 FFmpeg）', () => {
  const SRC_W = 1920
  const SRC_H = 1080
  const SEC = 1.5
  const MXF = path.join(WORK_DIR, 'proxy-source.mxf')
  const PROXY = path.join(WORK_DIR, 'proxy-output.mp4')

  beforeAll(async () => {
    // 广播容器夹具：mpeg2video + PCM（ffmpeg 原生可读，Chromium 不可）
    const gen = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc=size=${SRC_W}x${SRC_H}:rate=25:duration=${SEC}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SEC}`,
      '-c:v', 'mpeg2video', '-pix_fmt', 'yuv422p', '-q:v', '5',
      '-c:a', 'pcm_s16le', '-ar', '48000',
      '-f', 'mxf', MXF
    ])
    expect(gen.code, gen.stderr.slice(-600)).toBe(0)
  }, 240_000)

  it('MXF → 720p H.264/AAC 代理：尺寸上限、30fps、时长保持、faststart', async () => {
    await fs.rm(PROXY, { force: true }).catch(() => undefined)
    const args = buildProxyArgs({ inputPath: MXF, outputPath: PROXY, hasAudio: true })
    expect(args[args.indexOf('-i') + 1]).toBe(MXF)

    const result = await run(ffmpeg, args)
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    const stat = await fs.stat(PROXY)
    expect(stat.size).toBeGreaterThan(0)

    const meta = parseProbeJson(await probeJson(PROXY), PROXY)
    expect(meta).not.toBeNull()
    if (!meta) return
    const longSide = Math.max(meta.width, meta.height)
    const shortSide = Math.min(meta.width, meta.height)
    expect(longSide).toBeLessThanOrEqual(1280)
    expect(shortSide).toBeLessThanOrEqual(720)
    // 16:9 源应正好落到 1280×720（不被拉伸）
    expect(`${meta.width}x${meta.height}`).toBe('1280x720')
    expect(meta.avgFrameRate.num / meta.avgFrameRate.den).toBeCloseTo(30, 1)
    expect(meta.videoCodec).toBe('h264')
    expect(meta.audioCodec).toBe('aac')
    // 整片转码：时长与源 1:1（25→30 帧率只补帧，不改变时长）
    expect(meta.durationSec).toBeGreaterThan(SEC - 0.2)
    expect(meta.durationSec).toBeLessThan(SEC + 0.2)

    // faststart：moov 在 mdat 之前，预览协议的 Range 流才能边下边播
    const head = (await fs.readFile(PROXY)).subarray(0, 64 * 1024).toString('latin1')
    const moov = head.indexOf('moov')
    const mdat = head.indexOf('mdat')
    expect(moov, 'faststart 未生效：前 64KB 里没有 moov').toBeGreaterThanOrEqual(0)
    if (mdat >= 0) expect(moov).toBeLessThan(mdat)
  }, 300_000)
})

/**
 * v11 组合交付（Task 11.3 · 实机 FFmpeg）：一次导出同时开启
 * 9:16 cover 画布 + 片段几何/调色 + 0.5s 溶解转场 + BGM ducking + social 响度。
 *
 * 全部走生产同一套 `buildOverlayMp4MultiInput`（内部再由 `buildMediaBasisFilterComplex` /
 * `buildAudioMixPlan` 装配），因此这里通过即等于组合场景的导出链可解且读数正确：
 * 1. ffprobe：竖屏尺寸、30fps、时长 = 两段核心时长之和、音轨存在；
 * 2. ebur128：整片积分响度 -14 ±1 LUFS（social）；
 * 3. 逐帧抽样：溶解中点是两色混合，前后仍是各段主色（几何/调色没有把画面吃掉）。
 */
describe.skipIf(!HAS_BUNDLED_FFMPEG)('组合交付：9:16 + 转场 + 几何/调色 + ducking + 响度（v11 · 实机 FFmpeg）', () => {
  const OUT_W = 360
  const OUT_H = 640
  const SEG_SEC = 3
  const TOTAL_SEC = SEG_SEC * 2
  const RED = path.join(WORK_DIR, 'cd-red.mp4')
  const BLUE = path.join(WORK_DIR, 'cd-blue.mp4')
  const LAYER = path.join(WORK_DIR, 'cd-layer.mov')
  const BGM = path.join(WORK_DIR, 'cd-bgm.wav')
  const VOICE = path.join(WORK_DIR, 'cd-voice.wav')

  const makeSolid = async (color: string, target: string): Promise<void> => {
    const result = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=${color}:s=${OUT_W}x${OUT_H}:r=30:d=${SEG_SEC + 2}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', target
    ])
    expect(result.code, result.stderr.slice(-600)).toBe(0)
  }

  const segments = (): ConcatSegment[] => [
    {
      refVideoPath: RED,
      timelineStartSec: 0,
      timelineEndSec: SEG_SEC,
      sourceInSec: 0,
      sourceOutSec: SEG_SEC,
      sourceDurationSec: SEG_SEC + 2,
      hasAudio: false,
      // 片段一：调色（亮度 +20），验证色彩参数真的烧进组合导出
      video: { ...defaultMediaVideo(), brightness: 20 }
    },
    {
      refVideoPath: BLUE,
      timelineStartSec: SEG_SEC,
      timelineEndSec: TOTAL_SEC,
      sourceInSec: 1,
      sourceOutSec: 4,
      sourceDurationSec: SEG_SEC + 2,
      hasAudio: false,
      // 片段二：几何（放大 120% + 左移 10%），与转场/画布同时生效
      video: { ...defaultMediaVideo(), scalePercent: 120, offsetXPercent: -10 },
      transitionIn: { type: 'dissolve', durationSec: 0.5 }
    }
  ]

  const compositeArgs = (output: string): string[] =>
    buildOverlayMp4MultiInput({
      segments: segments(),
      spanStartSec: 0,
      spanEndSec: TOTAL_SEC,
      overlayLabel: '2',
      overlayPath: LAYER,
      outputPath: output,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      audioMode: 'aac',
      fpsMode: 'cfr',
      canvas: { width: OUT_W, height: OUT_H, fit: 'cover' },
      quality: 'standard',
      audioClips: [
        {
          path: BGM,
          timelineStartSec: 0,
          timelineEndSec: TOTAL_SEC,
          sourceInSec: 0,
          sourceOutSec: TOTAL_SEC,
          role: 'bgm',
          ducking: 'standard'
        },
        {
          path: VOICE,
          timelineStartSec: 2,
          timelineEndSec: 4,
          sourceInSec: 0,
          sourceOutSec: 2,
          role: 'voice',
          audio: { volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 }
        }
      ],
      mastering: 'social'
    })

  beforeAll(async () => {
    await makeSolid('red', RED)
    await makeSolid('blue', BLUE)
    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, LAYER, 'png', { width: OUT_W, height: OUT_H }),
      Array.from({ length: TOTAL_SEC * 30 }, () =>
        encodeRgbaPng(OUT_W, OUT_H, rgbaFrame(OUT_W, OUT_H, () => null))
      )
    )
    expect(layer.code, layer.stderr.slice(-600)).toBe(0)
    const bgm = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=200:duration=${TOTAL_SEC}`,
      '-c:a', 'pcm_s16le', BGM
    ])
    expect(bgm.code, bgm.stderr.slice(-600)).toBe(0)
    const voice = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=3000:duration=2',
      '-c:a', 'pcm_s16le', VOICE
    ])
    expect(voice.code, voice.stderr.slice(-600)).toBe(0)
  }, 300_000)

  const rgbAt = async (target: string, atSec: number): Promise<Buffer> => {
    const result = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', target,
      '-ss', atSec.toFixed(6),
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'
    ])
    expect(result.code, result.stderr.slice(-400)).toBe(0)
    return result.stdout
  }

  const center = (frame: Buffer): [number, number, number] => {
    const offset = (Math.floor(OUT_H / 2) * OUT_W + Math.floor(OUT_W / 2)) * 3
    return [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0]
  }

  it('一次导出：竖屏尺寸/帧率/时长/音轨 + 转场中点混合 + social 响度达标', async () => {
    const out = path.join(WORK_DIR, 'cd-combined.mp4')
    const argv = compositeArgs(out)
    // 组合图里各项能力都必须真的在链上（不是「参数写了但没生效」）
    const joined = argv.join(' ')
    expect(joined).toContain('scale=360:640:force_original_aspect_ratio=increase,crop=360:640')
    expect(joined).toContain('xfade=transition=fade:duration=0.500000')
    expect(joined).toContain('sidechaincompress')
    expect(joined).toContain('loudnorm=I=-14')
    // 亮度按 RGB 乘性增益（与预览 CSS brightness 同口径），不是 eq
    expect(joined).toContain('colorchannelmixer=rr=1.2:gg=1.2:bb=1.2')

    const result = await run(ffmpeg, argv)
    expect(result.code, result.stderr.slice(-600)).toBe(0)

    const meta = parseProbeJson(await probeJson(out), out)
    expect(meta).not.toBeNull()
    if (!meta) return
    // 9:16 竖屏（cover 归一后目标画布）
    expect(`${meta.width}x${meta.height}`).toBe(`${OUT_W}x${OUT_H}`)
    expect(meta.avgFrameRate.num / meta.avgFrameRate.den).toBeCloseTo(30, 1)
    // 成片时长仍等于两段核心时长之和（xfade 手柄不改变长度）；
    // 30fps 下 0.5s 转场的半手柄是 7.5 帧，扩展源区间必然落在半帧边界，允许 1 帧量化误差
    expect(meta.durationSec).toBeGreaterThan(TOTAL_SEC - 0.1)
    expect(meta.durationSec).toBeLessThan(TOTAL_SEC + 0.1)
    // 音轨存在（BGM + 口播混音后编码）
    expect(meta.audioCodec).toBeTruthy()

    // 音频必须覆盖整片：转场路径的音频 concat 不能在 concat 前再按时间轴平移，
    // 否则第二段起会被推到 2× 偏移处，成片后半段静音（本用例曾实测只有前 3s 有声）
    const audioProbe = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=duration', '-of', 'json', out
    ])
    const audioStreams = (JSON.parse(audioProbe.stdout.toString('utf8')) as {
      streams?: { duration?: string }[]
    }).streams
    const audioDurationSec = Number.parseFloat(audioStreams?.[0]?.duration ?? 'NaN')
    expect(audioDurationSec, `音轨时长 ${audioDurationSec}s`).toBeGreaterThan(TOTAL_SEC - 0.2)
    const tail = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'info', '-i', out,
      '-af', 'atrim=start=5:end=6,volumedetect', '-f', 'null', '-'
    ])
    const meanTail = /mean_volume:\s*(-?[0-9.]+)\s*dB/.exec(tail.stderr)
    expect(meanTail, `末段无音频样本：${tail.stderr.slice(-400)}`).not.toBeNull()
    // 口播结束后 BGM 恢复（200Hz 底乐仍在），不能是一片静音
    expect(Number.parseFloat(meanTail?.[1] ?? 'NaN')).toBeGreaterThan(-60)

    const verified = await verifyJson(out)
    expect(verified).not.toBeNull()
    if (verified) {
      expect(Math.abs(Number(verified.nbFrames) - TOTAL_SEC * 30)).toBeLessThanOrEqual(1)
      expect(isDeliveryYuv420p(verified)).toBe(true)
    }

    // 切点中点（3.0s）是两色混合：红与蓝都明显存在，且不是任一端的纯色
    const before = center(await rgbAt(out, 1))
    const mid = center(await rgbAt(out, SEG_SEC))
    const after = center(await rgbAt(out, TOTAL_SEC - 1))
    expect(before[0]).toBeGreaterThan(150)
    expect(before[2]).toBeLessThan(90)
    expect(after[2]).toBeGreaterThan(150)
    expect(after[0]).toBeLessThan(90)
    expect(Math.min(mid[0], mid[2]), `中点像素 ${mid.join(',')}`).toBeGreaterThan(20)

    // 响度：social 目标 -14 LUFS，单遍 loudnorm 后整片积分响度 ±1 LU
    const lufsRun = await run(ffmpeg, ['-hide_banner', '-i', out, '-af', 'ebur128', '-f', 'null', '-'])
    expect(lufsRun.code, lufsRun.stderr.slice(-600)).toBe(0)
    const match = /Integrated loudness:[\s\S]*?I:\s*(-?[0-9.]+)\s*LUFS/.exec(lufsRun.stderr)
    expect(match, lufsRun.stderr.slice(-600)).not.toBeNull()
    const lufs = Number.parseFloat(match?.[1] ?? 'NaN')
    expect(Math.abs(lufs - -14), `实测 ${lufs} LUFS`).toBeLessThanOrEqual(1)
  }, 300_000)
})

/**
 * v11 验收追加：非转场单轨 concat 的 PTS 二次偏移护栏（实机 FFmpeg）。
 *
 * 历史缺陷：`buildSingleTrackBasis` 在送进 `concat` 之前又给每段加了
 * `setpts/asetpts=PTS+<时间轴偏移>`；`concat` 本身会累加前序段时长，于是偏移被算两次。
 * 实测「两段各 0.5s 相邻」的成片是 1.5s（应为 1.0s）。
 * 本用例直接跑生产构造函数 `buildOverlayMp4MultiInput`，只量成片时长/帧数：
 * 相邻 0.5+0.5 → 1.0s；中间留 0.5s 空隙（pushGap 补黑+静音）→ 1.5s。
 */
describe.skipIf(!HAS_BUNDLED_FFMPEG)('非转场单轨 concat 时长（v11 验收追加 · 实机 FFmpeg）', () => {
  const OUT_W = 320
  const OUT_H = 240
  const SRC_SEC = 2
  const SRC = path.join(WORK_DIR, 'nt-src.mp4')
  const LAYER = path.join(WORK_DIR, 'nt-layer.mov')

  /** 一段 0.5s 的媒体段（带音轨，音频链同样不能再平移 PTS） */
  const seg = (timelineStartSec: number, sourceInSec: number): ConcatSegment => ({
    refVideoPath: SRC,
    timelineStartSec,
    timelineEndSec: timelineStartSec + 0.5,
    sourceInSec,
    sourceOutSec: sourceInSec + 0.5,
    hasAudio: true
  })

  const compositeArgs = (segments: ConcatSegment[], spanEndSec: number, output: string): string[] =>
    buildOverlayMp4MultiInput({
      segments,
      spanStartSec: 0,
      spanEndSec,
      overlayLabel: '2',
      overlayPath: LAYER,
      outputPath: output,
      fps: FPS_30,
      frameSize: { width: OUT_W, height: OUT_H },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })

  beforeAll(async () => {
    const gen = await run(ffmpeg, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=red:s=${OUT_W}x${OUT_H}:r=30:d=${SRC_SEC}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SRC_SEC}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC
    ])
    expect(gen.code, gen.stderr.slice(-600)).toBe(0)
    const layer = await runWithFrames(
      buildTransparentMovFromPipe(FPS_30, LAYER, 'png', { width: OUT_W, height: OUT_H }),
      Array.from({ length: SRC_SEC * 30 }, () =>
        encodeRgbaPng(OUT_W, OUT_H, rgbaFrame(OUT_W, OUT_H, () => null))
      )
    )
    expect(layer.code, layer.stderr.slice(-600)).toBe(0)
  }, 240_000)

  const assertSpan = async (out: string, expectedSec: number): Promise<void> => {
    const probe = parseProbeJson(await probeJson(out), out)
    expect(probe, 'ffprobe 解析失败').not.toBeNull()
    if (!probe) return
    // 缺陷版本会给第二段叠加一次偏移：相邻两段会得到 1.5s
    expect(probe.durationSec, `成片时长 ${probe.durationSec}s ≠ ${expectedSec}s`).toBeGreaterThan(expectedSec - 0.08)
    expect(probe.durationSec, `成片时长 ${probe.durationSec}s ≠ ${expectedSec}s`).toBeLessThan(expectedSec + 0.08)
    const verified = await verifyJson(out)
    expect(verified).not.toBeNull()
    if (verified) {
      expect(Math.abs(Number(verified.nbFrames) - Math.round(expectedSec * 30))).toBeLessThanOrEqual(1)
    }
    // 音轨同样必须覆盖整条 span（缺陷版本会把第二段推到 2× 偏移处）
    const audioProbe = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=duration', '-of', 'json', out
    ])
    const audioDuration = Number.parseFloat(
      ((JSON.parse(audioProbe.stdout.toString('utf8')) as { streams?: { duration?: string }[] }).streams ??
        [])[0]?.duration ?? 'NaN'
    )
    expect(audioDuration, `音轨时长 ${audioDuration}s`).toBeGreaterThan(expectedSec - 0.15)
  }

  it('两段 0.5s 相邻：成片 = 1.0s / 30 帧（不再被二次偏移成 1.5s）', async () => {
    const out = path.join(WORK_DIR, 'nt-contiguous.mp4')
    const result = await run(ffmpeg, compositeArgs([seg(0, 0), seg(0.5, 0.5)], 1, out))
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    await assertSpan(out, 1)
  }, 300_000)

  it('两段 0.5s + 中段 0.5s 空隙：成片 = 1.5s / 45 帧', async () => {
    const out = path.join(WORK_DIR, 'nt-gap.mp4')
    const result = await run(ffmpeg, compositeArgs([seg(0, 0), seg(1, 0.5)], 1.5, out))
    expect(result.code, result.stderr.slice(-600)).toBe(0)
    await assertSpan(out, 1.5)
  }, 300_000)
})
