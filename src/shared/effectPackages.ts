/**
 * M7-E：特效包（Effect Packages）——manifest + 参数 schema + FFmpeg 实现（导出侧）。
 *
 * 每个包 = 一组可调参数 + 一条 FFmpeg 滤镜链；参数范围在 schema 里定义，
 * 工程里**只落盘用户改过的参数**（默认值不写），归一化统一走 `normalizeActiveEffects`。
 *
 * 为什么先只做 FFmpeg 实现：预览侧用 CSS 近似（见 `effectPreviewFilter`），
 * 像素级一致靠导出；等 WebGL2 合成器落地后再补 GPU 端，接口形状不用变。
 *
 * 本文件不 import 任何东西（`types.ts` 会反向引用它的类型，避免成环）。
 */

export const EFFECT_PACKAGE_IDS = [
  'vignette',
  'filmGrain',
  'glitch',
  'chromaShift',
  'warmLeak',
  'monochrome'
] as const

export type EffectPackageId = (typeof EFFECT_PACKAGE_IDS)[number]

export interface EffectParamSchema {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  unit?: string
}

export interface EffectPackage {
  id: EffectPackageId
  label: string
  description: string
  params: EffectParamSchema[]
  /** 参数 → FFmpeg 滤镜串（导出侧） */
  build: (params: Record<string, number>) => string[]
}

const p = (key: string, label: string, min: number, max: number, def: number, step = 1, unit = ''): EffectParamSchema => ({
  key,
  label,
  min,
  max,
  step,
  default: def,
  ...(unit ? { unit } : {})
})

function round2(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 强度 0..100 → 0..1 */
function unit(value: number): number {
  return clamp(value, 0, 100) / 100
}

export const EFFECT_PACKAGES: EffectPackage[] = [
  {
    id: 'vignette',
    label: '暗角',
    description: '四角压暗，把注意力收到画面中心',
    params: [p('intensity', '强度', 0, 100, 60, 1, '%')],
    build: (params) => [`vignette=angle=${round2((Math.PI / 2) * (0.12 + 0.68 * unit(params['intensity'] ?? 60)))}`]
  },
  {
    id: 'filmGrain',
    label: '胶片颗粒',
    description: '时间上抖动的细颗粒，压掉数字画面的“塑料感”',
    params: [p('strength', '强度', 0, 100, 18, 1, '%')],
    build: (params) => {
      const strength = Math.round(clamp(params['strength'] ?? 18, 0, 100))
      return strength === 0 ? [] : [`noise=alls=${strength}:allf=t+u`]
    }
  },
  {
    id: 'glitch',
    label: '故障',
    description: '红蓝通道错位，新闻突发/切屏的瞬时故障感',
    params: [p('amount', '幅度', 0, 20, 6, 1, 'px')],
    build: (params) => {
      const amount = Math.round(clamp(params['amount'] ?? 6, 0, 20))
      return amount === 0 ? [] : [`rgbashift=rh=${amount}:bh=${-amount}`]
    }
  },
  {
    id: 'chromaShift',
    label: '色差偏移',
    description: '色度平面横移，模拟镜头色散',
    params: [p('amount', '幅度', 0, 40, 8, 1, 'px')],
    build: (params) => {
      const amount = Math.round(clamp(params['amount'] ?? 8, 0, 40))
      return amount === 0 ? [] : [`chromashift=cbh=${amount}:crh=${-amount}`]
    }
  },
  {
    id: 'warmLeak',
    label: '暖色漏光',
    description: '高光偏暖、阴影偏冷，仿胶片漏光',
    params: [p('strength', '强度', 0, 100, 40, 1, '%')],
    build: (params) => {
      const s = unit(params['strength'] ?? 40)
      if (s <= 0) return []
      return [
        `colorbalance=rs=${round2(0.22 * s)}:gs=${round2(0.06 * s)}:bs=${round2(-0.16 * s)}:rm=${round2(
          0.12 * s
        )}:bm=${round2(-0.1 * s)}:rh=${round2(0.18 * s)}:bh=${round2(-0.14 * s)}`
      ]
    }
  },
  {
    id: 'monochrome',
    label: '黑白',
    description: '去色 + 轻微对比提升，专题片/回忆段常用',
    params: [p('contrast', '对比度', 0, 100, 40, 1, '%')],
    build: (params) => {
      const contrast = clamp(params['contrast'] ?? 40, 0, 100)
      return ['hue=s=0', `eq=contrast=${round2(1 + contrast / 200)}`]
    }
  }
]

export const EFFECT_PACKAGE_MAP: Record<EffectPackageId, EffectPackage> = Object.fromEntries(
  EFFECT_PACKAGES.map((item) => [item.id, item])
) as Record<EffectPackageId, EffectPackage>

export const MAX_ACTIVE_EFFECTS = 8

export interface ActiveEffect {
  id: EffectPackageId
  /** 只存用户改过的参数（缺省 = 用 schema 默认值） */
  params: Record<string, number>
}

function isEffectPackageId(value: unknown): value is EffectPackageId {
  return typeof value === 'string' && (EFFECT_PACKAGE_IDS as readonly string[]).includes(value)
}

/** 某包参数的完整取值（缺省补 schema 默认值并夹到范围）。 */
export function effectParamsOf(effect: ActiveEffect): Record<string, number> {
  const pkg = EFFECT_PACKAGE_MAP[effect.id]
  const out: Record<string, number> = {}
  for (const schema of pkg.params) {
    const raw = effect.params[schema.key]
    out[schema.key] = clamp(typeof raw === 'number' ? raw : schema.default, schema.min, schema.max)
  }
  return out
}

/** 任意 JSON → 合法特效列表；空列表/全非法返回 undefined（调用方整键删除）。 */
export function normalizeActiveEffects(raw: unknown): ActiveEffect[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const byId = new Map<EffectPackageId, ActiveEffect>()
  for (const item of raw.slice(0, MAX_ACTIVE_EFFECTS * 2)) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = record['id']
    if (!isEffectPackageId(id)) continue
    const schema = EFFECT_PACKAGE_MAP[id]
    const rawParams = typeof record['params'] === 'object' && record['params'] !== null ? (record['params'] as Record<string, unknown>) : {}
    const params: Record<string, number> = {}
    for (const param of schema.params) {
      const value = rawParams[param.key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const clamped = clamp(value, param.min, param.max)
      // 默认值不落盘（与工程里其他"默认=不生效"的纪律一致）
      if (Math.abs(clamped - param.default) > 1e-9) params[param.key] = Math.round(clamped * 1000) / 1000
    }
    byId.set(id, { id, params })
    if (byId.size >= MAX_ACTIVE_EFFECTS) break
  }
  return byId.size > 0 ? [...byId.values()] : undefined
}

/** 特效列表 → FFmpeg 滤镜串（顺序 = 列表顺序，后加的压在后）。 */
export function buildEffectFilters(effects: readonly ActiveEffect[] | undefined): string[] {
  if (!effects || effects.length === 0) return []
  const filters: string[] = []
  for (const effect of effects) {
    const pkg = EFFECT_PACKAGE_MAP[effect.id]
    if (!pkg) continue
    filters.push(...pkg.build(effectParamsOf(effect)))
  }
  return filters
}

/** 预览侧近似（CSS filter）：只覆盖能近似的包，其余靠导出。 */
export function effectPreviewFilter(effects: readonly ActiveEffect[] | undefined): string {
  if (!effects || effects.length === 0) return ''
  const parts: string[] = []
  for (const effect of effects) {
    const params = effectParamsOf(effect)
    if (effect.id === 'monochrome') parts.push('grayscale(1)')
    else if (effect.id === 'warmLeak') parts.push(`sepia(${round2(unit(params['strength'] ?? 40) * 0.45)})`)
    else if (effect.id === 'vignette') parts.push(`brightness(${round2(1 - unit(params['intensity'] ?? 60) * 0.06)})`)
  }
  return parts.join(' ')
}