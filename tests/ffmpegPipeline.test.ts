import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ALPHA_DROPPED_MARKER,
  buildCfrArgs,
  buildOverlayMp4,
  buildProbeArgs,
  buildTransparentMovFromPipe,
  buildVerifyArgs,
  buildVfrSampleArgs
} from '@shared/ffmpegArgs'
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

function run(bin: string, args: string[], stdin?: Buffer): Promise<RunResult> {
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

// alpha 语义的量化断言已归入上方「alpha 语义与选项取值」块（旧版此处重复了两个同名的
// describe，且其中「premultiplied 与 straight 像素结果不同」的断言与 FFmpeg 8.1.1 实测不符，
// 已删除：实测两种写法在 RGBA 直通素材上得到相同像素，真正可靠的证据是枚举定义与期望混合值）。
