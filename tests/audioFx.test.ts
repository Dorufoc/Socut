import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isVoiceChangeKind, isVoiceEnhanceLevel, voiceChangeFilters, voiceEnhanceFilters } from '@shared/audioFx'
import { clipAudioFilterChain, normalizeClipAudio } from '@shared/mediaClipAudio'
import type { ClipAudio } from '@shared/types'

/**
 * M8：人声增强 / 变声（净化链）。
 *
 * 分两层：argv 层（纯函数，必跑）+ 真机层（随包 FFmpeg 现场跑滤镜链）。
 * 真机层统一验两件事：**滤镜链可解析**、**时长不变**（变声用 rubberband，不是 asetrate 组合）。
 */

const FFMPEG = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const FFPROBE = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE)

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

let tempDir = ''

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-audiofx-'))
})

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('audioFx：argv 口径', () => {
  it('人声增强三档：高通频率递增、压缩档位递进；关闭时返回空数组', () => {
    expect(voiceEnhanceFilters(undefined)).toEqual([])
    expect(voiceEnhanceFilters('light').join(',')).toContain('highpass=f=80')
    expect(voiceEnhanceFilters('standard').join(',')).toContain('highpass=f=100')
    const strong = voiceEnhanceFilters('strong').join(',')
    expect(strong).toContain('highpass=f=120')
    expect(strong).toContain('acompressor=')
    expect(strong).toContain('speechnorm=')
  })

  it('变声：花栗鼠/低沉用 rubberband（1:1 时长），机器人与电话用不等长滤镜', () => {
    expect(voiceChangeFilters(undefined)).toEqual([])
    expect(voiceChangeFilters('chipmunk')).toEqual(['rubberband=pitch=1.3'])
    expect(voiceChangeFilters('deep')).toEqual(['rubberband=pitch=0.8'])
    expect(voiceChangeFilters('robot')).toEqual(['vibrato=f=10:d=0.8', 'tremolo=f=25:d=0.9'])
    const phone = voiceChangeFilters('phone').join(',')
    expect(phone).toContain('highpass=f=300')
    expect(phone).toContain('lowpass=f=3400')
  })

  it('类型守卫：只认识四个已知变声/三档增强', () => {
    expect(isVoiceEnhanceLevel('strong')).toBe(true)
    expect(isVoiceEnhanceLevel('ultra')).toBe(false)
    expect(isVoiceChangeKind('phone')).toBe(true)
    expect(isVoiceChangeKind('alien')).toBe(false)
  })
})

describe('audioFx：工程落盘与滤镜链顺序', () => {
  it('normalizeClipAudio：合法档位落盘，非法档位丢弃，全默认返回 undefined', () => {
    const parsed = normalizeClipAudio({ voiceEnhance: 'standard', voiceChange: 'phone' })
    expect(parsed).toEqual({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, voiceEnhance: 'standard', voiceChange: 'phone' })
    expect(normalizeClipAudio({ voiceEnhance: 'ultra' })).toBeUndefined()
    expect(normalizeClipAudio({})).toBeUndefined()
    expect(normalizeClipAudio(null)).toBeUndefined()
  })

  it('clipAudioFilterChain 顺序：降噪 → 人声增强 → 变声 → 变速 → 音量 → 淡入淡出', () => {
    const audio: ClipAudio = {
      volumePercent: 50,
      fadeInSec: 0.5,
      fadeOutSec: 0.2,
      denoise: 'standard',
      voiceEnhance: 'light',
      voiceChange: 'chipmunk'
    }
    const chain = clipAudioFilterChain({
      audio,
      speed: { speed: 2, maintainPitch: true },
      outputDurationSec: 3
    })
    const order = ['afftdn', 'highpass=f=80', 'rubberband', 'atempo=2', 'volume=0.5', 'afade=t=in']
    let cursor = -1
    for (const token of order) {
      const index = chain.indexOf(token)
      expect(index, `${token} 缺失（chain=${chain}）`).toBeGreaterThan(cursor)
      cursor = index
    }
  })

  it('全部默认时滤镜链为空串（argv 与旧版逐字节一致）', () => {
    expect(clipAudioFilterChain({ audio: undefined, speed: undefined, outputDurationSec: 3 })).toBe('')
  })
})

describe('真机：滤镜链可解析且时长不变（随包 FFmpeg 缺失时跳过）', () => {
  async function durationOf(file: string): Promise<number> {
    const result = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    return Number(result.stdout.trim())
  }

  it.skipIf(!HAS_FFMPEG)('四种变声：产物时长与源一致（±1 帧 @30fps）', async () => {
    const source = path.join(tempDir, 'tone.wav')
    const make = await run(FFMPEG, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-ac',
      '2',
      '-ar',
      '48000',
      source
    ])
    expect(make.code).toBe(0)
    const original = await durationOf(source)

    for (const kind of ['chipmunk', 'robot', 'phone', 'deep'] as const) {
      const target = path.join(tempDir, `${kind}.wav`)
      const chain = voiceChangeFilters(kind).join(',')
      const result = await run(FFMPEG, ['-hide_banner', '-y', '-loglevel', 'error', '-i', source, '-af', chain, '-ac', '2', target])
      expect(result.code, `${kind} 滤镜链失败：${result.stderr.slice(0, 200)}`).toBe(0)
      const duration = await durationOf(target)
      expect(Math.abs(duration - original), `${kind} 时长漂移过大：${duration} vs ${original}`).toBeLessThan(1 / 30)
    }
  })

  it.skipIf(!HAS_FFMPEG)('电话音：8kHz 高频被带通压掉（mean_volume 明显下降）', async () => {
    const high = path.join(tempDir, 'high.wav')
    const make = await run(FFMPEG, [
      '-hide_banner',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=8000:duration=1',
      '-ac',
      '2',
      '-ar',
      '48000',
      high
    ])
    expect(make.code).toBe(0)

    const measure = async (file: string, filter?: string): Promise<number> => {
      const args = [
        '-hide_banner',
        '-i',
        file,
        '-af',
        filter ? `${filter},volumedetect` : 'volumedetect',
        '-f',
        'null',
        process.platform === 'win32' ? 'NUL' : '/dev/null'
      ]
      const result = await run(FFMPEG, args)
      const match = result.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)
      return match ? Number(match[1]) : Number.NaN
    }

    const before = await measure(high)
    const after = await measure(high, voiceChangeFilters('phone').join(','))
    expect(Number.isFinite(before)).toBe(true)
    expect(Number.isFinite(after)).toBe(true)
    // 8kHz 被 highpass/lowpass 带通削掉，输出电平应下降至少 10dB
    expect(after).toBeLessThan(before - 10)
  })
})
