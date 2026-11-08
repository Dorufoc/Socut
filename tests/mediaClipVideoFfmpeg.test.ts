import { describe, expect, it } from 'vitest'
import {
  buildMediaClipVideoFx,
  type MediaClipVideoFxInput
} from '@shared/mediaClipVideoFfmpeg'
import { defaultCurves, defaultMediaVideo, normalizeMediaVideo } from '@shared/mediaClipVideo'
import { FPS_30 } from '@shared/constants'
import type { MediaClipVideo } from '@shared/types'

const videoOf = (over: Partial<MediaClipVideo> = {}): MediaClipVideo => ({
  ...defaultMediaVideo(),
  ...over
})

const inputOf = (over: Partial<MediaClipVideoFxInput> = {}): MediaClipVideoFxInput => ({
  baseLabel: 'in',
  outputLabel: 'out',
  frame: { width: 1920, height: 1080 },
  fps: FPS_30,
  durationSec: 4,
  transparentBackground: false,
  ...over
})

/** 取某一路曲线通道的控制点串 */
function channelPoints(statement: string, channel: 'r' | 'g' | 'b'): string[] {
  const match = new RegExp(`${channel}='([^']+)'`).exec(statement)
  return match ? match[1]!.split(' ') : []
}

describe('片段几何/调色 → FFmpeg 滤镜（v10）', () => {
  it('缺省/默认：空语句，输出标签原样返回（零回归）', () => {
    expect(buildMediaClipVideoFx(inputOf())).toEqual({ statements: [], outputLabel: 'in' })
    expect(buildMediaClipVideoFx(inputOf({ video: defaultMediaVideo() }))).toEqual({
      statements: [],
      outputLabel: 'in'
    })
    // 全部默认的曲线 / 0 值也是默认
    expect(
      buildMediaClipVideoFx(
        inputOf({
          video: videoOf({ curves: defaultCurves() }),
          transparentBackground: true
        })
      )
    ).toEqual({ statements: [], outputLabel: 'in' })
  })

  it('只有亮度：colorchannelmixer 乘性增益，不注入补底/overlay', () => {
    const plan = buildMediaClipVideoFx(inputOf({ video: videoOf({ brightness: 20 }) }))
    expect(plan.outputLabel).toBe('out')
    expect(plan.statements).toEqual([
      '[in]format=rgba,colorchannelmixer=rr=1.2:gg=1.2:bb=1.2:aa=1,format=yuv420p[out]'
    ])
    expect(plan.statements.join(';')).not.toContain('overlay')
    expect(plan.statements.join(';')).not.toContain('color=c=black')
  })

  it('对比度 + 饱和度：单个 eq，两个值都写出；饱和度乘上光感补偿', () => {
    const plan = buildMediaClipVideoFx(inputOf({ video: videoOf({ contrast: 15, saturation: 30 }) }))
    expect(plan.statements.join(';')).toContain('eq=contrast=1.15:saturation=1.3')
  })

  it('光感只改饱和补偿，不单独生成 saturation 以外的滤镜', () => {
    const plan = buildMediaClipVideoFx(inputOf({ video: videoOf({ vibrance: 25 }) }))
    const joined = plan.statements.join(';')
    // lightToneSaturate(25) = 1 + 0.25 * 0.08 = 1.02
    expect(joined).toContain('eq=contrast=1:saturation=1.02')
    // 光感的提亮走曲线表（needsChannelTable 口径）
    expect(joined).toContain('curves=r=')
  })

  it('曲线：每条通道 33 个控制点；直线曲线不注入', () => {
    const plan = buildMediaClipVideoFx(
      inputOf({
        video: videoOf({
          curves: {
            ...defaultCurves(),
            master: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0.6 },
              { x: 1, y: 1 }
            ]
          }
        })
      })
    )
    const curves = plan.statements.join(';')
    expect(curves).toContain('curves=r=')
    for (const channel of ['r', 'g', 'b'] as const) {
      expect(channelPoints(curves, channel)).toHaveLength(33)
    }
    // 直线曲线 + 其余默认：整条链不出现 curves
    const straight = buildMediaClipVideoFx(inputOf({ video: videoOf({ brightness: 10 }) }))
    expect(straight.statements.join(';')).not.toContain('curves=')
  })

  it('曝光/冷暖即使曲线全直线也要注入 curves（通道增益由同一张表承担）', () => {
    const exposure = buildMediaClipVideoFx(inputOf({ video: videoOf({ exposure: 20 }) }))
    expect(exposure.statements.join(';')).toContain('curves=r=')
    const warmth = buildMediaClipVideoFx(inputOf({ video: videoOf({ warmth: 30 }) }))
    expect(warmth.statements.join(';')).toContain('curves=r=')
  })

  it('缩放 + 位移 + 水平镜像：补黑底 + overlay 落点按归一帧尺寸计算', () => {
    const plan = buildMediaClipVideoFx(
      inputOf({
        video: videoOf({ scalePercent: 150, offsetXPercent: 20, offsetYPercent: 10, flipH: true })
      })
    )
    expect(plan.statements).toHaveLength(3)
    expect(plan.statements[0]).toBe(
      '[in]format=rgba,hflip,scale=trunc(iw*1.5/2)*2:trunc(ih*1.5/2)*2:flags=bicubic[fg]'
    )
    // 1920x1080 × 1.5 = 2880x1620；居中后 +20% / +10% 位移 → (-96, -162)
    expect(plan.statements[1]).toBe('color=c=black:s=1920x1080:r=30/1:d=4.000000[bg]')
    expect(plan.statements[2]).toBe(
      '[bg][fg]overlay=x=-96:y=-162:format=auto:eof_action=pass:shortest=0,format=yuv420p[out]'
    )
    expect(plan.statements.join(';')).not.toContain('colorchannelmixer')
    expect(plan.statements.join(';')).not.toContain('eq=')
  })

  it('旋转：包围盒用帧尺寸 × 缩放，透明背景写 black@0.0', () => {
    const plan = buildMediaClipVideoFx(
      inputOf({
        frame: { width: 320, height: 240 },
        transparentBackground: true,
        video: videoOf({ rotationDeg: 90 })
      })
    )
    const joined = plan.statements.join(';')
    expect(joined).toContain('rotate=1.5708:ow=240:oh=320:c=black@0.0')
    expect(plan.statements[1]).toBe('color=c=black@0.0:s=320x240:r=30/1:d=4.000000[bg]')
    // (320-240)/2 = 40；(240-320)/2 = -40
    expect(joined).toContain('overlay=x=40:y=-40')
    expect(joined).toContain('format=rgba[out]')
  })

  it('最终像素格式：透明图层 rgba，单轨基座 yuv420p', () => {
    const transparent = buildMediaClipVideoFx(
      inputOf({ transparentBackground: true, video: videoOf({ brightness: 10 }) })
    )
    expect(transparent.statements[0]).toMatch(/format=rgba\[out\]$/)
    const opaque = buildMediaClipVideoFx(inputOf({ video: videoOf({ brightness: 10 }) }))
    expect(opaque.statements[0]).toMatch(/format=yuv420p\[out\]$/)
  })

  it('脏值：NaN 归一为默认（空语句），越界值夹到合法区间且不出现 NaN', () => {
    expect(
      buildMediaClipVideoFx(inputOf({ video: videoOf({ brightness: Number.NaN }) }))
    ).toEqual({ statements: [], outputLabel: 'in' })

    const dirty = normalizeMediaVideo(
      videoOf({ scalePercent: 9999, offsetXPercent: Number.POSITIVE_INFINITY })
    )
    expect(dirty).toBeDefined()
    const plan = buildMediaClipVideoFx(inputOf({ video: dirty }))
    const joined = plan.statements.join(';')
    expect(joined).not.toContain('NaN')
    // scale 夹到 400% = 4x
    expect(joined).toContain('scale=trunc(iw*4/2)*2:trunc(ih*4/2)*2')
  })
})
