import type { Preset } from '../types'
import {
  INSET,
  buildScrimLines,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 冷静版：半透明轻底 + 极细竖线，几乎不遮画面；标题在上、副标题在下。
 * 适合纪录片与深度报道，亮画面上靠 62% 的深色轻底保证可读性。
 */

const maxWidth = 'min(1100px@1080p, 60%)' as const
const title: TextTier = { size: 'clamp(40px@1080p, 5.2vh, 74px@1080p)', maxLines: 2, tracking: '0.5px@1080p' }
const subtitle: TextTier = { size: 'clamp(21px@1080p, 2.5vh, 36px@1080p)', maxLines: 2, tracking: '0.2px@1080p' }

export const calmEditorial: Preset = {
  id: 'calmEditorial',
  name: '冷静版',
  description: '半透明轻底 + 细竖线，几乎不遮画面；长段落信息最稳的读法。',
  tokens: {
    primary: '#2A2E35',
    accent: '#8FA3B8',
    text: '#F5F7FA',
    secondaryText: '#CBD5E1',
    barBackground: 'rgba(14, 18, 24, 0.78)'
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
  layout: buildScrimLines({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: '320px@1080p',
    title,
    subtitle,
    innerGap: '6px@1080p',
    plate: { fill: 'barBackground', opacity: 0.62, paddingX: '28px@1080p', paddingY: '13px@1080p', radius: '2px@1080p' },
    accent: { width: '3px@1080p', gap: '16px@1080p', token: 'accent', opacity: 0.9 },
    rule: {
      placement: 'below',
      width: '34%',
      height: '2px@1080p',
      gap: '8px@1080p',
      token: 'accent',
      opacity: 0.55,
      fadeEnd: 0.6
    }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
