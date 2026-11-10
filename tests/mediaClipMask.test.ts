import { beforeEach, describe, expect, it } from 'vitest'
import { createDefaultProject, normalizeMediaClipMask, normalizeProject } from '@shared/projectSchema'
import type { MediaClip, MediaClipMask, MediaItem } from '@shared/types'
import { useProjectStore } from '../src/renderer/src/state/projectStore'

/**
 * M8：手绘遮罩的数据契约。
 *
 * 锁四件事：
 * 1. 归一化：半径夹到 0.1..50、点夹到 [0,1]、未知 mode/无点笔画丢弃、空 → undefined；
 * 2. 工程 JSON 往返：mask 保留、空 mask 不落盘（旧工程写回逐字节一致）；
 * 3. store：写入归一 + **同值不产生撤销步** + undefined 整键删除 + 未知 id 静默不改；
 * 4. 上限：200 笔 / 每笔 2000 点（工程 JSON 不被一笔画爆）。
 */

function stroke(mode: 'hide' | 'restore', radiusPct: number, points: Array<{ x: number; y: number }>) {
  return { mode, radiusPct, points }
}

describe('normalizeMediaClipMask', () => {
  it('夹取半径与点坐标（越界不报错）；空白/非法输入返回 undefined', () => {
    const mask = normalizeMediaClipMask({
      strokes: [stroke('hide', 999, [{ x: -1, y: 2 }])]
    })
    expect(mask).toBeTruthy()
    expect(mask!.strokes).toHaveLength(1)
    expect(mask!.strokes[0]!.mode).toBe('hide')
    expect(mask!.strokes[0]!.radiusPct).toBe(50)
    expect(mask!.strokes[0]!.points[0]).toEqual({ x: 0, y: 1 })

    expect(normalizeMediaClipMask({ strokes: [stroke('hide', 0, [])] })).toBeUndefined()
    expect(normalizeMediaClipMask({ strokes: [] })).toBeUndefined()
    expect(normalizeMediaClipMask({ strokes: [{ mode: 'blur', radiusPct: 1, points: [{ x: 0.5, y: 0.5 }] }] })).toBeUndefined()
    expect(normalizeMediaClipMask({ strokes: [{ mode: 'hide', radiusPct: 'x', points: [] }] })).toBeUndefined()
    expect(normalizeMediaClipMask(null)).toBeUndefined()
    expect(normalizeMediaClipMask(42)).toBeUndefined()
  })

  it('笔画数量与单笔点数有上限（保护工程 JSON）', () => {
    const many = Array.from({ length: 260 }, () => stroke('hide', 2, [{ x: 0.5, y: 0.5 }]))
    expect(normalizeMediaClipMask({ strokes: many })!.strokes).toHaveLength(200)

    const long = Array.from({ length: 2100 }, (_, index) => ({ x: index / 2100, y: 0.5 }))
    const mask = normalizeMediaClipMask({ strokes: [stroke('hide', 2, long)] })!
    expect(mask.strokes[0]!.points).toHaveLength(2000)
  })

  it('restore 模式保留（擦回语义）', () => {
    const mask = normalizeMediaClipMask({
      strokes: [stroke('hide', 5, [{ x: 0.2, y: 0.2 }]), stroke('restore', 3, [{ x: 0.4, y: 0.4 }])]
    })!
    expect(mask.strokes.map((item) => item.mode)).toEqual(['hide', 'restore'])
  })

  it('M8 羽化：夹到 0..20，0/非法值不落键（硬边 = 旧行为）', () => {
    const strokes = [stroke('hide', 5, [{ x: 0.2, y: 0.2 }])]
    expect(normalizeMediaClipMask({ strokes, featherPct: 6.5 })!.featherPct).toBe(6.5)
    expect(normalizeMediaClipMask({ strokes, featherPct: 99 })!.featherPct).toBe(20)
    expect(normalizeMediaClipMask({ strokes, featherPct: -3 })!.featherPct).toBeUndefined()
    expect(normalizeMediaClipMask({ strokes, featherPct: 0 })!.featherPct).toBeUndefined()
    expect(normalizeMediaClipMask({ strokes, featherPct: 'blur' })!.featherPct).toBeUndefined()
    expect('featherPct' in normalizeMediaClipMask({ strokes })!).toBe(false)
  })

  it('M8 反向遮罩：只有显式 true 才落键；false/非法值不落键（旧工程零回归）', () => {
    const strokes = [stroke('hide', 5, [{ x: 0.2, y: 0.2 }])]
    expect(normalizeMediaClipMask({ strokes, invert: true })!.invert).toBe(true)
    expect(normalizeMediaClipMask({ strokes, invert: false })!.invert).toBeUndefined()
    expect(normalizeMediaClipMask({ strokes, invert: 'yes' })!.invert).toBeUndefined()
    expect('invert' in normalizeMediaClipMask({ strokes })!).toBe(false)
    // 与羽化可共存，写回顺序稳定（strokes → featherPct → invert）
    expect(normalizeMediaClipMask({ strokes, featherPct: 3, invert: true })).toEqual({
      strokes,
      featherPct: 3,
      invert: true
    })
  })
})

describe('工程 JSON：MediaClip.mask', () => {
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

  function rawProjectWithMask(mask: unknown) {
    const project = createDefaultProject('遮罩')
    return {
      ...JSON.parse(JSON.stringify(project)),
      media: [mediaItem()],
      mediaClips: [
        {
          id: 'mclip-1',
          mediaId: 'media-1',
          trackId: project.mediaTracks[0]!.id,
          timelineStartSec: 0,
          timelineEndSec: 5,
          sourceInSec: 0,
          sourceOutSec: 5,
          ...(mask === undefined ? {} : { mask })
        }
      ]
    }
  }

  it('合法 strokes 保留；没有 mask 的媒体段不凭空多出键', () => {
    const project = normalizeProject(
      rawProjectWithMask({ strokes: [stroke('hide', 4, [{ x: 0.25, y: 0.5 }])] })
    )!
    expect(project.mediaClips[0]!.mask?.strokes).toHaveLength(1)

    const plain = normalizeProject(rawProjectWithMask(undefined))!
    expect('mask' in plain.mediaClips[0]!).toBe(false)
  })

  it('全非法 strokes → 整键不落盘', () => {
    const project = normalizeProject(rawProjectWithMask({ strokes: [{ mode: 'oops' }] }))!
    expect('mask' in project.mediaClips[0]!).toBe(false)
  })
})

describe('projectStore.setMediaClipMask', () => {
  function freshProject(): string {
    useProjectStore.setState({
      project: createDefaultProject('遮罩 store'),
      selectedClipId: null,
      selectedMediaClipId: null,
      selectedAudioClipId: null,
      selectedTrackId: null,
      selectionKind: 'subtitle',
      fonts: [],
      revision: 0,
      currentPath: null
    })
    useProjectStore.getState().addClip()
    return useProjectStore.getState().project.clips[0]!.id
  }

  /** 在工程里直接塞一条媒体段（比走插入流程更稳定：遮罩契约与插入无关）。 */
  function seedMediaClip(): string {
    const state = useProjectStore.getState()
    const project = state.project
    const item: MediaItem = {
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
    const clip: MediaClip = {
      id: 'mclip-1',
      mediaId: 'media-1',
      trackId: project.mediaTracks[0]!.id,
      timelineStartSec: 0,
      timelineEndSec: 5,
      sourceInSec: 0,
      sourceOutSec: 5
    }
    useProjectStore.setState({ project: { ...project, media: [item], mediaClips: [clip] }, revision: 1 })
    return clip.id
  }

  beforeEach(() => {
    freshProject()
  })

  it('写入后归一落盘；undefined 整键删除', () => {
    const id = seedMediaClip()
    const mask: MediaClipMask = { strokes: [stroke('hide', 3, [{ x: 0.1, y: 0.2 }])] }
    useProjectStore.getState().setMediaClipMask(id, mask)
    const stored = useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!
    expect(stored.mask).toEqual(mask)

    useProjectStore.getState().setMediaClipMask(id, undefined)
    expect('mask' in useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!).toBe(false)
  })

  it('同值写入不产生新撤销步（点顺序不同但归一后相同）', () => {
    const id = seedMediaClip()
    const mask: MediaClipMask = { strokes: [stroke('hide', 3, [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }])] }
    useProjectStore.getState().setMediaClipMask(id, mask)
    const revision = useProjectStore.getState().revision
    useProjectStore.getState().setMediaClipMask(id, {
      strokes: [stroke('hide', 3, [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }])]
    })
    expect(useProjectStore.getState().revision).toBe(revision)
  })

  it('未知 id 静默不改（不抛错、不推 revision）', () => {
    const revision = useProjectStore.getState().revision
    expect(() => useProjectStore.getState().setMediaClipMask('missing', { strokes: [] })).not.toThrow()
    expect(useProjectStore.getState().revision).toBe(revision)
  })
})
