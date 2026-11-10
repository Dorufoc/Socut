import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { arnndnFilter, denoiseFilter, filterPathArg } from '@shared/audioQuality'
import { clipAudioFilterChain, normalizeClipAudio } from '@shared/mediaClipAudio'
import { buildAudioMixPlan } from '@shared/ffmpegArgs'
import { assertAiDenoiseModel, needsAiDenoise, resolveRnnoiseModel, RNNOISE_MISSING_MESSAGE } from '../src/main/rnnoise'

/**
 * M8：AI 降噪（FFmpeg `arnndn` + RNNoise `.rnnn` 模型）。
 *
 * 真机踩过的坑（记录在案，测试锁定）：
 * - `arnndn=m=D:\a\b.rnnn` 与 `m=D:/a/b.rnnn` 都解析失败（"No option name near …"），
 *   必须 `m='D\:/a/b.rnnn'`（引号 + 冒号转义）；
 * - 模型可选资产，缺失时必须**明确报错**，不能静默退化成 afftdn。
 *
 * 纪律：仓库禁止同步子进程（`check:env` / eslint 的 no-restricted-syntax），所以这里统一走异步 `spawn`。
 */

/** 跑一次外部进程并收集 stderr（测试用；异步、带退出码）。 */
function run(file: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout.on('data', () => undefined)
    child.on('error', (error) => resolve({ code: -1, stderr: `${stderr}${String(error)}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

const root = path.resolve(__dirname, '..')
const ffmpeg = path.join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const bundledModel = path.join(root, 'resources', 'models', 'rnnoise', 'std.rnnn')
const hasModel = fs.existsSync(bundledModel)
const hasFfmpeg = fs.existsSync(ffmpeg)

let tempDir = ''

beforeAll(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'socut-rnnoise-test-'))
})

afterAll(async () => {
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true })
})

describe('rnnoise 纯口径', () => {
  it('filterPathArg：反斜杠转正斜杠 + 冒号转义（FFmpeg 滤镜语法）', () => {
    expect(filterPathArg('D:\\a\\b\\std.rnnn')).toBe('D\\:/a/b/std.rnnn')
    expect(filterPathArg('D:/a/b/std.rnnn')).toBe('D\\:/a/b/std.rnnn')
    expect(filterPathArg('')).toBe('')
  })

  it('arnndnFilter：引号包裹；没有路径返回空串（不产生半个滤镜）', () => {
    expect(arnndnFilter('D:\\models\\std.rnnn')).toBe(`arnndn=m='D\\:/models/std.rnnn'`)
    expect(arnndnFilter(undefined)).toBe('')
    expect(arnndnFilter('')).toBe('')
  })

  it('denoiseFilter：ai 走 arnndn，其余档位与旧版逐字节一致', () => {
    expect(denoiseFilter('ai', { arnndnModelPath: 'C:\\m\\std.rnnn' })).toBe(`arnndn=m='C\\:/m/std.rnnn'`)
    // ai 但没有模型 → 空串（main 会先报错，这里保证纯函数不产出半成品）
    expect(denoiseFilter('ai')).toBe('')
    expect(denoiseFilter('light')).toBe('afftdn=nr=6:nf=-30')
    expect(denoiseFilter('standard')).toBe('afftdn=nr=12:nf=-25')
    expect(denoiseFilter('strong')).toBe('afftdn=nr=20:nf=-20')
    expect(denoiseFilter(undefined)).toBe('')
  })

  it('clipAudioFilterChain：arnndn 在链首（降噪 → 增强 → 变速 → 音量 → 淡变）', () => {
    const chain = clipAudioFilterChain({
      audio: { volumePercent: 120, fadeInSec: 0, fadeOutSec: 0, denoise: 'ai', voiceEnhance: 'light' },
      speed: { speed: 2, maintainPitch: true },
      outputDurationSec: 1,
      arnndnModelPath: 'D:\\m\\std.rnnn'
    })
    const parts = chain.split(',')
    expect(parts[0]).toBe(`arnndn=m='D\\:/m/std.rnnn'`)
    expect(parts.some((part) => part.startsWith('atempo='))).toBe(true)
    expect(parts.at(-1)).toBe('volume=1.2')
    // 不传模型时这条链里的 ai 不产出任何滤镜（其余参数照旧）
    expect(
      clipAudioFilterChain({
        audio: { volumePercent: 120, fadeInSec: 0, fadeOutSec: 0, denoise: 'ai' },
        outputDurationSec: 1
      })
    ).toBe('volume=1.2')
  })

  it('buildAudioMixPlan：媒体段原声的 ai 降噪进入混音链，未开 ai 的段保持旧语句', () => {
    const base = {
      baseIndex: 1,
      spanStartSec: 0,
      spanEndSec: 2,
      arnndnModelPath: 'D:\\m\\std.rnnn'
    }
    const withAi = buildAudioMixPlan({
      ...base,
      clips: [
        {
          path: 'D:/a.wav',
          timelineStartSec: 0,
          timelineEndSec: 2,
          sourceInSec: 0,
          audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'ai' }
        }
      ]
    })
    expect(withAi?.filter).toContain(`arnndn=m='D\\:/m/std.rnnn'`)
    const withoutAi = buildAudioMixPlan({
      ...base,
      clips: [
        {
          path: 'D:/a.wav',
          timelineStartSec: 0,
          timelineEndSec: 2,
          sourceInSec: 0,
          audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 }
        }
      ]
    })
    expect(withoutAi?.filter).not.toContain('arnndn')
    // 缺省（不传模型）时语句里也不会出现 arnndn
    expect(buildAudioMixPlan({ ...base, clips: [] })).toBeNull()
  })

  it('工程 JSON：denoise:"ai" 归一化后保留；未知档位丢弃且全默认整键不落盘', () => {
    expect(
      normalizeClipAudio({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'ai' })
    ).toEqual({
      volumePercent: 100,
      fadeInSec: 0,
      fadeOutSec: 0,
      denoise: 'ai'
    })
    // 未知档位 = 当作没填：其余全默认 → undefined（工程里不出现 audio 键）
    expect(normalizeClipAudio({ denoise: 'ultra' })).toBeUndefined()
  })

  it('needsAiDenoise / assertAiDenoiseModel：缺模型必须抛可读错误', () => {
    const aiSegment = { audio: { denoise: 'ai' } }
    expect(needsAiDenoise({ segments: [aiSegment] })).toBe(true)
    expect(needsAiDenoise({ audioClips: [aiSegment] })).toBe(true)
    expect(needsAiDenoise({ segments: [{ audio: { denoise: 'light' } }] })).toBe(false)
    expect(needsAiDenoise({})).toBe(false)
    expect(() => assertAiDenoiseModel({ segments: [{}] }, undefined)).not.toThrow()
    expect(() => assertAiDenoiseModel({ segments: [aiSegment] }, undefined)).toThrow(RNNOISE_MISSING_MESSAGE)
    expect(() => assertAiDenoiseModel({ segments: [aiSegment] }, 'D:\\m\\std.rnnn')).not.toThrow()
  })
})

describe('rnnoise 模型解析（离线资产）', () => {
  it('候选顺序：env → userData → 随包；空文件不算可用', async () => {
    const userDir = path.join(tempDir, 'user')
    const bundledDir = path.join(tempDir, 'bundled')
    await fsp.mkdir(userDir, { recursive: true })
    await fsp.mkdir(bundledDir, { recursive: true })
    await fsp.writeFile(path.join(bundledDir, 'std.rnnn'), Buffer.alloc(2048, 1))
    await fsp.writeFile(path.join(bundledDir, 'empty.rnnn'), Buffer.alloc(0))
    await fsp.writeFile(path.join(userDir, 'mine.rnnn'), Buffer.alloc(1024, 2))

    const fromUser = await resolveRnnoiseModel({ userDir, bundledDir })
    expect(fromUser.path).toBe(path.join(userDir, 'mine.rnnn'))
    expect(fromUser.candidates[0]).toBe(path.join(userDir, 'mine.rnnn'))
    expect(fromUser.candidates).toContain(path.join(bundledDir, 'std.rnnn'))

    const emptyOnly = await resolveRnnoiseModel({
      userDir: path.join(tempDir, 'missing'),
      bundledDir: path.join(tempDir, 'empty-only')
    })
    expect(emptyOnly.path).toBeNull()

    // env 优先
    const envModel = path.join(bundledDir, 'std.rnnn')
    const fromEnv = await resolveRnnoiseModel({ userDir, bundledDir, env: { SOCUT_RNNOISE_MODEL: envModel } })
    expect(fromEnv.path).toBe(envModel)
    expect(fromEnv.candidates[0]).toBe(envModel)
  })

  it.skipIf(!hasModel)('随包模型可被默认目录解析到', async () => {
    const resolved = await resolveRnnoiseModel({
      userDir: path.join(tempDir, 'no-user-models'),
      bundledDir: path.dirname(bundledModel),
      env: {}
    })
    expect(resolved.path).toBe(bundledModel)
  })
})

describe('rnnoise 真机（随包 FFmpeg + 真模型）', () => {
  it.skipIf(!hasModel || !hasFfmpeg)('arnndn 滤镜链真跑：噪声夹具 → 可解码产物，时长不变', async () => {
    const noisy = path.join(tempDir, 'noisy.wav')
    const denoised = path.join(tempDir, 'denoised.wav')
    const made = await run(ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=0.6:c=pink:r=48000',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:duration=0.6',
      '-filter_complex',
      '[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0[m]',
      '-map',
      '[m]',
      noisy
    ])
    expect(made.code, made.stderr.slice(0, 300)).toBe(0)

    const filter = clipAudioFilterChain({
      audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'ai' },
      outputDurationSec: 0.6,
      arnndnModelPath: bundledModel
    })
    const ran = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', noisy, '-af', filter, denoised])
    expect(ran.code, ran.stderr.slice(0, 400)).toBe(0)
    expect(fs.statSync(denoised).size).toBeGreaterThan(0)

    const probe = await run(ffmpeg, ['-hide_banner', '-i', denoised, '-f', 'null', '-'])
    expect(probe.code, probe.stderr.slice(0, 400)).toBe(0)
    // 时长必须与源一致（arnndn 只改音色不拉伸时间）
    expect(probe.stderr).toMatch(/time=00:00:00\.6/)
  }, 60_000)
})
