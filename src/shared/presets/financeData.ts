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
 * 财经数据：深蓝主条 + 上方更深的读数小条；读数固定等宽字体、琥珀色。
 * 副标题条左缘与主条对齐，读数与指数名共左线。
 */

const maxWidth = BAR_MAX_WIDTH
const minWidth = 'min(400px@1080p, 27%)' as const
const title: TextTier = { size: 'clamp(38px@1080p, 5vh, 74px@1080p)', maxLines: 1, tracking: '0.6px@1080p' }
const subtitle: TextTier = { size: 'clamp(24px@1080p, 2.7vh, 40px@1080p)', maxLines: 1, tracking: '0.4px@1080p' }

export const financeData: Preset = {
  id: 'financeData',
  name: '财经数据',
  description: '指数名主条 + 上方指标读数小条；读数等宽字体、琥珀色，适合行情播报。',
  tokens: {
    primary: '#0F223C',
    accent: '#F0A33A',
    text: '#FFFFFF',
    secondaryText: '#FFC978',
    barBackground: '#08182B'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notosanssc-700' },
    // 读数固定等宽字体（数字对齐），不被片段字体覆盖
    subtitle: { builtinKey: 'builtin-jetbrainsmono-700', weight: 700, fallbackBuiltinKey: 'builtin-jetbrainsmono-700' }
  },
  animation: {
    inDuration: 0.27,
    outDuration: 0.16,
    easing: 'outQuart',
    textRevealFrames: 2,
    displacement: { x: '-26px@1080p', y: '0' },
    ruleLeadInFrames: 2
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
    titlePlate: { fill: 'primary', paddingX: '32px@1080p', paddingY: '14px@1080p' },
    subtitlePlate: { fill: 'barBackground', paddingX: '28px@1080p', paddingY: '8px@1080p', minWidth: '160px@1080p' },
    titleBlock: { width: '10px@1080p', gap: '18px@1080p', token: 'accent' },
    titleFillToken: 'text',
    subtitleTextToken: 'secondaryText'
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
