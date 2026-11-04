import type { Preset, PresetId } from '../types'
import { validatePreset, type ValidationIssue } from '../presetSchema'
import { policyAuthority } from './policyAuthority'
import { stackedNews } from './stackedNews'
import { calmEditorial } from './calmEditorial'
import { financeData } from './financeData'
import { globalSimple } from './globalSimple'
import { localWarm } from './localWarm'
import { breakingRed } from './breakingRed'
import { personProfile } from './personProfile'

/** MVP 的 8 套广播级预设（规格 §3.1 / §7）。顺序即 UI 展示顺序。 */
export const PRESETS: Preset[] = [
  policyAuthority,
  stackedNews,
  calmEditorial,
  financeData,
  globalSimple,
  localWarm,
  breakingRed,
  personProfile
]

export const PRESET_MAP: Record<PresetId, Preset> = PRESETS.reduce(
  (acc, preset) => {
    acc[preset.id] = preset
    return acc
  },
  {} as Record<PresetId, Preset>
)

export const PRESET_IDS: PresetId[] = PRESETS.map((p) => p.id)

export function getPreset(id: PresetId): Preset {
  const preset = PRESET_MAP[id]
  if (!preset) throw new Error(`未知预设: ${id}`)
  return preset
}

/** 新建片段的默认预设。 */
export const DEFAULT_PRESET_ID: PresetId = 'stackedNews'

/** 全量校验（测试与启动自检使用）。 */
export function validateAllPresets(): ValidationIssue[] {
  return PRESETS.flatMap((preset) => validatePreset(preset))
}

export { policyAuthority, stackedNews, calmEditorial, financeData, globalSimple, localWarm, breakingRed, personProfile }
