import { describe, expect, it } from 'vitest'
import {
  ALPHA_DROPPED_MARKER,
  BT709_TAGS,
  PRORES_PROFILE_4444,
  PRORES_PIX_FMT,
  buildCfrArgs,
  buildMediaBasisFilterComplex,
  buildOverlayMp4,
  buildOverlayMp4DirectPipe,
  buildOverlayMp4MultiInput,
  buildOverlayMp4MultiInputDirectPipe,
  buildProbeArgs,
  buildThumbnailArgs,
  buildTransparentMovFromPipe,
  buildTransparentMovFromSeq,
  buildTransparentMovQtrle,
  buildVerifyArgs,
  buildVfrSampleArgs,
  proresArgs
} from '@shared/ffmpegArgs'
import type { ConcatSegment } from '@shared/ffmpegArgs'
import { FPS_23_976, FPS_29_97, FPS_30 } from '@shared/constants'

/**
 * FFmpeg argv 快照（计划 C1–C5 修正的锁定测试）。
 * 这些参数全部经本机 FFmpeg 8.1.1 实证：
 *  - profile 0–3 + yuva444p10le 不报错但静默丢 alpha → 必须显式 4；
 *  - overlay 的 alpha=1 是 premultiplied，直通 alpha 素材要用 straight；
 *  - overlay format=auto 会给出 10-bit 4:4:4，必须补 format=yuv420p；
 *  - ffprobe/ffmpeg 均无 -nologo 选项（传入直接退出）。
 */

describe('透明 MOV argv', () => {
  it('主路径（raw）：未压缩 RGBA 帧流 + prores_ks profile 4 + 无 faststart', () => {
    const args = buildTransparentMovFromPipe(FPS_23_976, 'D:/out/lower.mov', 'raw', {
      width: 1280,
      height: 720
    })
    expect(args.slice(0, 2)).toEqual(['-hide_banner', '-y'])
    expect(args).not.toContain('-nologo')
    expect(args).toContain('rawvideo')
    expect(args).toContain('rgba')
    expect(args).toContain('1280x720')
    expect(args).toContain('-video_size')
    expect(args).toContain('24000/1001')
    expect(args).not.toContain('image2pipe')
    const profileIndex = args.indexOf('-profile:v')
    expect(args[profileIndex + 1]).toBe(PRORES_PROFILE_4444)
    expect(args[profileIndex + 1]).not.toBe('3')
    expect(args).toContain(PRORES_PIX_FMT)
    expect(args).toContain('apl0')
    expect(args).not.toContain('+faststart')
    expect(args.at(-1)).toBe('D:/out/lower.mov')
  })

  it('回退路径（png）：image2pipe + PNG 解码入参', () => {
    const args = buildTransparentMovFromPipe(FPS_30, 'D:/out/lower.mov', 'png')
    expect(args).toContain('image2pipe')
    expect(args).toContain('png')
    expect(args).toContain('-probesize')
    expect(args).not.toContain('rawvideo')
  })

  it('色彩标签固定为 BT.709 + tv range（HDR 丢失后统一回归 SDR）', () => {
    const args = proresArgs()
    expect(args).toContain('bt709')
    expect(args).toContain('-color_range')
    expect(args[args.indexOf('-color_range') + 1]).toBe('tv')
    expect(BT709_TAGS.length).toBe(6)
  })

  it('PNG 序列回退路径带 -start_number 0 与 image 序列模板', () => {
    const args = buildTransparentMovFromSeq(FPS_30, 'C:/tmp/frame_%06d.png', 'D:/out/lower.mov')
    expect(args).toContain('-start_number')
    expect(args[args.indexOf('-start_number') + 1]).toBe('0')
    expect(args).toContain('C:/tmp/frame_%06d.png')
    expect(args).toContain('-framerate')
    expect(args).not.toContain('image2pipe')
  })

  it('qtrle 兼容模式输出 argb 且使用全范围', () => {
    const args = buildTransparentMovQtrle(FPS_30, 'D:/out/lower.mov', 'png')
    expect(args).toContain('qtrle')
    expect(args).toContain('argb')
    expect(args[args.indexOf('-color_range') + 1]).toBe('pc')
  })

  it('alpha 丢失检测串与 FFmpeg 实际告警一致', () => {
    expect(ALPHA_DROPPED_MARKER).toBe('will not encode alpha')
  })
})

describe('叠加合成 argv（计划 C2/C3/C4/C7）', () => {
  const input = {
    refVideoPath: 'D:/videos/ref.mp4',
    overlayPath: 'C:/tmp/overlay.mov',
    outputPath: 'D:/out/final.mp4',
    fps: FPS_23_976,
    spanStartSec: 2.5,
    spanEndSec: 8.75,
    audioMode: 'copy' as const,
    fpsMode: 'cfr' as const
  }

  it('overlay 用 alpha=straight 而不是 premultiplied 数字 1', () => {
    const args = buildOverlayMp4(input)
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain('alpha=straight')
    expect(graph).not.toContain('alpha=1')
  })

  it('滤镜链尾回到 yuv420p（避免 10-bit 4:4:4 交付）', () => {
    const args = buildOverlayMp4(input)
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toMatch(/overlay=.*format=auto.*format=yuv420p/)
  })

  it('span 平移与时间窗、eof_action=pass（C7）', () => {
    const graph = buildOverlayMp4(input)[buildOverlayMp4(input).indexOf('-filter_complex') + 1]
    expect(graph).toContain('setpts=PTS+2.500000/TB')
    expect(graph).toContain("enable='between(t,2.500000,8.750000)'")
    expect(graph).toContain('eof_action=pass')
    expect(graph).toContain('fps=24000/1001')
  })

  it('音频映射可选（无音轨不失败）且 copy 参数正确', () => {
    const args = buildOverlayMp4(input)
    expect(args).toContain('0:a?')
    expect(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 3)).toEqual(['-c:a', 'copy', '-movflags'])
    const aac = buildOverlayMp4({ ...input, audioMode: 'aac' })
    expect(aac).toContain('192k')
  })

  it('VFR 回归输出使用 -fps_mode vfr', () => {
    const args = buildOverlayMp4({ ...input, fpsMode: 'vfr' })
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('vfr')
  })

  it('直接管道合成后端不引用第二个文件输入（两种帧形式均可）', () => {
    const rawArgs = buildOverlayMp4DirectPipe({ ...input })
    expect(rawArgs).toContain('rawvideo')
    expect(rawArgs).not.toContain('C:/tmp/overlay.mov')
    const pngArgs = buildOverlayMp4DirectPipe({ ...input, frameFormat: 'png' })
    expect(pngArgs).toContain('image2pipe')
    expect(pngArgs).not.toContain('C:/tmp/overlay.mov')
  })
})

describe('探测与转码 argv', () => {
  it('ffprobe 参数不含 -nologo（该选项不存在）', () => {
    const probe = buildProbeArgs('D:/a.mp4')
    expect(probe).not.toContain('-nologo')
    expect(probe).toContain('-show_streams')
    const sample = buildVfrSampleArgs('D:/a.mp4', 60).join(' ')
    expect(sample).toContain('%+#60')
    // 字段名在同一项的逗号串里（不是独立元素）
    expect(buildVerifyArgs('D:/a.mov').join(' ')).toContain('codec_tag_string')
    expect(buildVerifyArgs('D:/a.mov')).not.toContain('-nologo')
  })

  it('CFR 转换使用分数 fps 滤镜 + -fps_mode cfr + faststart', () => {
    const args = buildCfrArgs('D:/in.mp4', 'D:/out_cfr.mp4', FPS_29_97, 'copy')
    expect(args).toContain(`fps=${30000}/${1001}`)
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('cfr')
    expect(args).toContain('+faststart')
    expect(args).toContain('copy')
  })
})

describe('v2 缩略图与多输入 trim+concat argv', () => {
  it('缩略图：-ss 在 -i 前做关键帧快定位，单帧 jpg，固定宽度偶数高', () => {
    const args = buildThumbnailArgs('D:/media/a.mp4', 'D:/thumbs/m1.jpg', 1.25, 320)
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args).toContain('-frames:v')
    expect(args).toContain('scale=320:-2,setsar=1')
    expect(args.at(-1)).toBe('D:/thumbs/m1.jpg')
    expect(args).not.toContain('-progress')
  })

  const seg = (over: Partial<ConcatSegment> = {}): ConcatSegment => ({
    refVideoPath: 'D:/media/a.mp4',
    timelineStartSec: 0,
    timelineEndSec: 4,
    sourceInSec: 2,
    sourceOutSec: 6,
    hasAudio: true,
    ...over
  })
  const basis = (segments: ConcatSegment[], withOverlayLabel = '2') => ({
    segments,
    spanStartSec: 0,
    spanEndSec: 10,
    overlayLabel: withOverlayLabel,
    outputPath: 'D:/out/comp.mp4',
    fps: FPS_30,
    frameSize: { width: 1920, height: 1080 },
    audioMode: 'aac' as const,
    fpsMode: 'cfr' as const
  })

  it('两段拼接：逐段 trim + 平移，concat=n=2，透明层取最后一路输入', () => {
    const fc = buildMediaBasisFilterComplex(
      basis([seg(), seg({ refVideoPath: 'D:/media/b.mp4', timelineStartSec: 4, timelineEndSec: 8, sourceInSec: 0, sourceOutSec: 4 })])
    )
    expect(fc).toContain('[0:v]trim=start=2.000000:end=6.000000')
    expect(fc).toContain('[1:v]trim=start=0.000000:end=4.000000')
    expect(fc).toContain('[pres0]setpts=PTS+0.000000/TB[vs0]')
    expect(fc).toContain('[pres1]setpts=PTS+4.000000/TB[vs1]')
    // 两段覆盖 0–8，span 到 10：尾部空隙自动补一段黑场+静音
    expect(fc).toContain('concat=n=3:v=1:a=1[vb][ab]')
    expect(fc).toContain('[2:v]setpts=PTS+0.000000/TB[ov]')
    expect(fc).toContain('overlay=0:0:alpha=straight')
    expect(fc.endsWith('format=yuv420p[v]')).toBe(true)
  })

  it('段间空隙与无音轨段：黑场 + anullsrc 补齐，concat 两侧流结构一致', () => {
    const fc = buildMediaBasisFilterComplex(
      basis([seg({ timelineEndSec: 2 }), seg({ timelineStartSec: 5, timelineEndSec: 7, sourceInSec: 0, sourceOutSec: 2, hasAudio: false })])
    )
    expect(fc).toContain('color=c=black:s=1920x1080')
    expect(fc).toContain('anullsrc=channel_layout=stereo:sample_rate=48000')
    // 中段无音轨 → 自己的静音补位；尾部空隙再补一段
    expect(fc).toContain('[ns1]atrim=duration=2.000000')
    expect(fc).toContain('concat=n=4:v=1:a=1[vb][ab]')
  })

  it('多输入两阶段：N 路 -i + 仅用 -t 限长的透明 MOV，map [v]/[ab]', () => {
    const args = buildOverlayMp4MultiInput({ ...basis([seg()]), overlayPath: 'D:/tmp/overlay.mov' })
    expect(args.filter((a) => a === '-i')).toHaveLength(2)
    // 本机 FFmpeg 8.1.1 实证：`-loop` / `-framerate` 是 image2 解封装器选项，
    // 给 mov 输入会 `Option loop not found.` 并直接退出 —— 这两项不得出现在拼接路径里
    expect(args).not.toContain('-loop')
    expect(args).not.toContain('-framerate')
    const overlayIndex = args.indexOf('D:/tmp/overlay.mov')
    expect(args[overlayIndex - 1]).toBe('-i')
    expect(args[overlayIndex - 3]).toBe('-t')
    expect(args).toContain('D:/tmp/overlay.mov')
    expect(args).toContain('D:/media/a.mp4')
    expect(args[args.indexOf('-map') + 1]).toBe('[v]')
    expect(args).toContain('[ab]')
    expect(args.at(-1)).toBe('D:/out/comp.mp4')
  })

  it('多输入直管道：stdin rawvideo，不引用透明 MOV', () => {
    const args = buildOverlayMp4MultiInputDirectPipe({ ...basis([seg()]), frameFormat: 'raw' })
    expect(args).toContain('rawvideo')
    expect(args).toContain('pipe:0')
    expect(args).not.toContain('D:/tmp/overlay.mov')
    const pngArgs = buildOverlayMp4MultiInputDirectPipe({ ...basis([seg()]), frameFormat: 'png' })
    expect(pngArgs).toContain('image2pipe')
  })
})
