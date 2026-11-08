import { describe, expect, it } from 'vitest'
import {
  audioMasteringLabel,
  denoiseFilter,
  duckingFilter,
  duckingStrengthOf,
  loudnormFilter
} from '@shared/audioQuality'
import type { AudioDuckingLevel, AudioRole } from '@shared/types'

/**
 * v10 音频质量的纯口径（导出侧降噪 / BGM ducking / 响度）。
 *
 * 锁三件事：
 * 1. 三档参数与规格逐字对应（nr/nf、threshold/ratio/attack/release、I/TP/LRA）；
 * 2. 关闭/缺省一律返回空串（调用方拼接时不会多出逗号）；
 * 3. ducking 档位取全部 BGM 片段里最强的一档，非 BGM 或未开启不参与。
 */

describe('降噪档位', () => {
  it('三档映射到 afftdn 的 nr/nf', () => {
    expect(denoiseFilter('light')).toBe('afftdn=nr=6:nf=-30')
    expect(denoiseFilter('standard')).toBe('afftdn=nr=12:nf=-25')
    expect(denoiseFilter('strong')).toBe('afftdn=nr=20:nf=-20')
  })

  it('关闭（undefined）返回空串', () => {
    expect(denoiseFilter(undefined)).toBe('')
  })
})

describe('BGM ducking 档位', () => {
  it('三档映射到 sidechaincompress 参数（attack/release 毫秒）', () => {
    expect(duckingFilter('light', 'bgm', 'voice', 'out')).toBe(
      '[bgm][voice]sidechaincompress=threshold=0.08:ratio=4:attack=200:release=400:makeup=1[out]'
    )
    expect(duckingFilter('standard', 'bgm', 'voice', 'out')).toBe(
      '[bgm][voice]sidechaincompress=threshold=0.05:ratio=8:attack=100:release=300:makeup=1[out]'
    )
    expect(duckingFilter('strong', 'bgm', 'voice', 'out')).toBe(
      '[bgm][voice]sidechaincompress=threshold=0.03:ratio=12:attack=50:release=200:makeup=1[out]'
    )
  })

  it('档位强度：只取 role=bgm 且开启 ducking 的最强一档', () => {
    const clips: { role?: AudioRole; ducking?: AudioDuckingLevel }[] = [
      { role: 'voice', ducking: 'strong' },
      { role: 'bgm' },
      { role: 'bgm', ducking: 'light' },
      { role: 'bgm', ducking: 'standard' }
    ]
    expect(duckingStrengthOf(clips)).toBe('standard')
    expect(duckingStrengthOf([{ role: 'bgm', ducking: 'strong' }])).toBe('strong')
    expect(duckingStrengthOf([{ role: 'bgm' }])).toBeUndefined()
    expect(duckingStrengthOf([{ role: 'voice', ducking: 'strong' }])).toBeUndefined()
    expect(duckingStrengthOf([])).toBeUndefined()
  })
})

describe('响度标准化档位', () => {
  it('social / broadcast 目标逐字对应规格', () => {
    expect(loudnormFilter('social')).toBe('loudnorm=I=-14:TP=-1.5:LRA=11')
    expect(loudnormFilter('broadcast')).toBe('loudnorm=I=-23:TP=-1:LRA=7')
  })

  it('off / undefined 返回空串（不注入 loudnorm）', () => {
    expect(loudnormFilter('off')).toBe('')
    expect(loudnormFilter(undefined)).toBe('')
  })

  it('界面读数名', () => {
    expect(audioMasteringLabel(undefined)).toBe('关闭')
    expect(audioMasteringLabel('off')).toBe('关闭')
    expect(audioMasteringLabel('social')).toBe('社交 -14 LUFS')
    expect(audioMasteringLabel('broadcast')).toBe('广播 -23 LUFS')
  })
})
