import type { Preset } from '../types'
import {
  INSET,
  buildSideBySidePlate,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 财经数据：暗板 + 琥珀左条；标题与读数在**同一行**（左侧指数名、右侧数值），
 * 副标题固定等宽数字字体，读数是这一版式的主角。
 */

const maxWidth = 'min(1120px@1080p, 62%)' as const
const title: TextTier = { size: 'clamp(38px@1080p, 5vh, 74px@1080p)', maxLines: 1, tracking: '0.6px@1080p' }
const subtitle: TextTier = { size: 'clamp(24px@1080p, 2.7vh, 40px@1080p)', maxLines: 1, tracking: '0.4px@1080p' }

export const financeData: Preset = {
  id: 'financeData',
  name: '财经数据',
  description: '左侧指数名、右侧指标读数同排；琥珀左条 + 等宽数字，适合行情与指标播报。',
  tokens: {
    primary: '#0F223C',
    accent: '#F0A33A',
    text: '#FFFFFF',
    secondaryText: '#FFC978',
    barBackground: 'rgba(11, 26, 46, 0.92)'
  },
  fonts: {
    title: { builtinKey: 'auto', weight: 700, fallbackBuiltinKey: 'builtin-notosanssc-700' },
    // 读数固定等宽字体（数字对齐），不被片段字体覆盖
    subtitle: { builtinKey: 'builtin-jetbrainsmono-700', weight: 700, fallbackBuiltinKey: 'builtin-jetbrainsmono-700' }
  },
  animation: {
    inDuration: 0.27,
    outDuration: 0.16,
    easing: 'outQuart',
    textRevealFrames: 2,
    displacement: { x: '-26px@1080p', y: '0' },
    ruleLeadInFrames: 2
  },
  safeArea: 'title',
  layout: buildSideBySidePlate({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: 'min(460px@1080p, 30%)',
    title,
    subtitle,
    fieldGap: '28px@1080p',
    plate: { fill: 'primary', paddingX: '32px@1080p', paddingY: '14px@1080p' },
    leftBlock: { width: '10px@1080p', gap: '18px@1080p', token: 'accent' },
    rule: {
      placement: 'below',
      width: '30%',
      height: '3px@1080p',
      gap: '8px@1080p',
      token: 'accent',
      opacity: 0.7,
      fadeEnd: 0.5
    }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
