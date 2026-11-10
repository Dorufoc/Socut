import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildWhisperArgs,
  normalizeWhisperSegment,
  parseWhisperJson,
  planCuesFromSegments
} from '@shared/whisper'
import { WhisperError, createWhisperManager, parseFfmpegOutTimeSeconds, writeFakeWhisperSidecar } from '../src/main/whisper'

/** M11：whisper.cpp 参数/JSON/cue 规划（纯函数）+ 主进程 sidecar 编排（假 sidecar 真进程）。 */

const WHISPER_JSON = JSON.stringify({
  result: { language: 'zh' },
  transcription: [
    {
      timestamps: { from: '00:00:00,200', to: '00:00:02,400' },
      offsets: { from: '200', to: '2400' },
      text: ' 今日头条'
    },
    {
      offsets: { from: '2600', to: '4800' },
      text: ' 省发展改革委发布'
    },
    { offsets: { from: '5000', to: '5000' }, text: ' 零时长' }
  ]
})

describe('whisper 纯口径', () => {
  it('buildWhisperArgs：模型/输入/JSON 输出/线程/语言/翻译顺序稳定', () => {
    expect(
      buildWhisperArgs({
        modelPath: 'D:/models/ggml-base.bin',
        mediaPath: 'D:/media/a.mp4',
        outputBase: 'D:/tmp/out'
      })
    ).toEqual([
      '-m',
      'D:/models/ggml-base.bin',
      '-f',
      'D:/media/a.mp4',
      '-oj',
      '-of',
      'D:/tmp/out',
      '-t',
      '4',
      '-np',
      // 真机验收：whisper.cpp 默认不打印进度，必须显式 -pp，否则进度回调永远是 0
      '-pp'
    ])
    expect(
      buildWhisperArgs({
        modelPath: 'm.bin',
        mediaPath: 'a.wav',
        language: 'zh',
        translate: true,
        threads: 8,
        outputBase: 'o'
      })
    ).toContain('-tr')
  })

  it('parseWhisperJson：原生 offsets/timestamps、语言、非法片段计数', () => {
    const result = parseWhisperJson(WHISPER_JSON)
    expect(result.language).toBe('zh')
    expect(result.segments).toHaveLength(2)
    expect(result.dropped).toBe(1)
    expect(result.segments[0]).toEqual({ startSec: 0.2, endSec: 2.4, text: '今日头条' })
  })

  it('parseWhisperJson：真机原生 offsets 是**数字毫秒**（不能当秒）', () => {
    // 真 whisper-cli 1.8.2 的输出形态：offsets.from/to 是 number 毫秒 + timestamps 时间码
    const real = JSON.stringify({
      systeminfo: 'WHISPER : COREML = 0',
      result: { language: 'zh' },
      transcription: [
        {
          timestamps: { from: '00:00:00,000', to: '00:00:05,500' },
          offsets: { from: 0, to: 5500 },
          text: ' 今日头条报道，省发展改革委发布新能源项目通知。'
        }
      ]
    })
    expect(parseWhisperJson(real).segments).toEqual([
      { startSec: 0, endSec: 5.5, text: '今日头条报道，省发展改革委发布新能源项目通知。' }
    ])
    // 只有数字 offsets、没有时间码时也必须按毫秒
    expect(parseWhisperJson('{"transcription":[{"offsets":{"from":1200,"to":3400},"text":"a"}]}').segments).toEqual([
      { startSec: 1.2, endSec: 3.4, text: 'a' }
    ])
  })

  it('parseWhisperJson：简化 segments / 裸数组 / 坏 JSON', () => {
    expect(parseWhisperJson('{"segments":[{"startSec":0,"endSec":1,"text":"a"}]}').segments).toHaveLength(1)
    expect(parseWhisperJson('[{"startSec":0,"endSec":1,"text":"a"}]').segments).toHaveLength(1)
    expect(parseWhisperJson('不是 JSON')).toEqual({ segments: [], dropped: 0 })
  })

  it('normalizeWhisperSegment：去方括号提示、压空白、丢空/倒挂', () => {
    expect(normalizeWhisperSegment({ startSec: 0, endSec: 1, text: ' [BLANK_AUDIO]  ' })).toBeNull()
    expect(normalizeWhisperSegment({ startSec: 1, endSec: 1, text: 'x' })).toBeNull()
    expect(normalizeWhisperSegment({ startSec: 0, endSec: 1, text: ' 你好  世界 ' })).toEqual({
      startSec: 0,
      endSec: 1,
      text: '你好 世界'
    })
  })

  it('planCuesFromSegments：短句合并、长句切分、去重叠', () => {
    const merged = planCuesFromSegments(
      [
        { startSec: 0, endSec: 1.2, text: '今日' },
        { startSec: 1.3, endSec: 2.4, text: '头条' }
      ],
      { minDurationSec: 1, maxDurationSec: 8, maxChars: 40 }
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.text).toBe('今日 头条')

    const split = planCuesFromSegments(
      [{ startSec: 0, endSec: 10, text: '一，二，三，四，五，六，七，八' }],
      { minDurationSec: 1, maxDurationSec: 4, maxChars: 5 }
    )
    expect(split.length).toBeGreaterThan(1)
    for (let index = 1; index < split.length; index += 1) {
      expect(split[index]!.startSec).toBeGreaterThanOrEqual(split[index - 1]!.endSec - 1e-9)
    }
  })
})

describe('whisper 主进程编排（假 sidecar 真进程）', () => {
  it('parseFfmpegOutTimeSeconds：out_time_us/out_time_ms 都是微秒；时间码形式也能解析', () => {
    expect(parseFfmpegOutTimeSeconds('out_time_us=1500000')).toBeCloseTo(1.5, 6)
    expect(parseFfmpegOutTimeSeconds('out_time_ms=250000')).toBeCloseTo(0.25, 6)
    expect(parseFfmpegOutTimeSeconds('out_time=00:01:02.500000')).toBeCloseTo(62.5, 6)
    expect(parseFfmpegOutTimeSeconds('progress=continue')).toBeNull()
    expect(parseFfmpegOutTimeSeconds('')).toBeNull()
  })
  let dir = ''
  let fakeScript = ''
  let modelPath = ''
  let mediaPath = ''

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-whisper-test-'))
    const fake = await writeFakeWhisperSidecar({ dir })
    fakeScript = fake.script
    modelPath = path.join(dir, 'ggml-base.bin')
    mediaPath = path.join(dir, 'news.wav')
    await fs.writeFile(modelPath, 'fake-model', 'utf8')
    await fs.writeFile(mediaPath, 'fake-media', 'utf8')
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  function manager(overrides: { binaryArgsPrefix?: string[] } = {}) {
    return createWhisperManager({
      userDataDir: path.join(dir, 'userdata'),
      resourcesDir: path.join(dir, 'resources'),
      env: { SOCUT_WHISPER_BIN: process.execPath },
      binaryArgsPrefix: overrides.binaryArgsPrefix ?? [fakeScript]
    })
  }

  it('status：二进制/模型都能被发现时 ready=true', async () => {
    const m = manager()
    await m.saveConfig({ modelPath, language: 'zh' })
    const status = await m.status()
    expect(status.binaryPath).toBe(process.execPath)
    expect(status.modelPath).toBe(modelPath)
    expect(status.ready).toBe(true)
    expect(status.language).toBe('zh')
  })

  it('saveConfig：null 清除单项（自动检测/忘记已选），其余项保持不变', async () => {
    const m = manager()
    await m.saveConfig({ modelPath, language: 'zh', threads: 6 })
    // 清语言 = 回到自动检测
    const cleared = await m.saveConfig({ language: null })
    expect(cleared.language).toBeUndefined()
    expect(cleared.modelPath).toBe(modelPath)
    expect(cleared.threads).toBe(6)
    // 空串/空白语言同样视为清除
    await m.saveConfig({ language: 'en' })
    expect((await m.saveConfig({ language: '   ' })).language).toBeUndefined()
    // 清模型：文件仍在，但配置项没了（回到候选探测）
    const noModel = await m.saveConfig({ modelPath: null })
    expect(noModel.modelPath).toBeUndefined()
    // 再传真实模型仍然可用
    expect((await m.saveConfig({ modelPath })).modelPath).toBe(modelPath)
  })

  it('saveConfig：非法语言/线程被忽略，不存在路径被拒绝（不改配置）', async () => {
    const m = manager()
    // 前面的用例共用同一个 userData：先清掉配置，保证本用例起点干净
    await m.resetConfig()
    await m.saveConfig({ modelPath })
    const stillThere = await m.saveConfig({ language: undefined, threads: -3 })
    expect(stillThere.modelPath).toBe(modelPath)
    expect(stillThere.threads).toBeUndefined()
    await expect(m.saveConfig({ modelPath: path.join(dir, 'missing.bin') })).rejects.toMatchObject({
      code: 'WHISPER_MODEL_MISSING'
    })
    expect((await m.readConfig()).modelPath).toBe(modelPath)
  })

  it('transcribe：真跑假 sidecar，读 JSON、回报进度、返回 cue', async () => {
    const m = manager()
    await m.saveConfig({ modelPath })
    const progress: number[] = []
    const result = await m.transcribe({ mediaPath, onProgress: (percent) => progress.push(percent) })
    expect(result.segments).toBe(2)
    expect(result.cues.map((cue) => cue.text)).toEqual(['今日头条', '省发展改革委发布'])
    expect(result.language).toBe('zh')
    expect(progress).toContain(40)
    expect(progress).toContain(100)
  })

  it('transcribe：媒体/模型缺失给出可判错误码', async () => {
    const m = manager()
    await m.saveConfig({ modelPath })
    await expect(m.transcribe({ mediaPath: path.join(dir, 'nope.wav') })).rejects.toMatchObject({
      code: 'WHISPER_MEDIA_MISSING'
    })
    await expect(m.transcribe({ mediaPath, modelPath: path.join(dir, 'nope.bin') })).rejects.toMatchObject({
      code: 'WHISPER_MODEL_MISSING'
    })
  })

  it('transcribe：AbortSignal 取消（真进程被 kill）', async () => {
    const slowScript = path.join(dir, 'slow-whisper.mjs')
    await fs.writeFile(
      slowScript,
      'setTimeout(() => process.exit(0), 5000)\n',
      'utf8'
    )
    const m = manager({ binaryArgsPrefix: [slowScript] })
    await m.saveConfig({ modelPath })
    const controller = new AbortController()
    const pending = m.transcribe({ mediaPath, signal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('saveConfig：路径不存在时拒绝（离线导入必须给真实文件）', async () => {
    const m = manager()
    await expect(m.saveConfig({ modelPath: path.join(dir, 'missing.bin') })).rejects.toBeInstanceOf(WhisperError)
  })

  it('未找到二进制：错误信息包含候选与 SOCUT_WHISPER_BIN 提示', async () => {
    const m = createWhisperManager({
      userDataDir: path.join(dir, 'userdata2'),
      resourcesDir: path.join(dir, 'no-resources'),
      env: {}
    })
    await expect(m.transcribe({ mediaPath, modelPath })).rejects.toMatchObject({ code: 'WHISPER_BINARY_MISSING' })
  })
})
