import { describe, expect, it } from 'vitest'
import { resolveSize, resolveToPx, describeToken } from '@shared/units'
import { ACTION_SAFE_RATIO, TITLE_SAFE_RATIO } from '@shared/constants'
import { barWidthPercent, classifyAspect, fontSizeCapPx, isNon16_9, displayAspectRatio } from '@shared/aspect'
import { gradientLine, isValidColor, mergeTokens, parseColor, toCssColor } from '@shared/colors'
import { EASING_KEYS, applyEasing, isOvershootFree } from '@shared/easing'
import type { ColorTokens } from '@shared/types'

/** 规格 §4.3 单位体系 + 宽高比分支 + §7 配色令牌/缓动的机器校验。 */

const HD = { width: 1920, height: 1080 }
const PRESETS_6 = [
  { width: 640, height: 360 },
  { width: 854, height: 480 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 }
]

describe('单位体系', () => {
  it('vw / vh 按视口线性缩放', () => {
    expect(resolveToPx('10vw', HD)).toBeCloseTo(192, 6)
    expect(resolveToPx('10vh', HD)).toBeCloseTo(108, 6)
    expect(resolveToPx('10vw', PRESETS_6[5]!)).toBeCloseTo(384, 6)
  })

  it('px@1080p 按高度等比换算（360p 到 4K 一致缩放）', () => {
    expect(resolveToPx('100px@1080p', HD)).toBeCloseTo(100, 6)
    expect(resolveToPx('100px@1080p', PRESETS_6[0]!)).toBeCloseTo((100 * 360) / 1080, 6)
    expect(resolveToPx('100px@1080p', PRESETS_6[5]!)).toBeCloseTo((100 * 2160) / 1080, 6)
  })

  it('固定 px 不随分辨率变化（描边/线宽用）', () => {
    for (const preset of PRESETS_6) expect(resolveToPx('2px', preset)).toBe(2)
  })

  it('百分号透传给 Yoga（不折算为像素）', () => {
    expect(resolveSize('72%', HD)).toEqual({ kind: 'percent', value: 72 })
    expect(resolveSize('auto', HD)).toEqual({ kind: 'auto' })
    expect(resolveSize(undefined, HD)).toEqual({ kind: 'auto' })
  })

  it('safe-* 按动作/标题安全区内缩', () => {
    const actionSide = ((1 - ACTION_SAFE_RATIO) / 2) * 1920
    const titleBottom = ((1 - TITLE_SAFE_RATIO) / 2) * 1080
    expect(resolveToPx('safe-side', HD)).toBeCloseTo(actionSide, 6)
    expect(resolveToPx('safe-bottom', HD)).toBeCloseTo(((1 - ACTION_SAFE_RATIO) / 2) * 1080, 6)
    expect(resolveToPx('safe-title-side', HD)).toBeCloseTo(((1 - TITLE_SAFE_RATIO) / 2) * 1920, 6)
    expect(resolveToPx('safe-title-bottom', HD)).toBeCloseTo(titleBottom, 6)

    /**
     * 上面的断言都从常量反推，改常量它们不会报错（同义反复）。
     * 这里钉住**绝对值**与两者关系：动作安全区每边 3.5%（SMPTE ST 2048-1 HDTV），
     * 标题安全区每边 10%（EBU R 95）；标题必须比动作更内缩，否则两条参考线没有意义。
     * 计划 §2 给的是 2.5% / 5%（0.95 / 0.90），差异已在 docs/verification/M0.md C43 留档。
     */
    expect(ACTION_SAFE_RATIO).toBe(0.93)
    expect(TITLE_SAFE_RATIO).toBe(0.8)
    expect(resolveToPx('safe-side', HD)).toBeCloseTo(0.035 * 1920, 6)
    expect(resolveToPx('safe-title-side', HD)).toBeCloseTo(0.1 * 1920, 6)
    expect(resolveToPx('safe-title-bottom', HD)).toBeGreaterThan(resolveToPx('safe-bottom', HD))
    // 1080p 下标题安全区底部内缩应为 108px（10% 高度），字幕条不得超出此线
    expect(resolveToPx('safe-title-bottom', HD)).toBeCloseTo(108, 6)
    expect(actionSide).toBeGreaterThan(0)
  })

  it('clamp(min, preferred, max) 三档解析并钳制', () => {
    const token = 'clamp(28px@1080p, 6vh, 72px@1080p)'
    expect(resolveToPx(token, HD)).toBeCloseTo(64.8, 5) // 6vh=64.8 落在 [28,72] 内
    // 竖屏：6vh 变成 115.2 → 被 max 72px@1080p（=128）钳制的边界检查
    const portrait = { width: 1080, height: 1920 }
    const clamped = resolveToPx(token, portrait)
    expect(clamped).toBeCloseTo(Math.min(6 * 19.2, (72 * 1920) / 1080), 5)
    expect(clamped).toBeGreaterThanOrEqual(resolveToPx('28px@1080p', portrait))
  })

  it('min/max 表达式（超宽上限用）', () => {
    expect(resolveToPx('min(1400px@1080p, 50%)', HD)).toBeCloseTo(960, 6)
    expect(resolveToPx('max(1400px@1080p, 50%)', HD)).toBeCloseTo(1400, 6)
  })

  it('非法令牌回退 auto 而不是抛错', () => {
    expect(resolveSize('abc', HD)).toEqual({ kind: 'auto' })
    expect(resolveSize('clamp(1px)', HD)).toEqual({ kind: 'point', value: 1 })
  })

  it('describeToken 标注实际像素（UI 用）', () => {
    expect(describeToken('96px@1080p', HD)).toContain('96px')
  })
})

describe('宽高比分支（计划 C8）', () => {
  it('16:9 不触发非 16:9', () => {
    expect(isNon16_9(1920 / 1080)).toBe(false)
    expect(isNon16_9(1280 / 720)).toBe(false)
  })
  it('4:3 / 9:16 / 21:9 触发模态', () => {
    expect(isNon16_9(4 / 3)).toBe(true)
    expect(isNon16_9(9 / 16)).toBe(true)
    expect(isNon16_9(21 / 9)).toBe(true)
  })
  it('SAR 修正显示比（anamorphic）', () => {
    // NTSC DV anamorphic：存储 704×480、SAR 40:33 → 显示比恰好 16:9（像素比只有 1.467）
    const anamorphic = displayAspectRatio({ width: 704, height: 480 }, { num: 40, den: 33 })
    expect(anamorphic).toBeCloseTo(16 / 9, 6)
    expect(isNon16_9(anamorphic)).toBe(false)
    // 忽略 SAR 时会被误判为非 16:9 —— 这就是必须用显示比的原因（计划 C8）
    expect(isNon16_9(displayAspectRatio({ width: 704, height: 480 }))).toBe(true)
  })
  it('compact / ultrawide / standard 阈值', () => {
    expect(classifyAspect(9 / 16)).toBe('compact')
    expect(classifyAspect(1 / 1)).toBe('compact')
    expect(classifyAspect(4 / 3)).toBe('standard')
    expect(classifyAspect(21 / 9)).toBe('ultrawide')
    expect(barWidthPercent('compact')).toBe(88)
  })
  it('字号硬上限：竖屏下不失控（验收第 9 条）', () => {
    const portrait = { width: 1080, height: 1920 }
    const raw = resolveToPx('clamp(44px@1080p, 5.4vh, 88px@1080p)', portrait)
    const capped = fontSizeCapPx('compact', raw, portrait.width, portrait.height)
    expect(capped).toBeLessThanOrEqual(portrait.width * 0.075 + 1e-6)
    expect(capped).toBeGreaterThan(6)
    // 16:9 下不受该上限影响（预设 clamp 已合理）
    const hd = resolveToPx('clamp(44px@1080p, 5.4vh, 88px@1080p)', HD)
    expect(fontSizeCapPx('standard', hd, HD.width, HD.height)).toBeCloseTo(hd, 6)
  })
})

describe('配色令牌', () => {
  it('解析 #RGB/#RGBA/#RRGGBB/#RRGGBBAA/rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#fffa')).toEqual({ r: 255, g: 255, b: 255, a: 170 / 255 })
    expect(parseColor('#143a6b')).toEqual({ r: 20, g: 58, b: 107, a: 1 })
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 })
    expect(parseColor('nope')).toBeNull()
    expect(isValidColor('rgba(0,0,0,1)')).toBe(true)
  })
  it('toCssColor 乘上不透明度且夹紧', () => {
    expect(toCssColor('#000000', 0.5)).toBe('rgba(0, 0, 0, 0.5)')
    expect(toCssColor('garbage')).toBe('rgba(0, 0, 0, 0)')
  })
  it('mergeTokens 只接受合法颜色（用户覆盖作用于令牌层）', () => {
    const base: ColorTokens = {
      primary: '#143A6B',
      accent: '#C9A227',
      text: '#FFFFFF',
      secondaryText: '#E8EDF5',
      barBackground: '#0A1A30'
    }
    const merged = mergeTokens(base, { primary: '#FF0000', accent: 'garbage' as string })
    expect(merged.primary).toBe('#FF0000')
    expect(merged.accent).toBe('#C9A227')
  })
  it('渐变线段端点落在盒边界上', () => {
    const box = { x: 100, y: 200, w: 600, h: 80 }
    const horizontal = gradientLine(box, 0)
    expect(horizontal.x0).toBeCloseTo(100, 6)
    expect(horizontal.x1).toBeCloseTo(700, 6)
    expect(horizontal.y0).toBeCloseTo(240, 6)
    const vertical = gradientLine(box, 90)
    expect(vertical.y0).toBeCloseTo(200, 6)
    expect(vertical.y1).toBeCloseTo(280, 6)
    expect(vertical.x0).toBeCloseTo(400, 6)
  })
})

describe('缓动曲线（规格 §7 动画电视感）', () => {
  it('全部曲线无过冲且单调不减', () => {
    for (const key of EASING_KEYS) {
      expect(isOvershootFree(key), `曲线 ${key} 存在过冲`).toBe(true)
      expect(applyEasing(key, 0)).toBeCloseTo(0, 6)
      expect(applyEasing(key, 1)).toBeCloseTo(1, 6)
    }
  })
  it('越界输入被钳制', () => {
    expect(applyEasing('outCubic', -1)).toBe(0)
    expect(applyEasing('outCubic', 2)).toBe(1)
  })
})
