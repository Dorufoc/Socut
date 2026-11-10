import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { KEY_DEFAULTS } from '@shared/keying'
import { createDefaultProject, normalizeProject } from '@shared/projectSchema'
import type { MediaClip, MediaItem, Project, VideoMeta } from '@shared/types'
import { useProjectStore } from './projectStore'

/** M8：媒体段抠像（store + schema 持久化）。 */

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
    bitRate: null,
    nbFrames: null,
    audioChannels: 2,
    bitRateKbps: null
  } as unknown as VideoMeta
}

function seededProject(): Project {
  const project = createDefaultProject('抠像')
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

function fresh(): void {
  useProjectStore.setState({
    project: seededProject(),
    selectedMediaClipId: 'c1',
    selectionKind: 'media',
    fonts: [],
    revision: 0
  })
}

beforeEach(() => fresh())
afterEach(() => fresh())

const clipOf = (): MediaClip => useProjectStore.getState().project.mediaClips[0]!

describe('setClipKey', () => {
  it('设置键控：归一后写入并推进 revision；同值重复设置不再推进', () => {
    useProjectStore.getState().setClipKey('c1', { ...KEY_DEFAULTS, similarity: 0.3 })
    expect(clipOf().key).toMatchObject({ mode: 'chroma', similarity: 0.3 })
    const revision = useProjectStore.getState().revision

    useProjectStore.getState().setClipKey('c1', { ...KEY_DEFAULTS, similarity: 0.3 })
    expect(useProjectStore.getState().revision).toBe(revision)
  })

  it('undefined / 全默认 → 删键（整键不落盘）', () => {
    useProjectStore.getState().setClipKey('c1', { ...KEY_DEFAULTS, similarity: 0.5 })
    expect(clipOf().key).toBeDefined()
    useProjectStore.getState().setClipKey('c1', undefined)
    expect(clipOf().key).toBeUndefined()
    expect('key' in clipOf()).toBe(false)

    useProjectStore.getState().setClipKey('c1', { ...KEY_DEFAULTS })
    expect(clipOf().key).toBeUndefined()
  })

  it('未知片段 id：不产生变更', () => {
    const before = useProjectStore.getState().revision
    useProjectStore.getState().setClipKey('nope', { ...KEY_DEFAULTS, similarity: 0.4 })
    expect(useProjectStore.getState().revision).toBe(before)
  })

  it('schema 往返：键控参数保留（夹取后）', () => {
    useProjectStore.getState().setClipKey('c1', {
      ...KEY_DEFAULTS,
      mode: 'luma',
      color: '#00ff00',
      threshold: 0.4,
      despill: 0
    })
    const normalized = normalizeProject(JSON.parse(JSON.stringify(useProjectStore.getState().project)))
    expect(normalized?.mediaClips[0]?.key).toMatchObject({
      mode: 'luma',
      color: '#00ff00',
      threshold: 0.4,
      despill: 0
    })
  })
})
