import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '@shared/projectSchema'
import type { MediaClip, MediaItem, Project, VideoMeta } from '@shared/types'
import { buildOverlayBase, rasterizeExportMasks } from './exportRunner'

/**
 * M8：渲染侧导出请求的遮罩接线。
 *
 * 覆盖：
 * - `buildOverlayBase` 只在片段有 mask 时带 `mask` 键（旧工程 segments 无该键 → 请求逐字节不变）；
 * - 带 mask 的段强制走多输入路径（主进程才有逐段 alphamerge 插入点）；
 * - `rasterizeExportMasks` 用导出画布尺寸逐段光栅化，clipId 归属与段顺序一致。
 */

function meta(durationSec: number): VideoMeta {
  return {
    path: 'D:/media/a.mp4',
    containerName: 'mov',
    width: 1920,
    height: 1080,
    sar: { num: 1, den: 1 },
    displayRatio: 16 / 9,
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 },
    pixFmt: 'yuv420p',
    colorPrimaries: 'bt709',
    colorSpace: 'bt709',
    colorTransfer: 'bt709',
    colorRange: 'tv',
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioChannels: 2,
    durationSec,
    nbFrames: Math.round(durationSec * 30),
    bitRateKbps: 4000
  }
}

function fixture(mask?: MediaClip['mask']): { project: Project; clip: MediaClip; item: MediaItem } {
  const project = createDefaultProject('遮罩导出')
  const track = project.mediaTracks[0]!
  const item: MediaItem = {
    id: 'media-1',
    path: 'D:/media/a.mp4',
    name: 'a.mp4',
    meta: meta(4),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'converted',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-11-10T00:00:00.000Z'
  }
  const clip: MediaClip = {
    id: 'mclip-1',
    mediaId: item.id,
    timelineStartSec: 0,
    timelineEndSec: 2,
    sourceInSec: 0,
    sourceOutSec: 2,
    trackId: track.id,
    ...(mask ? { mask } : {})
  }
  project.media = [item]
  project.mediaClips = [clip]
  return { project, clip, item }
}

const MASK = { strokes: [{ mode: 'hide' as const, radiusPct: 5, points: [{ x: 0.2, y: 0.5 }] }] }

describe('buildOverlayBase：遮罩只在新数据上出现', () => {
  it('无 mask 的工程：segments 没有 mask 键（旧请求逐字节不变）', () => {
    const { project, clip } = fixture()
    const base = buildOverlayBase(project)!
    expect(base.segments).toHaveLength(1)
    expect(Object.prototype.hasOwnProperty.call(base.segments[0], 'mask')).toBe(false)
    expect(base.segments[0]!.maskPath).toBeUndefined()
    expect(base.clipIds).toEqual([clip.id])
    // 单段整段覆盖：没有 mask 时不强制多输入
    expect(base.multi).toBe(false)
  })

  it('有 mask 的工程：segments 原样带 mask、并强制多输入路径', () => {
    const { project, clip } = fixture(MASK)
    const base = buildOverlayBase(project)!
    expect(base.segments[0]!.mask).toEqual(MASK)
    expect(base.segments[0]!.maskPath).toBeUndefined()
    expect(base.clipIds).toEqual([clip.id])
    expect(base.multi).toBe(true)
  })

  it('clipIds 与 segments 严格同序（遮罩归属靠这条平行数组）', () => {
    const { project, clip } = fixture(MASK)
    const track = project.mediaTracks[0]!
    project.mediaClips = [
      clip,
      {
        id: 'mclip-2',
        mediaId: clip.mediaId,
        timelineStartSec: 2,
        timelineEndSec: 4,
        sourceInSec: 2,
        sourceOutSec: 4,
        trackId: track.id
      }
    ]
    const base = buildOverlayBase(project)!
    expect(base.segments).toHaveLength(2)
    expect(base.clipIds).toEqual(['mclip-1', 'mclip-2'])
    expect(base.segments[0]!.mask).toEqual(MASK)
    expect(base.segments[1]!.mask).toBeUndefined()
  })
})

describe('rasterizeExportMasks：光栅化归属与尺寸', () => {
  it('按段顺序只光栅化带 mask 的段（尺寸 = 导出画布）', async () => {
    const { project, clip } = fixture(MASK)
    const track = project.mediaTracks[0]!
    project.mediaClips = [
      clip,
      {
        id: 'mclip-2',
        mediaId: clip.mediaId,
        timelineStartSec: 2,
        timelineEndSec: 4,
        sourceInSec: 2,
        sourceOutSec: 4,
        trackId: track.id,
        mask: { strokes: [{ mode: 'restore', radiusPct: 2, points: [{ x: 0.5, y: 0.5 }] }] }
      }
    ]
    const base = buildOverlayBase(project)!
    const calls: Array<{ mask: unknown; width: number; height: number }> = []
    const rasterized = await rasterizeExportMasks(base, 1080, 1920, async (mask, width, height) => {
      calls.push({ mask, width, height })
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.width).toBe(1080)
    expect(calls[0]!.height).toBe(1920)
    expect(calls[0]!.mask).toEqual(MASK)
    expect(calls[1]!.mask).toEqual({ strokes: [{ mode: 'restore', radiusPct: 2, points: [{ x: 0.5, y: 0.5 }] }] })
    expect(rasterized).toEqual([
      { clipId: 'mclip-1', png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      { clipId: 'mclip-2', png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }
    ])
  })

  it('没有遮罩时返回空数组（请求体不落 mediaMasks 键）', async () => {
    const { project } = fixture()
    const base = buildOverlayBase(project)!
    const rasterize = async (): Promise<Uint8Array> => {
      throw new Error('不应被调用')
    }
    expect(await rasterizeExportMasks(base, 1920, 1080, rasterize)).toEqual([])
  })

  it('光栅化失败向上抛（导出直接失败，不静默丢遮罩）', async () => {
    const { project } = fixture(MASK)
    const base = buildOverlayBase(project)!
    await expect(
      rasterizeExportMasks(base, 1920, 1080, async () => {
        throw new Error('没有可用 2D Canvas')
      })
    ).rejects.toThrow(/没有可用 2D Canvas/)
  })
})
