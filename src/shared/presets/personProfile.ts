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
 * 人物条：姓名主条（大字）+ 上方职务小条；副标题条左缘与姓名条对齐。
 * 职务不再压到姓名上方，姓名也不会被一条满宽空板淹没。
 */

const maxWidth = BAR_MAX_WIDTH
const minWidth = 'min(440px@1080p, 29%)' as const
const title: TextTier = { size: 'clamp(48px@1080p, 6.2vh, 88px@1080p)', maxLines: 1, tracking: '1.6px@1080p' }
const subtitle: TextTier = { size: 'clamp(20px@1080p, 2.4vh, 36px@1080p)', maxLines: 2, tracking: '0.2px@1080p' }

export const personProfile: Preset = {
  id: 'personProfile',
  name: '人物条',
  description: '姓名字号最大、上方独立职务小条；适合访谈与出镜人物，层级清楚。',
  tokens: {
    primary: '#172B45',
    accent: '#6FA8DC',
    text: '#FFFFFF',
    secondaryText: '#D8E6F5',
    barBackground: '#101F31'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notosanssc-700' },
    subtitle: { builtinKey: 'auto', weight: 400, fallbackBuiltinKey: 'builtin-notosanssc-400' }
  },
  animation: {
    inDuration: 0.36,
    outDuration: 0.22,
    easing: 'smootherstep',
    textRevealFrames: 3,
    displacement: { x: '-18px@1080p', y: '8px@1080p' },
    ruleLeadInFrames: 4
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
    titlePlate: { fill: 'primary', paddingX: '34px@1080p', paddingY: '18px@1080p', radius: '2px@1080p' },
    subtitlePlate: { fill: 'barBackground', paddingX: '27px@1080p', paddingY: '8px@1080p', radius: '2px@1080p', minWidth: '150px@1080p' },
    titleBlock: { width: '5px@1080p', gap: '22px@1080p', token: 'accent' }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
