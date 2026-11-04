import { describe, expect, it } from 'vitest'
import {
  VISUAL_THRESHOLDS,
  checkVisualSample,
  contrastRatio,
  relativeLuminance,
  rightVoidRatio,
  textWidthRatio,
  type VisualSampleMetrics
} from '@shared/visualRules'

/**
 * 视觉检查规则的纯函数部分（无需 Canvas）：
 * 对比度用 WCAG 公式，占比用条盒几何；阈值检查必须能逐条报错，否则失败无法定位。
 */

const GOOD: VisualSampleMetrics = {
  textRatio: 0.82,
  rightVoid: 0.12,
  barFontRatio: 2.2,
  subFontRatio: 0.47,
  padTop: 15,
  padBottom: 15,
  bottomRatio: 0.08,
  leftRatio: 0.05,
  titleContrast: 12,
  subtitleContrast: 7,
  titleLines: 1
}

describe('对比度（WCAG）', () => {
  it('黑白为 21:1，同色为 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#12345E', '#12345E')).toBeCloseTo(1, 5)
  })

  it('常见字幕配色达到 AA 大字阈值', () => {
    expect(contrastRatio('#FFFFFF', '#12345E')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#101418', '#F2F4F6')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#FFC978', '#0F223C')).toBeGreaterThanOrEqual(3)
  })

  it('无法解析的颜色返回 null（不误判为通过）', () => {
    expect(relativeLuminance('not-a-color')).toBeNull()
    expect(contrastRatio('not-a-color', '#000000')).toBeNull()
  })
})

describe('占比计算', () => {
  it('文字占比被钳制在 0~1，条宽为 0 不产生 NaN', () => {
    expect(textWidthRatio(120, 0)).toBe(0)
    expect(textWidthRatio(50, 100)).toBeCloseTo(0.5)
    expect(textWidthRatio(200, 100)).toBe(1)
    expect(textWidthRatio(-5, 100)).toBe(0)
  })

  it('右侧空白 = (条右缘 − 文字右缘) / 条宽', () => {
    expect(rightVoidRatio(400, 500, 500)).toBeCloseTo(0.2)
    expect(rightVoidRatio(600, 500, 500)).toBe(0)
    expect(rightVoidRatio(400, 500, 0)).toBe(0)
  })
})

describe('视觉阈值检查', () => {
  it('全部达标的样本没有失败项', () => {
    expect(checkVisualSample(GOOD)).toEqual([])
  })

  it('文字占比过低 / 右侧空白过大 → 明确报出满宽空板', () => {
    const failures = checkVisualSample({ ...GOOD, textRatio: 0.2, rightVoid: 0.8 })
    expect(failures.some((item) => item.includes('文字只占条宽'))).toBe(true)
    expect(failures.some((item) => item.includes('右侧空白'))).toBe(true)
  })

  it('条高/字号、副标题比例、内边距、安全区、行数、对比度逐项可报', () => {
    const failures = checkVisualSample({
      ...GOOD,
      barFontRatio: 0.9,
      subFontRatio: 0.9,
      padTop: 2,
      padBottom: 1,
      bottomRatio: 0.01,
      leftRatio: 0.01,
      titleContrast: 2,
      subtitleContrast: 1.5,
      titleLines: 4
    })
    for (const keyword of ['条高/字号', '副标题字号比例', '距条顶', '距条底', '底边距', '左边距', '标题对比度', '副标题对比度', '标题 4 行']) {
      expect(failures.some((item) => item.includes(keyword)), `缺少「${keyword}」`).toBe(true)
    }
  })

  it('阈值区间自洽（最小值 < 最大值）', () => {
    expect(VISUAL_THRESHOLDS.minBarFontRatio).toBeLessThan(VISUAL_THRESHOLDS.maxBarFontRatio)
    expect(VISUAL_THRESHOLDS.minSubFontRatio).toBeLessThan(VISUAL_THRESHOLDS.maxSubFontRatio)
    expect(VISUAL_THRESHOLDS.maxTitleLines).toBeGreaterThanOrEqual(1)
  })
})
