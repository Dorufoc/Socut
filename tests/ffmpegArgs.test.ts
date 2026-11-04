import { describe, expect, it } from 'vitest'
import {
  ALPHA_DROPPED_MARKER,
  BT709_TAGS,
  PRORES_PROFILE_4444,
  PRORES_PIX_FMT,
  buildCfrArgs,
  buildOverlayMp4,
  buildOverlayMp4DirectPipe,
  buildProbeArgs,
  buildTransparentMovFromPipe,
  buildTransparentMovFromSeq,
  buildTransparentMovQtrle,
  buildVerifyArgs,
  buildVfrSampleArgs,
  proresArgs
} from '@shared/ffmpegArgs'
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
