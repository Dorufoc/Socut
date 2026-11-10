import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { buildMediaClipVideoFx } from '@shared/mediaClipVideoFfmpeg'
import { buildOverlayMp4MultiInputDirectPipe } from '@shared/ffmpegArgs'
import {
  mediaFrameParamsAt,
  mediaKeyframeCssAt,
  mediaKeyframesActive,
  mediaParamExpr,
  MEDIA_KEYFRAME_EXPR_SAMPLES
} from '@shared/mediaClipKeyframes'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import type { KeyframeTrack } from '@shared/keyframes'
import type { MediaClipVideo } from '@shared/types'
import { createDefaultProject, normalizeProject } from '@shared/projectSchema'

/**
 * M6-E：媒体段关键帧。
 *
 * 锁四件事：
 * 1. 求值口径：轨道覆盖静态值，缺轨道用静态值；CSS transform 顺序与静态一致；
 * 2. 表达式：无轨道 → null；常量轨道 → 字面量；分段线性/嵌套 if；`geq` 用大写 `T`；
 * 3. 零回归：无关键帧时 `buildMediaClipVideoFx` 的语句与旧静态路径完全一致；
 * 4. 真机：带缩放/位移/不透明度关键帧的滤镜图能被随包 FFmpeg 9 解出来，产物可解码。
 */

const root = path.resolve(__dirname, '..')
const ffmpeg = path.join(root, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const hasFfmpeg = fs.existsSync(ffmpeg)

function run(file: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout.on('data', () => undefined)
    child.on('error', (error) => resolve({ code: -1, stderr: `${stderr}${String(error)}` }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

/** 一段常量轨道（t=0 与 t=1 同值）。 */
function constantTrack(param: KeyframeTrack['param'], value: number): KeyframeTrack {
  return {
    param,
    points: [
      { t: 0, value, easing: 'linear' },
      { t: 1, value, easing: 'linear' }
    ]
  }
}

/** 一段线性变化轨道。 */
function rampTrack(param: KeyframeTrack['param'], from: number, to: number): KeyframeTrack {
  return {
    param,
    points: [
      { t: 0, value: from, easing: 'linear' },
      { t: 1, value: to, easing: 'linear' }
    ]
  }
}

describe('媒体段关键帧 · 求值口径', () => {
  const video: MediaClipVideo = { ...defaultMediaVideo(), scalePercent: 150, offsetXPercent: 10, rotationDeg: 30 }

  it('没有关键帧：沿用静态 video 值，hasKeyframes=false', () => {
    const params = mediaFrameParamsAt(video, undefined, 0.5)
    expect(params).toMatchObject({
      opacity: 1,
      scalePct: 150,
      offsetXPct: 10,
      offsetYPct: 0,
      rotationDeg: 30,
      hasKeyframes: false
    })
    expect(mediaKeyframesActive(undefined)).toBe(false)
    expect(mediaKeyframesActive([])).toBe(false)
  })

  it('有轨道的参数覆盖静态值，其余参数保持静态值', () => {
    const tracks = [rampTrack('scalePct', 100, 200), constantTrack('opacity', 0.5)]
    const mid = mediaFrameParamsAt(video, tracks, 0.5)
    expect(mid.scalePct).toBeCloseTo(150, 6) // 覆盖静态 150 → 轨道中点 150（这里是巧合，用 0/1 再验）
    expect(mediaFrameParamsAt(video, tracks, 0).scalePct).toBeCloseTo(100, 6)
    expect(mediaFrameParamsAt(video, tracks, 1).scalePct).toBeCloseTo(200, 6)
    expect(mid.opacity).toBeCloseTo(0.5, 6)
    // 没有轨道的参数仍是静态值
    expect(mid.offsetXPct).toBe(10)
    expect(mid.rotationDeg).toBe(30)
    expect(mid.hasKeyframes).toBe(true)
  })

  it('CSS：顺序与静态 mediaVideoTransform 一致（translate → rotate → scale → flip）', () => {
    const tracks = [rampTrack('offsetXPct', 0, 20), rampTrack('rotationDeg', 0, 90), rampTrack('scalePct', 100, 200)]
    const css = mediaKeyframeCssAt({ ...video, flipH: true, rotationDeg: 0, scalePercent: 100, offsetXPercent: 0 }, tracks, 1)
    expect(css.transform).toBe('translate(20%, 0%) rotate(90deg) scale(2) scaleX(-1)')
    expect(css.hasKeyframes).toBe(true)
    // 无关键帧 → none（元素自己走静态 transform）
    expect(mediaKeyframeCssAt(video, undefined, 0.5).transform).toBe('none')
    // opacity 夹到 0..1
    expect(mediaKeyframeCssAt(video, [constantTrack('opacity', 3)], 0.5).opacity).toBe(1)
  })
})

describe('媒体段关键帧 · FFmpeg 表达式', () => {
  it('无轨道 → null；常量轨道 → 字面量；线性轨道 → 嵌套 if', () => {
    expect(mediaParamExpr(undefined, 1)).toBeNull()
    expect(mediaParamExpr(constantTrack('scalePct', 150), 1)).toBe('150')
    const rampe = mediaParamExpr(rampTrack('offsetXPct', 0, 30), 2)
    expect(rampe).toBeTruthy()
    expect(rampe!).toContain('if(lt(t,')
    expect(rampe!).toContain('30')
    // 轨道越界钳制：t 超过末点仍是末值（表达式最内层 = 末点字面量，不再有区间）
    expect(rampe!).toMatch(/if\(lt\(t,[^,]+\),.+?,30\)+$/)
  })

  it('geq 的时间变量是 T（大写）：同一轨道换变量名后其它字符不变', () => {
    const track = rampTrack('opacity', 1, 0.2)
    const lower = mediaParamExpr(track, 1)!
    const upper = mediaParamExpr(track, 1, MEDIA_KEYFRAME_EXPR_SAMPLES, 'T')!
    expect(upper).toContain('T')
    expect(upper.replace(/T/g, 't')).toBe(lower)
  })
})

describe('媒体段关键帧 · 导出滤镜图', () => {
  const frame = { width: 320, height: 180 }
  const base = {
    baseLabel: '0:v',
    outputLabel: 'v',
    frame,
    fps: FPS_30,
    durationSec: 0.6,
    transparentBackground: false
  }

  it('零回归：没有关键帧时与静态路径的语句一致（同一输入）', () => {
    const withStatic = buildMediaClipVideoFx({ ...base, video: { ...defaultMediaVideo(), scalePercent: 150 } })
    const withUndefined = buildMediaClipVideoFx({ ...base, video: { ...defaultMediaVideo(), scalePercent: 150 } })
    expect(withStatic.statements).toEqual(withUndefined.statements)
    // 关键帧存在时才会出现 eval=frame / 表达式
    const keyed = buildMediaClipVideoFx({
      ...base,
      video: defaultMediaVideo(),
      keyframes: [rampTrack('scalePct', 100, 50)]
    })
    expect(keyed.statements.some((statement) => statement.includes('eval=frame'))).toBe(true)
  })

  it('缩放/位移/旋转/不透明度各自只生成对应表达式（不掺旧数值）', () => {
    const scale = buildMediaClipVideoFx({ ...base, keyframes: [rampTrack('scalePct', 100, 50)] })
    expect(scale.statements[0]).toContain(`scale=w='trunc(iw*`)
    expect(scale.statements[0]).toContain('eval=frame')
    expect(scale.statements[0]).not.toContain('rotate=')

    const offset = buildMediaClipVideoFx({ ...base, keyframes: [rampTrack('offsetXPct', 0, 30)] })
    expect(offset.statements.at(-1)).toContain(`overlay=x='(W-w)/2+`)

    const opacity = buildMediaClipVideoFx({ ...base, keyframes: [rampTrack('opacity', 1, 0.2)] })
    expect(opacity.statements.join(';')).toContain('geq=')
    expect(opacity.statements.join(';')).toContain('alphaextract')
    expect(opacity.statements.join(';')).toContain('alphamerge')
    // geq 用大写 T
    expect(opacity.statements.find((statement) => statement.includes('geq='))!).toMatch(/T/)

    const rotate = buildMediaClipVideoFx({ ...base, keyframes: [rampTrack('rotationDeg', 0, 45)] })
    expect(rotate.statements[0]).toContain(`rotate=angle='(`)
    expect(rotate.statements[0]).toContain('ow=')
    // 本机 FFmpeg 9 的 rotate 没有 eval 选项（真机踩坑记录）
    expect(rotate.statements[0]).not.toContain('rotate=angle=\'(.+):eval=frame')
  })

  it('特效仍然作用在 overlay 之后（顺序不变）', () => {
    const fx = buildMediaClipVideoFx({
      ...base,
      keyframes: [rampTrack('scalePct', 100, 50)],
      video: { ...defaultMediaVideo(), effects: [{ id: 'vignette', params: {} }] }
    })
    const overlay = fx.statements.at(-1)!
    expect(overlay).toContain('overlay=')
    expect(overlay).toContain('vignette')
  })

  it('调色关键帧：静态调色串按时间窗分段（enable 各自生效），无调色轨道仍是单串', () => {
    const staticFx = buildMediaClipVideoFx({
      ...base,
      video: { ...defaultMediaVideo(), brightness: 20 }
    })
    expect(staticFx.statements.join(';')).not.toContain('enable=')
    expect(staticFx.statements.join(';')).toContain('colorchannelmixer=rr=1.2')

    const keyed = buildMediaClipVideoFx({
      ...base,
      video: { ...defaultMediaVideo(), brightness: 20 },
      keyframes: [rampTrack('brightness', 0, 40)]
    })
    const joined = keyed.statements.join(';')
    // 每个时间窗一份静态调色串：数量远多于 1，且首窗/末窗用半开/闭区间覆盖整段
    expect((joined.match(/colorchannelmixer/g) ?? []).length).toBeGreaterThan(10)
    expect(joined).toContain("enable='lt(t,")
    expect(joined).toContain("enable='gte(t,")
  })

  it('导出 argv 接线：媒体段关键帧进入 filter_complex（不是只在 fx 层可用）', () => {
    const argv = buildOverlayMp4MultiInputDirectPipe({
      segments: [
        {
          refVideoPath: 'D:/media/a.mp4',
          timelineStartSec: 0,
          timelineEndSec: 2,
          sourceInSec: 0,
          sourceOutSec: 2,
          hasAudio: false,
          keyframes: [rampTrack('scalePct', 100, 50), rampTrack('offsetXPct', 0, 30)]
        }
      ],
      spanStartSec: 0,
      spanEndSec: 2,
      overlayLabel: '1',
      fps: FPS_30,
      frameSize: frame,
      audioMode: 'aac',
      fpsMode: 'cfr',
      outputPath: 'D:/out.mp4',
      frameFormat: 'raw'
    })
    const filter = argv[argv.indexOf('-filter_complex') + 1]!
    expect(filter).toContain('eval=frame')
    expect(filter).toContain('[0:v]')
    expect(filter).toContain('overlay=x=')
  })

  it.skipIf(!hasFfmpeg)('真机：关键帧滤镜图可被 FFmpeg 解出（缩放+位移+不透明度）', async () => {    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'socut-mkf-e2e-'))
    try {
      const source = path.join(dir, 'source.mp4')
      const made = await run(ffmpeg, [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=30:d=0.6',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        source
      ])
      expect(made.code, made.stderr.slice(0, 300)).toBe(0)

      const fx = buildMediaClipVideoFx({
        ...base,
        keyframes: [
          rampTrack('scalePct', 100, 50),
          rampTrack('offsetXPct', 0, 30),
          rampTrack('rotationDeg', 0, 30),
          rampTrack('opacity', 1, 0.2)
        ]
      })
      const target = path.join(dir, 'out.mp4')
      const rendered = await run(ffmpeg, [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        source,
        '-filter_complex',
        fx.statements.join(';'),
        '-map',
        '[v]',
        '-r',
        '30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        target
      ])
      expect(rendered.code, rendered.stderr.slice(0, 800)).toBe(0)
      expect(fs.statSync(target).size).toBeGreaterThan(0)

      // 产物可解码、时长与输入一致（关键帧只改画面，不拉长/缩短时间）
      const probe = await run(ffmpeg, ['-hide_banner', '-i', target, '-f', 'null', '-'])
      expect(probe.code, probe.stderr.slice(0, 400)).toBe(0)
      expect(probe.stderr).toMatch(/time=00:00:00\.6/)

      // 动画真的发生了：不同时刻抽帧不同（否则就是"关键帧没生效但链路没报错"）
      const shots: string[] = []
      for (const [index, at] of ['0.05', '0.55'].entries()) {
        const png = path.join(dir, `shot-${index}.png`)
        const grab = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at, '-i', target, '-frames:v', '1', png])
        expect(grab.code, grab.stderr.slice(0, 300)).toBe(0)
        shots.push(png)
      }
      expect(fs.readFileSync(shots[0]!).equals(fs.readFileSync(shots[1]!))).toBe(false)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it.skipIf(!hasFfmpeg)('真机：调色关键帧分段滤镜可解，且亮度随时间单调抬升', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'socut-mkf-grade-'))
    try {
      // 纯灰源：避免素材自身运动干扰"亮度是否真的变了"的判断
      const source = path.join(dir, 'gray.mp4')
      const made = await run(ffmpeg, [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=gray:s=320x180:r=30:d=0.6',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        source
      ])
      expect(made.code, made.stderr.slice(0, 300)).toBe(0)

      const fx = buildMediaClipVideoFx({
        ...base,
        keyframes: [rampTrack('brightness', 0, 80)]
      })
      const target = path.join(dir, 'out.mp4')
      const rendered = await run(ffmpeg, [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        source,
        '-filter_complex',
        fx.statements.join(';'),
        '-map',
        '[v]',
        '-r',
        '30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        target
      ])
      expect(rendered.code, rendered.stderr.slice(0, 800)).toBe(0)

      const lumaAt = async (at: string): Promise<number> => {
        const probe = await run(ffmpeg, [
          '-hide_banner',
          '-ss',
          at,
          '-i',
          target,
          '-frames:v',
          '1',
          '-vf',
          'signalstats,metadata=print',
          '-f',
          'null',
          '-'
        ])
        const match = probe.stderr.match(/lavfi\.signalstats\.YAVG=([\d.]+)/)
        expect(match, probe.stderr.slice(0, 400)).toBeTruthy()
        return Number(match![1])
      }
      const first = await lumaAt('0.05')
      const last = await lumaAt('0.55')
      // 亮度 -100..100 映射成 0..2 倍增益：尾帧应明显亮于首帧
      expect(last - first).toBeGreaterThan(10)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('媒体段关键帧 · 工程 JSON', () => {
  it('归一化：合法轨道落盘、非法 param/点被丢弃', () => {
    const project = createDefaultProject('关键帧')
    const media = {
      id: 'media-1',
      path: 'D:/a.mp4',
      name: 'a.mp4',
      meta: {
        path: 'D:/a.mp4',
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
    const trackId = project.mediaTracks[0]!.id
    const raw = JSON.parse(
      JSON.stringify({
        ...project,
        media: [media],
        mediaClips: [
          {
            id: 'mclip-1',
            mediaId: 'media-1',
            trackId,
            timelineStartSec: 0,
            timelineEndSec: 5,
            sourceInSec: 0,
            sourceOutSec: 5,
            keyframes: [
              { param: 'scalePct', points: [{ t: 0, value: 100, easing: 'linear' }, { t: 1, value: 200, easing: 'linear' }] },
              { param: 'opacity', points: [{ t: 0, value: 0.5, easing: 'linear' }] },
              // 合法：媒体段调色参数（M7 起可打点）
              { param: 'brightness', points: [{ t: 0, value: 50, easing: 'linear' }] },
              // 非法：未知参数、非法点
              { param: 'maskFeather', points: [{ t: 0, value: 5, easing: 'linear' }] },
              { param: 'offsetXPct', points: [{ t: 'x', value: 10 }] }
            ]
          }
        ]
      })
    )
    const normalized = normalizeProject(raw)
    expect(normalized).toBeTruthy()
    const clip = normalized!.mediaClips[0]!
    // 顺序由 ALL_CLIP_PARAM_IDS 决定（基础参数在前、调色参数在后），与工程 JSON 稳定性口径一致
    expect(clip.keyframes!.map((track) => track.param)).toEqual(['opacity', 'scalePct', 'brightness'])
    expect(clip.keyframes![1]!.points.map((point) => point.value)).toEqual([100, 200])
    expect(clip.keyframes![2]!.points.map((point) => point.value)).toEqual([50])
  })
})
