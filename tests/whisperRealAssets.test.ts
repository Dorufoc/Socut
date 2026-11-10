import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWhisperManager } from '../src/main/whisper'

/**
 * M11 真资产验收：**真的** whisper.cpp 二进制 + **真的** ggml 模型 + 真的 16k 单声道 WAV。
 *
 * 资产是离线随包内容（`npm run fetch:whisper` / `npm run fetch:whisper:model` 产出），
 * 已 gitignore、不随仓库提交，所以：
 * - 本机拉过资产 → 这条验收真跑（约 1~3 秒，base 模型短音频）；
 * - CI / 干净检出没有资产 → 整组 skip，不会把网络依赖带进 `npm run verify`。
 *
 * 这一组抓到过两个"假 sidecar 测不出来"的真问题：
 * 1. whisper.cpp 默认**不打印进度**，必须传 `-pp`，否则主进程进度回调永远停在 0；
 * 2. 自动检测语言会把中文短音频识别成英文（真机 `-l zh` 才稳定）——所以这里显式给语言。
 */

const root = path.resolve(__dirname, '..')
const resourcesDir = path.join(root, 'resources')
const binaryName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
const binaryPath = path.join(resourcesDir, 'whisper', binaryName)
const modelsDir = path.join(resourcesDir, 'models', 'whisper')
const fixturePath = path.join(__dirname, 'fixtures', 'whisper', 'speech-zh.wav')

function bundledModels(): string[] {
  try {
    return fs
      .readdirSync(modelsDir)
      .filter((name) => name.endsWith('.bin'))
      .map((name) => path.join(modelsDir, name))
  } catch {
    return []
  }
}

const models = bundledModels()
const hasAssets = fs.existsSync(binaryPath) && fs.existsSync(fixturePath) && models.length > 0
/** 只有多语种模型才能识别中文；`ggml-*.en.bin` 是纯英文模型。 */
const hasMultilingualModel = models.some((file) => !path.basename(file).includes('.en.'))
const ffmpegPath = path.join(resourcesDir, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobePath = path.join(resourcesDir, 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

/** 跑一个小进程并收集输出（仅本验收用；不引测试 helper）。 */
function run(file: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout.on('data', () => undefined)
    child.on('error', () => resolve({ code: -1, stderr }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socut-whisper-real-'))

afterAll(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

describe.skipIf(!hasAssets)('whisper 真资产（随包二进制 + 真 ggml 模型）', () => {
  const manager = (): ReturnType<typeof createWhisperManager> =>
    createWhisperManager({
      userDataDir,
      resourcesDir,
      env: {},
      // 真实链路：先用随包 FFmpeg 抽 16k WAV（抽音进度靠 ffprobe 读时长）
      ffmpegPath,
      ffprobePath
    })

  it('status：从 resources/whisper 与 resources/models/whisper 自动找到二进制与模型', async () => {
    const status = await manager().status()
    expect(status.ready).toBe(true)
    expect(status.binaryPath).toBe(binaryPath)
    expect(status.modelPath).toMatch(/ggml-.*\.bin$/)
    expect(status.candidates.binaries).toContain(binaryPath)
  })

  it('transcribe：真跑出中文 cue、进度到 100、JSON 结果被清理解析', async () => {
    if (!hasMultilingualModel) return
    const progress: number[] = []
    const prepare: number[] = []
    const result = await manager().transcribe({
      mediaPath: fixturePath,
      language: 'zh',
      onProgress: (percent) => progress.push(percent),
      onPrepareProgress: (percent) => prepare.push(percent)
    })

    // 真识别的文本：TTS 读音"今日头条报道，省发展改革委发布新能源项目通知。"
    const text = result.cues.map((cue) => cue.text).join('')
    expect(result.segments).toBeGreaterThan(0)
    expect(result.cues.length).toBeGreaterThan(0)
    expect(text).toContain('新能源')
    expect(result.binaryPath).toBe(binaryPath)
    expect(result.modelPath).toMatch(/ggml-.*\.bin$/)
    // cue 时间必须落在夹具时长（5.5s）内且不倒挂
    for (const cue of result.cues) {
      expect(cue.endSec).toBeGreaterThan(cue.startSec)
      expect(cue.startSec).toBeGreaterThanOrEqual(0)
      expect(cue.endSec).toBeLessThan(8)
    }
    // 这就是 `-pp` 的价值：没有它 progress 一条都不会有
    expect(progress.length).toBeGreaterThan(0)
    expect(Math.max(...progress)).toBe(100)
    // M11：抽音阶段也有真实进度（0..99 递增；夹具 5.5s，抽音很快，至少要有一次回调）
    expect(prepare.length).toBeGreaterThan(0)
    expect(Math.max(...prepare)).toBeLessThan(100)
    for (let index = 1; index < prepare.length; index += 1) {
      expect(prepare[index]!).toBeGreaterThanOrEqual(prepare[index - 1]!)
    }
  }, 120_000)

  it('transcribe：mp4 输入也能转写（原版 whisper-cli 只读 16k WAV，必须先抽音）', async () => {
    if (!hasMultilingualModel) return
    if (!fs.existsSync(ffmpegPath)) return
    const mp4 = path.join(userDataDir, 'speech.mp4')
    const made = await run(ffmpegPath, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      fixturePath,
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x180:r=25',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mp4
    ])
    expect(made.code, made.stderr.slice(0, 300)).toBe(0)

    // 前提锁定：把 mp4 直接喂给 whisper-cli 会 `failed to read audio data as wav`
    const directBase = path.join(userDataDir, 'direct')
    await run(binaryPath, ['-m', models[0]!, '-f', mp4, '-oj', '-of', directBase, '-np', '-l', 'zh'])
    expect(fs.existsSync(`${directBase}.json`)).toBe(false)

    const result = await createWhisperManager({
      userDataDir,
      resourcesDir,
      env: {},
      ffmpegPath,
      ffprobePath
    }).transcribe({
      mediaPath: mp4,
      language: 'zh'
    })
    expect(result.cues.map((cue) => cue.text).join('')).toContain('新能源')
    expect(result.cues[0]!.endSec).toBeLessThan(10)
  }, 120_000)
})
