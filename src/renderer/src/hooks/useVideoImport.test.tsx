import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultProject } from '@shared/projectSchema'
import type { CompatFlags, VideoMeta } from '@shared/types'
import { importMediaBatch, importMediaWith, type PickedVideo } from './useVideoImport'
import { useProjectStore } from '../state/projectStore'

/**
 * 导入契约（v12）：导入只把媒体写入素材库，绝不自动往时间轴铺片段。
 * 用户需要显式拖拽或点「放到播放头」才会生成媒体片段。
 */

const META: VideoMeta = {
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
  durationSec: 10,
  nbFrames: null,
  bitRateKbps: null
}

const FLAGS: CompatFlags = {
  non169: false,
  portrait: false,
  ultraWide: false,
  hdr: false,
  vfr: false,
  noAudio: false,
  audioTranscodeNeeded: false
}

function picked(path = META.path): PickedVideo {
  return {
    path,
    probe: {
      meta: { ...META, path },
      flags: { ...FLAGS },
      suggestedFps: { num: 30, den: 1 }
    }
  }
}

function resetProject(): void {
  useProjectStore.setState({ project: createDefaultProject('导入契约'), fonts: [], revision: 0 })
}

beforeEach(() => {
  resetProject()
  ;(window as unknown as { focusnews: unknown }).focusnews = {
    media: {
      generateThumb: vi.fn(async () => null)
    }
  }
})

describe('importMediaWith 只入素材库', () => {
  it('单枚导入后素材池 +1，时间轴媒体片段保持 0', async () => {
    const outcome = await importMediaWith(picked())
    const state = useProjectStore.getState()

    expect(outcome.cancelled).toBe(false)
    expect(outcome.mediaId).not.toBeNull()
    expect(state.project.media).toHaveLength(1)
    expect(state.project.mediaClips).toHaveLength(0)
  })

  it('批量导入同样不自动落时间轴', async () => {
    const outcomes = await importMediaBatch([picked('C:/media/a.mp4'), picked('C:/media/b.mp4')])
    const state = useProjectStore.getState()

    expect(outcomes.every((item) => !item.cancelled)).toBe(true)
    expect(state.project.media).toHaveLength(2)
    expect(state.project.mediaClips).toHaveLength(0)
  })
})
