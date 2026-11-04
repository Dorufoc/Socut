import type { Preset } from '../types'
import {
  INSET,
  buildSinglePlate,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 地方台暖色：赭红圆角单板 + 暖橙左条 + 端部渐隐饰线。
 * 圆角与暖色让版式更亲和，但结构仍是「一板两层」，不做满宽。
 */

const maxWidth = 'min(1160px@1080p, 63%)' as const
const title: TextTier = { size: 'clamp(42px@1080p, 5.3vh, 76px@1080p)', maxLines: 2, tracking: '1px@1080p' }
const subtitle: TextTier = { size: 'clamp(22px@1080p, 2.6vh, 38px@1080p)', maxLines: 1, tracking: '0.2px@1080p' }

export const localWarm: Preset = {
  id: 'localWarm',
  name: '地方台暖色',
  description: '赭红圆角单板 + 暖橙左条，端部渐隐饰线；民生新闻常用，亲和而不刺眼。',
  tokens: {
    primary: '#B23A18',
    accent: '#F0B44E',
    text: '#FFF8EE',
    secondaryText: '#FFE2B8',
    barBackground: 'rgba(90, 34, 16, 0.92)'
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
  layout: buildSinglePlate({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: '340px@1080p',
    title,
    subtitle,
    innerGap: '5px@1080p',
    plate: { fill: 'primary', paddingX: '32px@1080p', paddingY: '15px@1080p', radius: '6px@1080p' },
    leftBlock: { width: '8px@1080p', gap: '20px@1080p', token: 'accent' },
    rule: {
      placement: 'above',
      width: '38%',
      height: '4px@1080p',
      gap: '9px@1080p',
      token: 'accent',
      opacity: 0.95,
      fadeEnd: 0.5
    }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
