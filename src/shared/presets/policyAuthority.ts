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
 * 时政权威：藏青主条 + 上方独立金边副标题小条；衬线主标题，庄重克制。
 * 副标题矩形左缘与主条严格对齐，文字与主标题共左线。
 */

const maxWidth = BAR_MAX_WIDTH
const minWidth = 'min(420px@1080p, 28%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.4vh, 78px@1080p)', maxLines: 2, tracking: '1.1px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.6vh, 38px@1080p)', maxLines: 2, tracking: '0.3px@1080p' }

export const policyAuthority: Preset = {
  id: 'policyAuthority',
  name: '时政权威',
  description: '藏青主条 + 上方金边副标题条；衬线主标题，适合发布、通报类信息。',
  tokens: {
    primary: '#12345E',
    accent: '#D4AF37',
    text: '#FFFFFF',
    secondaryText: '#E6EDF7',
    barBackground: '#0A1B2E'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notoserifsc-700' },
    subtitle: { builtinKey: 'auto', weight: 500, fallbackBuiltinKey: 'builtin-notosanssc-500' }
  },
  animation: {
    inDuration: 0.3,
    outDuration: 0.18,
    easing: 'outQuart',
    textRevealFrames: 3,
    displacement: { x: '-36px@1080p', y: '0' },
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
    titlePlate: { fill: 'primary', paddingX: '34px@1080p', paddingY: '15px@1080p', radius: '2px@1080p' },
    subtitlePlate: { fill: 'barBackground', paddingX: '26px@1080p', paddingY: '9px@1080p', radius: '2px@1080p', minWidth: '140px@1080p' },
    titleBlock: { width: '6px@1080p', gap: '20px@1080p', token: 'accent' }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
