import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { createDefaultProject, normalizeProject } from '@shared/projectSchema'
import type { MediaClip, MediaItem, Project, VideoMeta } from '@shared/types'
import { useProjectStore } from './projectStore'

/** M8-P0：外部 matte（store 写入 + schema 归一化/工程往返）。 */

function meta(): VideoMeta {
  return {
    path: 'C:/media/a.mp4',
    containerName: 'mov,mp4',
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
    durationSec: 10,
    nbFrames: null,
    bitRateKbps: null,
    audioChannels: 2
  } as unknown as VideoMeta
}

function seededProject(): Project {
  const project = createDefaultProject('外部 matte')
  project.fps = FPS_30
  const item: MediaItem = {
    id: 'm1',
    name: 'a.mp4',
    thumbnailUrl: '',
    path: 'C:/media/a.mp4',
    meta: meta(),
    non169Ack: true,
    hdrAck: false,
    vfrPolicy: 'none',
    compactMode: 'auto',
    importedAt: new Date(0).toISOString()
  }
  const clip: MediaClip = {
    id: 'c1',
    mediaId: 'm1',
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 0,
    sourceOutSec: 2,
    trackId: project.mediaTracks[0]!.id
  }
  project.media = [item]
  project.mediaClips = [clip]
  return project
}

function loadProject(project: Project): void {
  useProjectStore.getState().loadProject(project, undefined, undefined)
}

beforeEach(() => {
  loadProject(seededProject())
})

afterEach(() => {
  useProjectStore.getState().loadProject(seededProject(), undefined, undefined)
})

describe('projectStore.setMediaClipMatte', () => {
  it('写入 path/kind；同值不产生撤销步；null 清除两键', () => {
    const store = useProjectStore.getState()
    const before = store.revision
    store.setMediaClipMatte('c1', { path: 'C:/m/matte.mp4', kind: 'video' })
    const afterSet = useProjectStore.getState()
    expect(afterSet.project.mediaClips[0]!.mattePath).toBe('C:/m/matte.mp4')
    expect(afterSet.project.mediaClips[0]!.matteKind).toBe('video')
    expect(afterSet.revision).toBe(before + 1)

    // 同值：revision 不变（不产生撤销步）
    afterSet.setMediaClipMatte('c1', { path: 'C:/m/matte.mp4', kind: 'video' })
    expect(useProjectStore.getState().revision).toBe(before + 1)

    // 换类型 = 变更
    useProjectStore.getState().setMediaClipMatte('c1', { path: 'C:/m/matte.mp4', kind: 'image' })
    expect(useProjectStore.getState().project.mediaClips[0]!.matteKind).toBe('image')
    expect(useProjectStore.getState().revision).toBe(before + 2)

    // undefined 清除两键
    useProjectStore.getState().setMediaClipMatte('c1', undefined)
    const cleared = useProjectStore.getState().project.mediaClips[0]!
    expect(cleared.mattePath).toBeUndefined()
    expect(cleared.matteKind).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(cleared, 'mattePath')).toBe(false)
  })

  it('path 空白串视为清除；未知 id 不抛错', () => {
    useProjectStore.getState().setMediaClipMatte('c1', { path: 'C:/m/a.png', kind: 'image' })
    useProjectStore.getState().setMediaClipMatte('c1', { path: '   ', kind: 'image' })
    expect(useProjectStore.getState().project.mediaClips[0]!.mattePath).toBeUndefined()
    expect(() =>
      useProjectStore.getState().setMediaClipMatte('missing', { path: 'C:/m/a.png', kind: 'image' })
    ).not.toThrow()
  })
})

describe('projectSchema：mattePath/matteKind 归一化与往返', () => {
  it('trim + 非法 kind 丢弃 + 空路径整键删除', () => {
    const project = seededProject()
    project.mediaClips[0] = {
      ...project.mediaClips[0]!,
      mattePath: '  C:/m/matte.mkv  ',
      matteKind: 'weird' as never
    }
    const normalized = normalizeProject(project)!
    expect(normalized.mediaClips[0]!.mattePath).toBe('C:/m/matte.mkv')
    expect(normalized.mediaClips[0]!.matteKind).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(normalized.mediaClips[0], 'matteKind')).toBe(false)

    project.mediaClips[0] = { ...project.mediaClips[0]!, mattePath: '   ' }
    const blank = normalizeProject(project)!
    expect(blank.mediaClips[0]!.mattePath).toBeUndefined()
  })

  it('工程 JSON 往返保留 matte（绝对路径 + 类型）', () => {
    const project = seededProject()
    project.mediaClips[0] = { ...project.mediaClips[0]!, mattePath: 'C:/m/matte.mp4', matteKind: 'video' }
    const round = normalizeProject(JSON.parse(JSON.stringify(normalizeProject(project))) as Project)!
    expect(round.mediaClips[0]!.mattePath).toBe('C:/m/matte.mp4')
    expect(round.mediaClips[0]!.matteKind).toBe('video')
  })
})
