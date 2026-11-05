import { describe, expect, it } from 'vitest'
import {
  buildAudioMixPlan,
  buildOverlayMp4MultiInput,
  buildTransparentAudioArgs,
  buildTransparentMovFromPipe,
  buildTransparentMovQtrle
} from '@shared/ffmpegArgs'
import { FPS_30 } from '@shared/constants'
import type { AudioMixClip } from '@shared/ffmpegArgs'
import type { ConcatSegment } from '@shared/ffmpegArgs'

/**
 * 导出混音（v7.1）：音频轨怎么变成 argv。
 *
 * 锁五件事：
 * 1. 没有音频段 → 计划为 null，所有出口的 argv 与旧版**逐字一致**（旧工程导出不变）；
 * 2. `-ss/-t` 在 `-i` 之前（只解码用得到的一段）；
 * 3. `adelay=delays=…:all=1` 把音频摆到时间轴位置（对单/立体声都成立）；
 * 4. `amix=…:normalize=0`：真混音（不按路数衰减），最后 `atrim` 对齐 span；
 * 5. overlay 出口把混音挂在 `[ab]` 上并 `-map [amix]`；透明出口去掉 `-an` 并带 `-map`。
 */

const clip = (over: Partial<AudioMixClip> = {}): AudioMixClip => ({
  path: 'C:/audio/bed.mp3',
  timelineStartSec: 2,
  timelineEndSec: 6,
  sourceInSec: 0.5,
  ...over
})

const segment = (over: Partial<ConcatSegment> = {}): ConcatSegment => ({
  refVideoPath: 'C:/media/a.mp4',
  timelineStartSec: 0,
  timelineEndSec: 10,
  sourceInSec: 0,
  sourceOutSec: 10,
  hasAudio: true,
  ...over
})

describe('混音计划', () => {
  it('没有音频段时返回 null（旧 argv 不变）', () => {
    expect(buildAudioMixPlan({ clips: [], baseIndex: 1, spanStartSec: 0, spanEndSec: 10 })).toBeNull()
  })

  it('输入参数：-ss/-t 在 -i 之前，下标按 baseIndex 递增', () => {
    const plan = buildAudioMixPlan({
      clips: [clip(), clip({ path: 'C:/audio/b.mp3', timelineStartSec: 4, timelineEndSec: 7 })],
      baseIndex: 2,
      spanStartSec: 0,
      spanEndSec: 10,
      baseLabel: '[ab]'
    })!
    expect(plan.inputArgs.slice(0, 4)).toEqual(['-ss', '0.500000', '-t', '4.000000'])
    expect(plan.inputArgs[4]).toBe('-i')
    expect(plan.inputArgs[5]).toBe('C:/audio/bed.mp3')
    // 第二路的时长 = 3s（4→7）
    const secondStart = plan.inputArgs.indexOf('C:/audio/b.mp3') - 5
    expect(plan.inputArgs.slice(secondStart, secondStart + 4)).toEqual(['-ss', '0.500000', '-t', '3.000000'])
  })

  it('延迟按 span 起点换算成毫秒，并用 all=1 兼容任意声道数', () => {
    const plan = buildAudioMixPlan({
      clips: [clip({ timelineStartSec: 3.25, timelineEndSec: 5 })],
      baseIndex: 1,
      spanStartSec: 1,
      spanEndSec: 8,
      baseLabel: '[ab]'
    })!
    expect(plan.filter).toContain('adelay=delays=2250:all=1')
  })

  it('有基座原声时 amix 两路、normalize=0，最后按 span 对齐', () => {
    const plan = buildAudioMixPlan({
      clips: [clip()],
      baseIndex: 1,
      spanStartSec: 0,
      spanEndSec: 10,
      baseLabel: '[ab]'
    })!
    expect(plan.filter).toContain('[ab][ai0]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mx]')
    expect(plan.filter).toContain('[mx]atrim=duration=10')
    expect(plan.label).toBe('amix')
  })

  it('只有音频轨（没有基座）时不进 amix，直接按 span 截断', () => {
    const plan = buildAudioMixPlan({ clips: [clip()], baseIndex: 1, spanStartSec: 0, spanEndSec: 10 })!
    expect(plan.filter).not.toContain('amix=')
    expect(plan.filter).toContain('[ai0]atrim=duration=10')
  })
})

/**
 * v9：音频段自己的音量 / 渐入渐出 / 变速怎么落进混音计划。
 *
 * 锁三件事：
 * 1. 不带 v9 键时计划与 v7 逐字节一致（旧工程argv 不变）；
 * 2. 变速时 `-t` / `atrim` 读的是**源窗口**，滤镜链再把时长压回时间轴长度；
 * 3. 渐变的秒数按时间轴长度（变速后的输出）算，不会淡到片段中段就结束。
 */
describe('混音计划的音频参数（v9）', () => {
  const planOf = (over: Partial<AudioMixClip>) =>
    buildAudioMixPlan({ clips: [clip(over)], baseIndex: 1, spanStartSec: 0, spanEndSec: 10, baseLabel: '[ab]' })!

  it('不带 audio/speed/sourceOutSec：与 v7 基线逐字节一致', () => {
    const baseline = planOf({})
    expect(baseline.inputArgs.slice(0, 4)).toEqual(['-ss', '0.500000', '-t', '4.000000'])
    expect(baseline.filter).not.toContain('atempo')
    expect(baseline.filter).not.toContain('volume=')
    expect(planOf({ audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 }, speed: { speed: 1, maintainPitch: true } })).toEqual(baseline)
  })

  it('默认值不写但倍速 2x：源窗口变长，然后 atempo 压回时间轴长度', () => {
    const plan = planOf({ speed: { speed: 2, maintainPitch: true } })
    // 时间轴 4s × 2 = 读 8s 源
    expect(plan.inputArgs.slice(0, 4)).toEqual(['-ss', '0.500000', '-t', '8.000000'])
    expect(plan.filter).toContain('[1:a]atrim=duration=8.000000,asetpts=PTS-STARTPTS,atempo=2,')
    expect(plan.filter).toContain('adelay=delays=2000:all=1[ai0]')
  })

  it('显式源出点优先于「时间轴 × 倍速」', () => {
    const plan = planOf({ sourceOutSec: 3.5, speed: { speed: 2, maintainPitch: true } })
    expect(plan.inputArgs.slice(0, 4)).toEqual(['-ss', '0.500000', '-t', '3.000000'])
  })

  it('音量与渐变：链顺序变速 → 音量 → 淡入 → 淡出，淡变用时间轴长度', () => {
    const plan = planOf({
      audio: { volumePercent: 150, fadeInSec: 1, fadeOutSec: 1 },
      speed: { speed: 2, maintainPitch: false }
    })
    expect(plan.filter).toContain(
      'asetrate=96000,aresample=48000,volume=1.5,afade=t=in:st=0:d=1,afade=t=out:st=3:d=1,'
    )
  })
})

describe('叠加出口', () => {
  const base = {
    segments: [segment()],
    spanStartSec: 0,
    spanEndSec: 10,
    overlayLabel: '1',
    overlayPath: 'C:/tmp/overlay.mov',
    outputPath: 'C:/out/final.mp4',
    fps: FPS_30,
    frameSize: { width: 1920, height: 1080 },
    audioMode: 'aac' as const,
    fpsMode: 'cfr' as const
  }

  it('没有音频段：仍然 -map [ab]（回归锁定）', () => {
    const args = buildOverlayMp4MultiInput(base)
    expect(args.join(' ')).toContain('-map [ab]')
    expect(args.join(' ')).not.toContain('amix')
  })

  it('有音频段：追加一路 -i、混到 [ab] 上并 -map [amix]', () => {
    const args = buildOverlayMp4MultiInput({ ...base, audioClips: [clip()] })
    const joined = args.join(' ')
    // 单段媒体(1) + 透明层(1) → 音频从 2 号开始
    expect(joined).toContain('-ss 0.500000 -t 4.000000 -i C:/audio/bed.mp3')
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[2:a]atrim=duration=4')
    expect(joined).toContain('[ab][ai0]amix=inputs=2')
    expect(joined).toContain('-map [amix]')
  })

  it('水印 + 音频同时存在时，音频输入下标在水印之后', () => {
    const args = buildOverlayMp4MultiInput({
      ...base,
      audioClips: [clip()],
      watermark: { path: 'C:/wm.png', sourceWidth: 800, sourceHeight: 450 }
    })
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[3:a]atrim=duration=4')
  })

  it('v9：音频段的音量一路带到最终 argv', () => {
    const args = buildOverlayMp4MultiInput({
      ...base,
      audioClips: [clip({ audio: { volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 } })]
    })
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      '[2:a]atrim=duration=4.000000,asetpts=PTS-STARTPTS,volume=2,'
    )
  })
})

describe('透明出口', () => {
  it('没有音频段：保留 -an（回归锁定）', () => {
    expect(buildTransparentMovFromPipe(FPS_30, 'C:/out/t.mov')).toContain('-an')
    expect(buildTransparentMovQtrle(FPS_30, 'C:/out/t.mov')).toContain('-an')
    expect(buildTransparentAudioArgs(undefined)).toBeNull()
    expect(buildTransparentAudioArgs({ clips: [], spanStartSec: 0, spanEndSec: 1 })).toBeNull()
  })

  it('有音频段：去掉 -an，带 filter_complex 与两条 -map，音频重编码为 AAC', () => {
    const audio = { clips: [clip()], spanStartSec: 0, spanEndSec: 10 }
    const args = buildTransparentMovFromPipe(FPS_30, 'C:/out/t.mov', 'raw', { width: 1920, height: 1080 }, audio)
    const joined = args.join(' ')
    expect(joined).not.toContain('-an')
    expect(joined).toContain('-ss 0.500000 -t 4.000000 -i C:/audio/bed.mp3')
    expect(joined).toContain('[0:v]null[v];')
    expect(joined).toContain('-map [v] -map [amix]')
    expect(joined).toContain('-c:a aac -b:a 192k')
  })
})



