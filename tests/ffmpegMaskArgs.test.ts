import { describe, expect, it } from 'vitest'
import {
  buildMaskInputArgs,
  buildMediaBasisFilterComplex,
  buildMediaMaskFilterChain,
  buildOverlayMp4MultiInputDirectPipe,
  maskInputIndexFor,
  segmentWantsMask,
  segmentsNeedMultiInput
} from '@shared/ffmpegArgs'
import type { ConcatSegment } from '@shared/ffmpegArgs'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import { FPS_30 } from '@shared/constants'

/**
 * M8 手绘遮罩 argv 层锁定：
 * - 没有 maskPath 时，滤镜图/参数与旧版**逐字节一致**（81 例快照之外的补充断言）；
 * - 有 maskPath 时：mask 输入紧跟在各段媒体输入之后、滤镜里出现 alphaextract/blend/alphamerge；
 * - 单轨基座合黑底回 yuv420p、多轨透明图层保留 RGBA；
 * - overlayLabel = 段数 + 遮罩数（水印/音频的输入序号随之顺延）。
 */

const seg = (over: Partial<ConcatSegment> = {}): ConcatSegment => ({
  refVideoPath: 'D:/media/a.mp4',
  timelineStartSec: 0,
  timelineEndSec: 4,
  sourceInSec: 2,
  sourceOutSec: 6,
  hasAudio: true,
  ...over
})

const basis = (segments: ConcatSegment[], overlayLabel = '2') => ({
  segments,
  spanStartSec: 0,
  spanEndSec: 10,
  overlayLabel,
  outputPath: 'D:/out/comp.mp4',
  fps: FPS_30,
  frameSize: { width: 1920, height: 1080 },
  audioMode: 'aac' as const,
  fpsMode: 'cfr' as const
})

const twoSegs = (over: Partial<ConcatSegment> = {}): ConcatSegment[] => [
  seg({ maskPath: 'D:/m/mask-a.png', ...over }),
  seg({
    timelineStartSec: 4,
    timelineEndSec: 8,
    sourceInSec: 0,
    sourceOutSec: 4,
    maskPath: 'D:/m/mask-b.png'
  })
]

describe('M8 遮罩：默认缺省零回归', () => {
  it('maskPath 缺省 / 空串都不算遮罩', () => {
    expect(segmentWantsMask(seg())).toBe(false)
    expect(segmentWantsMask(seg({ maskPath: '' }))).toBe(false)
    expect(segmentWantsMask(seg({ maskPath: 'D:/m/a.png' }))).toBe(true)
  })

  it('没有遮罩时基座滤镜图与旧版逐字节一致', () => {
    const baseline = buildMediaBasisFilterComplex(basis([seg()]))
    expect(buildMediaBasisFilterComplex(basis([seg({ maskPath: '' })]))).toBe(baseline)
    expect(baseline).not.toContain('alphamerge')
    expect(baseline).not.toContain('blend=all_mode=multiply')
  })

  it('没有遮罩时多输入 argv 不多任何输入/滤镜', () => {
    const plain = [
      seg({ sourceInSec: 0, sourceOutSec: 4 }),
      seg({ timelineStartSec: 4, timelineEndSec: 8, sourceInSec: 0, sourceOutSec: 4 })
    ]
    const without = buildOverlayMp4MultiInputDirectPipe({ ...basis(plain), frameFormat: 'raw' })
    const emptyMask = buildOverlayMp4MultiInputDirectPipe({
      ...basis(plain.map((item) => ({ ...item, maskPath: '' }))),
      frameFormat: 'raw'
    })
    expect(emptyMask).toEqual(without)
    expect(without.join(' ')).not.toContain('mask-a.png')
  })

  it('有遮罩必须切多输入路径（单输入 builder 没有 alphamerge 入口）', () => {
    const whole = seg({ sourceInSec: 0, sourceOutSec: 4 })
    expect(segmentsNeedMultiInput([seg({ ...whole, maskPath: 'D:/m/a.png' })])).toBe(true)
    expect(segmentsNeedMultiInput([whole])).toBe(false)
  })
})

describe('M8 遮罩：输入参数与序号', () => {
  it('遮罩输入 = 静态图只喂 1 帧（framesync repeatlast 补齐，不会拖长段）', () => {
    // 30fps → 一帧间隔 1/30 = 0.033333（不是整段时长：alphamerge 取两路较长者，喂满段会把段拖长）
    expect(buildMaskInputArgs('D:/m/mask-a.png', FPS_30)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30/1',
      '-t',
      '0.033333',
      '-i',
      'D:/m/mask-a.png'
    ])
  })

  it('mask 输入序号 = 段数 + 该段之前的遮罩数', () => {
    const segments = [seg({ maskPath: 'a.png' }), seg(), seg({ maskPath: 'b.png' })]
    expect(maskInputIndexFor(segments, 0)).toBe(3)
    expect(maskInputIndexFor(segments, 1)).toBe(4)
    expect(maskInputIndexFor(segments, 2)).toBe(4)
  })

  it('单段遮罩：mask 输入排在媒体输入之后、stdin 帧流之前', () => {
    const args = buildOverlayMp4MultiInputDirectPipe(
      { ...basis([seg({ maskPath: 'D:/m/mask-a.png' })], '2'), frameFormat: 'raw' },
      null
    )
    const media = args.indexOf('D:/media/a.mp4')
    const mask = args.indexOf('D:/m/mask-a.png')
    const stdin = args.indexOf('pipe:0')
    expect(media).toBeGreaterThan(-1)
    expect(mask).toBeGreaterThan(media)
    expect(stdin).toBeGreaterThan(mask)
    // 遮罩输入用的是一组完整的 image2 输入参数
    const maskAt = args.indexOf('D:/m/mask-a.png')
    expect(args.slice(maskAt - 7, maskAt)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30/1',
      '-t',
      '0.033333',
      '-i'
    ])
  })

  it('overlayLabel = 段数 + 遮罩数：帧流/水印/音频序号整体后移', () => {
    const args = buildOverlayMp4MultiInputDirectPipe(
      {
        ...basis(twoSegs(), '4'),
        frameFormat: 'raw',
        watermark: { path: 'D:/wm.png', sourceWidth: 64, sourceHeight: 32 }
      },
      null
    )
    const graph = args[args.indexOf('-filter_complex') + 1]!
    // 两段各一个遮罩 → mask 输入是 2、3；帧流 4；水印 5
    expect(graph).toContain('[2:v]format=gray,scale=1920:1080[mms0]')
    expect(graph).toContain('[3:v]format=gray,scale=1920:1080[mms1]')
    expect(graph).toContain('[4:v]setpts=PTS+0.000000/TB[ov]')
    expect(graph).toContain('[5:v]format=rgba,scale=')
    // 水印输入确实排在 stdin 帧流之后（-i 顺序）
    expect(args.indexOf('D:/wm.png')).toBeGreaterThan(args.indexOf('pipe:0'))
  })
})

describe('M8 遮罩：段链（单轨合黑底 / 多轨保留透明）', () => {
  it('单轨基座：alphaextract → multiply → alphamerge → 黑底 overlay → yuv420p', () => {
    const graph = buildMediaBasisFilterComplex({
      ...basis(twoSegs(), '4'),
      overlayLabel: '4'
    })
    expect(graph).toContain('[mbs0]alphaextract[maes0]')
    expect(graph).toContain('[2:v]format=gray,scale=1920:1080[mms0]')
    expect(graph).toContain('[maes0][mms0]blend=all_mode=multiply[mams0]')
    expect(graph).toContain('[mbs0][mams0]alphamerge[mons0]')
    // 黑底比段长（4s）+2s，靠 endall 在段结束时收口
    expect(graph).toContain('color=c=black:s=1920x1080:r=30/1:d=6.000000[mbgs0]')
    expect(graph).toContain(
      '[mbgs0][mons0]overlay=0:0:format=auto:eof_action=pass:shortest=0,trim=end=4.000000,setpts=PTS-STARTPTS,format=yuv420p[mouts0]'
    )
    // concat 用的是遮罩后的标签（末帧仍是 yuv420p）
    expect(graph).toContain('[mouts0]null[vs0]')
    // 第二段同样接遮罩（输入序号 3）
    expect(graph).toContain('[3:v]format=gray,scale=1920:1080[mms1]')
    expect(graph).toContain('[mouts1]null[vs1]')
  })

  it('多轨透明图层：保留 RGBA（隐藏区透出下层），不合黑底', () => {
    const graph = buildMediaBasisFilterComplex({
      ...basis(
        [
          seg({ maskPath: 'D:/m/mask-a.png', trackIndex: 0 }),
          seg({ timelineStartSec: 4, timelineEndSec: 8, sourceInSec: 0, sourceOutSec: 4, trackIndex: 0, maskPath: 'D:/m/mask-b.png' }),
          seg({ maskPath: 'D:/m/mask-c.png', trackIndex: 1 })
        ],
        '5'
      )
    })
    expect(graph).toContain('[mbm2][mamm2]alphamerge[monm2]')
    expect(graph).toContain('[monm2]')
    expect(graph).not.toContain('[mbgm2]')
  })

  it('有遮罩段不影响无遮罩段的原有段链', () => {
    const graph = buildMediaBasisFilterComplex(
      basis([
        seg({ maskPath: 'D:/m/mask-a.png' }),
        seg({ timelineStartSec: 4, timelineEndSec: 8, sourceInSec: 0, sourceOutSec: 4 })
      ], '3')
    )
    // 第一段接遮罩，第二段没有 maskPath：仍是旧的非特效链
    expect(graph).toContain('[mouts0]null[vs0]')
    expect(graph).toContain('[pres1]null[vs1]')
    expect(graph).not.toContain('[mbs1]')
  })

  it('有遮挡+缩放/位移时：遮罩先于 fx 几何变换（遮罩随画面一起缩放）', () => {
    const graph = buildMediaBasisFilterComplex(
      basis(
        [
          seg({
            maskPath: 'D:/m/mask-a.png',
            video: { ...defaultMediaVideo(), scalePercent: 80, offsetXPercent: 10 }
          }),
          seg({ timelineStartSec: 4, timelineEndSec: 8, sourceInSec: 0, sourceOutSec: 4 })
        ],
        '3'
      )
    )
    // 遮罩作用在归一化后的段画面（元素空间），随后 fx 才做 scale/位移
    const maskAt = graph.indexOf('[mons0]format=rgba')
    const fxAt = graph.indexOf('overlay=x=')
    expect(maskAt).toBeGreaterThan(-1)
    expect(fxAt).toBeGreaterThan(maskAt)
    // fx 的几何链输入就是遮罩输出（缩放发生在遮罩之后 → 遮罩随画面一起缩放）
    expect(graph).toContain('[mons0]format=rgba,scale=trunc(iw*0.8')
    expect(graph).toContain('[fx0]null[vs0]')
  })

  it('链 helper 的输出标签与语句数可独立断言', () => {
    const transparent = buildMediaMaskFilterChain({
      id: 9,
      sourceLabel: 'src',
      maskInputIndex: 1,
      frameSize: { width: 320, height: 180 },
      fps: FPS_30,
      durationSec: 2,
      opaqueBackground: false
    })
    expect(transparent.outputLabel).toBe('mon9')
    expect(transparent.statements).toHaveLength(5)
    expect(transparent.statements[0]).toBe('[src]format=rgba[mb9]')
    expect(transparent.statements[4]).toBe('[mb9][mam9]alphamerge[mon9]')

    const opaque = buildMediaMaskFilterChain({
      id: 9,
      sourceLabel: 'src',
      maskInputIndex: 1,
      frameSize: { width: 320, height: 180 },
      fps: FPS_30,
      durationSec: 2,
      opaqueBackground: true
    })
    expect(opaque.outputLabel).toBe('mout9')
    expect(opaque.statements).toHaveLength(7)
    expect(opaque.statements[5]).toBe('color=c=black:s=320x180:r=30/1:d=4.000000[mbg9]')
    expect(opaque.statements[6]).toContain('eof_action=pass:shortest=0,trim=end=2.000000')
    expect(opaque.statements[6]).toContain('format=yuv420p[mout9]')
  })
})
