import type { Preset } from '../types'
import {
  INSET,
  buildSinglePlate,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 时政权威：深藏青单板 + 顶部金线 + 左侧金条，衬线主标题。
 * 版式收得窄而稳，强调“发布/通报”的庄重感，不做横向铺满。
 */

const maxWidth = 'min(1180px@1080p, 64%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.4vh, 78px@1080p)', maxLines: 2, tracking: '1.1px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.6vh, 38px@1080p)', maxLines: 1, tracking: '0.3px@1080p' }

export const policyAuthority: Preset = {
  id: 'policyAuthority',
  name: '时政权威',
  description: '深藏青单板、金饰细线与衬线主标题；窄而稳，适合发布、通报类信息。',
  tokens: {
    primary: '#12345E',
    accent: '#D4AF37',
    text: '#FFFFFF',
    secondaryText: '#E6EDF7',
    barBackground: 'rgba(8, 24, 44, 0.9)'
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
  layout: buildSinglePlate({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: '340px@1080p',
    title,
    subtitle,
    innerGap: '5px@1080p',
    plate: { fill: 'primary', paddingX: '34px@1080p', paddingY: '15px@1080p', radius: '2px@1080p' },
    leftBlock: { width: '6px@1080p', gap: '20px@1080p', token: 'accent' },
    rule: {
      placement: 'above',
      width: '26%',
      height: '4px@1080p',
      gap: '10px@1080p',
      token: 'accent',
      opacity: 0.95,
      fadeEnd: 0.4
    }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
