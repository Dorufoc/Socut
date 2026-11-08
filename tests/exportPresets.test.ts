import { describe, expect, it } from 'vitest'
import { exportQualityCrf, isPortraitOrSquare, resolveExportCanvas } from '@shared/exportPresets'
import { EXPORT_CANVAS_SIZES } from '@shared/constants'
import { classifyAspect } from '@shared/aspect'
import type { ExportCanvasSelection, ExportFit, ExportResolutionTier } from '@shared/types'

/**
 * 交付画布预设（v10）：尺寸 / fit 缺省 / 字幕条分支 / 文件名后缀的唯一口径。
 * 横屏跟随首个底层素材（无媒体时跟随工程），竖屏与方图按档位取固定尺寸。
 */

const projectResolution = { width: 1920, height: 1080 }
const primaryMeta = { width: 1600, height: 900 }

const resolve = (selection: ExportCanvasSelection, meta: { width: number; height: number } | null = primaryMeta) =>
  resolveExportCanvas({ selection, primaryMeta: meta, projectResolution })

describe('resolveExportCanvas', () => {
  it('横屏跟首个底层素材；fit 缺省 contain；16:9 走 standard 分支', () => {
    const canvas = resolve({ kind: 'landscape' })
    expect(canvas).toMatchObject({
      kind: 'landscape',
      width: 1600,
      height: 900,
      fit: 'contain',
      mode: 'standard',
      suffix: '16x9',
      label: '横屏 16:9'
    })
  })

  it('横屏无媒体时跟随工程分辨率', () => {
    const canvas = resolve({ kind: 'landscape' }, null)
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
  })

  it('横屏素材本身就竖屏：分支随素材宽高比走 compact', () => {
    const canvas = resolve({ kind: 'landscape' }, { width: 1080, height: 1920 })
    expect(canvas.mode).toBe('compact')
    expect(canvas.width).toBe(1080)
    expect(canvas.height).toBe(1920)
  })

  it('横屏可显式 cover', () => {
    expect(resolve({ kind: 'landscape', fit: 'cover' }).fit).toBe('cover')
  })

  it('竖屏/方图：两档固定尺寸、fit 缺省 cover、后缀与中文标签正确', () => {
    const portrait1080 = resolve({ kind: 'portrait' })
    expect(portrait1080).toMatchObject({
      ...EXPORT_CANVAS_SIZES.portrait['1080'],
      fit: 'cover',
      mode: 'compact',
      suffix: '9x16',
      label: '竖屏 9:16'
    })
    const portrait720 = resolve({ kind: 'portrait', tier: '720' })
    expect(portrait720).toMatchObject({ width: 720, height: 1280 })
    const square1080 = resolve({ kind: 'square' })
    expect(square1080).toMatchObject({
      ...EXPORT_CANVAS_SIZES.square['1080'],
      fit: 'cover',
      suffix: '1x1',
      label: '方形 1:1'
    })
    const square720 = resolve({ kind: 'square', tier: '720' })
    expect(square720).toMatchObject({ width: 720, height: 720 })
  })

  it('种 × 档 × fit 的笛卡尔组合：尺寸与 fit 都被原样保留', () => {
    const kinds = ['landscape', 'portrait', 'square'] as const
    const tiers: (ExportResolutionTier | undefined)[] = ['1080', '720']
    const fits: ExportFit[] = ['cover', 'contain']
    for (const kind of kinds) {
      for (const tier of tiers) {
        for (const fit of fits) {
          const canvas = resolve({ kind, tier, fit })
          expect(canvas.kind).toBe(kind)
          expect(canvas.fit).toBe(fit)
          if (kind === 'landscape') {
            expect({ width: canvas.width, height: canvas.height }).toEqual(primaryMeta)
          } else {
            expect({ width: canvas.width, height: canvas.height }).toEqual(
              EXPORT_CANVAS_SIZES[kind][tier ?? '1080']
            )
          }
        }
      }
    }
  })

  it('分支口径恒等于 classifyAspect(宽高比)：1:1 落在紧凑阈值内，与 9:16 同支', () => {
    // 常量口径：COMPACT_RATIO_MAX = 1.2，因此 1:1（比值 1）低于阈值 → compact
    expect(resolve({ kind: 'square' }).mode).toBe(classifyAspect(1))
    expect(resolve({ kind: 'portrait' }).mode).toBe(classifyAspect(1080 / 1920))
    expect(resolve({ kind: 'portrait' }).mode).toBe('compact')
    expect(resolve({ kind: 'square' }).mode).not.toBe('ultrawide')
  })
})

describe('exportQualityCrf', () => {
  it('缺省 high = 18（与现有默认逐字节一致）', () => {
    expect(exportQualityCrf(undefined)).toBe(18)
    expect(exportQualityCrf('high')).toBe(18)
  })

  it('standard = 23；small = 28', () => {
    expect(exportQualityCrf('standard')).toBe(23)
    expect(exportQualityCrf('small')).toBe(28)
  })
})

describe('isPortraitOrSquare', () => {
  it('竖屏/方图为 true，横屏为 false', () => {
    expect(isPortraitOrSquare('portrait')).toBe(true)
    expect(isPortraitOrSquare('square')).toBe(true)
    expect(isPortraitOrSquare('landscape')).toBe(false)
  })
})
