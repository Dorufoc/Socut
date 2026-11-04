import type { Preset } from '../types'
import {
  INSET,
  buildSinglePlate,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 层叠新闻：深蓝单板 + 左侧加宽强调块 + 顶部横条，副标题收在板内第二层。
 * 用“宽色块 + 顶部条”做出层叠感，而不是把副条贴到主条上沿。
 */

const maxWidth = 'min(1180px@1080p, 64%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.4vh, 78px@1080p)', maxLines: 2, tracking: '0.8px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.6vh, 38px@1080p)', maxLines: 1, tracking: '0.2px@1080p' }

export const stackedNews: Preset = {
  id: 'stackedNews',
  name: '层叠新闻',
  description: '深蓝单板 + 加宽左块与顶部横条，副标题收在第二层；最典型的广播新闻版式。',
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
  layout: buildSinglePlate({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: '360px@1080p',
    title,
    subtitle,
    innerGap: '5px@1080p',
    plate: { fill: 'primary', paddingX: '30px@1080p', paddingY: '14px@1080p' },
    leftBlock: { width: '14px@1080p', gap: '18px@1080p', token: 'accent' },
    rule: {
      placement: 'above',
      width: '18%',
      height: '6px@1080p',
      gap: '8px@1080p',
      token: 'accent',
      opacity: 0.95
    }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
