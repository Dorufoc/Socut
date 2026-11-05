import { describe, expect, it } from 'vitest'
import {
  clipFrames,
  createClip,
  createDefaultProject,
  duplicateClip,
  normalizeProject,
  validateClips
} from '@shared/projectSchema'
import { projectDurationSec, projectSpanSec } from '@shared/presetResolver'
import { MIN_CLIP_DURATION_SEC, PROJECT_VERSION, DEFAULT_FONT_ID, AUTOSAVE_FILE, DEFAULT_ANIMATION_IN_SEC, DEFAULT_ANIMATION_OUT_SEC } from '@shared/constants'
import { durationSecToFrames, framesToDurationSec, snapTimeToFrame, timeToFrameAtOrAfter } from '@shared/fps'
import { DEFAULT_PRESET_ID } from '@shared/presets'
import { PRESETS } from '@shared/presets'
import type { Project, SubtitleClip } from '@shared/types'

/** 工程 JSON 归一化与自动保存前的合法性（规格 §4.6 / §8）。 */

const FPS = { num: 30, den: 1 }

describe('normalizeProject', () => {
  it('往返保真：序列化后再解析结果一致', () => {
    const project = createDefaultProject('往返')
    const clip = createClip({ startTime: 1.234, fps: FPS })
    project.clips.push(clip)
    const parsed = normalizeProject(JSON.parse(JSON.stringify(project)))
    expect(parsed).not.toBeNull()
    expect(parsed?.clips[0]?.startTime).toBe(clip.startTime)
    expect(parsed?.clips[0]?.endTime).toBe(clip.endTime)
    expect(parsed?.version).toBe(PROJECT_VERSION)
  })

  it('缺字段/坏字段自动补齐而不抛错', () => {
    const parsed = normalizeProject({ nonsense: true })
    expect(parsed).not.toBeNull()
    expect(parsed?.clips).toEqual([])
    expect(parsed?.fps).toEqual({ num: 30, den: 1 })
    expect(parsed?.resolution).toEqual({ width: 1920, height: 1080 })
    expect(parsed?.name).toBe('未命名工程')
  })

  it('非对象输入返回 null', () => {
    expect(normalizeProject(null)).toBeNull()
    expect(normalizeProject('x')).toBeNull()
    expect(normalizeProject([])).toBeNull()
  })

  it('入出点重新吸附帧边界并保证最小时长', () => {
    const parsed = normalizeProject({
      version: 1,
      resolution: { width: 1920, height: 1080 },
      fps: FPS,
      clips: [
        { id: 'a', startTime: 0.03333333, endTime: 0.03333334, presetId: DEFAULT_PRESET_ID },
        { id: 'b', startTime: 5, endTime: 3 }
      ],
      fonts: []
    })!
    const [a, b] = parsed.clips
    expect(timeToFrameAtOrAfter(a!.endTime, FPS) - timeToFrameAtOrAfter(a!.startTime, FPS)).toBeGreaterThanOrEqual(1)
    expect(a!.endTime - a!.startTime).toBeGreaterThanOrEqual(MIN_CLIP_DURATION_SEC - 1e-6)
    expect(b!.startTime).toBeLessThan(b!.endTime)
  })

  it('未知 presetId 与非法动画字段回退默认值', () => {
    const parsed = normalizeProject({
      version: 1,
      resolution: { width: 1280, height: 720 },
      fps: FPS,
      clips: [
        {
          id: 'c',
          startTime: 0,
          endTime: 4,
          presetId: '不存在的预设',
          animation: { inDuration: 99, outDuration: -1, easing: 'easeOutBack', textRevealFrames: 0 },
          content: { title: null },
          styleOverrides: { tokens: { primary: 'garbage', accent: '#00ff00' }, barOpacity: 2 },
          fontId: ''
        }
      ],
      fonts: []
    })!
    const clip = parsed.clips[0]!
    expect(clip.presetId).toBe(DEFAULT_PRESET_ID)
    expect(clip.animation.inDuration).toBe(99) // 时长保留用户值，合法性由面板与 validatePreset 约束
    // 带过冲的网页式曲线（easeOutBack）不得进入工程，回退到 outCubic（规格 §7 / 验收第 10 条）
    expect(clip.animation.easing).toBe('outCubic')
    expect(clip.animation.textRevealFrames).toBeGreaterThanOrEqual(0)
    expect(clip.content.title).toBe('')
    expect(clip.fontId).toBe(DEFAULT_FONT_ID)
    expect(clip.styleOverrides.tokens?.accent).toBe('#00ff00')
    expect(clip.styleOverrides.tokens?.primary).toBeUndefined()
  })

  it('v0（无 version 字段）迁移到当前版本', () => {
    const parsed = normalizeProject({ resolution: { width: 640, height: 360 }, fps: FPS, clips: [], fonts: [] })
    expect(parsed?.version).toBe(PROJECT_VERSION)
  })

  it('v1 旧工程：refVideo 自动迁移为 media[0] + 一条覆盖整段的 mediaClip', () => {
    const legacy = {
      version: 1,
      name: '旧工程',
      resolution: { width: 1920, height: 1080 },
      fps: FPS,
      clips: [],
      fonts: [],
      refVideo: {
        path: 'C:/media/legacy.mp4',
        meta: {
          path: 'C:/media/legacy.mp4',
          containerName: 'mov,mp4,m4a,3gp,2b2,gif,webm',
          width: 1920,
          height: 1080,
          sar: null,
          displayRatio: 1920 / 1080,
          rFrameRate: { num: 30, den: 1 },
          avgFrameRate: { num: 30, den: 1 },
          pixFmt: 'yuv420p',
          colorPrimaries: null,
          colorSpace: null,
          colorTransfer: null,
          colorRange: null,
          videoCodec: 'h264',
          audioCodec: 'aac',
          audioChannels: 2,
          durationSec: 12,
          nbFrames: null,
          bitRateKbps: null
        },
        non169Ack: true,
        hdrAck: false,
        vfrPolicy: 'none',
        compactMode: 'auto',
        importedAt: '2026-01-01T00:00:00.000Z'
      }
    }
    const parsed = normalizeProject(legacy)!
    expect(parsed.version).toBe(PROJECT_VERSION)
    expect(parsed.media).toHaveLength(1)
    expect(parsed.media[0]?.path).toBe('C:/media/legacy.mp4')
    expect(parsed.media[0]?.name).toBe('legacy.mp4')
    expect(parsed.media[0]?.hdrAck).toBe(false)
    expect(parsed.mediaClips).toHaveLength(1)
    const clip = parsed.mediaClips[0]!
    expect(clip.mediaId).toBe(parsed.media[0]!.id)
    expect(clip.timelineStartSec).toBe(0)
    expect(clip.timelineEndSec).toBeCloseTo(12, 6)
    expect(clip.sourceInSec).toBe(0)
    expect(clip.sourceOutSec).toBeCloseTo(12, 6)
    // refVideo 旧字段不应回流到归一化后的工程
    expect((parsed as unknown as { refVideo?: unknown }).refVideo).toBeUndefined()
  })

  it('v1 旧工程无 refVideo：media/mediaClips 缺省为空数组', () => {
    const parsed = normalizeProject({ version: 1, fps: FPS, clips: [], fonts: [] })!
    expect(parsed.media).toEqual([])
    expect(parsed.mediaClips).toEqual([])
  })
})

describe('片段工具', () => {
  it('新建片段：默认预设、字体与吸附时长', () => {
    const clip = createClip({ startTime: 1.017, fps: FPS })
    expect(clip.presetId).toBe(DEFAULT_PRESET_ID)
    expect(clip.fontId).toBe(DEFAULT_FONT_ID)
    expect(clip.startTime).toBe(snapTimeToFrame(1.017, FPS))
    expect(clip.endTime - clip.startTime).toBeGreaterThan(0)
    expect(clip.id.startsWith('clip-')).toBe(true)
  })

  it('新建片段：入场/出场默认 1 秒，写入时吸附到当前帧率的整帧', () => {
    // 30/1 下 1s 正好落在 30 帧，与默认常量完全相等
    const p30 = createClip({ fps: { num: 30, den: 1 } }).animation
    expect(p30.inDuration).toBeCloseTo(DEFAULT_ANIMATION_IN_SEC, 6)
    expect(p30.outDuration).toBeCloseTo(DEFAULT_ANIMATION_OUT_SEC, 6)
    expect(durationSecToFrames(p30.inDuration, { num: 30, den: 1 })).toBe(30)

    // 23.976 这种非标准帧率：自动取整帧 (24)，回写的秒不恰好是 1，但仍是整帧边界
    const ntsc = { num: 24000, den: 1001 }
    const pNtsc = createClip({ fps: ntsc }).animation
    expect(durationSecToFrames(pNtsc.inDuration, ntsc)).toBe(24)
    expect(pNtsc.inDuration).toBe(framesToDurationSec(24, ntsc))

    // 60fps：展开为 60 帧，不再受旧 30 帧硬顶限制
    const p60 = createClip({ fps: { num: 60, den: 1 } }).animation
    expect(durationSecToFrames(p60.inDuration, { num: 60, den: 1 })).toBe(60)
  })

  it('复制片段：新 id、紧接原片段之后且不重叠', () => {
    const clip = createClip({ startTime: 0, fps: FPS })
    const copy = duplicateClip(clip, FPS)
    expect(copy.id).not.toBe(clip.id)
    expect(copy.startTime).toBeGreaterThanOrEqual(clip.endTime)
    expect(copy.content).toEqual(clip.content)
    expect(copy.animation.displacement).not.toBe(clip.animation.displacement)
  })

  it('ID 在同一批内不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createClip({ fps: FPS }).id))
    expect(ids.size).toBe(200)
  })
})

describe('时间轴合法性', () => {
  const clip = (over: Partial<SubtitleClip>): SubtitleClip => ({
    ...createClip({ fps: FPS }),
    ...over
  })

  it('重叠与倒序会被报出（MVP 不做多字幕条同屏）', () => {
    const a = clip({ startTime: 0, endTime: 4 })
    const b = clip({ startTime: 3, endTime: 6 })
    const issues = validateClips([a, b], FPS)
    expect(issues.some((text) => text.includes('重叠'))).toBe(true)
    expect(validateClips([clip({ startTime: 0, endTime: 2 }), clip({ startTime: 2, endTime: 4 })], FPS)).toEqual([])
  })

  it('时长与帧区间换算一致', () => {
    const c = clip({ startTime: snapTimeToFrame(1.5, FPS), endTime: snapTimeToFrame(4.5, FPS) })
    const { startFrame, endFrame } = clipFrames(c, FPS)
    expect(endFrame - startFrame).toBe(90)
  })

  it('空工程时长为下限值，span 可算', () => {
    const project = createDefaultProject()
    expect(projectDurationSec(project)).toBeGreaterThanOrEqual(MIN_CLIP_DURATION_SEC)
    expect(projectSpanSec(project).endSec).toBeGreaterThanOrEqual(projectSpanSec(project).startSec)
    const withClips: Project = { ...project, clips: [clip({ startTime: 2, endTime: 6 }), clip({ startTime: 0.5, endTime: 1 })] }
    const span = projectSpanSec(withClips)
    expect(span.startSec).toBe(0.5)
    expect(span.endSec).toBe(6)
    expect(projectDurationSec(withClips)).toBe(6)
  })

  it('自动存档文件名常量稳定（工程与备份成对）', () => {
    expect(AUTOSAVE_FILE).toBe('autosave.focusnews.json')
    expect(PRESETS.length).toBe(8)
  })
})
