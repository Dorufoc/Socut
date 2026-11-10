import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  KEY_DEFAULTS,
  despillTypeOf,
  isDefaultMediaClipKey,
  keyFilters,
  normalizeMediaClipKey
} from '@shared/keying'
import { buildMediaClipVideoFx } from '@shared/mediaClipVideoFfmpeg'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import { FPS_30 } from '@shared/constants'

/** M8：抠像（色度键/亮度键/去溢色）——归一化、滤镜串、画面链接入、真机可跑。 */

const FFMPEG = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const FFPROBE = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE)

function run(binary: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe('keying：归一化', () => {
  it('全默认 → undefined（整键删除）；未知键忽略', () => {
    expect(normalizeMediaClipKey(undefined)).toBeUndefined()
    expect(normalizeMediaClipKey({})).toBeUndefined()
    expect(normalizeMediaClipKey({ ...KEY_DEFAULTS })).toBeUndefined()
    expect(normalizeMediaClipKey('nope')).toBeUndefined()
  })

  it('脏值夹取、颜色规范化（非法回退默认绿）', () => {
    const parsed = normalizeMediaClipKey({
      mode: 'luma',
      color: '#ABCDEF',
      similarity: 5,
      blend: -1,
      threshold: 0.7
    })!
    expect(parsed.color).toBe('#abcdef')
    expect(parsed.mode).toBe('luma')
    expect(parsed.similarity).toBe(1)
    expect(parsed.blend).toBe(0)
    expect(parsed.threshold).toBeCloseTo(0.7, 6)
    // 非法颜色回退默认绿；其余全默认 → 整键删除
    expect(normalizeMediaClipKey({ color: 'red' })).toBeUndefined()
    expect(normalizeMediaClipKey({ color: 'red', similarity: 0.4 })!.color).toBe(KEY_DEFAULTS.color)
  })

  it('isDefaultMediaClipKey：默认参数为 true，动一项为 false', () => {
    expect(isDefaultMediaClipKey(undefined)).toBe(true)
    expect(isDefaultMediaClipKey({ ...KEY_DEFAULTS })).toBe(true)
    expect(isDefaultMediaClipKey({ ...KEY_DEFAULTS, similarity: 0.3 })).toBe(false)
  })
})

describe('keying：滤镜串', () => {
  it('色度键：chromakey + despill（绿幕 → green、蓝幕 → blue）', () => {
    const green = keyFilters({ ...KEY_DEFAULTS, color: '#00b140', similarity: 0.2, blend: 0.1, despill: 0.6 })
    expect(green[0]).toBe('chromakey=color=0x00b140:similarity=0.2:blend=0.1')
    expect(green[1]).toBe('despill=type=green:mix=0.6')

    const blue = keyFilters({ ...KEY_DEFAULTS, color: '#0000ff' })
    expect(blue[1]).toBe('despill=type=blue:mix=0.5')
    expect(despillTypeOf('#0000ff')).toBe('blue')
    expect(despillTypeOf('#00ff00')).toBe('green')
  })

  it('关闭去溢色时只出 chromakey；亮度键三参数', () => {
    expect(keyFilters({ ...KEY_DEFAULTS, despill: 0 })).toHaveLength(1)
    expect(keyFilters({ ...KEY_DEFAULTS, mode: 'luma', threshold: 0.2, tolerance: 0.1, softness: 0.05 })).toEqual([
      'lumakey=threshold=0.2:tolerance=0.1:softness=0.05'
    ])
    expect(keyFilters(undefined)).toEqual([])
  })
})

describe('keying：接入画面滤镜链', () => {
  const base = {
    baseLabel: 'v0',
    outputLabel: 'out',
    frame: { width: 1920, height: 1080 },
    fps: FPS_30,
    durationSec: 2
  }

  it('只有抠像（无调色）也会生成滤镜语句，位于 format 之前', () => {
    const plan = buildMediaClipVideoFx({
      ...base,
      transparentBackground: true,
      video: defaultMediaVideo(),
      key: { ...KEY_DEFAULTS, similarity: 0.2 }
    })
    expect(plan.statements).toHaveLength(1)
    expect(plan.statements[0]).toContain('chromakey=color=0x00b140')
    expect(plan.statements[0]!.indexOf('chromakey')).toBeLessThan(plan.statements[0]!.indexOf('format=rgba[out]'))
  })

  it('几何 + 抠像：抠像挂在 overlay 之后；无抠像逐字节不变', () => {
    const keyed = buildMediaClipVideoFx({
      ...base,
      transparentBackground: true,
      video: { ...defaultMediaVideo(), scalePercent: 50 },
      key: { ...KEY_DEFAULTS, mode: 'luma' }
    })
    const overlayLine = keyed.statements.find((line) => line.includes('overlay='))!
    expect(overlayLine.indexOf('overlay=')).toBeLessThan(overlayLine.indexOf('lumakey='))

    const plain = buildMediaClipVideoFx({ ...base, transparentBackground: true, video: { ...defaultMediaVideo(), scalePercent: 50 } })
    expect(plain.statements.join(';')).not.toContain('chromakey')
    expect(plain.statements.join(';')).not.toContain('lumakey')
  })
})

describe.skipIf(!HAS_FFMPEG)('真机：抠像滤镜链可执行且输出带 alpha', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-key-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('绿幕视频过 chromakey → rgba 输出，alpha 通道存在', async () => {
    const input = path.join(dir, 'green.mp4')
    const makeGreen = await run(FFMPEG, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x00b140:s=160x90:r=10:d=1',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', input
    ])
    expect(makeGreen.code).toBe(0)

    const output = path.join(dir, 'keyed.mov')
    const filters = keyFilters({ ...KEY_DEFAULTS, similarity: 0.3 }).join(',')
    const keyed = await run(FFMPEG, [
      '-hide_banner', '-y', '-loglevel', 'error',
      '-i', input,
      '-vf', `format=rgba,${filters},format=rgba`,
      '-c:v', 'qtrle', '-pix_fmt', 'argb', output
    ])
    expect(keyed.code, keyed.stderr.slice(0, 300)).toBe(0)

    const probe = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', output])
    expect(probe.stdout.trim()).toMatch(/argb|rgba|yuva/)
  }, 60_000)
})
