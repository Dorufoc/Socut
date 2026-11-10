/**
 * v11：Delete / 退格 删除「当前选中项」。
 *
 * 锁四件事：
 * 1. 转场选中时（时间轴缝隙图标高亮）Delete 与退格都只删转场，片段本身留下；
 * 2. 没有转场选中时行为不变：仍删选中的字幕条（以及媒体/音频段）；
 * 3. 输入框聚焦时完全不接管（框里的退格是删字）；
 * 4. 没有可删目标 / 门禁弹窗排队中时保持安静，不 preventDefault。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { MediaClip, Project } from '@shared/types'
import { useDeleteSelected, isDeleteKey } from './useDeleteSelected'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

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

/** A[0,2] + B[2,4] 两个紧贴的媒体段；B 上可挂转场。另给一条字幕条。 */
function seedProject(): Project {
  const project = createDefaultProject('删除快捷键')
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
    timelineStartSec: 2,
    timelineEndSec: 4,
    sourceInSec: 2,
    sourceOutSec: 4
  }
  project.media = [item]
  project.mediaClips = [a, b]
  project.clips = [createClip({ startTime: 0, fps: FPS_30 })]
  useProjectStore.setState({
    project,
    selectedClipId: project.clips[0]!.id,
    selectedMediaClipId: null,
    selectedTransitionClipId: null,
    selectionKind: 'subtitle',
    fonts: []
  })
  return project
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const clipOf = (id: string) => useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!

beforeEach(() => {
  seedProject()
  useUiStore.setState({ dialogQueue: [] })
  renderHook(() => useDeleteSelected())
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('isDeleteKey', () => {
  it('Delete 与退格都算删除键，其它键不算', () => {
    expect(isDeleteKey({ key: 'Delete' })).toBe(true)
    expect(isDeleteKey({ key: 'Backspace' })).toBe(true)
    expect(isDeleteKey({ key: 'b' })).toBe(false)
  })
})

describe('useDeleteSelected', () => {
  it('转场选中时 Delete 只删转场，片段保留，并回到视频检查器', () => {
    act(() => {
      useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })
      useProjectStore.getState().selectTransition('b')
    })
    expect(clipOf('b').transitionIn).toBeDefined()

    const event = press({ key: 'Delete' })

    expect('transitionIn' in clipOf('b')).toBe(false)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2)
    const state = useProjectStore.getState()
    expect(state.selectionKind).toBe('media')
    expect(state.selectedTransitionClipId).toBeNull()
    expect(event.defaultPrevented).toBe(true)
  })

  it('退格键同样删除选中的转场', () => {
    act(() => {
      useProjectStore.getState().setMediaClipTransition('b', { type: 'fadeBlack', durationSec: 0.4 })
      useProjectStore.getState().selectTransition('b')
    })

    const event = press({ key: 'Backspace' })

    expect('transitionIn' in clipOf('b')).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('没有转场选中时行为不变：删的是选中的字幕条', () => {
    const clipId = useProjectStore.getState().project.clips[0]!.id
    act(() => useProjectStore.getState().selectClip(clipId))

    press({ key: 'Delete' })

    expect(useProjectStore.getState().project.clips).toHaveLength(0)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2)
  })

  it('输入框聚焦时完全不接管（框里的退格是删字）', () => {
    act(() => {
      useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })
      useProjectStore.getState().selectTransition('b')
    })
    const input = document.createElement('input')
    input.type = 'text'
    document.body.appendChild(input)
    act(() => input.focus())

    const event = press({ key: 'Backspace' }, input)

    expect(clipOf('b').transitionIn).toBeDefined()
    expect(event.defaultPrevented).toBe(false)
  })

  it('没有可删目标时保持安静：不 preventDefault', () => {
    act(() => {
      useProjectStore.setState({ selectionKind: 'subtitle', selectedClipId: null })
    })

    const event = press({ key: 'Delete' })

    expect(event.defaultPrevented).toBe(false)
  })

  it('门禁弹窗排队中让位', () => {
    act(() => {
      useProjectStore.getState().setMediaClipTransition('b', { type: 'dissolve', durationSec: 0.5 })
      useProjectStore.getState().selectTransition('b')
      useUiStore.getState().pushPrompt({
        id: 'dlg-1',
        dialog: { kind: 'confirm', title: 't', body: 'b' },
        resolve: () => undefined
      })
    })

    const event = press({ key: 'Delete' })

    expect(clipOf('b').transitionIn).toBeDefined()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('Shift+Delete 波纹删除（M5）', () => {
  it('删除选中媒体段时同轨后续片段左移合拢', () => {
    act(() => useProjectStore.getState().selectMediaClip('a'))
    expect(clipOf('b').timelineStartSec).toBe(2)

    const event = press({ key: 'Delete', shiftKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(1)
    // b 从 2s 左移到 0s，时长不变
    expect(clipOf('b').timelineStartSec).toBe(0)
    expect(clipOf('b').timelineEndSec).toBe(2)
  })

  it('Shift+Delete 在字幕条选中时回落为普通删除（不触发波纹逻辑）', () => {
    const clipId = useProjectStore.getState().project.clips[0]!.id
    act(() => useProjectStore.getState().selectClip(clipId))

    const event = press({ key: 'Delete', shiftKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(useProjectStore.getState().project.clips).toHaveLength(0)
    // 媒体段一个都没动
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2)
  })

  it('工具栏「磁性删除」开启后，普通 Delete 也走波纹删除', () => {
    act(() => useUiStore.setState({ timelineTools: { ...useUiStore.getState().timelineTools, rippleDelete: true } }))
    act(() => useProjectStore.getState().selectMediaClip('a'))

    const event = press({ key: 'Delete' })

    expect(event.defaultPrevented).toBe(true)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(1)
    expect(clipOf('b').timelineStartSec).toBe(0)
  })
})
