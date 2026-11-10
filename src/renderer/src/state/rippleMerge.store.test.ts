import { beforeEach, describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import type { MediaItem, Project, VideoMeta } from '@shared/types'
import { useProjectStore } from './projectStore'

/**
 * M5 剪辑操作（store 侧）：波纹删除与相邻合并。
 *
 * 纯函数口径在 `tests/timelineOps.test.ts`；这里只钉住 store 的接线：
 * 锁定轨拒绝、选中态交还、撤销历史里算一步（revision 递增）、工程时间轴不变形。
 */

function baseMeta(over: Partial<VideoMeta> = {}): VideoMeta {
  return {
    path: 'C:/media/a.mp4',
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
    durationSec: 30,
    nbFrames: null,
    bitRateKbps: null,
    ...over
  }
}

function seedItem(): Omit<MediaItem, 'id'> {
  return {
    path: 'C:/media/a.mp4',
    name: 'a.mp4',
    meta: baseMeta(),
    non169Ack: false,
    hdrAck: false,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
}

function freshProject(project?: Project): string {
  useProjectStore.setState({
    project: project ?? createDefaultProject('M5 剪辑操作'),
    selectedClipId: null,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectedTrackId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0,
    currentPath: null
  })
  return useProjectStore.getState().addMedia(seedItem())
}

function mediaClipById(id: string) {
  return useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!
}

describe('projectStore.rippleDeleteMediaClip', () => {
  let mediaId = ''
  beforeEach(() => {
    mediaId = freshProject()
  })

  it('删除中间段后同轨后续片段左移合拢，选中态交还给同轨剩余片段', () => {
    const store = useProjectStore.getState()
    const a = store.insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 2 })!
    store.insertMediaClip({ mediaId, timelineStartSec: 2, durationSec: 2 })
    const c = store.insertMediaClip({ mediaId, timelineStartSec: 6, durationSec: 2 })!
    expect(mediaClipById(c.id).timelineStartSec).toBe(6)

    const beforeRevision = useProjectStore.getState().revision
    // 删中间段（b）：c 从 6 左移到 4
    const b = useProjectStore
      .getState()
      .project.mediaClips.find((clip) => clip.timelineStartSec === 2)!
    useProjectStore.getState().selectMediaClip(b.id)
    const ok = useProjectStore.getState().rippleDeleteMediaClip(b.id)

    expect(ok).toBe(true)
    expect(useProjectStore.getState().project.mediaClips.map((clip) => clip.id).sort()).toEqual([a.id, c.id].sort())
    expect(mediaClipById(c.id).timelineStartSec).toBe(4)
    expect(mediaClipById(c.id).timelineEndSec).toBe(6)
    // 撤销算一步：revision 只 +1
    expect(useProjectStore.getState().revision).toBe(beforeRevision + 1)
    // 被删的是选中段：选中态交还给同轨剩余片段，而不是留空
    expect(useProjectStore.getState().selectedMediaClipId).not.toBeNull()
    expect(useProjectStore.getState().selectedMediaClipId).not.toBe(b.id)
  })

  it('轨道锁定时拒绝波纹删除并保持工程不变', () => {
    const store = useProjectStore.getState()
    const a = store.insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 2 })!
    const trackId = a.trackId
    const project = useProjectStore.getState().project
    useProjectStore.setState({
      project: {
        ...project,
        mediaTracks: project.mediaTracks.map((track) =>
          track.id === trackId ? { ...track, locked: true } : track
        )
      }
    })
    const ok = useProjectStore.getState().rippleDeleteMediaClip(a.id)
    expect(ok).toBe(false)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(1)
  })

  it('片段不存在返回 false', () => {
    expect(useProjectStore.getState().rippleDeleteMediaClip('missing')).toBe(false)
  })
})

describe('projectStore.mergeMediaClipWithNext', () => {
  let mediaId = ''
  beforeEach(() => {
    mediaId = freshProject()
  })

  /** 插入一条 4s 片段并在 2s 处切开，得到源连续的左右两段。 */
  function splitPair() {
    const inserted = useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 4 })!
    useProjectStore.getState().selectMediaClip(inserted.id)
    const rightId = useProjectStore.getState().splitTargetAt(2)!
    const clips = useProjectStore.getState().project.mediaClips
    const left = clips.find((clip) => clip.timelineStartSec === 0)!
    const right = clips.find((clip) => clip.id === rightId)!
    return { left, right }
  }

  it('同轨相邻、源连续的两段合并成一段，时长与源窗口守恒', () => {
    const { left } = splitPair()
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2)
    const ok = useProjectStore.getState().mergeMediaClipWithNext(left.id)
    expect(ok).toBe(true)
    const clips = useProjectStore.getState().project.mediaClips
    expect(clips).toHaveLength(1)
    expect(clips[0]!.id).toBe(left.id)
    expect(clips[0]!.timelineStartSec).toBe(0)
    expect(clips[0]!.timelineEndSec).toBe(4)
    expect(clips[0]!.sourceInSec).toBe(left.sourceInSec)
    expect(clips[0]!.sourceOutSec).toBe(left.sourceOutSec + 2)
    expect(useProjectStore.getState().selectedMediaClipId).toBe(left.id)
    expect(useProjectStore.getState().selectionKind).toBe('media')
  })

  it('中间有空隙时拒绝合并', () => {
    const store = useProjectStore.getState()
    const a = store.insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 2 })!
    store.insertMediaClip({ mediaId, timelineStartSec: 3, durationSec: 2 })
    expect(useProjectStore.getState().mergeMediaClipWithNext(a.id)).toBe(false)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2)
  })

  it('最后一段没有下一段时返回 false', () => {
    const a = useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 2 })!
    expect(useProjectStore.getState().mergeMediaClipWithNext(a.id)).toBe(false)
  })

  it('轨道锁定时拒绝合并', () => {
    const { left } = splitPair()
    const project = useProjectStore.getState().project
    useProjectStore.setState({
      project: {
        ...project,
        mediaTracks: project.mediaTracks.map((track) => ({ ...track, locked: true }))
      }
    })
    expect(useProjectStore.getState().mergeMediaClipWithNext(left.id)).toBe(false)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(2)
  })

  it('合并后 30fps 工程时间轴总长不变', () => {
    const { left } = splitPair()
    const before = useProjectStore.getState().project.mediaClips.reduce(
      (acc, clip) => Math.max(acc, clip.timelineEndSec),
      0
    )
    useProjectStore.getState().mergeMediaClipWithNext(left.id)
    const after = useProjectStore.getState().project.mediaClips.reduce(
      (acc, clip) => Math.max(acc, clip.timelineEndSec),
      0
    )
    expect(after).toBeCloseTo(before, 9)
    // 时间轴照样以秒存、帧对齐（30fps 下 4s = 120 帧）
    expect(Math.round(after * FPS_30.num)).toBe(120)
  })
})

describe('projectStore.freezeFrameAt（M5 冻结帧）', () => {
  let mediaId = ''
  beforeEach(() => {
    mediaId = freshProject()
    delete (window as unknown as { socut?: unknown }).socut
  })

  /** 装一个只实现 extractFrame 的 window.socut（store 只用到这一条通道）。 */
  function stubExtract(result: { path: string | null; width: number; height: number }): { calls: number } {
    const state = { calls: 0 }
    ;(window as unknown as { socut: unknown }).socut = {
      media: {
        extractFrame: async () => {
          state.calls += 1
          return result
        }
      }
    }
    return state
  }

  it('在 2s 处插入 1s 冻结帧：切点两侧拆分 + 右段右移 + 冻结帧素材入池', async () => {
    useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 4 })
    const spy = stubExtract({ path: 'C:/freezes/a-2.png', width: 1920, height: 1080 })

    const freezeId = await useProjectStore.getState().freezeFrameAt(2)

    expect(freezeId).not.toBeNull()
    expect(spy.calls).toBe(1)
    const project = useProjectStore.getState().project
    expect(project.mediaClips).toHaveLength(3)
    const freeze = project.mediaClips.find((clip) => clip.id === freezeId)!
    expect(freeze.timelineStartSec).toBe(2)
    expect(freeze.timelineEndSec).toBe(3)
    // 抽出来的 PNG 作为 image 素材入池
    const still = project.media.find((item) => item.id === freeze.mediaId)!
    expect(still.kind).toBe('image')
    expect(still.path).toBe('C:/freezes/a-2.png')
    // 右段整体右移到 3..5，源窗口不变
    const right = project.mediaClips.find((clip) => clip.timelineStartSec === 3)!
    expect(right.timelineEndSec).toBe(5)
    expect(right.sourceInSec).toBe(2)
    expect(right.sourceOutSec).toBe(4)
    // 选中态落在冻结帧上，检查器切到媒体视图
    expect(useProjectStore.getState().selectedMediaClipId).toBe(freezeId)
    expect(useProjectStore.getState().selectionKind).toBe('media')
  })

  it('抽帧失败（path=null）时不改工程', async () => {
    useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 4 })
    const before = useProjectStore.getState().project.mediaClips.length
    stubExtract({ path: null, width: 0, height: 0 })

    const freezeId = await useProjectStore.getState().freezeFrameAt(2)

    expect(freezeId).toBeNull()
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(before)
  })

  it('没有 window.socut（非 Electron 环境/通道缺失）时返回 null', async () => {
    useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 4 })
    const freezeId = await useProjectStore.getState().freezeFrameAt(2)
    expect(freezeId).toBeNull()
  })

  it('轨道锁定 / 切点越界时直接拒绝，不调用抽帧', async () => {
    useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 4 })
    const spy = stubExtract({ path: 'C:/freezes/a-2.png', width: 1920, height: 1080 })
    expect(await useProjectStore.getState().freezeFrameAt(0)).toBeNull()
    expect(await useProjectStore.getState().freezeFrameAt(4)).toBeNull()

    const project = useProjectStore.getState().project
    useProjectStore.setState({
      project: { ...project, mediaTracks: project.mediaTracks.map((track) => ({ ...track, locked: true })) }
    })
    expect(await useProjectStore.getState().freezeFrameAt(2)).toBeNull()
    expect(spy.calls).toBe(0)
  })
})
