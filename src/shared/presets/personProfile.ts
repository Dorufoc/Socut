import type { Preset } from '../types'
import {
  INSET,
  buildSinglePlate,
  makeCompactPatches,
  makeUltrawidePatches,
  type TextTier
} from './layout'

/**
 * 人物条：姓名在上、职务在下，放在同一块窄名牌里；左侧细蓝条 + 底部细线。
 * 不再让职务条压到姓名上方，也不会出现「3 个字占满 1722px 宽条」的空旷。
 */

const maxWidth = 'min(980px@1080p, 55%)' as const
const title: TextTier = { size: 'clamp(48px@1080p, 6.2vh, 88px@1080p)', maxLines: 1, tracking: '1.6px@1080p' }
const subtitle: TextTier = { size: 'clamp(21px@1080p, 2.5vh, 36px@1080p)', maxLines: 2, tracking: '0.2px@1080p' }

export const personProfile: Preset = {
  id: 'personProfile',
  name: '人物条',
  description: '姓名在上、职务在下，窄名牌 + 细蓝条；适合访谈与出镜人物，名字不再被空板淹没。',
  tokens: {
    primary: '#172B45',
    accent: '#6FA8DC',
    text: '#FFFFFF',
    secondaryText: '#D8E6F5',
    barBackground: 'rgba(28, 50, 78, 0.86)'
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
  layout: buildSinglePlate({
    leftInset: INSET.side,
    bottomInset: INSET.bottom,
    maxWidth,
    minWidth: '360px@1080p',
    title,
    subtitle,
    innerGap: '6px@1080p',
    plate: { fill: 'primary', paddingX: '34px@1080p', paddingY: '18px@1080p', radius: '2px@1080p' },
    leftBlock: { width: '5px@1080p', gap: '22px@1080p', token: 'accent' },
    rule: {
      placement: 'below',
      width: '28%',
      height: '3px@1080p',
      gap: '8px@1080p',
      token: 'accent',
      opacity: 0.65,
      fadeEnd: 0.5
    }
  }),
  patches: {
    compact: makeCompactPatches({ title, subtitle }),
    ultrawide: makeUltrawidePatches({ maxWidth })
  }
}
