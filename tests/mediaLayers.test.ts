import { describe, expect, it } from 'vitest'
import { activeMediaClipSpans, resolveVisibleMediaClips, topActiveMediaClip } from '@shared/mediaClips'
import { IMAGE_STILL_SEC, inferMediaKind, mediaKindOf } from '@shared/audioClips'
import { buildOverlayMp4MultiInput } from '@shared/ffmpegArgs'
import { FPS_30 } from '@shared/constants'
import { makeMediaTrack, mediaTrackOrder } from '@shared/tracks'
import type { MediaClip, VideoMeta } from '@shared/types'

/**
 * v3 多轨合成与图像素材：
 *
 * 1. **多轨合成**：画面不透明 → 同一时刻取轨道索引最大的一段（上层盖下层）；
 *    导出侧的基座要求“互不重叠 + 按序拼接”，所以进滤镜链之前必须先把轨道解开。
 * 2. **图像素材**：按扩展名判 kind、上轨给默认时长、导出用 `-loop 1 -t` 撑成视频流。
 */

const TRACKS = [0, 1, 2].map((index) => makeMediaTrack(index))
const ORDER = mediaTrackOrder(TRACKS)

const clip = (id: string, start: number, end: number, track = 0): MediaClip => ({
  id,
  mediaId: 'm1',
  trackId: `track-media-${track}`,
  timelineStartSec: start,
  timelineEndSec: end,
  sourceInSec: 0,
  sourceOutSec: end - start
})

const meta = (width: number, height = 1080): VideoMeta => ({
  path: 'C:/x',
  containerName: 'mp4',
  width,
  height,
  sar: null,
  displayRatio: 16 / 9,
  rFrameRate: { num: 30, den: 1 },
  avgFrameRate: { num: 30, den: 1 },
  pixFmt: width > 0 ? 'yuv420p' : 'none',
  colorPrimaries: null,
  colorSpace: null,
  colorTransfer: null,
  colorRange: null,
  videoCodec: width > 0 ? 'h264' : 'none',
  audioCodec: width > 0 ? 'aac' : null,
  audioChannels: width > 0 ? 2 : null,
  durationSec: 10,
  nbFrames: null,
  bitRateKbps: null
})

describe('多轨合成：取最上层', () => {
  it('同一时刻多轨重叠时返回轨道索引最大的那条', () => {
    const clips = [clip('base', 0, 10), clip('top', 2, 6, 1)]
    expect(topActiveMediaClip(clips, 3, ORDER)!.id).toBe('top')
    expect(topActiveMediaClip(clips, 8, ORDER)!.id).toBe('base')
    expect(topActiveMediaClip(clips, 20, ORDER)).toBeNull()
  })

  it('同轨重叠时后开始的在上（后放上去的压住先放的）', () => {
    const clips = [clip('first', 0, 8), clip('second', 2, 6)]
    expect(topActiveMediaClip(clips, 3, ORDER)!.id).toBe('second')
  })

  it('被上层遮住的区间不会出现在可见轨道里，相邻同源段会合并', () => {
    const clips = [clip('base', 0, 10), clip('top', 2, 6, 1)]
    const visible = resolveVisibleMediaClips(clips, ORDER)
    // base 被切成 [0,2] + [6,10]，中间由 top 占着
    expect(visible.map((c) => [c.id, c.timelineStartSec, c.timelineEndSec])).toEqual([
      ['base', 0, 2],
      ['top', 2, 6],
      ['base', 6, 10]
    ])
    // 源坐标随切点同步平移（导出 trim 才不会错帧）
    expect(visible[2]!.sourceInSec).toBeCloseTo(6, 6)
    expect(visible[2]!.sourceOutSec).toBeCloseTo(10, 6)
  })

  it('完全不重叠时原样返回（顺序按时间）', () => {
    const clips = [clip('b', 4, 6), clip('a', 0, 2)]
    expect(resolveVisibleMediaClips(clips, ORDER).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('三层嵌套只保留最上层可见段', () => {
    const clips = [clip('l0', 0, 10, 0), clip('l1', 2, 8, 1), clip('l2', 4, 6, 2)]
    expect(resolveVisibleMediaClips(clips, ORDER).map((c) => c.id)).toEqual(['l0', 'l1', 'l2', 'l1', 'l0'])
  })
})

describe('多轨内嵌原声压平（activeMediaClipSpans）', () => {
  it('按最上层把时间轴切成互不重叠的区间，并合并相邻同源段', () => {
    const clips = [clip('base', 0, 10), clip('top', 2, 6, 1)]
    const spans = activeMediaClipSpans(clips, ORDER, 0, 10)
    expect(spans.map((s) => [s.clip.id, s.timelineStartSec, s.timelineEndSec])).toEqual([
      ['base', 0, 2],
      ['top', 2, 6],
      ['base', 6, 10]
    ])
    // 源坐标随切点平移（1x 时等于时间轴坐标）
    expect(spans[2]!.sourceInSec).toBeCloseTo(6, 6)
    expect(spans[2]!.sourceOutSec).toBeCloseTo(10, 6)
  })

  it('本次 span 之外的部分被裁掉，源入点同步平移', () => {
    const clips = [clip('base', 0, 10)]
    const spans = activeMediaClipSpans(clips, ORDER, 3, 7)
    expect(spans).toHaveLength(1)
    expect([spans[0]!.timelineStartSec, spans[0]!.timelineEndSec]).toEqual([3, 7])
    expect(spans[0]!.sourceInSec).toBeCloseTo(3, 6)
    expect(spans[0]!.sourceOutSec).toBeCloseTo(7, 6)
  })

  it('变速时源窗口按倍速换算（时间轴 1s = 源 2s）', () => {
    const base = clip('base', 0, 4)
    const spans = activeMediaClipSpans([{ ...base, speed: { speed: 2, maintainPitch: true } }], ORDER, 1, 3)
    expect(spans[0]!.sourceInSec).toBeCloseTo(2, 6)
    expect(spans[0]!.sourceOutSec).toBeCloseTo(6, 6)
  })

  it('没有覆盖的区间返回空（静音轨片段已被调用方剔除后不会从下层补声）', () => {
    expect(activeMediaClipSpans([], ORDER, 0, 10)).toEqual([])
    expect(activeMediaClipSpans([clip('base', 0, 2)], ORDER, 5, 10)).toEqual([])
  })
})

describe('图像素材', () => {
  it('按扩展名判 kind：png/jpg → image，mp3 → audio，mp4 → video', () => {
    expect(inferMediaKind('C:/a.PNG', meta(1920))).toBe('image')
    expect(inferMediaKind('C:/a.jpg', meta(1920))).toBe('image')
    expect(inferMediaKind('C:/a.mp3', meta(0))).toBe('audio')
    expect(inferMediaKind('C:/a.mp4', meta(1920))).toBe('video')
  })

  it('kind 缺省时按有无画面兜底（旧工程）', () => {
    expect(mediaKindOf({ meta: meta(1920) })).toBe('video')
    expect(mediaKindOf({ meta: meta(0) })).toBe('audio')
    expect(mediaKindOf({ kind: 'image', meta: meta(1920) })).toBe('image')
  })

  it('默认静帧时长是 5s（ffprobe 对单帧图读不出时长）', () => {
    expect(IMAGE_STILL_SEC).toBe(5)
  })

  it('导出用 -loop 1 -t 把静帧撑成视频，且该段必须补静音', () => {
    const args = buildOverlayMp4MultiInput({
      segments: [
        {
          refVideoPath: 'C:/still.png',
          timelineStartSec: 0,
          timelineEndSec: 5,
          sourceInSec: 0,
          sourceOutSec: 5,
          hasAudio: false,
          isImage: true
        }
      ],
      spanStartSec: 0,
      spanEndSec: 5,
      overlayLabel: '1',
      overlayPath: 'C:/tmp/overlay.mov',
      outputPath: 'C:/out/f.mp4',
      fps: FPS_30,
      frameSize: { width: 1920, height: 1080 },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    const joined = args.join(' ')
    expect(joined).toContain('-loop 1 -t 5.000000 -i C:/still.png')
    // 图像段没有音轨 → 滤镜链用 anullsrc 补静音（[0:a] 不存在）
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('anullsrc')
  })
})
