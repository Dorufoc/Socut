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
 * 地方台暖色：砖红圆角主条 + 上方深暖色副标题小条；圆角更亲和，但两块的左缘严格对齐。
 */

const maxWidth = BAR_MAX_WIDTH
const minWidth = 'min(380px@1080p, 26%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.3vh, 76px@1080p)', maxLines: 2, tracking: '1px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.2vh, 34px@1080p)', maxLines: 2, tracking: '0.2px@1080p' }

export const localWarm: Preset = {
  id: 'localWarm',
  name: '地方台暖色',
  description: '砖红圆角主条 + 深暖色副标题小条；民生新闻常用，亲和而不刺眼。',
  tokens: {
    primary: '#B23A18',
    accent: '#F0B44E',
    text: '#FFF8EE',
    secondaryText: '#FFE2B8',
    barBackground: '#7A2C12'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notosanssc-700' },
    subtitle: { builtinKey: 'auto', weight: 400, fallbackBuiltinKey: 'builtin-notosanssc-400' }
  },
  animation: {
    inDuration: 0.3,
    outDuration: 0.18,
    easing: 'outQuart',
    textRevealFrames: 3,
    displacement: { x: '-32px@1080p', y: '0' },
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
    titlePlate: { fill: 'primary', paddingX: '32px@1080p', paddingY: '15px@1080p', radius: '6px@1080p' },
    subtitlePlate: { fill: 'barBackground', paddingX: '28px@1080p', paddingY: '8px@1080p', radius: '4px@1080p', minWidth: '150px@1080p' },
    titleBlock: { width: '8px@1080p', gap: '20px@1080p', token: 'accent' }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
