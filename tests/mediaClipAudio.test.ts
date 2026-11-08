import { describe, expect, it } from 'vitest'
import {
  CLIP_AUDIO_RANGE,
  CLIP_SPEED_RANGE,
  PITCH_SHIFT_BASE_RATE,
  atempoFilters,
  clipAudioFilterChain,
  clipAudioOf,
  clipSpeedOf,
  clipVideoSpeedFilter,
  defaultClipAudio,
  defaultClipSpeed,
  fadeFilters,
  isDefaultClipAudio,
  isDefaultClipSpeed,
  normalizeClipAudio,
  normalizeClipSpeed,
  pitchShiftFilters,
  previewGainAt,
  previewPlaybackRate,
  previewPreservesPitch,
  sourceSecForTimelineSec,
  sourceTimeAt,
  speedValueOf,
  tempoFilters,
  timelineSecForSourceSec,
  volumeFilter
} from '@shared/mediaClipAudio'

/**
 * v9 片段音频与变速的纯口径（面板 / 预览 / 导出三处唯一的真值）。
 *
 * 锁四件事：
 * 1. **默认值不落盘**：全默认 → normalize 返回 undefined（调用方据此整键删除）；
 * 2. **脏值可夹心**：越界/NaN/字符串都回到合法区间，绝不让 NaN 进滤镜串；
 * 3. **滤镜串写法**：atempo 链的拆分、asetrate 的基准率、volume/afade 的参数与顺序；
 * 4. **时间换算**：变速时「源窗口不变、时间轴伸缩」的唯一公式。
 */

describe('默认值与归一', () => {
  it('默认值就是「不生效」：100% / 0 / 0 / 1x / 保持音高', () => {
    expect(defaultClipAudio()).toEqual({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 })
    expect(defaultClipSpeed()).toEqual({ speed: 1, maintainPitch: true })
    expect(isDefaultClipAudio(undefined)).toBe(true)
    expect(isDefaultClipSpeed(undefined)).toBe(true)
  })

  it('全默认的原始对象归一后返回 undefined（整键不落盘）', () => {
    expect(normalizeClipAudio({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 })).toBeUndefined()
    expect(normalizeClipSpeed({ speed: 1, maintainPitch: true })).toBeUndefined()
  })

  it('脏值全部夹回区间，非对象一律视为没有', () => {
    expect(normalizeClipAudio({ volumePercent: 500 })).toEqual({ volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 })
    expect(normalizeClipAudio({ volumePercent: -20, fadeInSec: 99 })).toEqual({
      volumePercent: 0,
      fadeInSec: CLIP_AUDIO_RANGE.fade.max,
      fadeOutSec: 0
    })
    // NaN 落回默认值：全默认时仍然不落盘
    expect(normalizeClipAudio({ volumePercent: Number.NaN })).toBeUndefined()
    expect(normalizeClipAudio({ volumePercent: 150, fadeInSec: Number.NaN })).toEqual({
      volumePercent: 150,
      fadeInSec: 0,
      fadeOutSec: 0
    })
    expect(normalizeClipSpeed({ speed: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(normalizeClipAudio('nope')).toBeUndefined()
    expect(normalizeClipAudio([])).toBeUndefined()
    expect(normalizeClipSpeed({ speed: 8 })).toEqual({ speed: CLIP_SPEED_RANGE.max, maintainPitch: true })
    expect(normalizeClipSpeed({ speed: 0 })).toEqual({ speed: CLIP_SPEED_RANGE.min, maintainPitch: true })
  })

  it('倍速 1x 但音高连动 = 仍然要落盘（不是默认）', () => {
    expect(normalizeClipSpeed({ speed: 1, maintainPitch: false })).toEqual({ speed: 1, maintainPitch: false })
    expect(isDefaultClipSpeed({ speed: 1, maintainPitch: false })).toBe(false)
  })

  it('读取缺省字段时补齐默认值（旧工程没有这些键）', () => {
    expect(clipAudioOf(undefined)).toEqual(defaultClipAudio())
    expect(clipAudioOf({ volumePercent: 60 } as never)).toEqual({ volumePercent: 60, fadeInSec: 0, fadeOutSec: 0 })
    expect(clipSpeedOf({ maintainPitch: false } as never)).toEqual({ speed: 1, maintainPitch: false })
    expect(speedValueOf(undefined)).toBe(1)
  })
})

describe('时间换算：源窗口不变，时间轴伸缩', () => {
  it('1x 时两个方向都是恒等（旧恒等式不变）', () => {
    expect(sourceSecForTimelineSec(1, 4.5)).toBeCloseTo(4.5, 9)
    expect(timelineSecForSourceSec(1, 4.5)).toBeCloseTo(4.5, 9)
  })

  it('2x：时间轴 1s 吃掉 2s 源；0.5x：时间轴 1s 只吃 0.5s 源', () => {
    expect(sourceSecForTimelineSec(2, 3)).toBeCloseTo(6, 9)
    expect(timelineSecForSourceSec(2, 6)).toBeCloseTo(3, 9)
    expect(sourceSecForTimelineSec(0.5, 3)).toBeCloseTo(1.5, 9)
    expect(timelineSecForSourceSec(0.5, 3)).toBeCloseTo(6, 9)
  })

  it('源坐标 = 入点 + 时间轴偏移 × 倍速', () => {
    const clip = { timelineStartSec: 10, sourceInSec: 2, speed: { speed: 2, maintainPitch: true } }
    expect(sourceTimeAt(clip, 10)).toBeCloseTo(2, 9)
    expect(sourceTimeAt(clip, 12)).toBeCloseTo(6, 9)
    // 播放头在片段之前不会算出负数偏移
    expect(sourceTimeAt(clip, 4)).toBeCloseTo(2, 9)
  })

  it('脏倍速（含 undefined）参与换算时先夹心', () => {
    expect(speedValueOf({ speed: 99, maintainPitch: true })).toBe(4)
    expect(speedValueOf({ speed: Number.NaN, maintainPitch: true })).toBe(1)
  })
})

describe('变速滤镜链', () => {
  it('1x 不挂任何滤镜（argv 与不变速逐字节一致）', () => {
    expect(atempoFilters(1)).toEqual([])
    expect(pitchShiftFilters(1)).toEqual([])
    expect(clipVideoSpeedFilter(undefined)).toBe('')
    expect(clipVideoSpeedFilter({ speed: 1, maintainPitch: false })).toBe('')
  })

  it('保持音高：单个 atempo 覆盖不了的倍速串接多个实例（0.5..2 安全区）', () => {
    expect(atempoFilters(2)).toEqual(['atempo=2'])
    expect(atempoFilters(1.5)).toEqual(['atempo=1.5'])
    expect(atempoFilters(4)).toEqual(['atempo=2', 'atempo=2'])
    expect(atempoFilters(3)).toEqual(['atempo=2', 'atempo=1.5'])
    expect(atempoFilters(0.25)).toEqual(['atempo=0.5', 'atempo=0.5'])
    expect(atempoFilters(0.4)).toEqual(['atempo=0.5', 'atempo=0.8'])
  })

  it('连动音高：先归一到基准率，再按倍速重解释采样率，最后回到基准率', () => {
    expect(pitchShiftFilters(2)).toEqual([
      `aresample=${PITCH_SHIFT_BASE_RATE}`,
      `asetrate=${PITCH_SHIFT_BASE_RATE * 2}`,
      `aresample=${PITCH_SHIFT_BASE_RATE}`
    ])
    expect(pitchShiftFilters(0.5)).toEqual([
      `aresample=${PITCH_SHIFT_BASE_RATE}`,
      `asetrate=${PITCH_SHIFT_BASE_RATE / 2}`,
      `aresample=${PITCH_SHIFT_BASE_RATE}`
    ])
  })

  it('开关只决定用哪条链', () => {
    expect(tempoFilters({ speed: 2, maintainPitch: true })).toEqual(['atempo=2'])
    expect(tempoFilters({ speed: 2, maintainPitch: false })[1]).toContain('asetrate=')
    expect(tempoFilters(undefined)).toEqual([])
  })

  it('画面：变速挂在重采样之后（.trf 帧序号才不会被错位）', () => {
    expect(clipVideoSpeedFilter({ speed: 2.5, maintainPitch: true })).toBe('setpts=(PTS-STARTPTS)/2.5')
  })
})

describe('音量与渐变滤镜', () => {
  it('100% 不挂 volume，200% 写成 volume=2', () => {
    expect(volumeFilter(undefined)).toBe('')
    expect(volumeFilter({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 })).toBe('')
    expect(volumeFilter({ volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 })).toBe('volume=2')
    expect(volumeFilter({ volumePercent: 150, fadeInSec: 0, fadeOutSec: 0 })).toBe('volume=1.5')
    expect(volumeFilter({ volumePercent: 0, fadeInSec: 0, fadeOutSec: 0 })).toBe('volume=0')
  })

  it('afade 用本段输出的局部时间：淡入从 0 起，淡出从「长度 - 淡出」起', () => {
    expect(fadeFilters({ volumePercent: 100, fadeInSec: 2, fadeOutSec: 1 }, 8)).toEqual([
      'afade=t=in:st=0:d=2',
      'afade=t=out:st=7:d=1'
    ])
  })

  it('渐变各自不超过半个片段（重叠淡变会互相吃掉）', () => {
    expect(fadeFilters({ volumePercent: 100, fadeInSec: 5, fadeOutSec: 5 }, 4)).toEqual([
      'afade=t=in:st=0:d=2',
      'afade=t=out:st=2:d=2'
    ])
    expect(fadeFilters({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 }, 4)).toEqual([])
  })

  it('整条链顺序固定：降噪 → 变速 → 音量 → 淡入 → 淡出；全默认时是空串', () => {
    expect(clipAudioFilterChain({ outputDurationSec: 4 })).toBe('')
    expect(
      clipAudioFilterChain({
        audio: { volumePercent: 150, fadeInSec: 1, fadeOutSec: 1 },
        speed: { speed: 2, maintainPitch: true },
        outputDurationSec: 4
      })
    ).toBe('atempo=2,volume=1.5,afade=t=in:st=0:d=1,afade=t=out:st=3:d=1')
    expect(
      clipAudioFilterChain({
        audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'standard' },
        speed: { speed: 2, maintainPitch: true },
        outputDurationSec: 4
      })
    ).toBe('afftdn=nr=12:nf=-25,atempo=2')
  })
})

describe('v10 降噪的默认值口径', () => {
  it('clipAudioOf 保留合法档位；非默认降噪算「已编辑」', () => {
    expect(clipAudioOf({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'light' })).toEqual({
      volumePercent: 100,
      fadeInSec: 0,
      fadeOutSec: 0,
      denoise: 'light'
    })
    expect(isDefaultClipAudio({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'strong' })).toBe(false)
    expect(isDefaultClipAudio({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 })).toBe(true)
  })

  it('归一：合法档位落盘；脏档位丢弃；只有降噪时整键保留', () => {
    expect(normalizeClipAudio({ denoise: 'strong' })).toEqual({
      volumePercent: 100,
      fadeInSec: 0,
      fadeOutSec: 0,
      denoise: 'strong'
    })
    expect(normalizeClipAudio({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'nope' })).toBeUndefined()
  })
})

describe('预览侧读数', () => {
  it('增益包络：淡入线性上升，中段满值，淡出线性下降到 0', () => {
    const audio = { volumePercent: 100, fadeInSec: 2, fadeOutSec: 2 }
    expect(previewGainAt(audio, 0, 8)).toBe(0)
    expect(previewGainAt(audio, 1, 8)).toBeCloseTo(0.5, 6)
    expect(previewGainAt(audio, 2, 8)).toBeCloseTo(1, 6)
    expect(previewGainAt(audio, 5, 8)).toBeCloseTo(1, 6)
    expect(previewGainAt(audio, 7, 8)).toBeCloseTo(0.5, 6)
    expect(previewGainAt(audio, 8, 8)).toBe(0)
  })

  it('200% 在预览里是 2（HTMLMediaElement.volume 封顶由增益图接管）', () => {
    expect(previewGainAt({ volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 }, 1, 4)).toBe(2)
  })

  it('播放倍率与音高开关直接给 HTMLMediaElement 用', () => {
    expect(previewPlaybackRate(undefined)).toBe(1)
    expect(previewPlaybackRate({ speed: 2, maintainPitch: true })).toBe(2)
    expect(previewPreservesPitch(undefined)).toBe(true)
    expect(previewPreservesPitch({ speed: 2, maintainPitch: false })).toBe(false)
  })
})
