import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCoverArgs } from '@shared/coverArgs'
import { buildImageSizeArgs, buildProbeArgs } from '@shared/ffmpegArgs'
import type { CoverMediaLayer } from '@shared/types'
import { encodeRgbaPng, rgbaFrame } from './helpers/png'

/** 封面帧（v10）：纯 argv 断言 + 真机合成一次（尺寸/媒体/字幕取样）。 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK_DIR = path.join(ROOT, 'spikes', 'tmp-cover')
const EXE = process.platform === 'win32' ? '.exe' : ''
const BUNDLED_FFMPEG = path.join(ROOT, 'resources', 'ffmpeg', `ffmpeg${EXE}`)
const BUNDLED_FFPROBE = path.join(ROOT, 'resources', 'ffmpeg', `ffprobe${EXE}`)

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

const layers: CoverMediaLayer[] = [
  { path: 'D:/media/a.mp4', kind: 'video', sourceTimeSec: 3.5 },
  { path: 'D:/media/b.png', kind: 'image', sourceTimeSec: 0, imageDurationSec: 4 }
]

function argsOf(watermark: boolean): string[] {
  return buildCoverArgs({
    width: 1080,
    height: 1920,
    fit: 'cover',
    layers,
    overlayPath: 'D:/tmp/subtitle.png',
    ...(watermark
      ? { watermark: { path: 'D:/brand/logo.png', sourceWidth: 800, sourceHeight: 450 } }
      : {}),
    outputPath: 'D:/out/cover.png'
  })
}

describe('封面 argv', () => {
  it('逐层输入：视频 -ss、图片 -loop -t、透明层与可选水印', () => {
    const args = argsOf(true)
    const ssIndex = args.indexOf('-ss')
    expect(ssIndex).toBeGreaterThanOrEqual(0)
    expect(args[ssIndex + 1]).toBe('3.500000')
    const joined = args.join(' ')
    expect(joined).toContain('-loop 1 -t 0.033333 -i D:/media/b.png')
    expect(joined).toContain('-loop 1 -t 0.033333 -i D:/tmp/subtitle.png')
    expect(joined).toContain('-loop 1 -i D:/brand/logo.png')
    expect(args[args.length - 1]).toBe('D:/out/cover.png')
    expect(args).toContain('-frames:v')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args[args.indexOf('-update') + 1]).toBe('1')
  })

  it('层归一 + 底→顶合成 + 字幕 + 水印顺序', () => {
    const filter = argsOf(true)[argsOf(true).indexOf('-filter_complex') + 1]!
    expect(filter).toContain(
      '[0:v]format=rgba,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[cv0]'
    )
    expect(filter).toContain(
      '[1:v]format=rgba,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[cv1]'
    )
    expect(filter).toContain('color=c=black:s=1080x1920')
    expect(filter.indexOf('[cv0]')).toBeGreaterThanOrEqual(0)
    expect(filter.indexOf('[base]')).toBeGreaterThan(filter.indexOf('[cv0]'))
    expect(filter.indexOf('[2:v]')).toBeGreaterThan(filter.indexOf('[mo1]'))
    expect(filter.indexOf('[st]')).toBeGreaterThan(filter.indexOf('[2:v]'))
    expect(filter.indexOf('[3:v]')).toBeGreaterThan(filter.indexOf('[st]'))
    expect(filter).toContain('overlay=0:0:alpha=straight:format=auto')
  })

  it('默认无水印不追加输入与滤镜', () => {
    const args = argsOf(false)
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).not.toContain('[wm]')
    expect(args.join(' ')).not.toContain('D:/brand/logo.png')
    expect(args.filter((arg) => arg === '-i')).toHaveLength(3)
  })

  it('没有媒体层也能产出黑底 + 字幕', () => {
    const args = buildCoverArgs({
      width: 720,
      height: 720,
      fit: 'contain',
      layers: [],
      overlayPath: 'D:/tmp/subtitle.png',
      outputPath: 'D:/out/cover.png'
    })
    const filter = args[args.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('color=c=black:s=720x720')
    expect(filter).toContain('[0:v]format=rgba[sub]')
    expect(filter).toContain('[base][sub]overlay=0:0')
  })
})

describe('封面真机合成', () => {
  let ffmpeg = ''
  let ffprobe = ''

  beforeAll(async () => {
    const present = await Promise.all(
      [BUNDLED_FFMPEG, BUNDLED_FFPROBE].map(async (file) => {
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
      const probe = await run('ffmpeg', ['-version'])
      if (probe.code !== 0) throw new Error('未找到 FFmpeg：请先执行 npm run fetch:ffmpeg')
      ffmpeg = 'ffmpeg'
      ffprobe = 'ffprobe'
    }
    await fs.mkdir(WORK_DIR, { recursive: true })
  })

  afterAll(async () => {
    if (process.env.SOCUT_CLEAN_TMP) await fs.rm(WORK_DIR, { recursive: true, force: true })
  })

  it('合成单帧 PNG：尺寸正确、媒体区域为视频颜色、字幕区域保留透明层内容', async () => {
    const mediaPath = path.join(WORK_DIR, 'cover-media.mp4')
    const overlayPath = path.join(WORK_DIR, 'cover-overlay.png')
    const outputPath = path.join(WORK_DIR, 'cover.png')

    const gen = await run(ffmpeg, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x36:d=2:r=30',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      mediaPath
    ])
    expect(gen.code).toBe(0)

    const overlay = rgbaFrame(128, 72, (x, y) =>
      x < 16 && y < 16 ? [0, 255, 0, 255] : null
    )
    await fs.writeFile(overlayPath, encodeRgbaPng(128, 72, overlay))

    const args = buildCoverArgs({
      width: 128,
      height: 72,
      fit: 'cover',
      layers: [{ path: mediaPath, kind: 'video', sourceTimeSec: 0.5 }],
      overlayPath,
      outputPath
    })
    const result = await run(ffmpeg, args)
    expect(result.code).toBe(0)
    if (result.code !== 0) throw new Error(result.stderr.slice(-800))

    const probe = await run(ffprobe, buildImageSizeArgs(outputPath))
    const parsed = JSON.parse(probe.stdout.toString('utf8')) as {
      streams?: Array<{ width: number; height: number; codec_type: string }>
    }
    expect(parsed.streams?.[0]?.width).toBe(128)
    expect(parsed.streams?.[0]?.height).toBe(72)

    const mediaPixel = await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      outputPath,
      '-vf',
      'crop=8:8:60:32,format=rgb24',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1'
    ])
    expect(mediaPixel.code).toBe(0)
    const media = mediaPixel.stdout
    expect(media[0]!).toBeGreaterThan(media[1]!)
    expect(media[0]!).toBeGreaterThan(media[2]!)

    const subtitlePixel = await run(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      outputPath,
      '-vf',
      'crop=8:8:2:2,format=rgb24',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      'pipe:1'
    ])
    expect(subtitlePixel.code).toBe(0)
    const subtitle = subtitlePixel.stdout
    expect(subtitle[1]!).toBeGreaterThan(subtitle[0]!)
    expect(subtitle[1]!).toBeGreaterThan(subtitle[2]!)

    const verify = await run(ffprobe, buildProbeArgs(outputPath))
    expect(verify.code).toBe(0)
  }, 120_000)

  it('带水印也能落盘（水印链尾的 yuv420p 由编码器自动转 PNG）', async () => {
    const mediaPath = path.join(WORK_DIR, 'cover-media.mp4')
    const overlayPath = path.join(WORK_DIR, 'cover-overlay.png')
    const watermarkPath = path.join(WORK_DIR, 'cover-watermark.png')
    const outputPath = path.join(WORK_DIR, 'cover-wm.png')

    await fs.writeFile(
      watermarkPath,
      encodeRgbaPng(40, 40, rgbaFrame(40, 40, () => [0, 0, 255, 255]))
    )
    const args = buildCoverArgs({
      width: 128,
      height: 72,
      fit: 'cover',
      layers: [{ path: mediaPath, kind: 'video', sourceTimeSec: 0.5 }],
      overlayPath,
      watermark: { path: watermarkPath, sourceWidth: 40, sourceHeight: 40 },
      outputPath
    })
    const result = await run(ffmpeg, args)
    expect(result.code).toBe(0)
    if (result.code !== 0) throw new Error(result.stderr.slice(-800))

    const probe = await run(ffprobe, buildImageSizeArgs(outputPath))
    const parsed = JSON.parse(probe.stdout.toString('utf8')) as {
      streams?: Array<{ width: number; height: number }>
    }
    expect(parsed.streams?.[0]?.width).toBe(128)
    expect(parsed.streams?.[0]?.height).toBe(72)
  }, 120_000)
})
