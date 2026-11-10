/**
 * v11：转场选中态与写入返回值（拖拽落点反馈 / Delete 优先级的底层契约）。
 *
 * - `setMediaClipTransition` 返回 boolean：拖拽面板据此区分「已生效」与「被拒绝」；
 * - `selectTransition` 只接受真的挂着转场的切点；
 * - 选中片段/字幕/音频时会把转场选中态清掉，右侧检查器不会停在旧转场上；
 * - 锁定轨道不可写转场。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import type { MediaClip, Project } from '@shared/types'
import { useProjectStore } from './projectStore'

function meta() {
  return {
    path: 'C:/media/a.mp4',
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
    audioCodec: null,
    audioChannels: null,
    durationSec: 30,
    nbFrames: null,
    bitRateKbps: null
  }
}

function seed(options: { gapSec?: number; locked?: boolean } = {}): Project {
  const project = createDefaultProject('转场选中')
  project.fps = FPS_30
  const item = {
    id: 'media-1',
    path: 'C:/media/a.mp4',
    name: 'a.mp4',
    meta: meta(),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none' as const,
    compactMode: 'auto' as const,
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
  const bStart = 2 + (options.gapSec ?? 0)
  const a: MediaClip = {
    id: 'a',
    mediaId: item.id,
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 0,
    sourceOutSec: 2
  }
  const b: MediaClip = {
    id: 'b',
    mediaId: item.id,
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: bStart,
    timelineEndSec: bStart + 2,
    sourceInSec: 2,
    sourceOutSec: 4
  }
  project.media = [item]
  project.mediaClips = [a, b]
  project.mediaTracks = project.mediaTracks.map((track) => ({ ...track, locked: options.locked === true }))
  useProjectStore.setState({
    project,
    selectedClipId: null,
    selectedMediaClipId: null,
    selectedTransitionClipId: null,
    selectionKind: 'subtitle',
    fonts: []
  })
  return project
}

const clipOf = (id: string) => useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!

beforeEach(() => {
  seed()
})

afterEach(() => {
  useProjectStore.setState({ project: createDefaultProject('空') })
})

describe('setMediaClipTransition 的返回值与选中态', () => {
  it('合法切点写入后返回 true；选中转场后 Delete 走 removeSelected 删转场', () => {
    expect(useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })).toBe(true)
    expect(clipOf('b').transitionIn).toEqual({ type: 'dissolve', durationSec: 0.5 })

    useProjectStore.getState().selectTransition('b')
    expect(useProjectStore.getState().selectionKind).toBe('transition')
    expect(useProjectStore.getState().selectedTransitionClipId).toBe('b')

    expect(useProjectStore.getState().removeSelected()).toBe(true)
    expect('transitionIn' in clipOf('b')).toBe(false)
    expect(useProjectStore.getState().selectionKind).toBe('media')
    expect(useProjectStore.getState().selectedTransitionClipId).toBeNull()
  })

  it('有空隙/首段：写入被拒绝并返回 false', () => {
    seed({ gapSec: 2 })
    expect(useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })).toBe(false)
    expect('transitionIn' in clipOf('b')).toBe(false)
    // 首段没有入场转场
    expect(useProjectStore.getState().setMediaClipTransition('a', { type: 'dissolve', durationSec: 0.5 })).toBe(false)
  })

  it('锁定轨道：只读，拒绝写入', () => {
    seed({ locked: true })
    expect(useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })).toBe(false)
  })

  it('selectTransition 在没有转场的片段上不生效', () => {
    useProjectStore.getState().selectTransition('b')
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
    expect(useProjectStore.getState().selectedTransitionClipId).toBeNull()
  })

  it('选中片段/音频/字幕时会清掉转场选中态', () => {
    useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })
    useProjectStore.getState().selectTransition('b')
    useProjectStore.getState().selectMediaClip('a')
    expect(useProjectStore.getState().selectedTransitionClipId).toBeNull()

    useProjectStore.getState().selectTransition('b')
    useProjectStore.getState().selectClip(null)
    expect(useProjectStore.getState().selectedTransitionClipId).toBeNull()
  })

  it('删除承载转场的片段会同时清掉转场选中态', () => {
    useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })
    useProjectStore.getState().selectTransition('b')

    useProjectStore.getState().removeMediaClip('b')

    const state = useProjectStore.getState()
    expect(state.selectedTransitionClipId).toBeNull()
    expect(state.selectionKind).not.toBe('transition')
  })
})
