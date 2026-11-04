import type { Preset } from '../types'
import {
  INSET,
  buildSinglePlate,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 国际简洁：浅色单板 + 红色顶部短饰线 + 左侧红色细条。
 * 深色字在浅板上对比最高；左条与顶部饰线让白底画面也能看出边界。
 */

const maxWidth = 'min(1180px@1080p, 64%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.4vh, 78px@1080p)', maxLines: 2, tracking: '0.3px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.6vh, 38px@1080p)', maxLines: 1, tracking: '0.2px@1080p' }

export const globalSimple: Preset = {
  id: 'globalSimple',
  name: '国际简洁',
  description: '浅色单板 + 红色短饰线，深色字对比最高，跨平台最中性的一套。',
  tokens: {
    primary: '#F2F4F6',
    accent: '#C81E28',
    text: '#101418',
    secondaryText: '#3B4450',
    barBackground: 'rgba(220, 226, 232, 0.96)'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notosanssc-700' },
    subtitle: { builtinKey: 'auto', weight: 400, fallbackBuiltinKey: 'builtin-notosanssc-400' }
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
  layout: buildSinglePlate({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: '340px@1080p',
    title,
    subtitle,
    innerGap: '5px@1080p',
    plate: { fill: 'primary', paddingX: '32px@1080p', paddingY: '16px@1080p', radius: '2px@1080p' },
    leftBlock: { width: '5px@1080p', gap: '22px@1080p', token: 'accent' },
    rule: {
      placement: 'above',
      width: '30%',
      height: '5px@1080p',
      gap: '9px@1080p',
      token: 'accent',
      opacity: 0.95,
      fadeEnd: 0.35
    }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
