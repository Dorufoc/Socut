import { describe, expect, it } from 'vitest'
import {
  clipFrames,
  createClip,
  createDefaultProject,
  duplicateClip,
  LEFT_TABS,
  normalizeLeftTab,
  normalizeProject,
  validateClips
} from '@shared/projectSchema'
import { projectDurationSec, projectSpanSec } from '@shared/presetResolver'
import {
  MIN_CLIP_DURATION_SEC,
  PROJECT_VERSION,
  DEFAULT_FONT_ID,
  AUTOSAVE_FILE,
  DEFAULT_ANIMATION_IN_SEC,
  DEFAULT_ANIMATION_OUT_SEC,
  TRACK_SOFT_LIMIT,
  TRANSITION_DURATION
} from '@shared/constants'
import { durationSecToFrames, framesToDurationSec, snapTimeToFrame, timeToFrameAtOrAfter } from '@shared/fps'
import { DEFAULT_PRESET_ID } from '@shared/presets'
import { PRESETS } from '@shared/presets'
import {
  AUDIO_TRACK_ID_PREFIX,
  MEDIA_TRACK_ID_PREFIX,
  makeAudioTrack,
  makeMediaTrack,
  mediaTrackOrder
} from '@shared/tracks'
import type { Project, SubtitleClip } from '@shared/types'

/** 工程 JSON 归一化与自动保存前的合法性（规格 §4.6 / §8）。 */

const FPS = { num: 30, den: 1 }

/** v8：带一枚素材 + 一段媒体段的最小工程；stabJson 原样写进片段的 stab 键。 */
function projectWithMediaClip(stabJson?: unknown): Record<string, unknown> {
  return {
    version: PROJECT_VERSION,
    name: '防抖工程',
    resolution: { width: 1920, height: 1080 },
    fps: FPS,
    clips: [],
    fonts: [],
    media: [
      {
        id: 'm1',
        path: 'C:/media/a.mp4',
        name: 'a.mp4',
        meta: { width: 1920, height: 1080, durationSec: 30, rFrameRate: { num: 30, den: 1 }, avgFrameRate: { num: 30, den: 1 } }
      }
    ],
    mediaClips: [
      {
        id: 'c1',
        mediaId: 'm1',
        timelineStartSec: 0,
        timelineEndSec: 4,
        sourceInSec: 0,
        sourceOutSec: 4,
        ...(stabJson === undefined ? {} : { stab: stabJson })
      }
    ]
  }
}

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
    expect(AUTOSAVE_FILE).toBe('autosave.socut.json')
    expect(PRESETS.length).toBe(8)
  })
})

describe('v8 防抖参数归一', () => {
  it('round-trip：开启的防抖参数序列化后再解析不丢', () => {
    const parsed = normalizeProject(projectWithMediaClip({ enabled: true, level: 'high', tripod: true }))!
    expect(parsed.mediaClips[0]!.stab).toEqual({ enabled: true, level: 'high', tripod: true })
    // JSON 往返保真
    const again = normalizeProject(JSON.parse(JSON.stringify(parsed)))!
    expect(again.mediaClips[0]!.stab).toEqual({ enabled: true, level: 'high', tripod: true })
  })

  it('全默认整键不落盘：关闭且无自定义选择时 stab 消失', () => {
    const parsed = normalizeProject(projectWithMediaClip({ enabled: false, level: 'standard', tripod: false }))!
    expect(parsed.mediaClips[0]!.stab).toBeUndefined()
    expect('stab' in (parsed.mediaClips[0] as unknown as Record<string, unknown>)).toBe(false)
  })

  it('脏值归一：非法档位回 standard、非 true 布尔视为 false，但 enabled 有效时仍落盘', () => {
    const parsed = normalizeProject(projectWithMediaClip({ enabled: true, level: 'ultra', tripod: 'yes' }))!
    expect(parsed.mediaClips[0]!.stab).toEqual({ enabled: true, level: 'standard', tripod: false })
  })

  it('旧工程无 stab 键：原样加载，不凭空多出字段（可选键免迁移）', () => {
    const parsed = normalizeProject(projectWithMediaClip())!
    expect(parsed.mediaClips[0]!.stab).toBeUndefined()
    expect(JSON.stringify(parsed.mediaClips[0])).not.toContain('stab')
  })

  it('v4 多序列容器是必填结构：PROJECT_VERSION 随之上调到 4', () => {
    expect(PROJECT_VERSION).toBe(4)
  })

  /**
   * M5-A 无限轨（第一阶段软上限 50）：
   * 旧「每类最多 8 条」已废除，但导出图与时间轴行数仍需有限保护。
   */
  it('轨道软上限：12 条媒体轨 + 12 条音频轨原样归一，mediaTrackOrder 顺序正确', () => {
    const mediaTracks = Array.from({ length: 12 }, (_, index) => makeMediaTrack(index))
    const audioTracks = Array.from({ length: 12 }, (_, index) => makeAudioTrack(index))
    const parsed = normalizeProject({
      version: PROJECT_VERSION,
      name: '多轨工程',
      resolution: { width: 1920, height: 1080 },
      fps: FPS,
      clips: [],
      fonts: [],
      mediaTracks,
      audioTracks
    })!

    expect(parsed.mediaTracks.map((track) => track.id)).toEqual(mediaTracks.map((track) => track.id))
    expect(parsed.audioTracks.map((track) => track.id)).toEqual(audioTracks.map((track) => track.id))
    // 导出/预览用的顺序表：12 条全在，0 = 最底层、11 = 最顶层
    expect([...mediaTrackOrder(parsed.mediaTracks)]).toEqual(mediaTracks.map((track, index) => [track.id, index]))
    // round-trip 不漂移（自动存档/历史快照读回同一份顺序）
    const again = normalizeProject(JSON.parse(JSON.stringify(parsed)))!
    expect(again.mediaTracks.map((track) => track.id)).toEqual(parsed.mediaTracks.map((track) => track.id))
  })

  it('轨道软上限：>8 可加——只有 12 条被引用的 trackId 时补出 12 条轨道（旧硬上限 8 不再截断）', () => {
    const mediaClips = Array.from({ length: 12 }, (_, index) => ({
      id: `c${index}`,
      mediaId: 'm1',
      timelineStartSec: index,
      timelineEndSec: index + 1,
      sourceInSec: 0,
      sourceOutSec: 1,
      trackId: `${MEDIA_TRACK_ID_PREFIX}${index}`
    }))
    const audioClips = Array.from({ length: 12 }, (_, index) => ({
      id: `a${index}`,
      mediaId: 'm1',
      timelineStartSec: index,
      timelineEndSec: index + 1,
      sourceInSec: 0,
      sourceOutSec: 1,
      trackId: `${AUDIO_TRACK_ID_PREFIX}${index}`
    }))
    const parsed = normalizeProject({ ...projectWithMediaClip(), mediaClips, audioClips })!

    expect(parsed.mediaTracks).toHaveLength(12)
    expect(parsed.audioTracks).toHaveLength(12)
    expect(parsed.mediaTracks[11]!.id).toBe(`${MEDIA_TRACK_ID_PREFIX}11`)
    expect(parsed.audioTracks[11]!.id).toBe(`${AUDIO_TRACK_ID_PREFIX}11`)
  })

  it('轨道软上限：51 条轨道夹到 50 条，保留前 50 条的顺序', () => {
    const mediaTracks = Array.from({ length: 51 }, (_, index) => makeMediaTrack(index))
    const audioTracks = Array.from({ length: 51 }, (_, index) => makeAudioTrack(index))
    const parsed = normalizeProject({
      version: PROJECT_VERSION,
      name: '超软上限工程',
      resolution: { width: 1920, height: 1080 },
      fps: FPS,
      clips: [],
      fonts: [],
      mediaTracks,
      audioTracks
    })!

    expect(parsed.mediaTracks).toHaveLength(TRACK_SOFT_LIMIT)
    expect(parsed.audioTracks).toHaveLength(TRACK_SOFT_LIMIT)
    expect(parsed.mediaTracks[TRACK_SOFT_LIMIT - 1]!.id).toBe(`${MEDIA_TRACK_ID_PREFIX}${TRACK_SOFT_LIMIT - 1}`)
    expect(parsed.audioTracks[TRACK_SOFT_LIMIT - 1]!.id).toBe(`${AUDIO_TRACK_ID_PREFIX}${TRACK_SOFT_LIMIT - 1}`)
  })
})

/**
 * v9：片段音频与变速的工程 JSON 口径。
 *
 * 除了 round-trip，最关键的是**变速后的时长恒等式**：
 * `sourceOutSec - sourceInSec === (timelineEndSec - timelineStartSec) × 倍速`
 * （1x 时就是旧恒等式，所以旧工程一个字节都不会变）。
 */
describe('v9 音频与变速参数归一', () => {
  const mediaDoc = (extra: Record<string, unknown>): Record<string, unknown> => {
    const doc = projectWithMediaClip()
    const clips = doc['mediaClips'] as Record<string, unknown>[]
    clips[0] = { ...clips[0], ...extra }
    return doc
  }
  const audioDoc = (extra: Record<string, unknown>): Record<string, unknown> => {
    const doc = mediaDoc({})
    doc['audioClips'] = [
      { id: 'a1', mediaId: 'm1', timelineStartSec: 1, timelineEndSec: 3, sourceInSec: 0.5, ...extra }
    ]
    return doc
  }

  it('round-trip：音量/渐变/倍速/音高开关序列化后再解析不丢', () => {
    const parsed = normalizeProject(
      mediaDoc({
        audio: { volumePercent: 150, fadeInSec: 1, fadeOutSec: 0.5 },
        speed: { speed: 2, maintainPitch: false }
      })
    )!
    expect(parsed.mediaClips[0]!.audio).toEqual({ volumePercent: 150, fadeInSec: 1, fadeOutSec: 0.5 })
    expect(parsed.mediaClips[0]!.speed).toEqual({ speed: 2, maintainPitch: false })
    const again = normalizeProject(JSON.parse(JSON.stringify(parsed)))!
    expect(again.mediaClips[0]!.audio).toEqual(parsed.mediaClips[0]!.audio)
    expect(again.mediaClips[0]!.speed).toEqual(parsed.mediaClips[0]!.speed)
  })

  it('变速的时长恒等式：时间轴 4s @ 2x → 源窗口 8s（1x 时回到旧口径）', () => {
    const fast = normalizeProject(mediaDoc({ speed: { speed: 2, maintainPitch: true } }))!
    // 夹具的时间轴段是 0→4、源入点 0
    expect(fast.mediaClips[0]!.sourceOutSec).toBeCloseTo(8, 6)
    const normal = normalizeProject(mediaDoc({}))!
    expect(normal.mediaClips[0]!.sourceOutSec).toBeCloseTo(4, 6)
    // 慢放也一样：0.5x 时时间轴 4s 只吃 2s 源
    const slow = normalizeProject(mediaDoc({ speed: { speed: 0.5, maintainPitch: true } }))!
    expect(slow.mediaClips[0]!.sourceOutSec).toBeCloseTo(2, 6)
  })

  it('音频轨同一套口径：倍速 2x 时源出点跟着伸长', () => {
    const parsed = normalizeProject(audioDoc({ speed: { speed: 2, maintainPitch: true } }))!
    expect(parsed.audioClips![0]!.sourceOutSec).toBeCloseTo(0.5 + 2 * 2, 6)
    expect(parsed.audioClips![0]!.speed).toEqual({ speed: 2, maintainPitch: true })
  })

  it('全默认整键不落盘：旧工程 JSON 不凭空多出 audio/speed', () => {
    const parsed = normalizeProject(
      mediaDoc({ audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 }, speed: { speed: 1, maintainPitch: true } })
    )!
    const clip = parsed.mediaClips[0] as unknown as Record<string, unknown>
    expect('audio' in clip).toBe(false)
    expect('speed' in clip).toBe(false)
    expect(JSON.stringify(parsed.mediaClips)).not.toContain('volumePercent')
  })

  it('脏值夹心：非数字回默认、越界夹到区间边界', () => {
    const parsed = normalizeProject(
      mediaDoc({ audio: { volumePercent: 900, fadeInSec: 'x', fadeOutSec: 99 }, speed: { speed: -3 } })
    )!
    expect(parsed.mediaClips[0]!.audio).toEqual({ volumePercent: 200, fadeInSec: 0, fadeOutSec: 5 })
    expect(parsed.mediaClips[0]!.speed).toEqual({ speed: 0.25, maintainPitch: true })
    // 源窗口按夹心后的倍速算，不会算出负数
    expect(parsed.mediaClips[0]!.sourceOutSec).toBeCloseTo(1, 6)
  })

  it('音频轨的默认值也不落盘', () => {
    const clip = normalizeProject(audioDoc({ audio: { volumePercent: 100, fadeInSec: 0, fadeOutSec: 0 } }))!
      .audioClips![0] as unknown as Record<string, unknown>
    expect('audio' in clip).toBe(false)
  })
})

/**
 * P6：字幕与水印合并进左侧「包装」Tab。
 * 旧工程里存的 `ui.leftTab` 可能是 'captions' 或 'watermark'，界面已经不再认识这两个值——
 * 迁移必须在「读入工程」这一步做完，而不是留到 UI 里猜，否则恢复现场会落进一个空 Tab。
 */
describe('leftTab 归一化与旧值迁移（P6）', () => {
  it('当前左侧 Tab 集合：素材库 / 转场 / 包装 / 导出 / 进度（不再有独立的水印与字幕 Tab）', () => {
    expect(LEFT_TABS).toEqual(['media', 'transition', 'wrap', 'export', 'progress'])
  })

  it('旧工程的 captions 与 watermark 都落到 wrap', () => {
    expect(normalizeLeftTab('captions')).toBe('wrap')
    expect(normalizeLeftTab('watermark')).toBe('wrap')
  })

  it('认识的值原样返回；不认识或缺省返回 undefined（由调用方退回默认）', () => {
    expect(normalizeLeftTab('export')).toBe('export')
    expect(normalizeLeftTab('progress')).toBe('progress')
    // v11：转场是当前认识的 Tab，旧工程恢复时能原样回到转场面板
    expect(normalizeLeftTab('transition')).toBe('transition')
    expect(normalizeLeftTab('bogus')).toBeUndefined()
    expect(normalizeLeftTab(undefined)).toBeUndefined()
  })

  it('normalizeProject 只改 ui.leftTab，ui 里其它键一个不丢', () => {
    const parsed = normalizeProject({
      version: PROJECT_VERSION,
      name: '包装迁移',
      ui: { leftTab: 'captions', paneRatio: 0.4 }
    })!
    expect(parsed.ui).toEqual({ leftTab: 'wrap', paneRatio: 0.4 })
  })

  it('ui 里没有 leftTab 时不凭空补一个（冷启动默认由 uiStore 决定）', () => {
    const parsed = normalizeProject({ version: PROJECT_VERSION, name: '只有别的 UI 键', ui: { paneRatio: 0.4 } })!
    expect('leftTab' in (parsed.ui ?? {})).toBe(false)
  })
})

/**
 * v10：转场、音频质量、素材分组与响度标准化的 schema 口径。
 * 共同纪律：默认值不落盘（旧工程 JSON 不变）、脏值丢弃、跨帧率吸附。
 */
describe('v10 转场归一', () => {
  const docWithTransition = (transitionIn: unknown, fps = FPS): Record<string, unknown> => {
    const doc = projectWithMediaClip()
    doc['fps'] = fps
    const clips = doc['mediaClips'] as Record<string, unknown>[]
    clips[0] = { ...clips[0], transitionIn }
    return doc
  }

  it('合法类型与时长：吸附到帧边界且至少 2 帧', () => {
    const transition = normalizeProject(docWithTransition({ type: 'dissolve', durationSec: 0.55 }))!
      .mediaClips[0]!.transitionIn!
    expect(transition.type).toBe('dissolve')
    expect(transition.durationSec).toBeCloseTo(snapTimeToFrame(0.55, FPS), 9)
    expect(durationSecToFrames(transition.durationSec, FPS)).toBe(17)
  })

  it('多族类型都能落盘（抽查基础/风感/运镜）', () => {
    for (const type of ['fadeBlack', 'windUp', 'zoomIn']) {
      const transition = normalizeProject(docWithTransition({ type, durationSec: 0.5 }))!
        .mediaClips[0]!.transitionIn
      expect(transition?.type).toBe(type)
    }
  })

  it('非法类型整键丢弃（不写入无效数据）', () => {
    const clip = normalizeProject(docWithTransition({ type: 'wipe', durationSec: 0.5 }))!
      .mediaClips[0] as unknown as Record<string, unknown>
    expect('transitionIn' in clip).toBe(false)
  })

  it('时长夹到 0.2–1.5s 并吸附帧', () => {
    const tooLong = normalizeProject(docWithTransition({ type: 'dissolve', durationSec: 3 }))!.mediaClips[0]!.transitionIn!
    expect(tooLong.durationSec).toBeCloseTo(TRANSITION_DURATION.max, 9)
    const tooShort = normalizeProject(docWithTransition({ type: 'dissolve', durationSec: 0.01 }))!.mediaClips[0]!
      .transitionIn!
    expect(tooShort.durationSec).toBeCloseTo(TRANSITION_DURATION.min, 9)
  })

  it('吸附后不足 2 帧（低帧率）丢弃', () => {
    const clip = normalizeProject(docWithTransition({ type: 'dissolve', durationSec: 0.2 }, { num: 5, den: 1 }))!
      .mediaClips[0] as unknown as Record<string, unknown>
    expect('transitionIn' in clip).toBe(false)
  })

  it('缺省不落盘；旧片段 JSON 不受影响', () => {
    const clip = normalizeProject(projectWithMediaClip())!.mediaClips[0] as unknown as Record<string, unknown>
    expect('transitionIn' in clip).toBe(false)
    expect(JSON.stringify(clip)).not.toContain('transitionIn')
  })

  it('round-trip 保真', () => {
    const parsed = normalizeProject(docWithTransition({ type: 'pushLeft', durationSec: 0.5 }))!
    expect(normalizeProject(JSON.parse(JSON.stringify(parsed)))!.mediaClips[0]!.transitionIn).toEqual(
      parsed.mediaClips[0]!.transitionIn
    )
  })
})

describe('v10 片段音频降噪', () => {
  const docWithAudio = (audio: unknown): Record<string, unknown> => {
    const doc = projectWithMediaClip()
    const clips = doc['mediaClips'] as Record<string, unknown>[]
    clips[0] = { ...clips[0], audio }
    return doc
  }

  it('合法档位落盘（即使音量/淡变全默认）', () => {
    for (const denoise of ['light', 'standard', 'strong'] as const) {
      expect(normalizeProject(docWithAudio({ denoise }))!.mediaClips[0]!.audio).toEqual({
        volumePercent: 100,
        fadeInSec: 0,
        fadeOutSec: 0,
        denoise
      })
    }
  })

  it('非法档位丢弃；三者全默认时 audio 整键不存在', () => {
    const clip = normalizeProject(docWithAudio({ denoise: 'ultra', volumePercent: 100 }))!
      .mediaClips[0] as unknown as Record<string, unknown>
    expect('audio' in clip).toBe(false)
  })

  it('round-trip 保真', () => {
    const parsed = normalizeProject(docWithAudio({ denoise: 'strong' }))!
    expect(normalizeProject(JSON.parse(JSON.stringify(parsed)))!.mediaClips[0]!.audio).toEqual(
      parsed.mediaClips[0]!.audio
    )
  })
})

describe('v10 音频段角色与 ducking', () => {
  const docWithAudioClip = (extra: Record<string, unknown>): Record<string, unknown> => {
    const doc = projectWithMediaClip()
    doc['audioClips'] = [
      { id: 'a1', mediaId: 'm1', timelineStartSec: 1, timelineEndSec: 3, sourceInSec: 0.5, ...extra }
    ]
    return doc
  }

  it('role: bgm 单独落盘；voice 是默认不落盘', () => {
    expect(normalizeProject(docWithAudioClip({ role: 'bgm' }))!.audioClips![0]!.role).toBe('bgm')
    const voice = normalizeProject(docWithAudioClip({ role: 'voice' }))!.audioClips![0] as unknown as Record<
      string,
      unknown
    >
    expect('role' in voice).toBe(false)
  })

  it('ducking 三档落盘，非法档位丢弃', () => {
    for (const ducking of ['light', 'standard', 'strong'] as const) {
      expect(normalizeProject(docWithAudioClip({ role: 'bgm', ducking }))!.audioClips![0]!.ducking).toBe(ducking)
    }
    const bogus = normalizeProject(docWithAudioClip({ role: 'bgm', ducking: 'max' }))!
      .audioClips![0] as unknown as Record<string, unknown>
    expect('ducking' in bogus).toBe(false)
  })

  it('非法 role 不落盘', () => {
    const clip = normalizeProject(docWithAudioClip({ role: 'music' }))!.audioClips![0] as unknown as Record<
      string,
      unknown
    >
    expect('role' in clip).toBe(false)
  })
})

describe('v10 成片响度标准化', () => {
  const doc = (audioMastering: unknown): Record<string, unknown> => ({
    version: PROJECT_VERSION,
    name: '响度',
    fps: FPS,
    clips: [],
    fonts: [],
    audioMastering
  })

  it('social / broadcast 落盘', () => {
    expect(normalizeProject(doc('social'))!.audioMastering).toBe('social')
    expect(normalizeProject(doc('broadcast'))!.audioMastering).toBe('broadcast')
  })

  it('off 与未知值不落盘', () => {
    expect('audioMastering' in normalizeProject(doc('off'))!).toBe(false)
    expect('audioMastering' in normalizeProject(doc('cinema'))!).toBe(false)
  })
})

describe('v10 素材分组与标签', () => {
  const docWithMedia = (mediaBins: unknown, mediaExtra: Record<string, unknown>): Record<string, unknown> => {
    const doc = projectWithMediaClip()
    doc['mediaBins'] = mediaBins
    const media = doc['media'] as Record<string, unknown>[]
    media[0] = { ...media[0], ...mediaExtra }
    return doc
  }

  it('分组归一：trim、去重、空名丢弃', () => {
    const parsed = normalizeProject(
      docWithMedia(
        [
          { id: ' b1 ', name: ' 现场 ' },
          { id: 'b1', name: '重复 id' },
          { id: 'b2', name: '素材' },
          { id: '', name: '空 id' },
          { id: 'b3', name: '   ' }
        ],
        {}
      )
    )!
    expect(parsed.mediaBins).toEqual([
      { id: 'b1', name: '现场' },
      { id: 'b2', name: '素材' }
    ])
  })

  it('binId 必须指向存在的分组，否则删除该键', () => {
    const item = normalizeProject(docWithMedia([{ id: 'b1', name: '现场' }], { binId: 'missing' }))!
      .media[0] as unknown as Record<string, unknown>
    expect('binId' in item).toBe(false)
  })

  it('有效 binId 落盘', () => {
    expect(normalizeProject(docWithMedia([{ id: 'b1', name: '现场' }], { binId: 'b1' }))!.media[0]!.binId).toBe('b1')
  })

  it('没有 mediaBins 时所有 binId 都退回未分组', () => {
    const item = normalizeProject(docWithMedia(undefined, { binId: 'b1' }))!.media[0] as unknown as Record<
      string,
      unknown
    >
    expect('binId' in item).toBe(false)
  })

  it('tags：trim、去空、去重、单条限长、最多 12 个', () => {
    const raw = [' 台风 ', '台风', '', '   ', 'a', 'a', 'b'.repeat(40), ...Array.from({ length: 10 }, (_, i) => `t${i}`)]
    const tags = normalizeProject(docWithMedia(undefined, { tags: raw }))!.media[0]!.tags!
    expect(tags[0]).toBe('台风')
    expect(tags.filter((tag) => tag === '台风')).toHaveLength(1)
    expect(tags.filter((tag) => tag === 'a')).toHaveLength(1)
    expect(tags.find((tag) => tag.startsWith('b'))?.length).toBe(24)
    expect(tags).toHaveLength(12)
  })

  it('空标签数组不落盘', () => {
    const item = normalizeProject(docWithMedia(undefined, { tags: ['  ', '', ''] }))!.media[0] as unknown as Record<
      string,
      unknown
    >
    expect('tags' in item).toBe(false)
  })
})

describe('v10 版本与旧工程兼容', () => {
  it('新增可选字段不改变 PROJECT_VERSION（当前 v4：多序列容器）', () => {
    expect(PROJECT_VERSION).toBe(4)
    const parsed = normalizeProject({
      version: PROJECT_VERSION,
      name: 'v10 兼容',
      fps: FPS,
      clips: [],
      fonts: [],
      audioMastering: 'social'
    })!
    expect(parsed.version).toBe(PROJECT_VERSION)
    // 单序列工程不写序列键（可选字段不落盘）
    expect(parsed.sequences).toBeUndefined()
    expect(parsed.activeSequenceId).toBeUndefined()
  })
})
