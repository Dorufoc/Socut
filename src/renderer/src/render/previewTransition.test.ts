import { describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import type { MediaClip, MediaItem, Project, TransitionType, VideoMeta } from '@shared/types'
import {
  PREVIEW_TRANSITION_MAX_BLUR_PX,
  PREVIEW_TRANSITION_ZOOM_BLUR_PX,
  previewTransitionForTrack,
  transitionStyles
} from './previewTransition'

/** v10 Task 6：转场窗口判定与 19 种效果的预览近似（纯函数）。 */

function meta(durationSec = 10): VideoMeta {
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
    audioCodec: 'aac',
    audioChannels: 2,
    durationSec,
    nbFrames: null,
    bitRateKbps: null
  }
}

function item(id = 'media-1', durationSec = 10): MediaItem {
  return {
    id,
    path: 'C:/media/a.mp4',
    name: 'a.mp4',
    meta: meta(durationSec),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
}

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    id: over.id ?? 'clip',
    mediaId: over.mediaId ?? 'media-1',
    trackId: over.trackId ?? 'track-media-0',
    timelineStartSec: over.timelineStartSec ?? 0,
    timelineEndSec: over.timelineEndSec ?? 2,
    sourceInSec: over.sourceInSec ?? 0,
    sourceOutSec: over.sourceOutSec ?? 2,
    ...over
  }
}

function projectWith(clips: MediaClip[], mediaDuration = 10): Project {
  const project = createDefaultProject('转场预览')
  project.fps = FPS_30
  project.media = [item('media-1', mediaDuration)]
  project.mediaClips = clips
  return project
}

/** 相邻两段：0–2s / 2–4s，右侧入点 0.5s，0.5s 溶解。 */
function pair(over: Partial<MediaClip> = {}): MediaClip[] {
  return [
    clip({ id: 'left', timelineStartSec: 0, timelineEndSec: 2, sourceInSec: 0, sourceOutSec: 2 }),
    clip({
      id: 'right',
      timelineStartSec: 2,
      timelineEndSec: 4,
      sourceInSec: 0.5,
      sourceOutSec: 2.5,
      transitionIn: { type: 'dissolve', durationSec: 0.5 },
      ...over
    })
  ]
}

describe('previewTransitionForTrack：窗口与时相', () => {
  const project = projectWith(pair())

  it('居中跨切点：起点 0、切点 0.5、终点 1，窗口外返回 null', () => {
    const at = (sec: number) =>
      previewTransitionForTrack({ clips: project.mediaClips, atSec: sec, project, fps: FPS_30, trackId: 'track-media-0' })

    expect(at(1.74)).toBeNull()
    expect(at(1.75)).toMatchObject({
      leftClipId: 'left',
      rightClipId: 'right',
      type: 'dissolve',
      cutSec: 2,
      startSec: 1.75,
      endSec: 2.25,
      durationSec: 0.5,
      progress: 0
    })
    expect(at(2)?.progress).toBeCloseTo(0.5, 9)
    expect(at(2.25)).toMatchObject({ progress: 1 })
    expect(at(2.26)).toBeNull()
  })

  it('没有 transitionIn / 有空隙 / 首段都返回 null', () => {
    const noTransition = projectWith([
      clip({ id: 'a', timelineStartSec: 0, timelineEndSec: 2 }),
      clip({ id: 'b', timelineStartSec: 2, timelineEndSec: 4 })
    ])
    expect(
      previewTransitionForTrack({ clips: noTransition.mediaClips, atSec: 2, project: noTransition, fps: FPS_30, trackId: 'track-media-0' })
    ).toBeNull()

    const gap = projectWith(pair({ timelineStartSec: 2.2 }))
    expect(
      previewTransitionForTrack({ clips: gap.mediaClips, atSec: 2.2, project: gap, fps: FPS_30, trackId: 'track-media-0' })
    ).toBeNull()

    const first = projectWith([
      clip({
        id: 'first',
        timelineStartSec: 0,
        timelineEndSec: 2,
        transitionIn: { type: 'dissolve', durationSec: 0.5 }
      })
    ])
    expect(
      previewTransitionForTrack({ clips: first.mediaClips, atSec: 0, project: first, fps: FPS_30, trackId: 'track-media-0' })
    ).toBeNull()
  })

  it('按轨道独立：只返回被查询轨道上的转场', () => {
    const clips = pair().map((c) => ({ ...c, trackId: 'track-media-1' }))
    const project = projectWith(clips)
    expect(
      previewTransitionForTrack({ clips, atSec: 2, project, fps: FPS_30, trackId: 'track-media-0' })
    ).toBeNull()
    expect(
      previewTransitionForTrack({ clips, atSec: 2, project, fps: FPS_30, trackId: 'track-media-1' })?.leftClipId
    ).toBe('left')
  })

  it('时长走 resolveTransitionDuration：头部手柄不足时窗口随夹取后的时长缩短', () => {
    // 右侧 sourceIn = 0.1s → 最大转场 = 2 × 0.1 = 0.2s
    const clips = pair({ sourceInSec: 0.1 })
    const project = projectWith(clips)
    const at = (sec: number) =>
      previewTransitionForTrack({ clips, atSec: sec, project, fps: FPS_30, trackId: 'track-media-0' })

    const state = at(1.9)
    expect(state?.durationSec).toBeCloseTo(0.2, 9)
    expect(state?.startSec).toBeCloseTo(1.9, 9)
    expect(state?.endSec).toBeCloseTo(2.1, 9)
    expect(at(1.85)).toBeNull()
  })
})

const at = (type: TransitionType, progress: number) => transitionStyles(type, progress)

describe('transitionStyles：基础族', () => {
  it('溶解 = 透明度交叉淡化，无闪色、无模糊', () => {
    expect(at('dissolve', 0).left.opacity).toBe(1)
    expect(at('dissolve', 0).right.opacity).toBe(0)
    expect(at('dissolve', 0.25)).toMatchObject({ left: { opacity: 0.75 }, right: { opacity: 0.25 } })
    expect(at('dissolve', 0.5).left.opacity).toBe(0.5)
    expect(at('dissolve', 0.5).flash).toBeUndefined()
    expect(at('dissolve', 0.5).blurPx).toBe(0)
  })

  it('黑场：中点两层透明 + 黑色色块峰值 1，两侧再淡入淡出', () => {
    const mid = at('fadeBlack', 0.5)
    expect(mid.left.opacity).toBe(0)
    expect(mid.right.opacity).toBe(0)
    expect(mid.flash).toEqual({ color: '#000', opacity: 1 })

    const quarter = at('fadeBlack', 0.25)
    expect(quarter.left.opacity).toBeCloseTo(0.5, 9)
    expect(quarter.right.opacity).toBe(0)
    expect(quarter.flash?.opacity).toBeCloseTo(0.5, 9)
  })

  it('白场同构，色块为白', () => {
    expect(at('fadeWhite', 0.5).flash).toEqual({ color: '#fff', opacity: 1 })
    expect(at('fadeWhite', 0).flash?.opacity).toBe(0)
  })

  it('光效闪灰：透明度交叉淡化 + 灰色峰值 0.55', () => {
    const mid = at('lightFlash', 0.5)
    expect(mid.left.opacity).toBe(0.5)
    expect(mid.right.opacity).toBe(0.5)
    expect(mid.flash?.color).toBe('#808080')
    expect(mid.flash?.opacity).toBeCloseTo(0.55, 9)
    expect(at('lightFlash', 0).flash?.opacity).toBeCloseTo(0, 9)
  })
})

describe('transitionStyles：模糊族', () => {
  it('横/纵向模糊两端清晰、中点最大模糊，同时透明度交叉淡化', () => {
    for (const type of ['blurH', 'blurV'] as const) {
      const mid = at(type, 0.5)
      expect(mid.blurPx).toBe(PREVIEW_TRANSITION_MAX_BLUR_PX)
      expect(mid.left).toMatchObject({ opacity: 0.5, filter: `blur(${PREVIEW_TRANSITION_MAX_BLUR_PX}px)` })
      expect(mid.right).toMatchObject({ opacity: 0.5, filter: `blur(${PREVIEW_TRANSITION_MAX_BLUR_PX}px)` })
      expect(at(type, 0).blurPx).toBeCloseTo(0, 9)
      expect(at(type, 1).blurPx).toBeCloseTo(0, 9)
    }
  })
})

describe('transitionStyles：风感（运动模糊平移）', () => {
  it('左移：旧画面从 0 移到 -100%，新画面从 +100% 回到 0，带缓动', () => {
    const start = at('windLeft', 0)
    expect(start.dx).toBe(-1)
    expect(start.dy).toBe(0)
    expect(start.left.opacity).toBe(1)
    expect(start.left.transform).toBeUndefined()
    expect(start.right.transform).toBe('translate(100%, 0%)')
    expect(start.blurPx).toBe(0)

    const half = at('windLeft', 0.5)
    expect(half.left.transform).toBe('translate(-87.5%, 0%)')
    expect(half.right.transform).toBe('translate(12.5%, 0%)')
    expect(half.blurPx).toBe(PREVIEW_TRANSITION_MAX_BLUR_PX)

    const end = at('windLeft', 1)
    expect(end.left.transform).toBe('translate(-100%, 0%)')
    expect(end.right.transform).toBeUndefined()
  })

  it('上移：dy = -1，新画面从下方向进入', () => {
    expect(at('windUp', 0).dy).toBe(-1)
    expect(at('windUp', 0).right.transform).toBe('translate(0%, 100%)')
    expect(at('windUp', 0.5).left.transform).toBe('translate(0%, -87.5%)')
    expect(at('windDown', 0.5).right.transform).toBe('translate(0%, -12.5%)')
  })
})

describe('transitionStyles：推入（cover）', () => {
  it('pushLeft：旧画面不动，新画面从右侧滑入并盖住', () => {
    const start = at('pushLeft', 0)
    expect(start.dx).toBe(-1)
    expect(start.left).toMatchObject({ opacity: 1, zIndex: 1 })
    expect(start.right).toMatchObject({ opacity: 1, zIndex: 2, transform: 'translate(100%, 0%)' })

    expect(at('pushLeft', 0.5).right.transform).toBe('translate(12.5%, 0%)')
    expect(at('pushLeft', 1).right.transform).toBeUndefined()
  })

  it('pushRight / pushUp / pushDown：入画方向与所选方向相反', () => {
    expect(at('pushRight', 0).right.transform).toBe('translate(-100%, 0%)')
    expect(at('pushUp', 0).right.transform).toBe('translate(0%, 100%)')
    expect(at('pushDown', 0).right.transform).toBe('translate(0%, -100%)')
  })
})

describe('transitionStyles：拉出（reveal）', () => {
  it('pullLeft：旧画面 0 → -100%，新画面原地不动且在下层', () => {
    const start = at('pullLeft', 0)
    expect(start.left).toMatchObject({ opacity: 1, zIndex: 2 })
    expect(start.left.transform).toBeUndefined()
    expect(start.right).toMatchObject({ opacity: 1, zIndex: 1 })

    expect(at('pullLeft', 0.5).left.transform).toBe('translate(-87.5%, 0%)')
    expect(at('pullLeft', 1).left.transform).toBe('translate(-100%, 0%)')
    // 移动的旧画面带运动模糊；原地的新画面不模糊
    expect(at('pullLeft', 0.5).left.filter).toBe(`blur(${PREVIEW_TRANSITION_MAX_BLUR_PX}px)`)
    expect(at('pullLeft', 0.5).right.filter).toBeUndefined()
  })

  it('pullUp / pullDown 的方向与位移轴一致', () => {
    expect(at('pullUp', 0.5).left.transform).toBe('translate(0%, -87.5%)')
    expect(at('pullDown', 0.5).left.transform).toBe('translate(0%, 87.5%)')
    expect(at('pullRight', 0.5).left.transform).toBe('translate(87.5%, 0%)')
  })
})

describe('transitionStyles：运镜推近', () => {
  it('新画面 1.16 → 1.0 推近淡入，旧画面淡出，带轻微模糊', () => {
    expect(at('zoomIn', 0).right).toMatchObject({ opacity: 0, zIndex: 2, transform: 'scale(1.16)' })
    expect(at('zoomIn', 0.5).right).toMatchObject({ opacity: 0.5, transform: 'scale(1.08)' })
    expect(at('zoomIn', 0.5).right.filter).toBe(`blur(${PREVIEW_TRANSITION_ZOOM_BLUR_PX}px)`)
    expect(at('zoomIn', 0.5).left.opacity).toBe(0.5)
    expect(at('zoomIn', 1).right).toMatchObject({ opacity: 1, transform: 'scale(1)' })
    expect(at('zoomIn', 1).blurPx).toBeCloseTo(0, 9)
  })

  it('进度夹在 0..1，避免脏值把画面推到窗口外', () => {
    expect(at('dissolve', -0.5).left.opacity).toBe(1)
    expect(at('dissolve', 1.5).right.opacity).toBe(1)
  })
})
