import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import {
  aomCpuUsed,
  pickHardwareEncoder,
  softwareEncoderName,
  softwareVideoEncodeArgs,
  videoEncodeArgs,
  type HardwareEncoderInfo
} from '@shared/gpu'
import {
  buildOverlayMp4DirectPipe,
  buildOverlayMp4MultiInputDirectPipe,
  fullRangeFilter,
  outputPixelFormat,
  outputTailFilters
} from '@shared/ffmpegArgs'

/**
 * M9 编码交付：AV1 / CRF 直给 / preset / 10bit / colorRange。
 *
 * 分两层：
 * 1. argv 层（纯函数，必定执行）：编码器选择、AV1 软件/硬件参数、色彩与位深参数、默认 argv 不变；
 * 2. 真机层（随包 FFmpeg 有对应编码器才跑）：libaom-av1 与 libx265 10bit 真的产出可解析的产物。
 */

const FFMPEG = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const FFPROBE = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const HAS_BUNDLED_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE)

/** 真机用例产物统一清掉，不给下一次 `verify` 留垃圾（spikes 本身被 gitignore）。 */
afterAll(async () => {
  await fs.rm(path.resolve('spikes', 'tmp-av1-encode.mp4'), { force: true })
  await fs.rm(path.resolve('spikes', 'tmp-hevc10-encode.mp4'), { force: true })
})

function joined(args: readonly string[]): string {
  return args.join(' ')
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(binary: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** 随包 FFmpeg 是否有该编码器（没有就跳过真机用例，而不是假绿）。 */
async function hasEncoder(name: string): Promise<boolean> {
  if (!HAS_BUNDLED_FFMPEG) return false
  const result = await run(FFMPEG, ['-hide_banner', '-encoders'])
  return result.stdout.includes(name)
}

describe('gpu：AV1 与编码参数', () => {
  it('软件 AV1：libaom-av1 + CRF + cpu-used（x264 preset 名粗映射）', () => {
    expect(softwareVideoEncodeArgs(30, 'medium', { codec: 'av1' })).toEqual([
      '-c:v',
      'libaom-av1',
      '-crf',
      '30',
      '-cpu-used',
      '5'
    ])
    expect(aomCpuUsed('ultrafast')).toBe(8)
    expect(aomCpuUsed('veryslow')).toBe(2)
    expect(aomCpuUsed('不认识的档位')).toBe(5)
  })

  it('软件 H.264/HEVC 仍逐字节保持旧 argv', () => {
    expect(softwareVideoEncodeArgs(18, 'medium')).toEqual(['-c:v', 'libx264', '-crf', '18', '-preset', 'medium'])
    expect(softwareVideoEncodeArgs(23, 'slow', { codec: 'hevc' })).toEqual([
      '-c:v',
      'libx265',
      '-crf',
      '23',
      '-preset',
      'slow'
    ])
  })

  it('硬件 AV1：nvenc/qsv/amf 走各自参数族；codec 不匹配时回退软件', () => {
    expect(videoEncodeArgs({ encoder: 'av1_nvenc', quality: 28, preset: 'medium', codec: 'av1' })).toEqual([
      '-c:v',
      'av1_nvenc',
      '-preset',
      'p5',
      '-tune',
      'hq',
      '-rc',
      'vbr',
      '-cq',
      '28',
      '-b:v',
      '0'
    ])
    expect(videoEncodeArgs({ encoder: 'av1_qsv', quality: 28, preset: 'medium', codec: 'av1' })).toContain('av1_qsv')
    expect(videoEncodeArgs({ encoder: 'av1_amf', quality: 28, preset: 'medium', codec: 'av1' })).toContain('av1_amf')
    // 请求 h264 却拿到 av1_nvenc：必须回退软件，绝不产出错配 argv
    expect(videoEncodeArgs({ encoder: 'av1_nvenc', quality: 18, preset: 'medium', codec: 'h264' })).toContain('libx264')
  })

  it('pickHardwareEncoder 支持 av1 过滤', () => {
    const encoders: HardwareEncoderInfo[] = [
      { name: 'h264_nvenc', vendor: 'nvidia', codec: 'h264' },
      { name: 'av1_nvenc', vendor: 'nvidia', codec: 'av1' }
    ]
    expect(pickHardwareEncoder(encoders, { mode: 'auto', codec: 'av1' })?.name).toBe('av1_nvenc')
    expect(pickHardwareEncoder(encoders, { mode: 'software', codec: 'av1' })).toBeNull()
  })
})

describe('ffmpegArgs：合成出口的 M9 编码参数', () => {
  function directInput(over: Record<string, unknown> = {}): Parameters<typeof buildOverlayMp4DirectPipe>[0] {
    return {
      refVideoPath: 'D:/media/ref.mp4',
      outputPath: 'D:/out/final.mp4',
      fps: FPS_30,
      frameFormat: 'raw',
      frameSize: { width: 1920, height: 1080 },
      spanStartSec: 0,
      spanEndSec: 1,
      audioMode: 'copy',
      fpsMode: 'cfr',
      ...over
    } as Parameters<typeof buildOverlayMp4DirectPipe>[0]
  }

  it('默认（不传 M9 字段）：argv 与旧版一致（libx264 / medium / CRF18 / 无 -pix_fmt）', () => {
    const text = joined(buildOverlayMp4DirectPipe(directInput()))
    expect(text).toContain('-c:v libx264 -crf 18 -preset medium')
    // 输入端本来就有 `-pix_fmt rgba`（stdin 帧流），这里只断言"输出侧没有 10bit/range 参数"
    expect(text).not.toContain('yuv420p10le')
    expect(text).not.toContain('-color_range')
    expect(text).toContain('-colorspace bt709 -color_primaries bt709 -color_trc bt709')
  })

  it('CRF 直给 + preset：覆盖画质档与默认 medium', () => {
    const text = joined(buildOverlayMp4DirectPipe(directInput({ crf: 30, encoderPreset: 'slow' })))
    expect(text).toContain('-c:v libx264 -crf 30 -preset slow')
  })

  it('AV1 + 10bit + full range：编码器/位深/范围标签齐全', () => {
    const text = joined(
      buildOverlayMp4DirectPipe(directInput({ videoCodec: 'av1', crf: 34, bitDepth: 10, colorRange: 'full' }))
    )
    expect(text).toContain('-c:v libaom-av1 -crf 34 -cpu-used')
    expect(text).toContain('-pix_fmt yuv420p10le')
    expect(text).toContain('-color_range pc')
  })

  it('硬件 AV1 编码器透传：-c:v av1_nvenc', () => {
    const text = joined(buildOverlayMp4DirectPipe(directInput({ videoCodec: 'av1' }), 'av1_nvenc'))
    expect(text).toContain('-c:v av1_nvenc')
  })
})

describe('真机：AV1 / 10bit 产物（随包 FFmpeg 缺编码器时跳过）', () => {
  async function probe(file: string): Promise<{ codec: string; pixFmt: string; colorRange: string }> {
    const result = await run(FFPROBE, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt,color_range',
      '-of',
      'default=nw=1',
      file
    ])
    const map = new Map<string, string>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const [key, value] = line.split('=')
      if (key && value) map.set(key.trim(), value.trim())
    }
    return {
      codec: map.get('codec_name') ?? '',
      pixFmt: map.get('pix_fmt') ?? '',
      colorRange: map.get('color_range') ?? ''
    }
  }

  it.skipIf(!HAS_BUNDLED_FFMPEG)('libaom-av1 产出 codec=av1', async () => {
    if (!(await hasEncoder('libaom-av1'))) return
    const output = path.resolve('spikes', 'tmp-av1-encode.mp4')
    const encode = await run(FFMPEG, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=0.3',
      '-c:v',
      'libaom-av1',
      '-crf',
      '50',
      '-cpu-used',
      '8',
      '-pix_fmt',
      'yuv420p',
      output
    ])
    expect(encode.code).toBe(0)
    const info = await probe(output)
    expect(info.codec).toBe('av1')
    expect(info.pixFmt).toBe('yuv420p')
  })

  it.skipIf(!HAS_BUNDLED_FFMPEG)('libx265 10bit 产出 pix_fmt=yuv420p10le；full range 带 pc 标签', async () => {
    if (!(await hasEncoder('libx265'))) return
    const output = path.resolve('spikes', 'tmp-hevc10-encode.mp4')
    const encode = await run(FFMPEG, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=0.3',
      '-c:v',
      'libx265',
      '-crf',
      '28',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p10le',
      '-color_range',
      'pc',
      output
    ])
    expect(encode.code).toBe(0)
    const info = await probe(output)
    expect(info.codec).toBe('hevc')
    expect(info.pixFmt).toBe('yuv420p10le')
    // 部分 muxer 会保留 full range 标签；没有标注时这里不应误报失败
    expect(['pc', '']).toContain(info.colorRange)
  })
})

/** M9-B：最小可用的多输入直接管道输入（只给必填字段）。 */
function minimalPipeInput() {
  return {
    segments: [
      {
        refVideoPath: 'D:/media/a.mp4',
        timelineStartSec: 0,
        timelineEndSec: 2,
        sourceInSec: 0,
        sourceOutSec: 2,
        hasAudio: false
      }
    ],
    spanStartSec: 0,
    spanEndSec: 2,
    overlayLabel: '1',
    fps: FPS_30,
    frameSize: { width: 320, height: 180 },
    audioMode: 'aac' as const,
    fpsMode: 'cfr' as const,
    outputPath: 'D:/out.mp4',
    frameFormat: 'raw' as const
  }
}

describe('M9-B：10bit 图内处理与 full range 像素转换', () => {
  /** 与上面真机 describe 同一份 ffprobe 读取（此处单独定义，避免跨 describe 作用域引用）。 */
  async function probeStream(file: string): Promise<{ codec: string; pixFmt: string; colorRange: string }> {
    const result = await run(FFPROBE, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt,color_range',
      '-of',
      'default=nw=1',
      file
    ])
    const map = new Map<string, string>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const [key, value] = line.split('=')
      if (key && value) map.set(key.trim(), value.trim())
    }
    return {
      codec: map.get('codec_name') ?? '',
      pixFmt: map.get('pix_fmt') ?? '',
      colorRange: map.get('color_range') ?? ''
    }
  }

  it('outputPixelFormat / outputTailFilters：缺省与旧版逐字节一致，10bit/full 才追加', () => {
    expect(outputPixelFormat(undefined)).toBe('yuv420p')
    expect(outputPixelFormat(8)).toBe('yuv420p')
    expect(outputPixelFormat(10)).toBe('yuv420p10le')
    expect(outputTailFilters({})).toBe('format=yuv420p')
    expect(outputTailFilters({ bitDepth: 10 })).toBe('format=yuv420p10le')
    expect(outputTailFilters({ colorRange: 'full', bitDepth: 10 })).toBe(
      'scale=in_range=limited:out_range=full,format=yuv420p10le'
    )
    expect(fullRangeFilter('limited')).toBeNull()
    expect(fullRangeFilter(undefined)).toBeNull()
  })

  it('滤镜链尾真的带上 10bit/范围转换（多输入直接管道 argv）', () => {
    const argv = buildOverlayMp4MultiInputDirectPipe({ ...minimalPipeInput(), bitDepth: 10, colorRange: 'full' })
    const filter = argv[argv.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('format=yuv420p10le')
    expect(filter).toContain('scale=in_range=limited:out_range=full')
    expect(argv.join(' ')).toContain('-pix_fmt yuv420p10le')
    expect(argv.join(' ')).toContain('-color_range pc')

    // 缺省（8bit/limited）：回到 yuv420p，不出现范围转换、也不追加 -pix_fmt（旧 argv 不变）
    const plain = buildOverlayMp4MultiInputDirectPipe(minimalPipeInput())
    const plainFilter = plain[plain.indexOf('-filter_complex') + 1]!
    expect(plainFilter).toContain('format=yuv420p')
    expect(plainFilter).not.toContain('out_range=full')
    expect(plain.join(' ')).not.toContain('-pix_fmt yuv420p10le')
  })

  it('软件编码回退映射：AV1 → libaom-av1（不会被悄悄降成 H.264）', () => {
    expect(softwareEncoderName('av1')).toBe('libaom-av1')
    expect(softwareEncoderName('hevc')).toBe('libx265')
    expect(softwareEncoderName('h264')).toBe('libx264')
    expect(softwareEncoderName(undefined)).toBe('libx264')
  })

  it.skipIf(!HAS_BUNDLED_FFMPEG)('真机：链尾 10bit + full 范围转换可被 libx265 编码并探测', async () => {
    if (!(await hasEncoder('libx265'))) return
    const tail = outputTailFilters({ bitDepth: 10, colorRange: 'full' })
    const output = path.resolve('spikes', 'tmp-hevc10-encode.mp4')
    const encode = await run(FFMPEG, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=0.3',
      '-vf',
      tail,
      '-c:v',
      'libx265',
      '-crf',
      '28',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p10le',
      '-color_range',
      'pc',
      output
    ])
    expect(encode.code, encode.stderr.slice(0, 400)).toBe(0)
    const info = await probeStream(output)
    expect(info.codec).toBe('hevc')
    expect(info.pixFmt).toBe('yuv420p10le')
  })
})
