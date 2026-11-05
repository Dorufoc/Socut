import { describe, expect, it } from 'vitest'
import { DEFAULT_FONT_ID, FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject, normalizeProject } from '@shared/projectSchema'
import { getPreset } from '@shared/presets'
import { framesToDurationSec } from '@shared/fps'
import type { SubtitleClip } from '@shared/types'
import {
  clipWithPresetDefaults,
  fontScaleDelta,
  hasKeys,
  revealTargetSec,
  sameColor,
  styleOverrideCount,
  tokensDelta
} from '@shared/clipStyle'

/**
 * 片段自定义覆盖的洁净度法则 + 预览可见性判定（纯函数）。
 *
 * 锁住三条会导致「改了没反应 / 切预设没生效」的行为：
 * 1. 等于预设声明的值**不能**留在覆盖里（否则它会跟着下一个预设压住它的配色）；
 * 2. 切预设 = 整层清空 + 字体/动画回预设默认，文字与入出点一律不动；
 * 3. 播放头不在「能看清当前样式」的窗口内时，编辑要把播放头带过去（播放中则不打扰）。
 */

const preset = getPreset('breakingRed')

function clipOf(patch: Partial<SubtitleClip> = {}): SubtitleClip {
  const clip = createClip({ startTime: 0, fps: FPS_30 })
  return { ...clip, ...patch }
}

describe('颜色等价（sameColor）', () => {
  it('缩写十六进制、全写与 rgb() 归一到同一颜色', () => {
    expect(sameColor('#F00', '#ff0000')).toBe(true)
    expect(sameColor('#ff0000', 'rgb(255, 0, 0)')).toBe(true)
    expect(sameColor('#12345E', '#12345e')).toBe(true)
  })

  it('不同色、无法解析或缺值都算不同（宁保守地把覆盖留着）', () => {
    expect(sameColor('#12345E', '#12345F')).toBe(false)
    expect(sameColor('not-a-color', '#12345E')).toBe(false)
    expect(sameColor(undefined, '#12345E')).toBe(false)
    expect(sameColor(undefined, undefined)).toBe(true)
  })
})

describe('令牌差集（tokensDelta）', () => {
  it('只留下真正偏离预设的键，其余一个都不写', () => {
    const next = tokensDelta(preset, undefined, 'primary', '#101010')
    expect(next).toEqual({ primary: '#101010' })
  })

  it('改回预设声明的色值等于撤销自定义（键消失，而不是留一个同值）', () => {
    const next = tokensDelta(preset, { primary: '#101010' }, 'primary', preset.tokens.primary)
    expect(next).toEqual({})
  })

  it('顺手清掉历史遗留的同值覆盖（旧版整套回写留下的脏键）', () => {
    const legacy = { accent: preset.tokens.accent, text: '#abcdef' }
    const next = tokensDelta(preset, legacy, 'barBackground', '#101010')
    expect(next).toEqual({ text: '#abcdef', barBackground: '#101010' })
    expect('accent' in next).toBe(false)
  })

  it('其他片段的自定义键不受影响（差集只针对本次改动的键）', () => {
    const previous = { primary: '#101010', secondaryText: '#eeeeee' }
    expect(tokensDelta(preset, previous, 'primary', '#202020')).toEqual({
      primary: '#202020',
      secondaryText: '#eeeeee'
    })
  })
})

describe('字号缩放差集（fontScaleDelta）', () => {
  it('写 130% 只留 title，回到 100% 就删键', () => {
    expect(fontScaleDelta(undefined, 'title', 1.3)).toEqual({ title: 1.3 })
    expect(fontScaleDelta({ title: 1.3 }, 'title', 1)).toEqual({})
  })

  it('滑杆粒度内的抖动（<0.5%）不算自定义，也不带出等于 1 的噪声', () => {
    expect(fontScaleDelta({ subtitle: 1.001 }, 'title', 1.002)).toEqual({})
  })
})

describe('自定义项计数（styleOverrideCount）', () => {
  it('干净的片段是 0 项；等于预设的令牌不计入', () => {
    expect(styleOverrideCount(preset, {})).toBe(0)
    expect(styleOverrideCount(preset, { tokens: { primary: preset.tokens.primary } })).toBe(0)
    expect(styleOverrideCount(preset, { barOpacity: 1 })).toBe(0)
    expect(styleOverrideCount(preset, { fontScale: { title: 1 } })).toBe(0)
    expect(styleOverrideCount(preset, { titleGradient: { enabled: false, from: '#fff', to: '#000', angleDeg: 90 } })).toBe(0)
  })

  it('配色 / 透明度 / 渐变 / 字号 / 紧凑各自计数', () => {
    const overrides = {
      tokens: { primary: '#101010', accent: preset.tokens.accent },
      barOpacity: 0.8,
      titleGradient: { enabled: true, from: '#ffffff', to: '#9ec7ff', angleDeg: 90 },
      fontScale: { title: 1.3, subtitle: 1 },
      compact: true
    } as const
    // primary 1 + barOpacity 1 + 渐变 1 + title 缩放 1 + 紧凑 1 = 5（accent 与 subtitle 等于默认不计）
    expect(styleOverrideCount(preset, overrides)).toBe(5)
  })
})

describe('切预设 = 回到该预设的默认配置', () => {
  it('清空全部自定义、字体回默认、动画回预设声明', () => {
    const source = clipOf({
      presetId: 'stackedNews',
      fontId: 'builtin-notosanssc-900',
      styleOverrides: { tokens: { primary: '#101010' }, barOpacity: 0.6, fontScale: { title: 1.5 } },
      animation: { inDuration: 0.9, outDuration: 0.2, easing: 'linear', textRevealFrames: 6, displacement: { x: '0', y: '0' } }
    })
    const next = clipWithPresetDefaults(source, preset)
    expect(next.presetId).toBe(preset.id)
    expect(next.styleOverrides).toEqual({})
    expect(next.fontId).toBe(DEFAULT_FONT_ID)
    expect(next.animation.inDuration).toBe(preset.animation.inDuration)
    expect(next.animation.outDuration).toBe(preset.animation.outDuration)
    expect(next.animation.easing).toBe(preset.animation.easing)
  })

  it('文字内容与入出点不属于样式，一律保持', () => {
    const source = clipOf({
      startTime: 4,
      endTime: 9,
      content: { title: '必须留下', subtitle: '也必须留下' },
      styleOverrides: { tokens: { primary: '#101010' } }
    })
    const next = clipWithPresetDefaults(source, preset)
    expect(next.content).toEqual({ title: '必须留下', subtitle: '也必须留下' })
    expect({ start: next.startTime, end: next.endTime }).toEqual({ start: 4, end: 9 })
  })

  it('displacement 是引用型字段，重置后与预设声明对象不是同一个引用（防止共享可变对象）', () => {
    const next = clipWithPresetDefaults(clipOf(), preset)
    expect(next.animation.displacement).toEqual(preset.animation.displacement)
    expect(next.animation.displacement).not.toBe(preset.animation.displacement)
  })
})

describe('编辑后把播放头带到看得见的帧（revealTargetSec）', () => {
  const clip = clipOf({ startTime: 10, endTime: 15 })
  const inSec = clip.animation.inDuration
  const outSec = clip.animation.outDuration

  it('播放中不动播放头（时钟自己在走，跳帧反而打断观感）', () => {
    expect(revealTargetSec(clip, FPS_30, 0, true)).toBeNull()
  })

  it('已经落在「入场完成 → 出场开始」窗口内不动，边界也算在内', () => {
    expect(revealTargetSec(clip, FPS_30, 10 + inSec, false)).toBeNull()
    expect(revealTargetSec(clip, FPS_30, 12, false)).toBeNull()
    expect(revealTargetSec(clip, FPS_30, 15 - outSec, false)).toBeNull()
  })

  it('窗口之外（片段还没开始 / 已经出场）落到入场完成后的第一帧', () => {
    expect(revealTargetSec(clip, FPS_30, 0, false)).toBeCloseTo(10 + inSec, 6)
    expect(revealTargetSec(clip, FPS_30, 14.9, false)).toBeCloseTo(10 + inSec, 6)
    // 入场过程中也不算「看得见」：停在擦除没走完的帧上看不出最终样式
    expect(revealTargetSec(clip, FPS_30, 10.2, false)).toBeCloseTo(10 + inSec, 6)
  })

  it('极短片段不会把播放头推到片段之外', () => {
    const oneFrame = framesToDurationSec(1, FPS_30)
    const tiny = clipOf({ startTime: 0, endTime: oneFrame })
    const target = revealTargetSec(tiny, FPS_30, 5, false)!
    expect(target).toBeGreaterThanOrEqual(0)
    expect(target).toBeLessThan(oneFrame)
  })
})

describe('hasKeys（覆盖集合是否还有内容）', () => {
  it('空对象算没有内容，undefined 也算没有', () => {
    expect(hasKeys({})).toBe(false)
    expect(hasKeys(undefined)).toBe(false)
    expect(hasKeys({ primary: '#fff' })).toBe(true)
  })
})

describe('与工程归一化同一口径', () => {
  it('normalizeProject 同样丢弃等于 1 的字号缩放（两层都不会积累噪声）', () => {
    const project = createDefaultProject('覆盖洁净度')
    project.clips = [clipOf({ styleOverrides: { fontScale: { title: 1, subtitle: 1.2 }, tokens: {} } })]
    const normalized = normalizeProject(project)
    expect(normalized?.clips[0]?.styleOverrides.fontScale).toEqual({ subtitle: 1.2 })
    expect(normalized?.clips[0]?.styleOverrides.tokens).toBeUndefined()
  })
})
