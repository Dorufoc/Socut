import { describe, expect, it } from 'vitest'
import {
  ALPHA_DROPPED_MARKER,
  BT709_TAGS,
  PRORES_PROFILE_4444,
  PRORES_PIX_FMT,
  buildAudioPeaksArgs,
  buildCfrArgs,
  buildMediaBasisFilterComplex,
  buildOverlayMp4,
  buildOverlayMp4DirectPipe,
  buildOverlayMp4MultiInput,
  buildOverlayMp4MultiInputDirectPipe,
  buildProbeArgs,
  buildStabDetectArgs,
  buildStabPreviewArgs,
  buildThumbnailArgs,
  buildStripArgs,
  buildTransparentMovFromPipe,
  buildTransparentMovFromSeq,
  buildTransparentMovQtrle,
  buildVerifyArgs,
  buildVfrSampleArgs,
  proresArgs,
  segmentsNeedMultiInput,
  segmentWantsStab,
  stabSegmentKey
} from '@shared/ffmpegArgs'
import type { AudioPeaksArgsInput, ConcatSegment } from '@shared/ffmpegArgs'
import { FPS_23_976, FPS_29_97, FPS_30 } from '@shared/constants'
import { defaultMediaStab } from '@shared/mediaStab'
import type { ClipAudio, ClipSpeed, MediaClipStab } from '@shared/types'

/** 夹具：一段多输入基座里的媒体段（v2/v8 两处 describe 共用，所以提到模块作用域） */
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

  /**
   * v5 时间帧预览条（Thumbnail Strip）：一次调用完成「均匀抽帧 + 横向 tile 拼接」。
   * 这里锁的是“不能逐格起进程”与“窗口必须就是片段的源区间”两条口径。
   */
  it('预览条：-ss/-t 都在 -i 前限定窗口，tile 格数与请求一致且不留缝', () => {
    const args = buildStripArgs({
      inputPath: 'D:/media/a.mp4',
      outputPath: 'D:/strips/m1-abc.jpg',
      sourceInSec: 2,
      sourceOutSec: 8,
      frames: 8,
      frameWidth: 128
    })
    // 定位与时长都是**输入选项**（在 -i 之前）：关键帧快定位，不逐帧解码整片
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.indexOf('-t')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-ss') + 1]).toBe('2.000000')
    expect(args[args.indexOf('-t') + 1]).toBe('6.000000')
    // 滤镜链：重采样到 8 帧/6s → 缩宽 → 拼成 8x1 长图（padding/margin=0 即无缝）
    const filter = args[args.indexOf('-vf') + 1]
    expect(filter).toContain('fps=1.333333')
    expect(filter).toContain('scale=128:-2')
    expect(filter).toContain('setsar=1')
    expect(filter).toContain('tile=8x1:padding=0:margin=0')
    // 只要一张长图，不起进度管道（不是导出任务）
    expect(args).toContain('-frames:v')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args).not.toContain('-progress')
    expect(args.at(-1)).toBe('D:/strips/m1-abc.jpg')
  })

  it('预览条：格数与时长退化时仍给 FFmpeg 合法正数（不出现 0 时长或 0 格）', () => {
    const args = buildStripArgs({
      inputPath: 'D:/media/a.mp4',
      outputPath: 'D:/strips/x.jpg',
      sourceInSec: 5,
      sourceOutSec: 5.001,
      frames: 0
    })
    expect(args[args.indexOf('-t') + 1]).toBe('0.040000')
    expect(args[args.indexOf('-vf') + 1]).toContain('tile=1x1')
    expect(args[args.indexOf('-ss') + 1]).toBe('5.000000')
    // 负入点不会写进 argv（FFmpeg 会当错参）
    const negative = buildStripArgs({
      inputPath: 'D:/media/a.mp4',
      outputPath: 'D:/strips/y.jpg',
      sourceInSec: -3,
      sourceOutSec: 2,
      frames: 4
    })
    expect(negative[negative.indexOf('-ss') + 1]).toBe('0.000000')
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

describe('防抖（v8：vidstab 两段式）', () => {
  const stabOf = (over: Partial<MediaClipStab> = {}): MediaClipStab => ({
    ...defaultMediaStab(),
    enabled: true,
    ...over
  })

  /** 共用前缀：trim → 归零 → fps（FPS_30 的 fpsToArg = 30/1）；
   *  detect 与合成段链必须逐字一致（.trf 按帧序号索引） */
  const TRIM_PREFIX = 'trim=start=2.000000:end=6.000000,setpts=PTS-STARTPTS,fps=30/1'

  it('零差异锁定：段不带 stabFile 时滤镜图不出现 vidstabtransform', () => {
    // 只带 stab 参数但没分配 .trf（主进程未跑 detect）也不能注入
    const fc = buildMediaBasisFilterComplex(basis([seg({ stab: stabOf() })]))
    expect(fc).not.toContain('vidstabtransform')
    // 与不带 stab 的基线逐字节一致
    expect(fc).toBe(buildMediaBasisFilterComplex(basis([seg()])))
  })

  it('buildStabDetectArgs：与合成段链同帧序列前缀 + result 相对名 + 只解码不编码', () => {
    const args = buildStabDetectArgs({
      inputPath: 'D:/media/a.mp4',
      sourceInSec: 2,
      sourceOutSec: 6,
      fps: FPS_30,
      stab: stabOf({ level: 'high' }),
      resultFile: 'stab_0.trf'
    })
    const vf = args[args.indexOf('-vf') + 1] ?? ''
    expect(vf.startsWith(TRIM_PREFIX)).toBe(true)
    expect(vf).toContain('vidstabdetect')
    expect(vf).toContain('result=stab_0.trf')
    // 画幅口径之外的检测参数：high 档 shakiness=8/accuracy=15
    expect(vf).toContain('shakiness=8')
    expect(vf).toContain('accuracy=15')
    expect(args).toContain('-an')
    expect(args[args.indexOf('-f') + 1]).toBe('null')
    expect(args.at(-1)).toBe('-')
    // 进度管道保留：预分析也要给 UI out_time_us（调用方必须消费 stdout）
    expect(args).toContain('-progress')
  })

  it('三脚架（v8.2）：detect 不写绝对参考帧；transform 走静态超长平滑，绝不再写 vidstab tripod=1', () => {
    const detect = buildStabDetectArgs({
      inputPath: 'D:/media/a.mp4',
      sourceInSec: 2,
      sourceOutSec: 6,
      fps: FPS_30,
      stab: stabOf({ tripod: true }),
      resultFile: 'stab_0.trf'
    })
    const dvf = detect[detect.indexOf('-vf') + 1] ?? ''
    // detect 恒相对：写绝对参考帧会与 transform relative=1 口径冲突
    expect(dvf).not.toContain('tripod')
    const fc = buildMediaBasisFilterComplex(basis([seg({ stab: stabOf({ tripod: true }), stabFile: 'stab_0.trf' })]))
    // 真机实证：vidstabtransform tripod=1 = relative=0:smoothing=0，实拍平移上会放大高频抖动→绝不能用
    expect(fc).not.toContain('tripod=1')
    expect(fc).toContain('smoothing=120')
    expect(fc).toContain('optalgo=gauss')
    expect(fc).toContain('optzoom=1')
    expect(fc).toContain('zoom=6')
    expect(fc).toContain('crop=keep')
    // 静态模式不写动态变倍速度（避免逐帧变倍脉动）
    expect(fc).not.toContain('zoomspeed')
  })

  it('transform 注入位置：fps 之后、setsar 之前；画幅口径 optzoom=2 + crop=keep + bicubic', () => {
    const fc = buildMediaBasisFilterComplex(
      basis([seg({ stab: stabOf({ level: 'standard' }), stabFile: 'stab_0.trf' })])
    )
    // v8 实现：滤镜名与首个选项用 = 连接（真机实证 `vidstabtransform:input=` 报 No option name）；
    // 只断言「紧跟在 trim 链之后」，不绑定 fps 的写法（fps=30 vs 30/1 两种都能对）
    expect(fc).toContain(',vidstabtransform=input=stab_0.trf')
    const chain = fc.split(';')[0]!
    const at = chain.indexOf('vidstabtransform')
    expect(chain.indexOf('fps=30')).toBeLessThan(at)
    expect(chain.indexOf('setsar=1')).toBeGreaterThan(at)
    expect(chain).toContain('smoothing=15')
    expect(chain).toContain('optalgo=opt')
    expect(chain).toContain('optzoom=2')
    expect(chain).toContain('zoomspeed=0.25')
    expect(chain).toContain('interpol=bicubic')
    expect(chain).toContain('crop=keep')
    // 音频链不受影响：atrim 口径与基线一致
    expect(fc).toContain('[0:a]atrim=start=2.000000:end=6.000000')
  })

  it('stabSegmentKey：同源同区间同档位同键；路径/区间/档位/三脚架任一不同则不同键', () => {
    const a = seg({ stab: stabOf() })
    expect(stabSegmentKey(a, FPS_30)).toBe(stabSegmentKey(seg({ stab: stabOf() }), FPS_30))
    expect(stabSegmentKey(a, FPS_30)).not.toBe(stabSegmentKey(seg({ stab: stabOf({ level: 'high' }) }), FPS_30))
    expect(stabSegmentKey(a, FPS_30)).not.toBe(stabSegmentKey(seg({ stab: stabOf({ tripod: true }) }), FPS_30))
    expect(stabSegmentKey(a, FPS_30)).not.toBe(stabSegmentKey(seg({ stab: stabOf(), sourceOutSec: 8 }), FPS_30))
    expect(stabSegmentKey(a, FPS_30)).not.toBe(stabSegmentKey(seg({ stab: stabOf(), refVideoPath: 'D:/media/b.mp4' }), FPS_30))
    // 帧率也是键的一部分：不同 fps 重采样后的帧序列不同，.trf 不可复用
    expect(stabSegmentKey(a, FPS_30)).not.toBe(stabSegmentKey(a, FPS_29_97))
  })

  it('segmentWantsStab：开关打开且分到 .trf 才算防抖段', () => {
    expect(segmentWantsStab(seg({ stab: stabOf(), stabFile: 'stab_0.trf' }))).toBe(true)
    expect(segmentWantsStab(seg({ stab: stabOf() }))).toBe(false)
    expect(segmentWantsStab(seg({ stab: { ...defaultMediaStab() }, stabFile: 'stab_0.trf' }))).toBe(false)
    expect(segmentWantsStab(seg())).toBe(false)
  })

  /**
   * v8.1 预览代理：与导出合成段链同一 transform 串、同一 trim+fps 前缀（.trf 帧序号才对得上），
   * 但交付坐标是源区间 1:1（不带时间轴平移），速度优先（veryfast/crf20）。
   */
  it('buildStabPreviewArgs：同前缀同 transform 串 + 带声时 -af atrim 裁到源区间', () => {
    const args = buildStabPreviewArgs({
      inputPath: 'D:/media/a.mp4',
      sourceInSec: 2,
      sourceOutSec: 6,
      fps: FPS_30,
      stab: stabOf({ level: 'high' }),
      stabFile: 'stab_clip.trf',
      hasAudio: true,
      outputPath: 'C:/userData/stab-preview/stab_clip.mp4'
    })
    const vf = args[args.indexOf('-vf') + 1] ?? ''
    expect(vf.startsWith(TRIM_PREFIX)).toBe(true)
    // 与导出合成段链同一滤镜串（vidstabtransform 名与首选项 = 连接，真机实证）
    expect(vf).toContain(',vidstabtransform=input=stab_clip.trf')
    expect(vf).toContain('smoothing=30')
    expect(vf).toContain('zoomspeed=0.4')
    expect(vf).toContain('optzoom=2')
    expect(vf).toContain('crop=keep')
    expect(vf).toContain(',setsar=1,format=yuv420p')
    // 音频：-vf 只动视频，音轨必须同样裁到源区间，否则代理比画面长一整条原音轨
    const af = args[args.indexOf('-af') + 1] ?? ''
    expect(af).toContain('atrim=start=2.000000:end=6.000000')
    expect(af).toContain('asetpts=PTS-STARTPTS')
    expect(args).toContain('aac')
    expect(args).not.toContain('-an')
    // 预览代理要的是尽快可播，不是归档画质
    expect(args[args.indexOf('-preset') + 1]).toBe('veryfast')
    expect(args[args.indexOf('-crf') + 1]).toBe('20')
    expect(args).toContain('+faststart')
    expect(args.at(-1)).toBe('C:/userData/stab-preview/stab_clip.mp4')
    // 进度管道保留：任务队列的百分比靠 out_time_us
    expect(args).toContain('-progress')
  })

  it('buildStabPreviewArgs：无声时 -an，不带 -af/aac', () => {
    const args = buildStabPreviewArgs({
      inputPath: 'D:/media/a.mp4',
      sourceInSec: 0,
      sourceOutSec: 3,
      fps: FPS_30,
      stab: stabOf(),
      stabFile: 's.trf',
      hasAudio: false,
      outputPath: 'C:/x/s.mp4'
    })
    expect(args).toContain('-an')
    expect(args).not.toContain('-af')
    expect(args).not.toContain('aac')
  })
})

/**
 * v9 片段音频与变速的 argv（面板上的每个滑杆都必须在这里落到滤镜串）。
 *
 * 锁四件事：
 * 1. **不带 audio/speed 键时段链逐字节不变**——旧工程导出不许变；
 * 2. 画面变速 `setpts=(PTS-STARTPTS)/s` 挂在 `fps=` **之后**（.trf 帧序号才不错位）；
 * 3. 音频链顺序变速 → 音量 → 淡入 → 淡出，淡变秒数用**变速后**的本段输出长度；
 * 4. 频谱取样的 argv 绝不带 `-progress`（进度键值对会污染 stdout 的 PCM）。
 */
describe('v9 片段音频与变速 argv', () => {
  const audioOf = (over: Partial<ClipAudio> = {}): ClipAudio => ({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, ...over })
  const speedOf = (value: number, maintainPitch = true): ClipSpeed => ({ speed: value, maintainPitch })
  const stabOn = (): MediaClipStab => ({ ...defaultMediaStab(), enabled: true })

  /** 取 filter_complex 里以某串开头的那一句链（不先把整个图拆开看容易误判） */
  const chainOf = (fc: string, prefix: string): string =>
    fc.split(';').find((statement) => statement.startsWith(prefix)) ?? ''

  it('不带 audio/speed 键：段链与基线逐字节一致', () => {
    const fc = buildMediaBasisFilterComplex(basis([seg()]))
    expect(chainOf(fc, '[0:v]')).toBe(
      '[0:v]trim=start=2.000000:end=6.000000,setpts=PTS-STARTPTS,fps=30/1,setsar=1,format=yuv420p[pres0]'
    )
    expect(fc).not.toContain('atempo')
    expect(fc).not.toContain('asetrate')
    expect(fc).not.toContain('volume=')
    expect(fc).not.toContain('afade')
    expect(fc).not.toContain('setpts=(PTS-STARTPTS)/')
  })

  it('默认值的 audio/speed 不落盘：传了也与基线一致', () => {
    expect(buildMediaBasisFilterComplex(basis([seg({ audio: audioOf(), speed: speedOf(1) })]))).toBe(
      buildMediaBasisFilterComplex(basis([seg()]))
    )
  })

  it('画面：变速挂在 fps 重采样之后、setsar 之前', () => {
    const fc = buildMediaBasisFilterComplex(basis([seg({ speed: speedOf(2) })]))
    const chain = chainOf(fc, '[0:v]')
    expect(chain).toContain(',setpts=(PTS-STARTPTS)/2,setsar=1,format=yuv420p[pres0]')
    expect(chain.indexOf('fps=30/1')).toBeLessThan(chain.indexOf('setpts=(PTS-STARTPTS)/2'))
    // 源窗口不变：trim 仍按原入出点切
    expect(chain).toContain('trim=start=2.000000:end=6.000000')
  })

  it('画面：防抖 + 变速同时存在时，transform 在前、变速在后', () => {
    const fc = buildMediaBasisFilterComplex(
      basis([seg({ stab: stabOn(), stabFile: 'stab_0.trf', speed: speedOf(2.5) })])
    )
    const chain = chainOf(fc, '[0:v]')
    expect(chain.indexOf('vidstabtransform')).toBeLessThan(chain.indexOf('setpts=(PTS-STARTPTS)/2.5'))
    expect(chain.indexOf('fps=30/1')).toBeLessThan(chain.indexOf('vidstabtransform'))
  })

  it('音频：变速 → 音量 → 淡入 → 淡出，淡变秒数按变速后的本段输出长度', () => {
    // 源窗口 4s / 2x = 输出 2s；淡入 1s、淡出 1s 正好各占半段
    const fc = buildMediaBasisFilterComplex(
      basis([
        seg({
          audio: audioOf({ volumePercent: 150, fadeInSec: 1, fadeOutSec: 1 }),
          speed: speedOf(2)
        })
      ])
    )
    expect(chainOf(fc, '[0:a]')).toBe(
      '[0:a]atrim=start=2.000000:end=6.000000,asetpts=PTS-STARTPTS,atempo=2,volume=1.5,' +
        'afade=t=in:st=0:d=1,afade=t=out:st=1:d=1,aresample=async=1:first_pts=0[preas0]'
    )
  })

  it('音频：关掉保持音高就走 asetrate（音高随倍速升降）', () => {
    const fc = buildMediaBasisFilterComplex(basis([seg({ speed: speedOf(2, false) })]))
    const chain = chainOf(fc, '[0:a]')
    expect(chain).not.toContain('atempo')
    expect(chain).toContain('asetrate=96000')
    expect(chain).toContain('aresample=48000')
  })

  it('音频：0.25x 串两个 atempo（单实例只吃 0.5..2）', () => {
    const fc = buildMediaBasisFilterComplex(basis([seg({ speed: speedOf(0.25) })]))
    expect(chainOf(fc, '[0:a]')).toContain('atempo=0.5,atempo=0.5')
  })

  it('无音轨段补的静音长度用时间轴长度（变速后仍然对得上 concat）', () => {
    const fc = buildMediaBasisFilterComplex(
      basis([seg({ hasAudio: false, timelineEndSec: 2, sourceInSec: 0, sourceOutSec: 4, speed: speedOf(2) })])
    )
    expect(fc).toContain('anullsrc=channel_layout=stereo:sample_rate=48000[ns0]')
    expect(fc).toContain('[ns0]atrim=duration=2.000000')
  })

  it('图像段 -loop 1 -t 用源窗口长度（变速前的长度）', () => {
    const args = buildOverlayMp4MultiInput({
      ...basis([seg({ isImage: true, sourceInSec: 0, sourceOutSec: 8, speed: speedOf(2) })], '1'),
      overlayPath: 'C:/tmp/o.mov'
    })
    const joined = args.join(' ')
    expect(joined).toContain('-loop 1 -t 8.000000 -i D:/media/a.mp4')
  })

  it('频谱取样 argv：-ss/-t 在 -i 前、只留声轨、单声道 s16le 到 stdout，绝不带 -progress', () => {
    const request: AudioPeaksArgsInput = {
      inputPath: 'C:/media/a.mp4',
      sourceInSec: 2,
      sourceOutSec: 8,
      sampleRate: 2000
    }
    const args = buildAudioPeaksArgs(request)
    const joined = args.join(' ')
    expect(args.slice(0, 7)).toEqual(['-hide_banner', '-loglevel', 'error', '-ss', '2.000000', '-t', '6.000000'])
    expect(args[7]).toBe('-i')
    expect(joined).not.toContain('-progress')
    expect(joined).toContain('-vn -sn -dn -ac 1 -ar 2000 -f s16le pipe:1')
    // 极短区间也给得到至少一帧，不会算出 -t 0
    expect(buildAudioPeaksArgs({ ...request, sourceOutSec: 2.001 })).toContain('0.040000')
  })
})

/**
 * 单/多输入拓扑判定（从主进程里提上来锁住）。
 *
 * 这条判定决定「参数会不会落进滤镜链」：需要逐段插入点的参数一旦走到
 * 旧单输入链，就会被默默吞掉（预览看得到、导出听不到）。
 */
describe('segmentsNeedMultiInput（导出拓扑判定）', () => {
  /** 「整段从头覆盖」的单段：只有这种形状才允许回到旧单输入链 */
  const whole = (over: Partial<ConcatSegment> = {}): ConcatSegment =>
    seg({ timelineStartSec: 0, timelineEndSec: 10, sourceInSec: 0, sourceOutSec: 10, ...over })

  it('空轨与「整段从头覆盖」的单段：走旧单输入（argv 零差异）', () => {
    expect(segmentsNeedMultiInput(undefined)).toBe(false)
    expect(segmentsNeedMultiInput([])).toBe(false)
    expect(segmentsNeedMultiInput([whole()])).toBe(false)
  })

  it('剪裁/不在 0 起点/多段：走 trim+concat', () => {
    expect(segmentsNeedMultiInput([seg({ sourceInSec: 1 })])).toBe(true)
    expect(segmentsNeedMultiInput([seg({ timelineStartSec: 2 })])).toBe(true)
    expect(segmentsNeedMultiInput([seg({ timelineEndSec: 3 }), seg({ timelineStartSec: 3 })])).toBe(true)
  })

  it('v8：开启防抖必须走 trim 链才能注入 transform', () => {
    expect(segmentsNeedMultiInput([whole({ stab: { ...defaultMediaStab(), enabled: true } })])).toBe(true)
    // 没开防抖不影响拓扑
    expect(segmentsNeedMultiInput([whole({ stab: { ...defaultMediaStab(), enabled: false } })])).toBe(false)
  })

  it('v9：带 audio/speed 的单段也必须走 trim 链，否则参数会被吞掉', () => {
    expect(segmentsNeedMultiInput([whole({ audio: { volumePercent: 150, fadeInSec: 0, fadeOutSec: 0 } })])).toBe(true)
    expect(segmentsNeedMultiInput([whole({ speed: { speed: 2, maintainPitch: true } })])).toBe(true)
    // 不改时长的写法（只关音高保持）同样要算：单看旧时长恒等式分支看不出来
    expect(segmentsNeedMultiInput([whole({ speed: { speed: 1, maintainPitch: false } })])).toBe(true)
    // 而「没写过这些键」依旧走单输入（旧 argv 逐字节不变）
    expect(segmentsNeedMultiInput([whole({ audio: undefined, speed: undefined })])).toBe(false)
  })

  it('v3：上层媒体轨（trackIndex > 0）必须走多输入分层合成', () => {
    // 即使只有一段，上层也不能回退旧单输入 builder（它没有分层入口）
    expect(segmentsNeedMultiInput([whole({ trackIndex: 1 })])).toBe(true)
    expect(segmentsNeedMultiInput([whole({ trackIndex: 0 })])).toBe(false)
  })

  it('v3：静音轨必须走 trim 链补静音；纯无音轨段仍可回退单输入', () => {
    expect(segmentsNeedMultiInput([whole({ muted: true })])).toBe(true)
    // 源本来就没音轨时，单输入 builder 的 `-map 0:a?` 已经能正确处理
    expect(segmentsNeedMultiInput([whole({ hasAudio: false })])).toBe(false)
  })

  it('v7：单张静帧必须走 `-loop 1 -t` 的多输入路径', () => {
    expect(segmentsNeedMultiInput([whole({ isImage: true })])).toBe(true)
  })
})

describe('v3 多轨图层合成', () => {
  it('按 trackIndex 从底到顶叠加，并为多轨原声补等长静音 [ab]', () => {
    const fc = buildMediaBasisFilterComplex(
      basis(
        [
          seg({ trackIndex: 0, timelineEndSec: 4 }),
          seg({
            trackIndex: 1,
            refVideoPath: 'D:/media/b.mp4',
            timelineStartSec: 2,
            timelineEndSec: 6,
            sourceInSec: 0,
            sourceOutSec: 4
          })
        ],
        '2'
      )
    )
    // 两条轨各一张全帧 RGBA 层，段间空隙补透明，overlay 按 0 → 1 从底到顶
    expect(fc).toContain('color=c=black@0.0')
    expect(fc).toContain('concat=n=')
    expect(fc).toContain('eof_action=pass:shortest=0')
    expect(fc.indexOf('[ml0]')).toBeLessThan(fc.indexOf('[ml1]'))
    // 多轨原声已由渲染侧压平进 audioClips：这里只留一路等长静音基座
    expect(fc).toContain('anullsrc=channel_layout=stereo:sample_rate=48000')
    expect(fc).toContain('[ab]')
    // 不能再逐段混原声，否则会与 audioClips 双声
    expect(fc).not.toContain('[0:a]')
    expect(fc).not.toContain('[1:a]')
  })

  it('水印仍然最后叠加：媒体层 → 字幕层 → 水印 [v]', () => {
    const fc = buildMediaBasisFilterComplex({
      ...basis([seg({ trackIndex: 1 })], '1'),
      watermark: { path: 'D:/wm.png', sourceWidth: 100, sourceHeight: 50 }
    })
    expect(fc).toContain('format=yuv420p[vsub]')
    // 水印输入索引 = 透明层序号 + 1 = 2，且水印链的产物是最终的 [v]
    expect(fc).toContain('[2:v]format=rgba')
    expect(fc.lastIndexOf('format=yuv420p[v]')).toBeGreaterThan(fc.lastIndexOf('format=yuv420p[vsub]'))
  })

  it('单轨（trackIndex 全 0）保持旧 trim+concat 路径（逐段音频仍在段内混）', () => {
    const legacy = buildMediaBasisFilterComplex({
      ...basis([
        seg({ trackIndex: 0 }),
        seg({ trackIndex: 0, timelineStartSec: 4, timelineEndSec: 8, sourceInSec: 0, sourceOutSec: 4 })
      ]),
      spanEndSec: 8
    })
    expect(legacy).toContain('[0:a]')
    expect(legacy).toContain('concat=n=2:v=1:a=1[vb][ab]')
    expect(legacy).not.toContain('color=c=black@0.0')
  })
})

