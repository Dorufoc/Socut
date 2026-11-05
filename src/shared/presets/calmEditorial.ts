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
 * 冷静版：中性灰主条 + 上方更深的副标题小条，极细左竖线。
 * 副标题条左缘与主条对齐，文字与主标题共左线；长段落副标题允许两行。
 */

const maxWidth = BAR_MAX_WIDTH
const minWidth = 'min(420px@1080p, 28%)' as const
const title: TextTier = { size: 'clamp(40px@1080p, 5.2vh, 74px@1080p)', maxLines: 2, tracking: '0.5px@1080p' }
const subtitle: TextTier = { size: 'clamp(21px@1080p, 2.5vh, 36px@1080p)', maxLines: 2, tracking: '0.2px@1080p' }

export const calmEditorial: Preset = {
  id: 'calmEditorial',
  name: '冷静版',
  description: '中性灰主条 + 深灰副标题小条，几乎没有装饰；长段落信息最稳的读法。',
  tokens: {
    primary: '#2A2E35',
    accent: '#8FA3B8',
    text: '#F5F7FA',
    secondaryText: '#CBD5E1',
    barBackground: '#171B21'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 500, fallbackBuiltinKey: 'builtin-notosanssc-500' },
    subtitle: { builtinKey: 'auto', weight: 400, fallbackBuiltinKey: 'builtin-notosanssc-400' }
  },
  animation: {
    inDuration: 0.3,
    outDuration: 0.19,
    easing: 'outQuint',
    textRevealFrames: 3,
    displacement: { x: '0', y: '14px@1080p' },
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
    titlePlate: { fill: 'primary', paddingX: '30px@1080p', paddingY: '14px@1080p', radius: '2px@1080p' },
    subtitlePlate: { fill: 'barBackground', paddingX: '20px@1080p', paddingY: '9px@1080p', radius: '2px@1080p', minWidth: '130px@1080p' },
    titleBlock: { width: '4px@1080p', gap: '16px@1080p', token: 'accent' }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
