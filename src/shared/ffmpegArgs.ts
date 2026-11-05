import { WATERMARK_BASE_RESOLUTION, WATERMARK_DISPLAY_SCALE, WATERMARK_MARGIN_PX } from './constants'
import { fpsToArg } from './fps'
import type { ExportTarget, Fps, Resolution } from './types'

/**
 * FFmpeg 参数构造（纯函数，argv 快照测试锁定；规格 §5 + 计划 C1–C5 修正）。
 * 严禁在本文件之外拼接 argv，也严禁任何同步子进程调用。
 */

/** profile 0–3 配 yuva444p10le 不报错但静默丢 alpha（本机 FFmpeg 8.1.1 实证，计划 C1）。 */
export const ALPHA_DROPPED_MARKER = 'will not encode alpha'
/** ProRes 4444 = prores_ks profile 4（`4444` 为其同名常量，仍写数字更稳） */
export const PRORES_PROFILE_4444 = '4'
export const PRORES_PIX_FMT = 'yuva444p10le'

export interface CommonInputFlags {
  /** 只输出错误 + 我们自己的进度管道 */
  loglevel?: 'error' | 'warning'
  /** 进度：仅采信 out_time_us（规格 §5.3） */
  progress?: boolean
}

/**
 * 全局前缀参数。
 * 注意：ffmpeg 与 ffprobe 都**不存在** `-nologo` 选项（本机 FFmpeg 8.1.1 实证：
 * 传入会直接 `Unrecognized option 'nologo'` 并退出），只能给 `-hide_banner`。
 */
const BASE: string[] = ['-hide_banner', '-y']

function common(flags: CommonInputFlags | undefined): string[] {
  const out = [...BASE]
  // 默认 warning：`-loglevel error` 会滤掉 prores_ks 「Profile selected will not encode alpha」这类
  // 关键告警（本机实测：该告警为 AV_LOG_WARNING 级别），计划 C1 的检测串将永远抓不到。
  out.push('-loglevel', flags?.loglevel ?? 'warning')
  if (flags?.progress !== false) {
    out.push('-progress', 'pipe:1', '-nostats')
  }
  return out
}

/** BT.709 SDR 标签（规格 §5.2 / §6.2：HDR 效果丢失后统一回归 SDR BT.709）。 */
export const BT709_TAGS: string[] = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709']

/** ProRes 4444 编码参数（透明通道必需）。 */
export function proresArgs(): string[] {
  return [
    '-c:v',
    'prores_ks',
    '-profile:v',
    PRORES_PROFILE_4444,
    '-pix_fmt',
    PRORES_PIX_FMT,
    '-vendor',
    'apl0',
    ...BT709_TAGS,
    // PNG 为全范围 RGB；ProRes 惯例为有限范围，Premiere/Resolve 读此标签决定合成基线
    '-color_range',
    'tv'
  ]
}

/** 透明帧序列 → ProRes 4444 MOV（帧从 PNG 目录读取，规格 §5.1 回退路径）。 */
export function buildTransparentMovFromSeq(
  fps: Fps,
  framePattern: string,
  outputPath: string,
  startNumber = 0
): string[] {
  return [
    ...common({}),
    '-framerate',
    fpsToArg(fps),
    '-start_number',
    String(startNumber),
    '-i',
    framePattern,
    ...proresArgs(),
    '-an',
    // 中间产物无需 faststart（计划 C5：moov 重定位会带来整文件重写）
    '-f',
    'mov',
    outputPath
  ]
}

/** 管道入口参数（image2pipe PNG，兼作 PNG 出口与回退路径）。 */
export function pipeInputArgs(fps: Fps): string[] {
  return [
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    '-framerate',
    fpsToArg(fps),
    // 单帧 PNG 头部即可给出尺寸，压低探测量以免拖慢首帧
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-i',
    'pipe:0'
  ]
}

/**
 * 未压缩 RGBA 帧流入口（主路径）。
 * 本机应用内冒烟实测：360p 下 `convertToBlob('image/png')` 平均 9.7ms/帧，
 * 而 `renderFrame` 只要 0.14ms/帧 —— PNG 编码（带 alpha 的 zlib 压缩）才是吞吐率瓶颈，
 * 且随像素数线性增长，直接卡住验收第 2 条（1080p30/10s ≤ 30s）。
 * rawvideo 把「逐帧压缩」换成「流式多传字节」（不增内存峰值），
 * FFmpeg 侧只做 rgba → yuva444p10le 转换，开销远小于 PNG 压缩+解码。
 * 这正是计划风险表「导出侧降级 rgba8」的具象化（完全不压缩更优）。
 */
export function rawPipeInputArgs(fps: Fps, width: number, height: number): string[] {
  return [
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-video_size',
    `${width}x${height}`,
    // 裸数据无容器/头部信息，帧率与尺寸必须显式给出
    '-framerate',
    fpsToArg(fps),
    '-i',
    'pipe:0'
  ]
}

/** 透明 MOV（stdin 帧流，形式由 frameFormat 决定）。 */
export function buildTransparentMovFromPipe(
  fps: Fps,
  outputPath: string,
  frameFormat: 'raw' | 'png' = 'raw',
  size?: { width: number; height: number }
): string[] {
  const input =
    frameFormat === 'raw'
      ? rawPipeInputArgs(fps, size?.width ?? 1920, size?.height ?? 1080)
      : pipeInputArgs(fps)
  return [...common({}), ...input, ...proresArgs(), '-an', '-f', 'mov', outputPath]
}

/** 素材卡片缩略图：-ss 放在 -i 前做关键帧快定位，尾部缩到 320 宽（高度按比例取偶数）供 <img> 显示。 */
export function buildThumbnailArgs(inputPath: string, outputPath: string, atSec: number, width = 320): string[] {
  return [
    '-hide_banner',
    '-y',
    '-loglevel',
    'error',
    '-ss',
    formatSec(Math.max(0, atSec)),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2,setsar=1`,
    '-q:v',
    '6',
    outputPath
  ]
}

// ---------------------------------------------------------------------------
// 水印（Watermark）：1080P 基准 → 原图 32% → 左上角 30px，随输出分辨率等比换算
// ---------------------------------------------------------------------------

/** 一路水印输入：路径 + 导入时探测到的原图像素尺寸。 */
export interface WatermarkInput {
  /** 图片绝对路径 */
  path: string
  /** 原图宽（像素） */
  sourceWidth: number
  /** 原图高（像素） */
  sourceHeight: number
}

/** 换算后的水印矩形（整数像素，保证落在输出画面内）。 */
export interface WatermarkBox {
  width: number
  height: number
  x: number
  y: number
}

/** 像素值向下夹到 [1, max]，非有限值归 1（尺寸永不为 0，否则 scale 直接报错）。 */
function clampPx(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(Math.round(value), Math.max(1, Math.floor(max))))
}

/**
 * 几何换算：以 1080P 为基准，显示尺寸 = 原图 × 32%，距顶/左各 30px。
 *
 * 换算因子取 **高度比**（`输出高 / 1080`）：“1080P” 本身就是按高度命名的基准，
 * 与预设里的 `px@1080p` 尺寸令牌同一口径；尺寸与边距共用一个因子，
 * 于是竖屏/4K/720p 下水印既不会被拉变形，相对位置也保持一致。
 * 极端情况（图比画还大）夹进画面，不让 overlay 把水印推到画外。
 */
export function computeWatermarkGeometry(watermark: WatermarkInput, output: Resolution): WatermarkBox {
  const factor = output.height > 0 && WATERMARK_BASE_RESOLUTION.height > 0
    ? output.height / WATERMARK_BASE_RESOLUTION.height
    : 1
  const width = clampPx(watermark.sourceWidth * WATERMARK_DISPLAY_SCALE * factor, output.width)
  const height = clampPx(watermark.sourceHeight * WATERMARK_DISPLAY_SCALE * factor, output.height)
  const margin = Math.max(0, Math.round(WATERMARK_MARGIN_PX * factor))
  return {
    width,
    height,
    x: Math.min(margin, Math.max(0, output.width - width)),
    y: Math.min(margin, Math.max(0, output.height - height))
  }
}

/**
 * 水印输入参数：循环图片并按目标帧率对齐时基。
 * 不给 `-t`：overlay 在基座 EOF 时结束，循环输入不会把输出拖成无限长；
 * 显式 `-framerate` 避免图片默认 25fps 与基座帧率不一致带来的时间戳重采样。
 */
export function buildWatermarkInputArgs(watermark: WatermarkInput, fps: Fps): string[] {
  return ['-loop', '1', '-framerate', fpsToArg(fps), '-i', watermark.path]
}

/**
 * 水印滤镜链（永远是最后一层，叠在字幕条之上）：
 * `format=rgba` 先做：调色板 PNG / pal8 不先转格式会丢透明通道；
 * 链尾回到 yuv420p（与字幕层同一纪律，计划 C3：format=auto 会给出 10-bit 4:4:4）。
 *
 * @param input.label 水印输入的路序号（紧接在透明层之后，由各 builder 统一分配）
 * @param input.prevLabel 上游标签（字幕合成结果，不含方括号）
 */
export function buildWatermarkFilterChain(input: {
  label: number | string
  prevLabel: string
  watermark: WatermarkInput
  output: Resolution
}): string[] {
  const box = computeWatermarkGeometry(input.watermark, input.output)
  return [
    `[${input.label}:v]format=rgba,scale=${box.width}:${box.height}[wm]`,
    `[${input.prevLabel}][wm]overlay=${box.x}:${box.y}:alpha=straight:format=auto:eof_action=pass,format=yuv420p[v]`
  ]
}

/** 把工程设置转成 builder 需要的水印输入；路径缺失或尺寸不可用时返回 undefined（argv 与旧路径一致）。 */
export function watermarkInputOf(settings: {
  path: string
  sourceWidth: number
  sourceHeight: number
} | undefined): WatermarkInput | undefined {
  if (!settings) return undefined
  if (typeof settings.path !== 'string' || settings.path.length === 0) return undefined
  if (!(settings.sourceWidth > 0) || !(settings.sourceHeight > 0)) return undefined
  return {
    path: settings.path,
    sourceWidth: Math.round(settings.sourceWidth),
    sourceHeight: Math.round(settings.sourceHeight)
  }
}

// ---------------------------------------------------------------------------
// v2 双轨：多输入 trim+concat 基座（阶段 7）
// ---------------------------------------------------------------------------

/** 媒体时间轴上的一段：源文件 + 源入出点 + 在时间轴上的目标位置。 */
export interface ConcatSegment {
  refVideoPath: string
  timelineStartSec: number
  timelineEndSec: number
  sourceInSec: number
  sourceOutSec: number
  /** 本段有没有音轨；false 时用 anullsrc 补静音，保证 concat 两侧流结构一致 */
  hasAudio: boolean
}

export interface MediaBasisOverlayInput {
  /** 按 timelineStartSec 升序的媒体段（至少一段） */
  segments: ConcatSegment[]
  /** 本次输出覆盖的时间轴区间（含开头/中间/尾部空隙补黑） */
  spanStartSec: number
  spanEndSec: number
  /** 透明层输入索引（两阶段法与直管道都是最后一路输入） */
  overlayLabel: string
  /** 透明 MOV（两阶段法）；directPipe 时忽略 */
  overlayPath: string
  outputPath: string
  /** 基座统一规整到目标帧率（规格 §2.3：叠加必须按参考参数重渲染） */
  fps: Fps
  /** 目标分辨率（空隙补黑的尺寸，与基座流对齐） */
  frameSize: { width: number; height: number }
  audioMode: 'copy' | 'aac'
  fpsMode: 'cfr' | 'vfr'
  /** 水印（可选）：作为紧接透明层之后的一路输入，合成在最后一层 */
  watermark?: WatermarkInput
}

/**
 * 多素材基座滤镜链：逐段 trim+setpts 归零→按时间轴平移→（有空隙时）黑场补齐→
 * concat 成 [vb]/[ab]，再 setpts 抬到 span 起点、fps 规整、overlay 透明层。
 * concat 前先统一帧率/SAR/像素格式/音频采样格式，避免参数不一致的素材直接报错。
 */
export function buildMediaBasisFilterComplex(
  input: Omit<MediaBasisOverlayInput, 'overlayPath'>
): string {
  const rate = fpsToArg(input.fps)
  const start = formatSec(input.spanStartSec)
  const end = formatSec(input.spanEndSec)
  const size = `${input.frameSize.width}x${input.frameSize.height}`
  const chains: string[] = []
  const parts: string[] = []
  const ordered: string[] = []
  let gapIndex = 0
  let cursor = input.spanStartSec

  const pushGap = (gapLen: number): void => {
    const vLabel = `g${gapIndex}`
    const aLabel = `ga${gapIndex}`
    gapIndex += 1
    const len = formatSec(gapLen)
    chains.push(
      `color=c=black:s=${size}:r=${rate}:d=${len}[pre${vLabel}]`,
      `anullsrc=channel_layout=stereo:sample_rate=48000[pre${aLabel}]`
    )
    parts.push(
      `[pre${vLabel}]fps=${rate},setsar=1,format=yuv420p,trim=duration=${len},setpts=PTS-STARTPTS[${vLabel}]`,
      `[pre${aLabel}]atrim=duration=${len},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[${aLabel}]`
    )
    ordered.push(`[${vLabel}][${aLabel}]`)
  }

  input.segments.forEach((seg, i) => {
    if (seg.timelineStartSec > cursor + 1e-6) {
      pushGap(seg.timelineStartSec - cursor)
      cursor = seg.timelineStartSec
    }
    const segIn = formatSec(seg.sourceInSec)
    const segOut = formatSec(seg.sourceOutSec)
    const shift = formatSec(Math.max(0, seg.timelineStartSec - input.spanStartSec))
    const label = `s${i}`
    chains.push(`[${i}:v]trim=start=${segIn}:end=${segOut},setpts=PTS-STARTPTS,fps=${rate},setsar=1,format=yuv420p[pre${label}]`)
    parts.push(`[pre${label}]setpts=PTS+${shift}/TB[vs${i}]`)
    if (seg.hasAudio) {
      chains.push(`[${i}:a]atrim=start=${segIn}:end=${segOut},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[prea${label}]`)
      parts.push(`[prea${label}]asetpts=PTS+${shift}/TB[as${i}]`)
    } else {
      const len = formatSec(Math.max(0, seg.sourceOutSec - seg.sourceInSec))
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000[n${label}]`)
      parts.push(`[n${label}]atrim=duration=${len},asetpts=PTS-STARTPTS[prea${label}]`)
      parts.push(`[prea${label}]asetpts=PTS+${shift}/TB[as${i}]`)
    }
    ordered.push(`[vs${i}][as${i}]`)
    cursor = Math.max(cursor, seg.timelineEndSec)
  })

  // 尾部空隙：补到 span 末端，基座长度 = 输出帧长，overlay 时间窗不会越界
  if (cursor < input.spanEndSec - 1e-6) pushGap(input.spanEndSec - cursor)

  const pairLabels = ordered.join('')
  const n = ordered.length
  // 有水印时字幕层改标 [vsub]，让水印成为最后一层 [v]（`-map [v]` 无需跟着变）
  const subtitleOut = input.watermark ? 'vsub' : 'v'
  return [
    ...chains,
    ...parts,
    `${pairLabels}concat=n=${n}:v=1:a=1[vb][ab]`,
    `[vb]setpts=PTS-${start}/TB,fps=${rate}[v0]`,
    // 透明层平移到 span 起点并按时间窗叠加（与单输入路径同一纪律，计划 C7）
    `[${input.overlayLabel}:v]setpts=PTS+${start}/TB[ov]`,
    `[v0][ov]overlay=0:0:alpha=straight:format=auto:eof_action=pass:enable='between(t,${start},${end})',format=yuv420p[${subtitleOut}]`,
    // 水印输入固定是「透明层序号 + 1」（与下面两个 builder 的 `-i` 顺序同一口径）
    ...(input.watermark
      ? buildWatermarkFilterChain({
          label: Number(input.overlayLabel) + 1,
          prevLabel: subtitleOut,
          watermark: input.watermark,
          output: input.frameSize
        })
      : [])
  ].join(';')
}

/** 多输入叠加（两阶段法）：N 路媒体 + 循环透明 MOV 帧序列，trim+concat 基座后叠加。 */
export function buildOverlayMp4MultiInput(input: MediaBasisOverlayInput): string[] {
  const audioArgs = input.audioMode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
  const args: string[] = [...common({})]
  for (const seg of input.segments) {
    args.push('-i', seg.refVideoPath)
  }
  // 透明 MOV 这一路只能给 `-t`：`-loop` 与 `-framerate` 都是 image2 解封装器的选项，
  // mov 解封装器不认识（本机 FFmpeg 8.1.1 实证：`Option loop not found.` + 打不开输入而直接退出）。
  // 这里也不需要循环：基座已按 span 补黑补齐，透明层的帧数本就覆盖整段，
  // 叠加窗口再由 enable='between(...)' 限定。
  args.push(
    '-t',
    formatSec(Math.max(0, input.spanEndSec - input.spanStartSec)),
    '-i',
    input.overlayPath
  )
  if (input.watermark) args.push(...buildWatermarkInputArgs(input.watermark, input.fps))
  args.push(
    '-filter_complex',
    buildMediaBasisFilterComplex(input),
    '-map',
    '[v]',
    '-map',
    '[ab]',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    '-fps_mode',
    input.fpsMode,
    ...BT709_TAGS,
    ...audioArgs,
    '-movflags',
    '+faststart',
    input.outputPath
  )
  return args
}

/** 多输入直接管道合成：N 路媒体 + stdin 帧流（image2pipe/rawvideo）。 */
export function buildOverlayMp4MultiInputDirectPipe(
  input: Omit<MediaBasisOverlayInput, 'overlayPath'> & { frameFormat: 'raw' | 'png' }
): string[] {
  const audioArgs = input.audioMode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
  const frameInput =
    input.frameFormat === 'raw'
      ? rawPipeInputArgs(input.fps, input.frameSize.width, input.frameSize.height)
      : pipeInputArgs(input.fps)
  const args: string[] = [...common({})]
  for (const seg of input.segments) {
    args.push('-i', seg.refVideoPath)
  }
  args.push(...frameInput)
  if (input.watermark) args.push(...buildWatermarkInputArgs(input.watermark, input.fps))
  args.push(
    '-filter_complex',
    buildMediaBasisFilterComplex(input),
    '-map',
    '[v]',
    '-map',
    '[ab]',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    '-fps_mode',
    input.fpsMode,
    ...BT709_TAGS,
    ...audioArgs,
    '-movflags',
    '+faststart',
    input.outputPath
  )
  return args
}

/**
 * 兼容模式出口：qtrle 无损 RGBA（ProRes 在个别 DCC 出现预乘/色偏时的回退，规格 §风险表）。 */
export function buildTransparentMovQtrle(
  fps: Fps,
  outputPath: string,
  frameFormat: 'raw' | 'png' = 'raw',
  size?: { width: number; height: number }
): string[] {
  const input =
    frameFormat === 'raw'
      ? rawPipeInputArgs(fps, size?.width ?? 1920, size?.height ?? 1080)
      : pipeInputArgs(fps)
  return [
    ...common({}),
    ...input,
    '-c:v',
    'qtrle',
    '-pix_fmt',
    'argb',
    ...BT709_TAGS,
    '-color_range',
    'pc',
    '-an',
    '-f',
    'mov',
    outputPath
  ]
}

/** PNG 序列 → qtrle MOV（兼容模式的落盘路径）。 */
export function buildTransparentMovQtrleFromSeq(
  fps: Fps,
  framePattern: string,
  outputPath: string,
  startNumber = 0
): string[] {
  return [
    ...common({}),
    '-framerate',
    fpsToArg(fps),
    '-start_number',
    String(startNumber),
    '-i',
    framePattern,
    '-c:v',
    'qtrle',
    '-pix_fmt',
    'argb',
    ...BT709_TAGS,
    '-color_range',
    'pc',
    '-an',
    '-f',
    'mov',
    outputPath
  ]
}

export interface OverlayInput {
  refVideoPath: string
  /** 透明 MOV（两阶段法）；directPipe 时忽略 */
  overlayPath: string
  outputPath: string
  /** 参考视频帧率（叠加必须跟随参考视频，规格 §2.3） */
  fps: Fps
  /** 直接管道合成时的帧形式与尺寸 */
  frameFormat?: 'raw' | 'png'
  frameSize?: { width: number; height: number }
  /** span 秒区间（计划 C7） */
  spanStartSec: number
  spanEndSec: number
  audioMode: 'copy' | 'aac'
  fpsMode: 'cfr' | 'vfr'
  /** 水印（可选）：固定在输入序号 2（参考视频 0 / 透明层或管道 1 之后） */
  watermark?: WatermarkInput
}

/** 无 frameSize 时的回退输出尺寸（与旧单输入路径的默认值一致）。 */
const FALLBACK_OUTPUT: Resolution = { width: 1920, height: 1080 }

/** overlay 滤镜链尾必须落到 8-bit 4:2:0（计划 C3：format=auto 会给出 10-bit 4:4:4）。 */
export function buildFilterComplex(
  spanStartSec: number,
  spanEndSec: number,
  fps: Fps,
  watermark?: WatermarkInput,
  output: Resolution = FALLBACK_OUTPUT
): string {
  const rate = fpsToArg(fps)
  const start = formatSec(spanStartSec)
  const end = formatSec(spanEndSec)
  // 有水印时字幕层改标 [vsub]，水印叠为最后的 [v]（与多输入路径同一命名纪律）
  const subtitleOut = watermark ? 'vsub' : 'v'
  return [
    `[0:v]fps=${rate},setsar=1[v0]`,
    `[1:v]setpts=PTS+${start}/TB[ov]`,
    // alpha=straight（计划 C2）+ format=auto + 链尾 format=yuv420p（计划 C3）
    `[v0][ov]overlay=0:0:alpha=straight:format=auto:eof_action=pass:enable='between(t,${start},${end})',format=yuv420p[${subtitleOut}]`,
    ...(watermark
      ? buildWatermarkFilterChain({ label: 2, prevLabel: subtitleOut, watermark, output })
      : [])
  ].join(';')
}

/** 叠加合成（两阶段：参考视频 + 临时透明 MOV）。 */
export function buildOverlayMp4(input: OverlayInput): string[] {
  const audioArgs =
    input.audioMode === 'copy'
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '192k']
  return [
    ...common({}),
    '-i',
    input.refVideoPath,
    '-i',
    input.overlayPath,
    ...(input.watermark ? buildWatermarkInputArgs(input.watermark, input.fps) : []),
    '-filter_complex',
    buildFilterComplex(
      input.spanStartSec,
      input.spanEndSec,
      input.fps,
      input.watermark,
      input.frameSize ?? FALLBACK_OUTPUT
    ),
    '-map',
    '[v]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    '-fps_mode',
    input.fpsMode,
    ...BT709_TAGS,
    ...audioArgs,
    '-movflags',
    '+faststart',
    input.outputPath
  ]
}

/** 直接管道合成：stdin 帧流作为 overlay 输入（长素材 / 磁盘不足时启用）。 */
export function buildOverlayMp4DirectPipe(
  input: Omit<OverlayInput, 'overlayPath'>
): string[] {
  const audioArgs =
    input.audioMode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
  const frameInput =
    (input.frameFormat ?? 'raw') === 'raw'
      ? rawPipeInputArgs(input.fps, input.frameSize?.width ?? 1920, input.frameSize?.height ?? 1080)
      : pipeInputArgs(input.fps)
  return [
    ...common({}),
    '-i',
    input.refVideoPath,
    ...frameInput,
    ...(input.watermark ? buildWatermarkInputArgs(input.watermark, input.fps) : []),
    '-filter_complex',
    // 与两阶段法共用同一张滤镜图：stdin 帧流就是序号 1，水印固定序号 2
    buildFilterComplex(
      input.spanStartSec,
      input.spanEndSec,
      input.fps,
      input.watermark,
      input.frameSize ?? FALLBACK_OUTPUT
    ),
    '-map',
    '[v]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    '-fps_mode',
    input.fpsMode,
    ...BT709_TAGS,
    ...audioArgs,
    '-movflags',
    '+faststart',
    input.outputPath
  ]
}

/** VFR → CFR（规格 §6.3）。 */
export function buildCfrArgs(
  inputPath: string,
  outputPath: string,
  fps: Fps,
  audioMode: 'copy' | 'aac'
): string[] {
  return [
    ...common({}),
    '-i',
    inputPath,
    '-vf',
    `fps=${fpsToArg(fps)}`,
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    ...(audioMode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-map',
    '0:v',
    '-map',
    '0:a?',
    '-movflags',
    '+faststart',
    outputPath
  ]
}

/** ffprobe 探测参数（规格 §5.2 步骤 1）。
 *  注意：ffprobe 不支持 -nologo（本机实证会把下一个位置参数吞为选项值），只能给 -hide_banner。 */
export function buildProbeArgs(targetPath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    '-hide_banner',
    targetPath
  ]
}

/**
 * 图片尺寸探测（水印导入）：只要 width/height/codec_type。
 * `codec_type` 必须显式列出（与 buildVerifyArgs 同一纪律），否则解析端分不出图片流。
 */
export function buildImageSizeArgs(targetPath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_type,width,height',
    '-of',
    'json',
    '-hide_banner',
    targetPath
  ]
}

/** VFR 抽样：只读前若干 packet 的 pts_time，成本远低于 -count_frames。 */
export function buildVfrSampleArgs(targetPath: string, packets: number): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,flags',
    '-of',
    'json',
    '-read_intervals',
    `%+#${packets}`,
    '-hide_banner',
    targetPath
  ]
}

/** 校验输出（规格 §5.3 产物断言）。
 *  注意：一旦用 `-show_entries stream=...` 限定字段，必须显式包含 codec_type，
 *  否则 parseVerifyJson / parseProbeJson 无法区分视频流而返回 null。 */
export function buildVerifyArgs(targetPath: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_type,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_frames,codec_name,codec_tag_string,color_space,color_range',
    '-show_entries',
    'format=duration,nb_streams:stream_tags=profile',
    '-of',
    'json',
    '-hide_banner',
    targetPath
  ]
}

/** 秒 → 滤镜表达式数值（保留 6 位小数，µs 精度足够）。 */
export function formatSec(sec: number): string {
  return (Math.round(sec * 1e6) / 1e6).toFixed(6)
}

/** 输出文件名去扩展名（PNG 序列需要目录 + 前缀）。 */
export function baseName(target: ExportTarget): string {
  const raw = target.fileName.replace(/\.[^.]+$/i, '')
  return raw.length > 0 ? raw : 'focusnews'
}
