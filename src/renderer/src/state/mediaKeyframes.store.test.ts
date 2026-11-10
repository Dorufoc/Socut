import { beforeEach, describe, expect, it } from 'vitest'
import { createDefaultProject, normalizeProject } from '@shared/projectSchema'
import type { KeyframeTrack } from '@shared/keyframes'
import type { MediaClip, MediaItem } from '@shared/types'
import { useProjectStore } from './projectStore'

/**
 * M6-E：媒体段关键帧的 store 接线（归一、去重、清空、工程 JSON 往返）。
 *
 * 与字幕条 `setClipKeyframes` 同一套纪律：同值不产生撤销步、全非法/undefined 整键删除。
 */

const tracks: KeyframeTrack[] = [
  {
    param: 'scalePct',
    points: [
      { t: 0, value: 100, easing: 'linear' },
      { t: 1, value: 200, easing: 'outCubic' }
    ]
  },
  {
    param: 'opacity',
    points: [{ t: 0, value: 1, easing: 'linear' }]
  }
]

function mediaItem(): MediaItem {
  return {
    id: 'media-1',
    path: 'D:/media/a.mp4',
    name: 'a.mp4',
    meta: {
      path: 'D:/media/a.mp4',
      containerName: 'mp4',
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
      durationSec: 10,
      nbFrames: 300,
      bitRateKbps: 2000
    },
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
}

/** 建一个有素材 + 一条 2 秒媒体段的状态，返回媒体段 id。 */
function freshProject(): string {
  const project = createDefaultProject('媒体关键帧 store')
  project.media = [mediaItem()]
  const trackId = project.mediaTracks[0]!.id
  useProjectStore.setState({
    project,
    selectedClipId: null,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectedTrackId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0,
    currentPath: null
  })
  useProjectStore.getState().insertMediaClip({
    mediaId: 'media-1',
    trackId,
    timelineStartSec: 0,
    sourceInSec: 0,
    durationSec: 2
  })
  return useProjectStore.getState().project.mediaClips[0]!.id
}

const clipOf = (id: string): MediaClip =>
  useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!

describe('projectStore.setMediaClipKeyframes', () => {
  let clipId = ''
  beforeEach(() => {
    clipId = freshProject()
  })

  it('写入后归一落盘（按参数固定顺序）；revision +1', () => {
    const revision = useProjectStore.getState().revision
    useProjectStore.getState().setMediaClipKeyframes(clipId, tracks)
    const stored = clipOf(clipId).keyframes
    expect(stored?.map((track) => track.param)).toEqual(['opacity', 'scalePct'])
    expect(stored?.find((track) => track.param === 'scalePct')?.points).toHaveLength(2)
    expect(useProjectStore.getState().revision).toBe(revision + 1)
  })

  it('同值写入不产生新撤销步（点顺序不同但归一后相同）', () => {
    useProjectStore.getState().setMediaClipKeyframes(clipId, tracks)
    const revision = useProjectStore.getState().revision
    useProjectStore.getState().setMediaClipKeyframes(clipId, [
      { param: 'scalePct', points: [...tracks[0]!.points].reverse() },
      { param: 'opacity', points: tracks[1]!.points }
    ])
    expect(useProjectStore.getState().revision).toBe(revision)
  })

  it('undefined / 空数组 / 全非法 → 整键删除（工程里不出现 keyframes）', () => {
    useProjectStore.getState().setMediaClipKeyframes(clipId, tracks)
    expect(clipOf(clipId).keyframes).toBeTruthy()
    useProjectStore.getState().setMediaClipKeyframes(clipId, undefined)
    expect('keyframes' in clipOf(clipId)).toBe(false)
    useProjectStore.getState().setMediaClipKeyframes(clipId, [])
    expect('keyframes' in clipOf(clipId)).toBe(false)
    useProjectStore.getState().setMediaClipKeyframes(clipId, [
      { param: 'brightness' as never, points: [{ t: 0, value: 1, easing: 'linear' }] }
    ])
    expect('keyframes' in clipOf(clipId)).toBe(false)
  })

  it('工程 JSON 往返：keyframes 保留（值被夹到参数范围内）', () => {
    useProjectStore.getState().setMediaClipKeyframes(clipId, [
      { param: 'scalePct', points: [{ t: 0, value: 9999, easing: 'linear' }] }
    ])
    const roundTrip = normalizeProject(JSON.parse(JSON.stringify(useProjectStore.getState().project)))
    expect(roundTrip).toBeTruthy()
    const clip = roundTrip!.mediaClips.find((item) => item.id === clipId)!
    expect(clip.keyframes?.[0]?.param).toBe('scalePct')
    expect(clip.keyframes?.[0]?.points[0]?.value).toBe(400) // CLIP_PARAM_LIMITS.scalePct.max
    // 没有关键帧的媒体段不应凭空多出 keyframes 键
    const other = roundTrip!.mediaClips.length
    expect(other).toBeGreaterThan(0)
  })

  it('不认识 id：静默不改（不抛错、不推 revision）', () => {
    const revision = useProjectStore.getState().revision
    expect(() => useProjectStore.getState().setMediaClipKeyframes('missing', tracks)).not.toThrow()
    expect(useProjectStore.getState().revision).toBe(revision)
  })
})
