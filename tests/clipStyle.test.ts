import { describe, expect, it } from 'vitest'
import { BUILTIN_FONTS, FONT_SCALE_MAX, FONT_SCALE_MIN, FPS_30 } from '@shared/constants'
import { applyClipStyleToAll, createClip, createDefaultProject, normalizeProject } from '@shared/projectSchema'
import { buildProjectPlan } from '@shared/presetResolver'
import type { FontRecord, Project } from '@shared/types'

/**
 * 片段级样式操作（右侧检查器的两个核心行为）：
 * - 单片段修改只落 `styleOverrides` / `content` / `animation` / `fontId`，不波及别段；
 * - 「应用到全部」复制**除文字与入出点之外**的一切（用户明确要求）。
 */

const FONT_INDEX: FontRecord[] = BUILTIN_FONTS.map((meta) => ({
  ...meta,
  source: 'builtin',
  bytes: 1024,
  sha1: '',
  importedAt: '2026-01-01T00:00:00.000Z'
}))

function projectWithThreeClips(): Project {
  const project = createDefaultProject('批量应用')
  project.resolution = { width: 1920, height: 1080 }
  project.fps = FPS_30
  project.clips = [0, 1, 2].map((index) => {
    const clip = createClip({ startTime: index * 4, fps: FPS_30 })
    clip.content = { title: `第 ${index + 1} 段主标题`, subtitle: `第 ${index + 1} 段副标题` }
    return clip
  })
  return project
}

describe('应用到全部字幕条（保留文字与入出点）', () => {
  it('预设 / 配色 / 字体 / 字号 / 动画被复制，文字与时间轴不动', () => {
    const project = projectWithThreeClips()
    const source = project.clips[0]!
    const second = project.clips[1]!
    const third = project.clips[2]!
    source.presetId = 'breakingRed'
    source.fontId = FONT_INDEX[3]!.fontId
    source.styleOverrides = {
      tokens: { primary: '#123456', accent: '#ffcc00' },
      barOpacity: 0.72,
      fontScale: { title: 1.25, subtitle: 0.9 },
      titleGradient: { enabled: true, from: '#ffffff', to: '#9ec7ff', angleDeg: 45 }
    }
    source.animation = { ...source.animation, inDuration: 0.4, outDuration: 0.24, easing: 'outExpo' }

    const before = project.clips.map((clip) => ({ ...clip.content, start: clip.startTime, end: clip.endTime }))
    const { project: next, count } = applyClipStyleToAll(project, source.id)

    expect(count).toBe(2)
    for (const [index, clip] of next.clips.entries()) {
      // 文字与入出点严格保留
      expect({ ...clip.content, start: clip.startTime, end: clip.endTime }).toEqual(before[index])
      if (index === 0) continue
      expect(clip.presetId).toBe('breakingRed')
      expect(clip.fontId).toBe(source.fontId)
      expect(clip.styleOverrides.tokens).toEqual({ primary: '#123456', accent: '#ffcc00' })
      expect(clip.styleOverrides.barOpacity).toBe(0.72)
      expect(clip.styleOverrides.fontScale).toEqual({ title: 1.25, subtitle: 0.9 })
      expect(clip.styleOverrides.titleGradient?.angleDeg).toBe(45)
      expect(clip.animation.inDuration).toBe(0.4)
      expect(clip.animation.easing).toBe('outExpo')
    }
    expect(second.id).not.toBe(source.id)
    // 纯函数：原工程不被就地改写（未应用到的那份引用保持原样）
    expect(third.presetId).toBe('stackedNews')
    expect(next.clips[2]!.presetId).toBe('breakingRed')
  })

  it('复制是深拷贝：改源片段的令牌不会串到其他片段', () => {
    const project = projectWithThreeClips()
    const source = project.clips[0]!
    source.styleOverrides = { tokens: { primary: '#101010' }, fontScale: { title: 1.4 } }
    const { project: next } = applyClipStyleToAll(project, source.id)

    const applied = next.clips[1]!
    applied.styleOverrides.tokens!.primary = '#aaaaaa'
    applied.styleOverrides.fontScale!.title = 2

    expect(next.clips[0]!.styleOverrides.tokens!.primary).toBe('#101010')
    expect(next.clips[0]!.styleOverrides.fontScale!.title).toBe(1.4)
    expect(next.clips[2]!.styleOverrides.tokens!.primary).toBe('#101010')
  })

  it('只有一个片段时不动工程（count=0，引用不变）', () => {
    const project = projectWithThreeClips()
    project.clips = [project.clips[0]!]
    const result = applyClipStyleToAll(project, project.clips[0]!.id)
    expect(result.count).toBe(0)
    expect(result.project).toBe(project)
  })

  it('源片段 id 不存在时安全返回', () => {
    const project = projectWithThreeClips()
    const result = applyClipStyleToAll(project, 'does-not-exist')
    expect(result.count).toBe(0)
    expect(result.project).toBe(project)
  })
})

describe('字号缩放的归一化', () => {
  const withScale = (fontScale: unknown): Project => {
    const project = projectWithThreeClips()
    const raw = JSON.parse(JSON.stringify(project)) as Record<string, unknown>
    const clips = raw['clips'] as Array<Record<string, unknown>>
    clips[0]!['styleOverrides'] = { fontScale }
    return normalizeProject(raw)!
  }

  it('合法值保留，越界值夹到上下限，接近 1 视为未设置', () => {
    expect(withScale({ title: 1.5 }).clips[0]!.styleOverrides.fontScale).toEqual({ title: 1.5 })
    expect(withScale({ title: 99 }).clips[0]!.styleOverrides.fontScale).toEqual({ title: FONT_SCALE_MAX })
    expect(withScale({ subtitle: 0.1 }).clips[0]!.styleOverrides.fontScale).toEqual({ subtitle: FONT_SCALE_MIN })
    expect(withScale({ title: 1 }).clips[0]!.styleOverrides.fontScale).toBeUndefined()
    expect(withScale({ title: 1.0005 }).clips[0]!.styleOverrides.fontScale).toBeUndefined()
    expect(withScale({ title: 'big' }).clips[0]!.styleOverrides.fontScale).toBeUndefined()
    expect(withScale({ title: 1.02, subtitle: 1.2 }).clips[0]!.styleOverrides.fontScale).toEqual({ title: 1.02, subtitle: 1.2 })
  })
})

describe('字号缩放对解析结果的作用', () => {
  const planFor = (fontScale?: { title?: number; subtitle?: number }) => {
    const project = projectWithThreeClips()
    project.clips = [project.clips[0]!]
    project.clips[0]!.content = { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' }
    if (fontScale) project.clips[0]!.styleOverrides = { fontScale }
    const plan = buildProjectPlan({ project, scope: { kind: 'timeline' }, fontIndex: FONT_INDEX })
    return plan.clips[0]!
  }

  it('115% 后字号等比变大，且副标题不因主标题缩放而变', () => {
    const base = planFor()
    const scaled = planFor({ title: 1.15 })
    expect(scaled.fonts.title.sizePx).toBeCloseTo(base.fonts.title.sizePx * 1.15, 2)
    expect(scaled.fonts.subtitle.sizePx).toBe(base.fonts.subtitle.sizePx)
  })

  it('缩放后仍受可读性硬上限约束，不会无限放大', () => {
    const base = planFor()
    const huge = planFor({ title: FONT_SCALE_MAX })
    // 1080p 标准档：宽度 6.2% / 高度 6.6% 两道硬上限，取小者
    expect(huge.fonts.title.sizePx).toBeLessThanOrEqual(Math.min(1920 * 0.062, 1080 * 0.066) + 1e-6)
    expect(huge.fonts.title.sizePx).toBeGreaterThan(base.fonts.title.sizePx)
  })
})
