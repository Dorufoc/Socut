import { describe, expect, it } from 'vitest'
import { FPS_30, MIN_CLIP_DURATION_SEC } from '@shared/constants'
import { resolveTargetAt } from '@shared/timelineTargets'
import { MIN_AUDIO_CLIP_SEC, splitAudioClipAt } from '@shared/audioClips'
import { createClip, splitSubtitleClipAt } from '@shared/projectSchema'
import { makeMediaTrack } from '@shared/tracks'
import type { AudioClip, MediaClip, SubtitleClip } from '@shared/types'

/**
 * 时间轴工具栏的「这一刀/这一下删的是谁」（P3）与两类新拆分原语。
 *
 * 规则来自用户明确要求：
 * - 拆分/删除作用于**当前选中的段**（字幕条 / 媒体段 / 音频段三类都算）；
 * - 没有任何选中时，默认落到**媒体轨**里播放头所覆盖的那一段，
 *   多轨时取最下面那一轨（轨道数组索引最小，合成时最先画）；
 * - 连这一段都没有 → 返回 null，由 UI 提示「没有」，而不是悄悄什么也不做。
 */

const MEDIA_TRACKS = [0, 1, 2, 3].map((index) => makeMediaTrack(index))

const NO_SELECTION = { clipId: null, mediaClipId: null, audioClipId: null, kind: 'subtitle' as const }

function mediaClip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    id: over.id ?? 'mclip-a',
    mediaId: over.mediaId ?? 'media-1',
    trackId: over.trackId ?? 'track-media-0',
    timelineStartSec: over.timelineStartSec ?? 0,
    timelineEndSec: over.timelineEndSec ?? 6,
    sourceInSec: over.sourceInSec ?? 0,
    sourceOutSec: over.sourceOutSec ?? 6,
    ...over
  }
}

function audioClip(over: Partial<AudioClip> = {}): AudioClip {
  return {
    id: over.id ?? 'aclip-a',
    mediaId: over.mediaId ?? 'media-1',
    trackId: over.trackId ?? 'track-audio-0',
    timelineStartSec: over.timelineStartSec ?? 0,
    timelineEndSec: over.timelineEndSec ?? 6,
    sourceInSec: over.sourceInSec ?? 0,
    sourceOutSec: over.sourceOutSec ?? 6,
    ...over
  }
}

function subtitle(over: Partial<SubtitleClip> = {}): SubtitleClip {
  const clip = createClip({ startTime: over.startTime ?? 0, fps: FPS_30 })
  return { ...clip, ...over }
}

describe('resolveTargetAt（拆分/删除该操作哪一段）', () => {
  it('选中字幕条时目标就是它，即使播放头落在别处', () => {
    const tracks = {
      mediaTracks: MEDIA_TRACKS,
      clips: [subtitle({ id: 'c1', startTime: 20, endTime: 25 })],
      mediaClips: [mediaClip({ id: 'm1' })],
      audioClips: []
    }
    const target = resolveTargetAt(tracks, { ...NO_SELECTION, clipId: 'c1', kind: 'subtitle' }, 2)

    expect(target).toEqual({ kind: 'subtitle', id: 'c1' })
  })

  it('选中媒体段 / 音频段时各自主导，不被另一条轨上同名的选中态干扰', () => {
    const tracks = {
      mediaTracks: MEDIA_TRACKS,
      clips: [subtitle({ id: 'c1' })],
      mediaClips: [mediaClip({ id: 'm1' })],
      audioClips: [audioClip({ id: 'a1' })]
    }
    // 三者的选中 id 同时存在（项目里两个选中态可以并存），只有 kind 说了算
    const selection = { clipId: 'c1', mediaClipId: 'm1', audioClipId: 'a1' }

    expect(resolveTargetAt(tracks, { ...selection, kind: 'media' }, 2)).toEqual({ kind: 'media', id: 'm1' })
    expect(resolveTargetAt(tracks, { ...selection, kind: 'audio' }, 2)).toEqual({ kind: 'audio', id: 'a1' })
  })

  it('没有选中时退回媒体轨，并且取播放头处最下面那一轨（索引最小）', () => {
    const tracks = {
      mediaTracks: MEDIA_TRACKS,
      clips: [],
      mediaClips: [
        mediaClip({ id: 'base', trackId: 'track-media-0', timelineStartSec: 0, timelineEndSec: 10 }),
        mediaClip({ id: 'mid', trackId: 'track-media-1', timelineStartSec: 0, timelineEndSec: 10 }),
        mediaClip({ id: 'top', trackId: 'track-media-3', timelineStartSec: 0, timelineEndSec: 10 })
      ],
      audioClips: [audioClip({ id: 'a1' })]
    }

    expect(resolveTargetAt(tracks, NO_SELECTION, 4)).toEqual({ kind: 'media', id: 'base' })
  })

  it('没有选中且播放头处没有媒体段：返回 null（UI 据此提示「没有」）', () => {
    const tracks = {
      mediaTracks: MEDIA_TRACKS,
      clips: [subtitle({ id: 'c1', startTime: 0, endTime: 3 })],
      mediaClips: [mediaClip({ id: 'm1', timelineStartSec: 8, timelineEndSec: 12 })],
      audioClips: [audioClip({ id: 'a1', timelineStartSec: 0, timelineEndSec: 20 })]
    }

    // 出点是开区间：正好落在段尾不算覆盖
    expect(resolveTargetAt(tracks, NO_SELECTION, 4)).toBeNull()
    expect(resolveTargetAt(tracks, NO_SELECTION, 12)).toBeNull()
    expect(resolveTargetAt(tracks, NO_SELECTION, 9)).toEqual({ kind: 'media', id: 'm1' })
  })

  it('选中的段已经不存在（撤销/别处删除）：退回默认解析，而不是抓着死 id', () => {
    const tracks = { mediaTracks: MEDIA_TRACKS, clips: [], mediaClips: [mediaClip({ id: 'm1' })], audioClips: [] }

    expect(resolveTargetAt(tracks, { ...NO_SELECTION, clipId: '已删除', kind: 'subtitle' }, 2)).toEqual({
      kind: 'media',
      id: 'm1'
    })
  })
})

describe('splitSubtitleClipAt（字幕条拆分）', () => {
  it('切开：左右首尾相接，文字与样式各自独立副本', () => {
    const clip = subtitle({ id: 'c1', startTime: 2, endTime: 8 })
    clip.content = { title: '长三角一体化新规', subtitle: '省发展改革委解读' }
    clip.fontId = 'noto-sans-sc'

    const result = splitSubtitleClipAt(clip, 5, FPS_30, () => 'c2')

    expect(result).not.toBeNull()
    expect(result!.left.startTime).toBe(2)
    expect(result!.left.endTime).toBe(5)
    expect(result!.right.id).toBe('c2')
    expect(result!.right.startTime).toBe(5)
    expect(result!.right.endTime).toBe(8)
    expect(result!.right.content).toEqual({ title: '长三角一体化新规', subtitle: '省发展改革委解读' })
    // 副本而不是同一个引用：改右半边的文字不能把左边一起改了
    expect(result!.right.content).not.toBe(clip.content)
    expect(result!.right.animation).not.toBe(clip.animation)
    expect(result!.right.styleOverrides).not.toBe(clip.styleOverrides)
  })

  it('切点太靠近端点（任一半不足最短时长）返回 null', () => {
    const clip = subtitle({ id: 'c1', startTime: 0, endTime: 6 })

    expect(splitSubtitleClipAt(clip, MIN_CLIP_DURATION_SEC / 2, FPS_30, () => 'c2')).toBeNull()
    expect(splitSubtitleClipAt(clip, 6 - MIN_CLIP_DURATION_SEC / 2, FPS_30, () => 'c2')).toBeNull()
  })

  it('切点不在本条区间内返回 null', () => {
    const clip = subtitle({ id: 'c1', startTime: 4, endTime: 9 })

    expect(splitSubtitleClipAt(clip, 2, FPS_30, () => 'c2')).toBeNull()
    expect(splitSubtitleClipAt(clip, 12, FPS_30, () => 'c2')).toBeNull()
  })

  it('切点吸附到帧边界：非整秒帧率（29.97）下两半仍然无缝相接', () => {
    const clip = subtitle({ id: 'c1', startTime: 0, endTime: 6 })
    const fps = { num: 30000, den: 1001 }

    const result = splitSubtitleClipAt(clip, 2.0037, fps, () => 'c2')

    expect(result).not.toBeNull()
    expect(result!.left.endTime).toBe(result!.right.startTime)
  })
})

describe('splitAudioClipAt（音频段拆分）', () => {
  it('切开并保持时长恒等式：源窗口按倍速投影到切点', () => {
    const clip = audioClip({ id: 'a1', timelineStartSec: 0, timelineEndSec: 8, sourceInSec: 2, sourceOutSec: 10 })

    const result = splitAudioClipAt(clip, 3, FPS_30, () => 'a2')

    expect(result).not.toBeNull()
    expect(result!.left.timelineEndSec).toBe(3)
    expect(result!.left.sourceOutSec).toBe(5)
    expect(result!.right.timelineStartSec).toBe(3)
    expect(result!.right.sourceInSec).toBe(5)
    expect(result!.right.sourceOutSec).toBe(10)
    // 音量/渐变等参数原样带到两半（拆分不改变处理）
    expect(result!.right.mediaId).toBe('media-1')
  })

  it('2x 变速段：时间轴 1s 吃掉源 2s，切点按倍速投影', () => {
    const clip = audioClip({
      id: 'a1',
      timelineStartSec: 0,
      timelineEndSec: 4,
      sourceInSec: 0,
      sourceOutSec: 8,
      speed: { speed: 2, maintainPitch: true }
    })

    const result = splitAudioClipAt(clip, 1, FPS_30, () => 'a2')

    expect(result!.left.sourceOutSec).toBe(2)
    expect(result!.right.sourceInSec).toBe(2)
  })

  it('任一半不足最短音频时长返回 null', () => {
    const clip = audioClip({ id: 'a1', timelineStartSec: 0, timelineEndSec: 4 })

    expect(splitAudioClipAt(clip, MIN_AUDIO_CLIP_SEC / 2, FPS_30, () => 'a2')).toBeNull()
    expect(splitAudioClipAt(clip, 4 - MIN_AUDIO_CLIP_SEC / 2, FPS_30, () => 'a2')).toBeNull()
    // 与媒体段同一口径：刚好等于最短时长算拆得开，再近一点点就不行
    expect(splitAudioClipAt(clip, MIN_AUDIO_CLIP_SEC, FPS_30, () => 'a2')).not.toBeNull()
    expect(splitAudioClipAt(clip, MIN_AUDIO_CLIP_SEC + 1 / 30, FPS_30, () => 'a2')).not.toBeNull()
  })
})
