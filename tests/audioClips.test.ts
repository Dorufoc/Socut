import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_TRACK_ID, FPS_30 } from '@shared/constants'
import {
  MIN_AUDIO_CLIP_SEC,
  activeAudioClips,
  applyAudioClipSpeed,
  audioClipsEndSec,
  makeAudioClip,
  moveAudioClip,
  sortAudioClips,
  trackOccupied,
  trimAudioClip
} from '@shared/audioClips'
import { createDefaultProject, normalizeProject } from '@shared/projectSchema'
import type { AudioClip, VideoMeta } from '@shared/types'

/**
 * 音频轨（v7.1）的数据层：建段 / 平移 / 拖入出点 / 叠放层 / 工程归一化。
 *
 * 时间轴口径与媒体段一致（秒存储、帧对齐、时长恒等式），差别是**允许重叠**：
 * 同一时刻可以有多段同时发声，所以取「当前段」返回一组。
 */

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'a1',
  mediaId: 'm1',
  trackId: over.trackId ?? DEFAULT_AUDIO_TRACK_ID,
  timelineStartSec: 0,
  timelineEndSec: 4,
  sourceInSec: 0,
  sourceOutSec: 4,
  ...over
})

describe('轨道占用', () => {
  it('同轨占用可判定（用于提示，不自动让位）', () => {
    const clips = [clip(), clip({ id: 'a2', trackId: 'track-audio-1' })]
    expect(trackOccupied(clips, DEFAULT_AUDIO_TRACK_ID)).toBe(true)
    expect(trackOccupied(clips, DEFAULT_AUDIO_TRACK_ID, 'a1')).toBe(false)
    expect(trackOccupied(clips, 'track-audio-9')).toBe(false)
  })
})

describe('建段（makeAudioClip）', () => {
  it('落点吸附到帧、时长按源长度收窄', () => {
    const made = makeAudioClip(
      { id: 'n1', mediaId: 'm1', timelineStartSec: 1.017, durationSec: 10, sourceDurationSec: 3 },
      FPS_30
    )!
    expect(made.timelineStartSec).toBeCloseTo(1.0333, 3) // 1.017 → 第 31 帧
    expect(made.timelineEndSec - made.timelineStartSec).toBeCloseTo(3, 6) // 源只有 3s
    expect(made.sourceOutSec).toBeCloseTo(3, 6)
  })

  it('源太短 / 时长退化为 0 时拒收（返回 null）', () => {
    expect(makeAudioClip({ id: 'n', mediaId: 'm', timelineStartSec: 0, durationSec: 5, sourceDurationSec: 0.05 }, FPS_30)).toBeNull()
  })

  it('缺省落到第一条音频轨，显式 trackId 原样保留', () => {
    const plain = makeAudioClip({ id: 'n1', mediaId: 'm', timelineStartSec: 0, durationSec: 2 }, FPS_30)!
    expect(plain.trackId).toBe(DEFAULT_AUDIO_TRACK_ID)
    const stacked = makeAudioClip(
      { id: 'n2', mediaId: 'm', timelineStartSec: 0, durationSec: 2, trackId: 'track-audio-2' },
      FPS_30
    )!
    expect(stacked.trackId).toBe('track-audio-2')
  })
})

describe('平移与拖边', () => {
  it('平移保持时长、夹在 0 之后，且不推挤邻居', () => {
    const moved = moveAudioClip(clip(), -5, FPS_30)
    expect(moved.timelineStartSec).toBe(0)
    expect(moved.timelineEndSec).toBe(4)
    const right = moveAudioClip(clip(), 6, FPS_30)
    expect(right.timelineStartSec).toBe(6)
    expect(right.timelineEndSec).toBe(10)
  })

  it('拖入点：时间轴与源坐标同幅度、时长恒等式成立', () => {
    const trimmed = trimAudioClip(clip({ sourceInSec: 1, sourceOutSec: 5 }), { timelineStartSec: 1 }, FPS_30, 20)
    expect(trimmed.timelineStartSec).toBe(1)
    expect(trimmed.sourceInSec).toBe(2) // 源同步右移 1s
    expect(trimmed.timelineEndSec - trimmed.timelineStartSec).toBeCloseTo(trimmed.sourceOutSec - trimmed.sourceInSec, 6)
  })

  it('拖出点：不超过「源入点 + 源剩余长度」，且不短于最短段', () => {
    // 源入点 2s、源长 5s → 最多再用 3s
    const capped = trimAudioClip(clip({ sourceInSec: 2 }), { timelineEndSec: 999 }, FPS_30, 5)
    expect(capped.timelineEndSec).toBeCloseTo(3, 6)
    const tooShort = trimAudioClip(clip(), { timelineEndSec: 0.01 }, FPS_30, 5)
    expect(tooShort.timelineEndSec - tooShort.timelineStartSec).toBeCloseTo(MIN_AUDIO_CLIP_SEC, 6)
  })
})

/**
 * v9：音频段的变速。
 *
 * 与媒体段同一口径：**源窗口不动、时间轴伸缩**，所以倍速上去片段在轴上变短；
 * 1x 时必须逐字回到旧行为（不带 speed 键、时长不变）。
 */
describe('音频段变速（v9）', () => {
  const speed2 = { speed: 2, maintainPitch: true }

  it('建段：倍速 2x 时同样的源只能撑一半时间轴长度', () => {
    const made = makeAudioClip(
      { id: 'n1', mediaId: 'm1', timelineStartSec: 0, durationSec: 10, sourceDurationSec: 6, speed: speed2 },
      FPS_30
    )!
    expect(made.timelineEndSec - made.timelineStartSec).toBeCloseTo(3, 6)
    expect(made.sourceOutSec).toBeCloseTo(6, 6)
    // 恒等式：源窗口 = 时间轴长度 × 倍速
    expect(made.sourceOutSec - made.sourceInSec).toBeCloseTo((made.timelineEndSec - made.timelineStartSec) * 2, 6)
  })

  it('拖入点：源坐标按倍速同比例走，恒等式仍成立', () => {
    const base = clip({ timelineEndSec: 2, sourceInSec: 1, sourceOutSec: 5, speed: speed2 })
    const trimmed = trimAudioClip(base, { timelineStartSec: 1 }, FPS_30, 20)
    expect(trimmed.sourceInSec).toBe(3) // 时间轴走 1s = 源走 2s
    expect(trimmed.sourceOutSec).toBe(5)
  })

  it('拖出点：能撑到源末尾的时间轴长度是「剩余源 / 倍速」', () => {
    const capped = trimAudioClip(clip({ sourceInSec: 2, speed: speed2 }), { timelineEndSec: 999 }, FPS_30, 6)
    expect(capped.timelineEndSec).toBeCloseTo(2, 6) // (6-2)/2
    expect(capped.sourceOutSec).toBeCloseTo(6, 6)
  })

  it('applyAudioClipSpeed：源窗口不变，只重算时间轴出点', () => {
    const base = clip({ timelineEndSec: 4, sourceInSec: 0, sourceOutSec: 4 })
    const fast = applyAudioClipSpeed(base, speed2, FPS_30)
    expect(fast.timelineEndSec).toBeCloseTo(2, 6)
    expect(fast.sourceOutSec).toBe(base.sourceOutSec)
    expect(fast.speed).toEqual(speed2)
    // 回到 1x：完全还原，且整键消失（不落盘）
    const back = applyAudioClipSpeed(fast, undefined, FPS_30)
    expect(back.timelineEndSec).toBeCloseTo(4, 6)
    expect('speed' in back).toBe(false)
  })

  it('只改音高开关不改时长：speed 键仍要落盘', () => {
    const kept = applyAudioClipSpeed(clip(), { speed: 1, maintainPitch: false }, FPS_30)
    expect(kept.timelineEndSec).toBeCloseTo(4, 6)
    expect(kept.speed).toEqual({ speed: 1, maintainPitch: false })
  })
})

describe('取当前段（混音语义）', () => {
  it('返回播放头处全部片段，按时间 + trackId 排序（底层先混）', () => {
    const clips = [
      clip({ id: 'top', trackId: 'track-audio-2', timelineEndSec: 6 }),
      clip({ id: 'base', timelineEndSec: 6 }),
      clip({ id: 'later', timelineStartSec: 5, timelineEndSec: 9 })
    ]
    expect(activeAudioClips(clips, 3).map((c) => c.id)).toEqual(['base', 'top'])
    expect(activeAudioClips(clips, 7).map((c) => c.id)).toEqual(['later'])
    expect(activeAudioClips(clips, 20)).toEqual([])
  })

  it('覆盖末端取最大结束时间', () => {
    expect(audioClipsEndSec([clip(), clip({ id: 'b', timelineStartSec: 8, timelineEndSec: 12 })])).toBe(12)
    expect(sortAudioClips([clip({ id: 'b', timelineStartSec: 8 }), clip()]).map((c) => c.id)).toEqual(['a1', 'b'])
  })
})

describe('工程归一化（旧工程零影响）', () => {
  const meta = (width: number): VideoMeta => ({
    path: 'C:/m',
    containerName: 'mp3',
    width,
    height: width,
    sar: null,
    displayRatio: 16 / 9,
    rFrameRate: { num: 25, den: 1 },
    avgFrameRate: { num: 25, den: 1 },
    pixFmt: width > 0 ? 'yuv420p' : 'none',
    colorPrimaries: null,
    colorSpace: null,
    colorTransfer: null,
    colorRange: null,
    videoCodec: width > 0 ? 'h264' : 'none',
    audioCodec: 'aac',
    audioChannels: 2,
    durationSec: 10,
    nbFrames: null,
    bitRateKbps: null
  })

  const item = (id: string, width: number) => ({
    id,
    path: `C:/${id}`,
    name: id,
    meta: meta(width),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: new Date(0).toISOString()
  })

  it('没有音频段时不写 audioClips 键（旧 JSON 形状不变）', () => {
    const project = createDefaultProject('x')
    const normalized = normalizeProject(JSON.parse(JSON.stringify(project)))!
    expect('audioClips' in normalized).toBe(false)
  })

  it('音频段按时间排序、时长对齐帧、媒体引用非法则丢弃', () => {
    const raw = {
      ...createDefaultProject('x'),
      media: [item('m1', 0), item('v1', 1920)],
      audioClips: [
        { id: 'c2', mediaId: 'm1', timelineStartSec: 8, timelineEndSec: 9, sourceInSec: 0 },
        { id: 'c1', mediaId: 'm1', timelineStartSec: 2.01, timelineEndSec: 4, sourceInSec: 1 },
        { id: 'gone', mediaId: 'missing', timelineStartSec: 0, timelineEndSec: 1 }
      ]
    }
    const normalized = normalizeProject(raw)!
    expect(normalized.audioClips?.map((c) => c.id)).toEqual(['c1', 'c2'])
    const first = normalized.audioClips![0]!
    expect(first.timelineStartSec).toBeCloseTo(2, 3) // 2.01 → 第 60 帧
    expect(first.sourceOutSec - first.sourceInSec).toBeCloseTo(first.timelineEndSec - first.timelineStartSec, 6)
  })

  it('媒体类型：无画面（width=0）判为音频，有画面不写 kind', () => {
    const raw = {
      ...createDefaultProject('x'),
      media: [item('m1', 0), item('v1', 1920)]
    }
    const normalized = normalizeProject(raw)!
    expect(normalized.media.find((m) => m.id === 'm1')!.kind).toBe('audio')
    expect('kind' in normalized.media.find((m) => m.id === 'v1')!).toBe(false)
  })

  it('媒体段的轨道：合法 trackId 保留，旧 layer 投影到 deterministic 轨道，缺省落到第一条媒体轨', () => {
    const raw = {
      ...createDefaultProject('x'),
      mediaTracks: [
        { id: 'track-media-0', kind: 'media', name: '媒体 1', muted: false, hidden: false, locked: false },
        { id: 'track-media-1', kind: 'media', name: '媒体 2', muted: false, hidden: false, locked: false }
      ],
      media: [item('v1', 1920)],
      mediaClips: [
        { id: 'c1', mediaId: 'v1', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0, trackId: 'track-media-1' },
        { id: 'c2', mediaId: 'v1', timelineStartSec: 2, timelineEndSec: 4, sourceInSec: 0, layer: 1 },
        { id: 'c3', mediaId: 'v1', timelineStartSec: 4, timelineEndSec: 6, sourceInSec: 0 }
      ]
    }
    const normalized = normalizeProject(raw)!
    expect(normalized.mediaClips.find((c) => c.id === 'c1')!.trackId).toBe('track-media-1')
    expect(normalized.mediaClips.find((c) => c.id === 'c2')!.trackId).toBe('track-media-1')
    expect(normalized.mediaClips.find((c) => c.id === 'c3')!.trackId).toBe('track-media-0')
    // 旧 layer 键不再写回
    expect('layer' in normalized.mediaClips.find((c) => c.id === 'c2')!).toBe(false)
  })
})
