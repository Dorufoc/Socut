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
 * 突发新闻：红色主条 + 上方深红副标题小条，左侧整高黄色徽标块。
 * 副标题条更矮且左缘对齐主条，两块共用同一个宽度上限，形成“红色标题牌 + 暗红信息条”的突发版式。
 */

const maxWidth = BAR_MAX_WIDTH
const minWidth = 'min(440px@1080p, 29%)' as const
const title: TextTier = { size: 'clamp(44px@1080p, 5.6vh, 82px@1080p)', maxLines: 2, tracking: '1.4px@1080p' }
const subtitle: TextTier = { size: 'clamp(23px@1080p, 2.7vh, 40px@1080p)', maxLines: 2, tracking: '0.3px@1080p' }

export const breakingRed: Preset = {
  id: 'breakingRed',
  name: '突发新闻',
  description: '红色主条 + 暗红副标题条 + 整高黄色徽标块；6 帧急入场，力度最强。',
  tokens: {
    primary: '#C4141E',
    accent: '#FFD400',
    text: '#FFFFFF',
    secondaryText: '#FFE9E9',
    barBackground: '#1A0A0C'
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
  layout: buildSubtitleAbove({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth,
    gapY: '6px@1080p',
    title,
    subtitle,
    titlePlate: { fill: 'primary', paddingX: '28px@1080p', paddingY: '14px@1080p' },
    subtitlePlate: { fill: 'barBackground', paddingX: '32px@1080p', paddingY: '9px@1080p', minWidth: '160px@1080p' },
    titleBlock: { width: '14px@1080p', gap: '18px@1080p', token: 'accent' }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
