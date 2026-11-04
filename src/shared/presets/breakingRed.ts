import type { Preset } from '../types'
import {
  INSET,
  buildBadgePlate,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 突发新闻：红色徽标板——左侧整高黄色块承担“突发”识别，右侧标题副标题。
 * 徽标块比细竖条更有冲击力，但不用满宽红条压住整幅画面。
 */

const maxWidth = 'min(1220px@1080p, 66%)' as const
const title: TextTier = { size: 'clamp(44px@1080p, 5.6vh, 82px@1080p)', maxLines: 2, tracking: '1.4px@1080p' }
const subtitle: TextTier = { size: 'clamp(23px@1080p, 2.7vh, 40px@1080p)', maxLines: 1, tracking: '0.3px@1080p' }

export const breakingRed: Preset = {
  id: 'breakingRed',
  name: '突发新闻',
  description: '整高黄色徽标块 + 红色单板，6 帧急入场；力度最强但不铺满画面。',
  tokens: {
    primary: '#C4141E',
    accent: '#FFD400',
    text: '#FFFFFF',
    secondaryText: '#FFE9E9',
    barBackground: 'rgba(100, 10, 14, 0.94)'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 900, fallbackBuiltinKey: 'builtin-notosanssc-900' },
    subtitle: { builtinKey: 'auto', weight: 500, fallbackBuiltinKey: 'builtin-notosanssc-500' }
  },
  animation: {
    inDuration: 0.2,
    outDuration: 0.12,
    easing: 'outExpo',
    textRevealFrames: 2,
    displacement: { x: '-44px@1080p', y: '0' },
    ruleLeadInFrames: 1
  },
  safeArea: 'title',
  layout: buildBadgePlate({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: 'min(500px@1080p, 34%)',
    title,
    subtitle,
    innerGap: '5px@1080p',
    plate: { fill: 'primary', paddingX: '28px@1080p', paddingY: '14px@1080p' },
    badge: { width: '104px@1080p', token: 'accent' }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
