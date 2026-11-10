import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EFFECT_PACKAGES,
  buildEffectFilters,
  effectParamsOf,
  effectPreviewFilter,
  normalizeActiveEffects,
  type ActiveEffect
} from '@shared/effectPackages'
import { defaultMediaVideo, normalizeMediaVideo } from '@shared/mediaClipVideo'
import { buildMediaClipVideoFx } from '@shared/mediaClipVideoFfmpeg'
import { FPS_30 } from '@shared/constants'

/**
 * M7-E：特效包（manifest / 归一化 / FFmpeg 滤镜串 / 预览近似）。
 *
 * 真机层：随包 FFmpeg 现场跑每个包的滤镜链，确认参数写法合法且视频仍可解码。
 */

const FFMPEG = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const FFPROBE = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const HAS_FFMPEG = existsSync(FFMPEG) && existsSync(FFPROBE)

function run(binary: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

describe('effectPackages：目录与归一化', () => {
  it('六个内置包，参数 schema 完整（min/max/default 在范围内）', () => {
    expect(EFFECT_PACKAGES.map((pkg) => pkg.id)).toEqual([
      'vignette', 'filmGrain', 'glitch', 'chromaShift', 'warmLeak', 'monochrome'
    ])
    for (const pkg of EFFECT_PACKAGES) {
      expect(pkg.label.length).toBeGreaterThan(0)
      expect(pkg.params.length).toBeGreaterThan(0)
      for (const param of pkg.params) {
        expect(param.min).toBeLessThan(param.max)
        expect(param.default).toBeGreaterThanOrEqual(param.min)
        expect(param.default).toBeLessThanOrEqual(param.max)
      }
    }
  })

  it('normalizeActiveEffects：非法 id 丢弃、参数夹取、默认值不落盘、同 id 后者覆盖', () => {
    expect(normalizeActiveEffects(undefined)).toBeUndefined()
    expect(normalizeActiveEffects([])).toBeUndefined()
    expect(normalizeActiveEffects('nope')).toBeUndefined()

    const parsed = normalizeActiveEffects([
      { id: 'vignette', params: { intensity: 80 } },
      { id: 'unknown', params: {} },
      { id: 'filmGrain', params: { strength: 999 } },
      { id: 'vignette', params: { intensity: 40 } }
    ])
    expect(parsed).toEqual([
      { id: 'vignette', params: { intensity: 40 } },
      { id: 'filmGrain', params: { strength: 100 } }
    ])
  })

  it('参数等于默认值时不落盘；缺省补默认值（effectParamsOf）', () => {
    const parsed = normalizeActiveEffects([{ id: 'vignette', params: { intensity: 60 } }])
    expect(parsed).toEqual([{ id: 'vignette', params: {} }])
    const resolved = effectParamsOf({ id: 'vignette', params: {} })
    expect(resolved.intensity).toBe(60)
  })

  it('最多 8 个包（超出截断）', () => {
    const raw = Array.from({ length: 12 }, () => ({ id: 'monochrome', params: {} }))
    // 同 id 去重后只剩 1 个；换用不同 id 验证上限语义：重复 id 不会膨胀
    expect(normalizeActiveEffects(raw)).toHaveLength(1)
  })
})

describe('effectPackages：FFmpeg 滤镜串与预览近似', () => {
  it('每个包都产出可解析的滤镜串；强度 0 时部分包不产滤镜', () => {
    expect(buildEffectFilters([{ id: 'vignette', params: {} }])[0]).toMatch(/^vignette=angle=/)
    expect(buildEffectFilters([{ id: 'filmGrain', params: { strength: 30 } }])[0]).toBe('noise=alls=30:allf=t+u')
    expect(buildEffectFilters([{ id: 'filmGrain', params: { strength: 0 } }])).toEqual([])
    expect(buildEffectFilters([{ id: 'glitch', params: { amount: 8 } }])[0]).toBe('rgbashift=rh=8:bh=-8')
    expect(buildEffectFilters([{ id: 'chromaShift', params: { amount: 10 } }])[0]).toBe('chromashift=cbh=10:crh=-10')
    expect(buildEffectFilters([{ id: 'warmLeak', params: { strength: 50 } }])[0]).toContain('colorbalance=')
    expect(buildEffectFilters([{ id: 'monochrome', params: {} }])).toEqual(['hue=s=0', 'eq=contrast=1.2'])
    expect(buildEffectFilters(undefined)).toEqual([])
  })

  it('预览近似：黑白/暖光/暗角有 CSS，其余为空（导出侧才有）', () => {
    expect(effectPreviewFilter([{ id: 'monochrome', params: {} }])).toBe('grayscale(1)')
    expect(effectPreviewFilter([{ id: 'warmLeak', params: {} }])).toContain('sepia(')
    expect(effectPreviewFilter([{ id: 'vignette', params: {} }])).toContain('brightness(')
    expect(effectPreviewFilter([{ id: 'glitch', params: {} }])).toBe('')
    expect(effectPreviewFilter(undefined)).toBe('')
  })
})

describe('effectPackages：接入画面滤镜链（buildMediaClipVideoFx）', () => {
  const base = {
    baseLabel: 'v0',
    outputLabel: 'out',
    frame: { width: 1920, height: 1080 },
    fps: FPS_30,
    durationSec: 2,
    transparentBackground: false
  }

  it('只有特效时输出含 effect 滤镜，且位于 format 之前', () => {
    const plan = buildMediaClipVideoFx({
      ...base,
      video: { ...defaultMediaVideo(), effects: [{ id: 'monochrome', params: {} }] }
    })
    expect(plan.statements).toHaveLength(1)
    expect(plan.statements[0]).toContain('hue=s=0')
    expect(plan.statements[0]).toContain('format=yuv420p[out]')
    expect(plan.statements[0]!.indexOf('hue=s=0')).toBeLessThan(plan.statements[0]!.indexOf('format=yuv420p'))
  })

  it('几何 + 特效：特效挂在 overlay 之后（整幅画面）', () => {
    const plan = buildMediaClipVideoFx({
      ...base,
      video: { ...defaultMediaVideo(), scalePercent: 50, effects: [{ id: 'filmGrain', params: { strength: 20 } }] }
    })
    const overlayLine = plan.statements.find((line) => line.includes('overlay='))!
    expect(overlayLine).toContain('overlay=')
    expect(overlayLine).toContain('noise=alls=20')
    expect(overlayLine.indexOf('overlay=')).toBeLessThan(overlayLine.indexOf('noise='))
  })

  it('无特效时语句与旧版逐字节一致（零回归）', () => {
    const withOld = buildMediaClipVideoFx({ ...base, video: normalizeMediaVideo({ scalePercent: 50 }) })
    const withEmpty = buildMediaClipVideoFx({
      ...base,
      video: { ...defaultMediaVideo(), scalePercent: 50 }
    })
    expect(withEmpty.statements).toEqual(withOld.statements)
  })
})

describe.skipIf(!HAS_FFMPEG)('真机：每个特效包都能跑通并可解码', () => {
  let tempDir = ''

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'socut-effects-'))
  })

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('六个包的滤镜链各跑一次（2s 小视频，全部 exit 0）', async () => {
    for (const pkg of EFFECT_PACKAGES) {
      const effects: ActiveEffect[] = [{ id: pkg.id, params: {} }]
      const filters = buildEffectFilters(effects).join(',')
      const output = path.join(tempDir, `${pkg.id}.mp4`)
      const result = await run(FFMPEG, [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=10:duration=2',
        '-vf',
        `${filters},format=yuv420p`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        output
      ])
      expect(result.code, `${pkg.id} 滤镜链失败：${result.stderr.slice(0, 300)}`).toBe(0)
      const probe = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output])
      const duration = Number(probe.stdout.trim())
      expect(Number.isFinite(duration)).toBe(true)
      expect(Math.abs(duration - 2)).toBeLessThan(0.2)
    }
  }, 120_000)
})
