import type { Preset } from '../types'
import {
  INSET,
  buildSubtitleAbove,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 层叠新闻：深蓝主条 + 上方浅一档的副标题小条，左侧加宽强调块。
 * 两块矩形左缘对齐，副标题条更矮更窄，形成清晰的“标题牌 + 信息条”双台阶。
 */

const maxWidth = 'min(1180px@1080p, 64%)' as const
const minWidth = 'min(440px@1080p, 29%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.4vh, 78px@1080p)', maxLines: 2, tracking: '0.8px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.2vh, 34px@1080p)', maxLines: 2, tracking: '0.2px@1080p' }

export const stackedNews: Preset = {
  id: 'stackedNews',
  name: '层叠新闻',
  description: '深蓝主条 + 上方浅蓝副标题条 + 加宽左块；最典型的广播新闻双台阶版式。',
  tokens: {
    primary: '#0E2E52',
    accent: '#2F7BD1',
    text: '#FFFFFF',
    secondaryText: '#D7E6F8',
    barBackground: '#164A80'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notosanssc-700' },
    subtitle: { builtinKey: 'auto', weight: 400, fallbackBuiltinKey: 'builtin-notosanssc-400' }
  },
  animation: {
    inDuration: 0.27,
    outDuration: 0.17,
    easing: 'outCubic',
    textRevealFrames: 3,
    displacement: { x: '-30px@1080p', y: '0' },
    ruleLeadInFrames: 3
  },
  safeArea: 'title',
  layout: buildSubtitleAbove({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth,
    subMaxWidth: minWidth,
    gapY: '6px@1080p',
    title,
    subtitle,
    titlePlate: { fill: 'primary', paddingX: '30px@1080p', paddingY: '14px@1080p' },
    subtitlePlate: { fill: 'barBackground', paddingX: '32px@1080p', paddingY: '8px@1080p', minWidth: '150px@1080p' },
    titleBlock: { width: '14px@1080p', gap: '18px@1080p', token: 'accent' }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
