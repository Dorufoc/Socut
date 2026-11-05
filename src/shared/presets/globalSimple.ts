import type { Preset } from '../types'
import {
  BAR_MAX_WIDTH,
  INSET,
  buildSubtitleAbove,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 国际简洁：浅色主条 + 上方红色副标题小条；深色标题字对比最高。
 * 红色小条同时承担“边界锚点”，浅色主条在浅背景上也不会整体消失。
 */

const maxWidth = BAR_MAX_WIDTH
const minWidth = 'min(460px@1080p, 30%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.4vh, 78px@1080p)', maxLines: 2, tracking: '0.3px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.6vh, 38px@1080p)', maxLines: 2, tracking: '0.2px@1080p' }

export const globalSimple: Preset = {
  id: 'globalSimple',
  name: '国际简洁',
  description: '浅色主条 + 红色副标题小条；深色字对比最高，跨平台最中性的一套。',
  tokens: {
    primary: '#F2F4F6',
    accent: '#C81E28',
    text: '#101418',
    secondaryText: '#3B4450',
    barBackground: '#E4E8ED'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notosanssc-700' },
    subtitle: { builtinKey: 'auto', weight: 500, fallbackBuiltinKey: 'builtin-notosanssc-500' }
  },
  animation: {
    inDuration: 0.33,
    outDuration: 0.21,
    easing: 'smootherstep',
    textRevealFrames: 3,
    displacement: { x: '-22px@1080p', y: '0' },
    ruleLeadInFrames: 3
  },
  safeArea: 'title',
  layout: buildSubtitleAbove({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth,
    gapY: '6px@1080p',
    title,
    subtitle,
    titlePlate: { fill: 'primary', paddingX: '32px@1080p', paddingY: '16px@1080p', radius: '2px@1080p' },
    subtitlePlate: { fill: 'accent', paddingX: '24px@1080p', paddingY: '9px@1080p', radius: '2px@1080p', minWidth: '140px@1080p' },
    titleBlock: { width: '4px@1080p', gap: '20px@1080p', token: 'accent' },
    titleFillToken: 'text',
    subtitleTextToken: 'primary'
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
