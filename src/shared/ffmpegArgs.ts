import {
  MEDIA_PROXY,
  WATERMARK_BASE_RESOLUTION,
  WATERMARK_DISPLAY_SCALE,
  WATERMARK_MARGIN_PX
} from './constants'
import { duckingFilter, duckingStrengthOf, loudnormFilter } from './audioQuality'
import { exportQualityCrf } from './exportPresets'
import { fpsToArg, frameIntervalSec, fpsRatio } from './fps'
import { videoEncodeArgs } from './gpu'
import { stabDetectProfile, stabTransformProfile } from './mediaStab'
import { clipAudioFilterChain, clipVideoSpeedFilter, speedValueOf } from './mediaClipAudio'
import { buildMediaClipVideoFx } from './mediaClipVideoFfmpeg'
import { isDefaultMediaVideo } from './mediaClipVideo'
import {
  planTransitionExport,
  type TransitionExportInputSegment,
  type TransitionExportPlan,
  type TransitionExportSegmentPlan
} from './transitions'
import type { MediaClipStab } from './mediaStab'
import type {
  AudioDuckingLevel,
  AudioMastering,
  AudioRole,
  ClipAudio,
  ClipSpeed,
  ExportFit,
  ExportQuality,
  ExportTarget,
  Fps,
  GraphicsZ,
  MediaClip,
  MediaClipTransition,
  MediaClipVideo,
  MediaClipKey,
  Resolution,
  VideoCodec
} from './types'
import type { KeyframeTrack } from './keyframes'
import { mediaKeyframesActive } from './mediaClipKeyframes'

/**
 * 该段是否需要走"特效/关键帧链"（`buildMediaClipVideoFx`）。
 * 静态几何全默认**且**没有关键帧时才允许走旧的直通链——否则关键帧会被静默忽略。
 */
function needsVideoFx(seg: ConcatSegment): boolean {
  return !isDefaultMediaVideo(seg.video) || mediaKeyframesActive(seg.keyframes)
}

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

/**
 * M9：合成出口的编码参数（四个 overlay builder 共用）。
 * 不传新字段时 argv 与旧版**逐字节一致**（CRF 仍按画质档、preset 仍 medium）。
 */
export function overlayEncodeArgs(
  input: {
    quality?: ExportQuality
    videoCodec?: VideoCodec
    videoBitrateKbps?: number
    crf?: number
    encoderPreset?: string
  },
  encoder: string | null
): string[] {
  const codec = input.videoCodec === 'hevc' ? 'hevc' : input.videoCodec === 'av1' ? 'av1' : 'h264'
  return videoEncodeArgs({
    encoder,
    quality: input.crf ?? exportQualityCrf(input.quality),
    preset: input.encoderPreset ?? 'medium',
    codec,
    ...(input.videoBitrateKbps !== undefined ? { bitrateKbps: input.videoBitrateKbps } : {})
  })
}

/**
 * M9：输出色彩参数。默认（8bit + limited）只输出 BT.709 标签，
 * 与旧版 argv 完全一致；显式 10bit / full range 时才追加 `-pix_fmt` / `-color_range`。
 */
export function overlayColorArgs(input: {
  bitDepth?: 8 | 10
  colorRange?: 'limited' | 'full'
}): string[] {
  const args: string[] = []
  if (input.bitDepth === 10) args.push('-pix_fmt', 'yuv420p10le')
  args.push(...BT709_TAGS)
  if (input.colorRange === 'full') args.push('-color_range', 'pc')
  return args
}

/**
 * M9-B：滤镜链尾的输出像素格式（缺省 yuv420p，与旧 argv 逐字节一致）。
 *
 * 10bit 时链尾落到 `yuv420p10le`，编码器才真正按 10bit 编码；
 * 源素材仍是 8bit（HDR 传递链路未做），所以这是"10bit 交付路径"而不是"原生 10bit 采集"。
 */
export function outputPixelFormat(bitDepth?: 8 | 10): 'yuv420p' | 'yuv420p10le' {
  return bitDepth === 10 ? 'yuv420p10le' : 'yuv420p'
}

/**
 * M9-B：full range 的**像素范围转换**。
 *
 * `-color_range pc` 只是标签：limited 的像素值（16–235）不转换就贴 pc 标签，
 * 播放器会把画面对比拉开。真正铺满 0–255 需要 `scale=in_range=limited:out_range=full`。
 */
export function fullRangeFilter(colorRange?: 'limited' | 'full'): string | null {
  return colorRange === 'full' ? 'scale=in_range=limited:out_range=full' : null
}

/** M9-B：滤镜链尾（可选范围转换 + 目标像素格式）；8bit/limited 时与旧版逐字节一致。 */
export function outputTailFilters(input: { bitDepth?: 8 | 10; colorRange?: 'limited' | 'full' }): string {
  const range = fullRangeFilter(input.colorRange)
  return [range, `format=${outputPixelFormat(input.bitDepth)}`].filter(Boolean).join(',')
}

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
  size?: { width: number; height: number },
  audio?: TransparentAudioOptions
): string[] {
  const input =
    frameFormat === 'raw'
      ? rawPipeInputArgs(fps, size?.width ?? 1920, size?.height ?? 1080)
      : pipeInputArgs(fps)
  return [
    ...common({}),
    ...input,
    ...proresArgs(),
    ...(buildTransparentAudioArgs(audio) ?? ['-an']),
    '-f',
    'mov',
    outputPath
  ]
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

/**
 * M5 冻结帧抽帧：从源视频的某一时刻取**一帧全分辨率 PNG**，作为静态素材落盘。
 *
 * 与缩略图的关键区别：
 * - `-ss` 放在 `-i` **之后**：这里要的是「与时间轴一致的这一帧」，宁可慢一点也要帧精确；
 * - 不做缩放、不压 JPEG：产物要按原始分辨率重新上轨（4K 源抽出来仍是 4K）；
 * - 输出 PNG（无损、无二次压缩），素材库里按 `MediaKind='image'` 处理，导出走 `-loop 1`。
 */
export function buildFreezeFrameArgs(inputPath: string, outputPath: string, atSec: number): string[] {
  return [
    '-hide_banner',
    '-y',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-ss',
    formatSec(Math.max(0, atSec)),
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-dn',
    outputPath
  ]
}

/**
 * 时间帧预览条（Thumbnail Strip）：一次调用完成「均匀抽帧 + 横向无缝拼接」。
 *
 * 为什么不逐帧起 N 个进程：每格一次 FFmpeg 冷启动会把导入/缩放卡成明显卡顿，
 * 而 `fps=… ,scale=… ,tile=Nx1` 在一条滤镜链里就能产出**一张长图**。
 *
 * 口径说明：
 * - `-ss` / `-t` 放在 `-i` **之前**：关键帧快速定位，只为缩略图服务，不要求帧精确；
 *   时间读数与 seek 一律用渲染层给的数学区间 `[sourceInSec, sourceOutSec]`，
 *   所以格子边界与 tooltip 永远自洽（不会因为 FFmpeg 落在前一个关键帧而错位）。
 * - `scale=W:-2` 按比例缩小（-2 保证高为偶数，JPEG 必需），`setsar=1` 去掉 SAR 干扰；
 * - `tile=Nx1` 以 padding/margin=0 拼接，格与格无缝，整体就是一条连续时间带；
 * - `-frames:v 1` 只要这一张。
 */
export interface StripArgsInput {
  inputPath: string
  outputPath: string
  /** 源入点（秒） */
  sourceInSec: number
  /** 源出点（秒）：预览条覆盖整个片段区间 */
  sourceOutSec: number
  /** 拼接格数（由卡片宽度与密度档位算出） */
  frames: number
  /** 每帧像素宽 */
  frameWidth?: number
}

export function buildStripArgs(input: StripArgsInput): string[] {
  const frames = Math.max(1, Math.round(input.frames))
  // 下限 40ms：不足一帧的区间不值得抽帧，但必须给 FFmpeg 一个正数时长
  const duration = Math.max(0.04, input.sourceOutSec - input.sourceInSec)
  const width = Math.max(16, Math.round(input.frameWidth ?? 128))
  return [
    '-hide_banner',
    '-y',
    '-loglevel',
    'error',
    '-ss',
    formatSec(Math.max(0, input.sourceInSec)),
    '-t',
    formatSec(duration),
    '-i',
    input.inputPath,
    '-frames:v',
    '1',
    '-vf',
    `fps=${formatSec(frames / duration)},scale=${width}:-2,setsar=1,tile=${frames}x1:padding=0:margin=0`,
    '-q:v',
    '6',
    input.outputPath
  ]
}

// ---------------------------------------------------------------------------
// 频谱条（v9）：把片段的源区间解成单声道 PCM 从 stdout 交回，柱高由渲染层折算
// ---------------------------------------------------------------------------

export interface AudioPeaksArgsInput {
  inputPath: string
  sourceInSec: number
  sourceOutSec: number
  /** 目标取样率（单声道 s16le；由 shared/audioPeaks 按区间长度与桶数选档） */
  sampleRate: number
}

/**
 * 频谱条取样：`-f s16le pipe:1` 把纯 PCM 写到 stdout。
 *
 * 三个必须不同的地方（与预览条/透明出口的 argv 对比）：
 * - **绝不带 `-progress pipe:1`**：那会把进度键值对混进 PCM 字节流，取样结果直接变成噪声；
 * - `-ss` / `-t` 放在 `-i` 之前：只为频谱服务，关键帧级定位就够，长音频不会拖慢时间轴；
 * - `-ac 1 -ar <低取样率>`：柱子是等分时间桶的峰值，不需要立体声也不需要 48k。
 */
export function buildAudioPeaksArgs(input: AudioPeaksArgsInput): string[] {
  const duration = Math.max(0.04, input.sourceOutSec - input.sourceInSec)
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    formatSec(Math.max(0, input.sourceInSec)),
    '-t',
    formatSec(duration),
    '-i',
    input.inputPath,
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    String(Math.max(1000, Math.round(input.sampleRate))),
    '-f',
    's16le',
    'pipe:1'
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
  /** M9-B：链尾目标像素格式/范围（缺省 = 旧版 yuv420p） */
  bitDepth?: 8 | 10
  colorRange?: 'limited' | 'full'
}): string[] {
  const box = computeWatermarkGeometry(input.watermark, input.output)
  return [
    `[${input.label}:v]format=rgba,scale=${box.width}:${box.height}[wm]`,
    `[${input.prevLabel}][wm]overlay=${box.x}:${box.y}:alpha=straight:format=auto:eof_action=pass,${outputTailFilters(input)}[v]`
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
  /** v3：本段所在媒体轨的合成序号（0 = 最底层）；缺省按 0 处理 */
  trackIndex?: number
  /** v3：本段所在媒体轨是否静音（静音轨仍出画面，但原声被丢弃） */
  muted?: boolean
  /** v6：画面调色/变换参数（原样透传；导出暂未烧录） */
  video?: MediaClipVideo
  /** v7：图像素材（需要 `-loop 1 -t` 才能撑成一段视频流） */
  isImage?: boolean
  /** v8：防抖参数（缺省/未启用 = 不防抖） */
  stab?: MediaClipStab
  /** v8：detect（pass 1）产出的运动数据文件名（相对任务工作目录，如 stab_0.trf）；由主进程分配 */
  stabFile?: string
  /** v9：该段原声的音量与渐入渐出（缺省 = 不动原声） */
  audio?: ClipAudio
  /** v9：该段变速（缺省 = 1x；视频走 `setpts`，音频走 `atempo`/`asetrate`） */
  speed?: ClipSpeed
  /** v10：入场转场（缺省 = 硬切）；非空时视频链用扩展手柄走 xfade，音频仍按切点硬切 */
  transitionIn?: MediaClipTransition
  /** M8：抠像参数（缺省 = 不抠像；只在导出侧合成） */
  key?: MediaClipKey
  /** M6-E：媒体段关键帧（缺省 = 静态几何；与旧 argv 逐字节一致） */
  keyframes?: KeyframeTrack[]
  /**
   * M8：手绘遮罩 PNG 的路径（主进程写盘后填）。
   * 缺省 = 不遮罩；argv 与旧版**逐字节一致**（没有这一路输入、段链不多一条语句）。
   */
  maskPath?: string
  /**
   * M8-P0：外部 matte 文件路径（静态图或视频；与 maskPath 可同时存在，两者都进 alpha 相乘链）。
   * 缺省 = 无外部 matte，argv 与旧版逐字节一致。
   */
  mattePath?: string
  /** M8-P0：外部 matte 类型（显式优先；缺省按扩展名推断，见 matteKindOf） */
  matteKind?: 'image' | 'video'
  /** v10：源素材总时长（手柄夹取用；图像视为无限手柄） */
  sourceDurationSec?: number
}

/** v8：该段本次导出是否需要防抖（开关打开且已分配到运动数据文件）。 */
export function segmentWantsStab(seg: ConcatSegment): boolean {
  return seg.stab?.enabled === true && typeof seg.stabFile === 'string' && seg.stabFile.length > 0
}

// ---------------------------------------------------------------------------
// M8：手绘遮罩（mask PNG → 段链 alpha 相乘 → 单轨合黑底 / 多轨保留透明）
// ---------------------------------------------------------------------------

/** 该段本次导出是否需要接遮罩（只有主进程写过 maskPath 才算）。 */
export function segmentWantsMask(seg: Pick<ConcatSegment, 'maskPath'>): boolean {
  return typeof seg.maskPath === 'string' && seg.maskPath.length > 0
}

// ---------------------------------------------------------------------------
// M8-P0：外部 matte（静态图 / 视频文件）
// ---------------------------------------------------------------------------

/** 静态图 matte 的扩展名集合。 */
const IMAGE_MATTE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'avif'])
/** 常见视频容器扩展名（其余扩展名视为「无法判断」，需要显式 matteKind）。 */
const VIDEO_MATTE_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'mpg',
  'mpeg',
  'mxf',
  'ts',
  'mts',
  'm2ts',
  'wmv',
  'flv',
  'ogv',
  '3gp',
  'prores',
  'y4m',
  'gifv'
])

/** matte 类型推断：扩展名 → image / video；不认识的扩展名返回 null（要求显式 matteKind）。 */
export function inferMatteKind(targetPath: string): 'image' | 'video' | null {
  const ext = (targetPath.split('.').pop() ?? '').toLowerCase()
  if (IMAGE_MATTE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_MATTE_EXTENSIONS.has(ext)) return 'video'
  return null
}

/** 显式优先、缺省按扩展名；无法判断时返回 null（由调用方报可读错误）。 */
export function resolveMatteKind(seg: Pick<ConcatSegment, 'mattePath' | 'matteKind'>): 'image' | 'video' | null {
  if (seg.matteKind === 'image' || seg.matteKind === 'video') return seg.matteKind
  return inferMatteKind(seg.mattePath ?? '')
}

/** 该段 matte 的最终类型：显式优先、缺省按扩展名，仍无法判断时按 video 兜底（构建 argv 用；预检会先报错）。 */
export function matteKindOf(seg: Pick<ConcatSegment, 'mattePath' | 'matteKind'>): 'image' | 'video' {
  return resolveMatteKind(seg) ?? 'video'
}

/** 该段本次导出是否需要接外部 matte。 */
export function segmentWantsMatte(seg: Pick<ConcatSegment, 'mattePath'>): boolean {
  return typeof seg.mattePath === 'string' && seg.mattePath.length > 0
}

/**
 * M8-P0：输入编号纪律（与 mask 同一套，先 mask 后 matte）：
 * 各段媒体（0..N-1）→ 各段 mask（N..N+maskTotal-1）→ 各段 matte（紧跟 mask 之后）
 * → 透明层/帧流 → 水印 → 音频。
 */
export function maskInputCount(segments: readonly Pick<ConcatSegment, 'maskPath'>[]): number {
  return segments.filter((seg) => segmentWantsMask(seg)).length
}

export function matteInputCount(segments: readonly Pick<ConcatSegment, 'mattePath'>[]): number {
  return segments.filter((seg) => segmentWantsMatte(seg)).length
}

/**
 * M8：遮罩输入的路序号。所有 builder 的输入顺序统一为：
 * 各段媒体（0..N-1）→ 各段的 mask PNG（N..N+M-1）→ 透明层/帧流 → 水印 → 音频。
 * 因此第 i 段的遮罩序号 = N + 「i 之前带遮罩的段数」。
 */
export function maskInputIndexFor(
  segments: readonly Pick<ConcatSegment, 'maskPath'>[],
  index: number
): number {
  const before = segments.slice(0, Math.max(0, index)).filter((seg) => segmentWantsMask(seg)).length
  return segments.length + before
}

/** M8-P0：第 i 段的外部 matte 输入序号（排在全部 mask 输入之后）。 */
export function matteInputIndexFor(
  segments: readonly (Pick<ConcatSegment, 'maskPath'> & Pick<ConcatSegment, 'mattePath'>)[],
  index: number
): number {
  const before = segments.slice(0, Math.max(0, index)).filter((seg) => segmentWantsMatte(seg)).length
  return segments.length + maskInputCount(segments) + before
}

/**
 * M8/M8-P0：段链需要的额外输入序号（mask 先、matte 后；没有对应输入的键不落）。
 * 三个基座（单轨/多轨/转场）共用，保证「输入编号」与「段链引用」始终同一口径。
 */
function alphaInputIndicesFor(
  segments: readonly ConcatSegment[],
  index: number
): { maskInputIndex?: number; matteInputIndex?: number } {
  const seg = segments[index]
  if (!seg) return {}
  return {
    ...(segmentWantsMask(seg) ? { maskInputIndex: maskInputIndexFor(segments, index) } : {}),
    ...(segmentWantsMatte(seg) ? { matteInputIndex: matteInputIndexFor(segments, index) } : {})
  }
}

/**
 * M8：遮罩 PNG 的输入参数（静态图循环播放）。
 *
 * 只喂 **1 帧**（`-t` = 一帧间隔），原因（本机 FFmpeg 8.1.1 实证）：
 * - 无界 `-loop 1` 时 `alphamerge` 的输出长度取两路中**较长**的一路（不是文档直觉的
 *   “按第一路结束”），1s 素材会被循环图拖成 90 帧；
 * - 静态图不会有变化，framesync 默认 `repeatlast` 会把最后一帧补齐到画面结束，
 *   于是输出长度恒等于段长，且与「本段被 span 夹短 / 转场扩展手柄」等时长差异完全解耦。
 */
export function buildMaskInputArgs(maskPath: string, fps: Fps): string[] {
  return ['-loop', '1', '-framerate', fpsToArg(fps), '-t', formatSec(frameIntervalSec(fps)), '-i', maskPath]
}

/**
 * M8-P0：外部 matte 的输入参数。
 * - 静态图：与手绘遮罩 PNG 完全同一写法（循环 + 只喂 1 帧，framesync repeatlast 补齐）；
 * - 视频：普通 `-i`（不加 -loop；时序裁切在段链里用 fps + trim 帧索引完成）。
 */
export function buildMatteInputArgs(
  seg: Pick<ConcatSegment, 'mattePath' | 'matteKind'>,
  fps: Fps
): string[] {
  if (!segmentWantsMatte(seg)) return []
  const target = seg.mattePath as string
  return matteKindOf(seg) === 'video' ? ['-i', target] : buildMaskInputArgs(target, fps)
}

export interface MediaMaskChainInput {
  /** 同一张 filter_complex 内的唯一后缀（用段下标），避免标签重复 */
  id: number | string
  /** 段链当前输出标签（不含方括号） */
  sourceLabel: string
  /** 遮罩/matte 输入的路序号（见 maskInputIndexFor / matteInputIndexFor） */
  maskInputIndex: number
  /**
   * M8-P0：输入种类。缺省 `'image'` = 旧行为（静态 PNG）；
   * `'video'` = 视频 matte，需要 sourceInSec/sourceOutSec/frameCount 做时序对齐。
   */
  kind?: 'image' | 'video'
  /** video matte：该段在 matte 上的源入点（与画面段同一 source 区间） */
  sourceInSec?: number
  /** video matte：源出点 */
  sourceOutSec?: number
  /** video matte：该段的输出帧数（trim 帧索引裁切，防止等长 matte 多出 1 帧） */
  frameCount?: number
  frameSize: { width: number; height: number }
  fps: Fps
  /** 段的输出时长（秒）：单轨黑底的时长基准 */
  durationSec: number
  /**
   * true = 单轨不透明基座：alpha 相乘后合到黑底并回到 yuv420p
   * （隐藏区必须变黑，不能保留原像素）；false = 多轨透明图层：保留 RGBA 让下层透出。
   */
  opaqueBackground: boolean
}

/**
 * M8-P0：alpha 相乘链的收尾（单轨不透明基座）。
 *
 * 黑底刻意比段长 +2s（`eof_action=pass` 让黑底在 alpha 流结束后继续供帧），
 * 再用 `trim=end=<段长>` 精确截回段长。为什么不用 `eof_action=endall`：
 * 本机 FFmpeg 8.1.1 实证 endall 的输出 EOF 落在「最后一帧 PTS」而不是「PTS+帧时长」，
 * 后续 `fps=..` 会因此少出一帧（1s/30fps 成片变 29 帧，拼接后整条时间轴错 1 帧）。
 */
export function buildAlphaOpaqueFinish(input: {
  id: number | string
  sourceLabel: string
  frameSize: { width: number; height: number }
  fps: Fps
  durationSec: number
}): { statements: string[]; outputLabel: string } {
  const size = `${input.frameSize.width}x${input.frameSize.height}`
  const bg = `mbg${input.id}`
  const out = `mout${input.id}`
  return {
    statements: [
      `color=c=black:s=${size}:r=${fpsToArg(input.fps)}:d=${formatSec(Math.max(0.01, input.durationSec + 2))}[${bg}]`,
      // 黑底供帧 → 精确 trim 回段长（EOF 必须落在段长上，否则后续 fps 会少一帧）
      `[${bg}][${input.sourceLabel}]overlay=0:0:format=auto:eof_action=pass:shortest=0,trim=end=${formatSec(
        Math.max(0.01, input.durationSec)
      )},setpts=PTS-STARTPTS,format=yuv420p[${out}]`
    ],
    outputLabel: out
  }
}

/**
 * M8：mask / matte 的 alpha 相乘段链。
 *
 * 做法：段画面转 RGBA → 抽 alpha → 与输入灰度做 multiply → alphamerge 回写 alpha。
 * 与手绘遮罩同一套；`kind:'video'` 时先把 matte 用 `fps + trim 帧索引` 对齐到该段的输出帧。
 */
export function buildMediaMaskFilterChain(input: MediaMaskChainInput): {
  statements: string[]
  outputLabel: string
} {
  const { width, height } = input.frameSize
  const id = input.id
  const mb = `mb${id}`
  const mae = `mae${id}`
  const mm = `mm${id}`
  const mam = `mam${id}`
  const mon = `mon${id}`
  let maskPrep: string
  if (input.kind === 'video') {
    const rate = fpsToArg(input.fps)
    const ratio = fpsRatio(input.fps)
    const startFrame = Math.max(0, Math.round((input.sourceInSec ?? 0) * ratio))
    const count = Math.max(
      1,
      Math.round(
        input.frameCount ?? ((input.sourceOutSec ?? 0) - (input.sourceInSec ?? 0)) * ratio
      )
    )
    // 帧索引裁切（不用 trim=end=秒：边界帧会留在 PTS=end 上，等长 matte 会多 1 帧）
    maskPrep =
      `[${input.maskInputIndex}:v]fps=${rate}` +
      `,trim=start_frame=${startFrame}:end_frame=${startFrame + count}` +
      `,setpts=PTS-STARTPTS,format=gray,scale=${width}:${height}[${mm}]`
  } else {
    // 静态图：统一成灰度并归一到目标画布尺寸（白=可见，黑=隐藏）
    maskPrep = `[${input.maskInputIndex}:v]format=gray,scale=${width}:${height}[${mm}]`
  }
  const statements = [
    // 1) 段画面先转 RGBA（yuv420p 没有 alpha 通道可乘）
    `[${input.sourceLabel}]format=rgba[${mb}]`,
    // 2) 取段自身 alpha（普通视频恒为 255；多轨图层里已有透明补边）
    `[${mb}]alphaextract[${mae}]`,
    // 3) 遮罩/matte 统一成灰度（视频 matte 先按段窗口对齐到输出帧）
    maskPrep,
    // 4) alpha × mask（multiply：255×255=255 可见，×0=0 隐藏）
    `[${mae}][${mm}]blend=all_mode=multiply[${mam}]`,
    // 5) 新的 alpha 回写到 RGBA 画面
    `[${mb}][${mam}]alphamerge[${mon}]`
  ]
  if (!input.opaqueBackground) return { statements, outputLabel: mon }
  const finish = buildAlphaOpaqueFinish({
    id,
    sourceLabel: mon,
    frameSize: input.frameSize,
    fps: input.fps,
    durationSec: input.durationSec
  })
  return { statements: [...statements, ...finish.statements], outputLabel: finish.outputLabel }
}

/** v8：detect 去重键：同一源文件、同一帧序列、同一档位只需分析一次。
 *  主进程按本键分配 stabFile，同键段共享同一份 .trf。 */
export function stabSegmentKey(
  seg: Pick<ConcatSegment, 'refVideoPath' | 'sourceInSec' | 'sourceOutSec' | 'stab'>,
  fps: Fps
): string {
  const stab = seg.stab
  return [
    seg.refVideoPath,
    formatSec(seg.sourceInSec),
    formatSec(seg.sourceOutSec),
    fpsToArg(fps),
    stab?.level ?? 'standard',
    stab?.tripod === true ? 'tripod' : 'smooth'
  ].join('|')
}

/** `segmentsNeedMultiInput` 只需看时间坐标与逐段开关，不要求调用方交整段。 */
type MultiInputDecisionSegment = Pick<
  ConcatSegment,
  | 'timelineStartSec'
  | 'timelineEndSec'
  | 'sourceInSec'
  | 'sourceOutSec'
  | 'stab'
  | 'audio'
  | 'speed'
  | 'trackIndex'
  | 'muted'
  | 'isImage'
  | 'transitionIn'
  | 'maskPath'
  | 'mattePath'
  | 'matteKind'
>

/**
 * 是否走多输入 trim+concat 基座（v2 阶段 7）。
 *
 * 单段且时间轴/源都从头覆盖时回退旧单输入（argv 快照与旧行为零差异）；
 * 否则逐段 trim 后 concat，段间空隙由滤镜链补黑+静音。
 *
 * v8/v9 的关键纪律：**任何需要「逐段插入点」的参数都必须走 trim 链**。
 * 旧单输入链里没有 `vidstabtransform` / `atempo` / `volume` / `afade` / `setpts` 的位置，
 * 不切过去参数就会被默默吞掉（预览与导出分叉）。
 */
export function segmentsNeedMultiInput(segments: MultiInputDecisionSegment[] | undefined): boolean {
  if (!segments || segments.length === 0) return false
  if (segments.length > 1) return true
  // v3：任一段来自上层媒体轨（trackIndex > 0）都必须走多输入分层合成；
  // 即使只有一段，也可能需要按层叠加/静音，旧单输入 builder 没有分层入口。
  if (segments.some((seg) => (seg.trackIndex ?? 0) > 0)) return true
  // v3：静音轨必须走 trim 链用 anullsrc 补静音（单输入 builder 会直通 0:a）。
  if (segments.some((seg) => seg.muted === true)) return true
  // v7：单张静帧也要 `-loop 1 -t`，旧单输入 builder 不支持
  if (segments.some((seg) => seg.isImage === true)) return true
  // v8：任一防抖段必须走 trim 链才能注入 transform
  if (segments.some((seg) => seg.stab?.enabled === true)) return true
  // v9：音量/渐变/变速同上；`{speed:1,maintainPitch:false}` 这种不改时长的写法也要算
  if (segments.some((seg) => seg.audio !== undefined || seg.speed !== undefined)) return true
  // v10：转场只能走多输入路径（旧单输入 builder 没有 xfade 入口/扩展手柄）
  if (segments.some((seg) => seg.transitionIn !== undefined)) return true
  // M8：遮罩必须在「段链输出之后」插 alpha 相乘，旧单输入 builder 没有逐段插入点
  if (segments.some((seg) => segmentWantsMask(seg))) return true
  // M8-P0：外部 matte 同样需要逐段 alpha 相乘（且要独立输入）
  if (segments.some((seg) => segmentWantsMatte(seg))) return true
  const only = segments[0]
  if (!only) return false
  // 单段但被剪裁/不在 0 起点：时长恒等式下 timelineEndSec - timelineStartSec === sourceOutSec - sourceInSec，
  // 任何一个坐标偏离「整段从头覆盖」都必须走 trim 路径
  return (
    only.sourceInSec > 1e-6 ||
    only.timelineStartSec > 1e-6 ||
    only.timelineEndSec - only.timelineStartSec !== only.sourceOutSec - only.sourceInSec ||
    only.timelineEndSec < only.sourceOutSec - 1e-6
  )
}

// ---------------------------------------------------------------------------
// v10（Task 7）：ConcatSegment → 转场导出计划（主进程 stab 检测与两条基座共用）
// ---------------------------------------------------------------------------

export interface TransitionPlanContext {
  plan: TransitionExportPlan
  /** 输入序号 → 核心区间已按 span 夹取的段（`source*` = 音频仍使用的核心源区间） */
  segments: Map<number, ConcatSegment>
  /** 输入序号 → 该段的扩展计划（视频 trim 使用 `sourceInExtSec/sourceOutExtSec`） */
  segmentPlans: Map<number, TransitionExportSegmentPlan>
  hasTransitions: boolean
}

/**
 * 把导出请求里的 `ConcatSegment[]` 适配成 `planTransitionExport` 的输入。
 *
 * 做两件事：
 * 1. 按 [spanStart, spanEnd] 夹取核心区间（音频与视频总时长仍等于 span）；
 * 2. 只保留「两侧片段都完整落在 span 内」的转场——被 span 切开的切点或窗口
 *    不再扩展手柄，避免把 xfade offset 推到 0 之前。
 *
 * `indices` 用于多轨分组：分组只参与 run 规划，但输入序号必须保留整体 `-i` 顺序。
 */
export type TransitionExportTrackSegment = Omit<ConcatSegment, 'hasAudio'> & { hasAudio?: boolean }

export function planTransitionExportForConcat(input: {
  segments: readonly TransitionExportTrackSegment[]
  fps: Fps
  spanStartSec?: number
  spanEndSec?: number
  indices?: readonly number[]
}): TransitionPlanContext {
  const spanStart = input.spanStartSec ?? Number.NEGATIVE_INFINITY
  const spanEnd = input.spanEndSec ?? Number.POSITIVE_INFINITY
  const entries: TransitionExportInputSegment[] = []
  const segments = new Map<number, ConcatSegment>()

  input.segments.forEach((seg, position) => {
    const index = input.indices?.[position] ?? position
    const speed = speedValueOf(seg.speed)
    const fullyInside =
      seg.timelineStartSec >= spanStart - 1e-9 && seg.timelineEndSec <= spanEnd + 1e-9
    const start = Math.max(seg.timelineStartSec, spanStart)
    const end = Math.min(seg.timelineEndSec, spanEnd)
    const sourceIn = fullyInside ? seg.sourceInSec : seg.sourceInSec + (start - seg.timelineStartSec) * speed
    const sourceOut = fullyInside ? seg.sourceOutSec : seg.sourceInSec + Math.max(0, end - seg.timelineStartSec) * speed
    const keepTransition = fullyInside && seg.transitionIn !== undefined
    const clip: MediaClip = {
      id: `seg-${index}`,
      mediaId: '',
      trackId: 'export-track',
      timelineStartSec: start,
      timelineEndSec: Math.max(start, end),
      sourceInSec: Math.max(0, sourceIn),
      sourceOutSec: Math.max(sourceIn, sourceOut),
      ...(seg.speed ? { speed: seg.speed } : {}),
      ...(keepTransition ? { transitionIn: seg.transitionIn } : {})
    }
    const clamped: ConcatSegment = {
      ...seg,
      // OverlaySegment 的 hasAudio 是可选的；这里回落到「非图像即有音轨」的旧口径
      hasAudio: seg.hasAudio ?? !seg.isImage,
      timelineStartSec: clip.timelineStartSec,
      timelineEndSec: clip.timelineEndSec,
      sourceInSec: clip.sourceInSec,
      sourceOutSec: clip.sourceOutSec,
      ...(keepTransition ? {} : { transitionIn: undefined })
    }
    segments.set(index, clamped)
    entries.push({
      index,
      clip,
      meta: seg.isImage
        ? { durationSec: Number.POSITIVE_INFINITY, kind: 'image' }
        : seg.sourceDurationSec !== undefined
          ? { durationSec: seg.sourceDurationSec, kind: 'video' }
          : null
    })
  })

  const plan = planTransitionExport({ segments: entries, fps: input.fps })
  const segmentPlans = new Map<number, TransitionExportSegmentPlan>()
  for (const run of plan.runs) {
    for (const segment of run.segments) segmentPlans.set(segment.index, segment)
  }
  return { plan, segments, segmentPlans, hasTransitions: plan.hasTransitions }
}

/**
 * 多轨安全版：按 `trackIndex` 分组计算计划（run/手柄只在同轨成立），
 * 再把各轨的 `index → 段计划` 合并。主进程 stab 检测与图像 `-t` 都用它，
 * 避免跨轨片段被误当成相邻前段。
 */
export function transitionSegmentPlansByTrack(input: {
  segments: readonly TransitionExportTrackSegment[]
  fps: Fps
  spanStartSec?: number
  spanEndSec?: number
}): Map<number, TransitionExportSegmentPlan> {
  const byTrack = new Map<number, { seg: TransitionExportTrackSegment; index: number }[]>()
  input.segments.forEach((seg, index) => {
    const track = Math.max(0, Math.round(seg.trackIndex ?? 0))
    const list = byTrack.get(track) ?? []
    list.push({ seg, index })
    byTrack.set(track, list)
  })
  const plans = new Map<number, TransitionExportSegmentPlan>()
  for (const group of byTrack.values()) {
    const ctx = planTransitionExportForConcat({
      segments: group.map((entry) => entry.seg),
      indices: group.map((entry) => entry.index),
      fps: input.fps,
      spanStartSec: input.spanStartSec,
      spanEndSec: input.spanEndSec
    })
    for (const [index, segment] of ctx.segmentPlans) plans.set(index, segment)
  }
  return plans
}

/**
 * 段链公共前缀（v8）：trim → 归零 → 按目标帧率重采样。
 * detect（pass 1）与合成段链必须共用本 helper：.trf 按帧序号索引，
 * 两侧帧序列逐帧对齐是补偿不错位的硬前提。
 */
function segmentTrimFpsPrefix(sourceInSec: number, sourceOutSec: number, rate: string): string {
  return `trim=start=${formatSec(sourceInSec)}:end=${formatSec(sourceOutSec)},setpts=PTS-STARTPTS,fps=${rate}`
}

/** v8：vidstabtransform 滤镜串（导出合成链与 v8.1 预览代理共用；诊断脚本也直接消费本函数，保证取证与生产逐字一致）。
 *  文件名固定相对任务工作目录，无盘符冒号转义问题；
 *  滤镜名与首个选项用 `=` 连接（真机实证：`vidstabtransform:input=` 报 No option name）。 */
export function stabTransformFilter(stab: MediaClipStab, stabFile: string): string {
  const p = stabTransformProfile(stab)
  const zoom =
    p.mode === 'tripod'
      ? // 虚拟三脚架：静态最优缩放 + 固定内缩边距（无逐帧变倍脉动），绝不写 vidstab tripod 宏
        [`optzoom=${p.optzoom}`, `zoom=${p.zoomMargin}`]
      : // 常规：逐帧动态最优缩放 + zoomspeed（已真机验证能抑制抖动，非本次缺陷路径）
        [`optzoom=${p.optzoom}`, `zoomspeed=${p.zoomspeed}`]
  return [
    `vidstabtransform=input=${stabFile}`,
    `smoothing=${p.smoothing}`,
    `optalgo=${p.optalgo}`,
    ...zoom,
    `interpol=${p.interpol}`,
    `crop=${p.crop}`
  ].join(':')
}

/** v8：vidstabdetect 滤镜串；tripod 参考帧号 >0 时才写（默认 0 = 关）。 */
function stabDetectFilter(stab: MediaClipStab, resultFile: string): string {
  const p = stabDetectProfile(stab)
  return [
    `vidstabdetect=shakiness=${p.shakiness}`,
    `accuracy=${p.accuracy}`,
    `result=${resultFile}`,
    ...(p.tripod > 0 ? [`tripod=${p.tripod}`] : [])
  ].join(':')
}

export interface StabDetectArgsInput {
  inputPath: string
  sourceInSec: number
  sourceOutSec: number
  fps: Fps
  stab: MediaClipStab
  /** 运动数据输出文件名（相对 ffmpeg 工作目录）；调用方需把 cwd 设为任务临时目录 */
  resultFile: string
}

/**
 * v8：防抖 pass 1（运动检测）：只解码不编码，`-f null` 丢弃像素，.trf 落到工作目录。
 * 帧序列前缀与合成段链同源（segmentTrimFpsPrefix），保证帧序号逐帧对齐。
 */
export function buildStabDetectArgs(input: StabDetectArgsInput): string[] {
  const prefix = segmentTrimFpsPrefix(input.sourceInSec, input.sourceOutSec, fpsToArg(input.fps))
  return [
    ...common({}),
    '-i',
    input.inputPath,
    '-vf',
    `${prefix},${stabDetectFilter(input.stab, input.resultFile)}`,
    '-an',
    '-f',
    'null',
    '-'
  ]
}

export interface StabPreviewArgsInput {
  inputPath: string
  sourceInSec: number
  sourceOutSec: number
  fps: Fps
  stab: MediaClipStab
  /** 运动数据文件名（相对工作目录，detect 产物） */
  stabFile: string
  /** 是否携带该区间原声（预览代理要能出声） */
  hasAudio: boolean
  outputPath: string
}

/**
 * v8.1：防抖预览代理的单进程转码（detect 产物已就绪后跑）：
 * 与导出合成同一 transform 滤镜串与同一 trim+fps 前缀，交付坐标 = 源区间 1:1；
 * 速度优先（veryfast + crf 20）——预览代理要的是尽快可播，不是归档画质。
 */
export function buildStabPreviewArgs(input: StabPreviewArgsInput): string[] {
  const prefix = segmentTrimFpsPrefix(input.sourceInSec, input.sourceOutSec, fpsToArg(input.fps))
  const args: string[] = [
    ...common({}),
    '-i',
    input.inputPath,
    '-vf',
    `${prefix},${stabTransformFilter(input.stab, input.stabFile)},setsar=1,format=yuv420p`
  ]
  if (input.hasAudio) {
    // -vf 只动视频；音频必须同样裁到源区间，否则代理会比画面长一整条原音轨
    args.push(
      '-af',
      `atrim=start=${formatSec(input.sourceInSec)}:end=${formatSec(input.sourceOutSec)},asetpts=PTS-STARTPTS`,
      '-c:a',
      'aac',
      '-b:a',
      '128k'
    )
  } else {
    args.push('-an')
  }
  args.push(
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'veryfast',
    '-fps_mode',
    'cfr',
    ...BT709_TAGS,
    '-movflags',
    '+faststart',
    input.outputPath
  )
  return args
}

// ---------------------------------------------------------------------------
// v10：4K / MXF 预览代理（只服务预览，导出永远读原片）
// ---------------------------------------------------------------------------

export interface ProxyArgsInput {
  inputPath: string
  outputPath: string
  /** 源是否带音轨；缺省 true（无音轨时 `-c:a` 不会产生音轨，不影响结果） */
  hasAudio?: boolean
  /** 代理帧率（缺省 MEDIA_PROXY.fps = 30） */
  fps?: number
}

/**
 * 代理缩放：短边 ≤720、长边 ≤1280、保持原始宽高比。
 *
 * 规格原文写的是 w=min(1280,720*iw/ih) / h=min(1280,720*ih/iw)；直接照抄会在
 * 16:9 源上得到 1280×405（h 公式把 720 当成了长边），画面会被压扁。这里用等价但
 * 正确的「按短边 720、长边 1280 夹取」写法：w 取两种取向的较大者，h=-2 由 FFmpeg
 * 按比例补偶数高度，因此竖屏 1080×1920 → 720×1280、4K → 1280×720。
 */
export function proxyScaleFilter(fps: number = MEDIA_PROXY.fps): string {
  const w = `trunc(max(min(${MEDIA_PROXY.maxLongSide},${MEDIA_PROXY.maxShortSide}*iw/ih),min(${MEDIA_PROXY.maxShortSide},${MEDIA_PROXY.maxLongSide}*iw/ih))/2)*2`
  return `scale=w='${w}':h=-2,fps=${fps},setsar=1,format=yuv420p`
}

/**
 * v10：4K / MXF 预览代理的单进程转码（整片 1:1 时间轴，预览坐标不需要偏移）。
 * 速度优先（veryfast + CRF 23），faststart 保证 `socut-media://` 的 Range 流边下边播。
 */
export function buildProxyArgs(input: ProxyArgsInput): string[] {
  const args: string[] = [
    ...common({ loglevel: 'error' }),
    '-i',
    input.inputPath,
    '-vf',
    proxyScaleFilter(input.fps)
  ]
  if (input.hasAudio === false) {
    args.push('-an')
  } else {
    args.push('-c:a', 'aac', '-b:a', `${MEDIA_PROXY.audioBitrateKbps}k`)
  }
  args.push(
    '-c:v',
    'libx264',
    '-crf',
    String(MEDIA_PROXY.crf),
    '-preset',
    'veryfast',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    input.outputPath
  )
  return args
}

// ---------------------------------------------------------------------------
// v10：交付画布归一（cover 裁切 / contain 补边）
// ---------------------------------------------------------------------------

/**
 * 画布归一滤镜串：
 * - `cover`：等比放大到覆盖目标画布后居中裁切（不拉伸、不留边）；
 * - `contain`：等比缩小装入目标画布，四周补边（单轨补黑，多轨图层补透明）。
 * 链尾恒有 `setsar=1`，避免非方形像素素材把目标画布再拉变形。
 */
export function buildCanvasNormalizeFilter(input: {
  width: number
  height: number
  fit: ExportFit
  transparent: boolean
}): string {
  const size = `${input.width}:${input.height}`
  if (input.fit === 'cover') {
    return `scale=${size}:force_original_aspect_ratio=increase,crop=${size},setsar=1`
  }
  return (
    `scale=${size}:force_original_aspect_ratio=decrease` +
    `,pad=${size}:(ow-iw)/2:(oh-ih)/2:color=${input.transparent ? 'black@0.0' : 'black'},setsar=1`
  )
}

export interface MediaBasisOverlayInput {
  /** 按 timelineStartSec 升序的媒体段（至少一段） */
  segments: ConcatSegment[]
  /** 本次输出覆盖的时间轴区间（含开头/中间/尾部空隙补黑） */
  spanStartSec: number
  spanEndSec: number
  /**
   * 透明层/帧流输入索引（两阶段法或直管道）。
   * M8：遮罩输入排在各段媒体之后，所以这里 = segments.length + maskCount；
   * 水印输入 = overlayLabel + 1、音频输入依次后移，均由调用方按同一口径传入。
   */
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
  /** M7-E：图形层 z 档；缺省 aboveMedia（旧 argv 逐字节不变） */
  graphicsZ?: GraphicsZ
  /** 水印（可选）：作为紧接透明层之后的一路输入，合成在最后一层 */
  watermark?: WatermarkInput
  /** v7：音频轨（可选）：全部追加在水印之后，与基座原声混在一起输出 */
  audioClips?: AudioMixClip[]
  /**
   * M8：`denoise = 'ai'` 用的 RNNoise 模型绝对路径（main 侧解析随包 `std.rnnn` 后下传）。
   * 缺省时 ai 档不产出滤镜（main 会在导出前把"要 ai 但没模型"拦成明确错误）。
   */
  arnndnModelPath?: string
  /** v10：显式目标画布；缺省 = 不做画布归一（argv 与旧版逐字节一致） */
  canvas?: { width: number; height: number; fit: ExportFit }
  /** v10：画质档；缺省 = high（CRF 18，与现有默认一致） */
  quality?: ExportQuality
  /** 视频编码格式；缺省 = AVC/H.264；M9 增加 AV1 */
  videoCodec?: VideoCodec
  /** 视频码率（kbps）；有值时走码率模式 */
  videoBitrateKbps?: number
  /** 音频码率（kbps）；有值时 AAC 分支使用该码率 */
  audioBitrateKbps?: number
  /** M9：CRF 直给（0–51）；缺省按画质档 */
  crf?: number
  /** M9：软件编码 preset（x264/x265 名称；AV1 映射到 SVT-AV1 档位） */
  encoderPreset?: string
  /** M9：输出位深（10 走 yuv420p10le） */
  bitDepth?: 8 | 10
  /** M9：色彩范围标签（full → -color_range pc） */
  colorRange?: 'limited' | 'full'
  /** v10：成片响度标准化（off/缺省 = 不注入 loudnorm，argv 与旧版一致） */
  mastering?: AudioMastering
}

/** v7：一条要混进成片的音频段（时间轴口径，秒） */
export interface AudioMixClip {
  path: string
  timelineStartSec: number
  timelineEndSec: number
  sourceInSec: number
  /** v9：源出点。变速时它比时间轴长度更长（缺省 = 按时间轴长度，argv 与旧版一致） */
  sourceOutSec?: number
  /** v9：音量与渐入渐出 */
  audio?: ClipAudio
  /** v9：变速 */
  speed?: ClipSpeed
  /** v10：角色（缺省 = voice）；bgm 段参与自动压低 */
  role?: AudioRole
  /** v10：BGM 自动压低档位（仅 role=bgm 时有意义） */
  ducking?: AudioDuckingLevel
}

export interface AudioMixPlan {
  /** 要在现有输入之后追加的 `-ss/-t/-i` 参数 */
  inputArgs: string[]
  /** 追加到 filter_complex 的语句（已用 `;` 连接，不带尾部 `;`） */
  filter: string
  /** 最终音频标签（调用方 `-map [label]`） */
  label: string
}

/**
 * 音频轨混音（v7；v10 加 BGM 自动压低与响度标准化）。
 *
 * 口径：
 * - `-ss/-t` 放在 `-i` **之前**：只解码用得到的那一段，长音频不会拖慢导出；
 * - `adelay=delays=…:all=1`：对单声道/立体声都成立（不依赖“声道数 = 延迟个数”）；
 * - `normalize=0`：amix 默认会把每路除以路数，会把原声越混越小；关掉才是真正的混音；
 * - 最后统一 `atrim=duration=<span>`：不管各路长短，输出恰好等于本次导出的时间窗。
 *
 * **零回归**：没有任何 `role = bgm` 的片段时，逐段链、基座/音频段 amix 与最终标签
 * 完全沿用 v7 的语句（只有显式开启响度时才在 `[amix]` 之后追加一条 `loudnorm`）。
 * 有 BGM 时才进入双总线：voice = 基座原声 + 非 BGM 段，bgm = BGM 段；
 * BGM 开 ducking 且 voice 非空时用最强势的 `sidechaincompress` 压 BGM 再与 voice 合并。
 *
 * 没有音频段时返回 null——调用方保持原 argv 一字不改（旧工程导出行为不变）。
 */
export function buildAudioMixPlan(input: {
  clips: AudioMixClip[]
  /** 第一个音频输入的全局下标（前面已有多少路 `-i`） */
  baseIndex: number
  spanStartSec: number
  spanEndSec: number
  /** 基座原声标签（如 `[ab]`）；不传 = 只混这些音频段 */
  baseLabel?: string
  /** v10：成片响度标准化（off/缺省 = 不注入 loudnorm，argv 与旧版逐字节一致） */
  mastering?: AudioMastering
  /** M8：`denoise = 'ai'` 的 RNNoise 模型路径（缺省 = ai 档不产出滤镜） */
  arnndnModelPath?: string
}): AudioMixPlan | null {
  if (input.clips.length === 0) return null
  const spanLen = formatSec(Math.max(0.01, input.spanEndSec - input.spanStartSec))
  const inputArgs: string[] = []
  const statements: string[] = []
  const labels: string[] = []
  const voiceLabels: string[] = []
  const bgmLabels: string[] = []

  input.clips.forEach((clip, index) => {
    const outLen = Math.max(0.01, clip.timelineEndSec - clip.timelineStartSec)
    const speed = speedValueOf(clip.speed)
    // 源窗口：变速时才是真的“读多少源”；不变速时等于输出长度（argv 与 v7 逐字节一致）
    const sourceLen = Math.max(
      0.01,
      clip.sourceOutSec !== undefined ? clip.sourceOutSec - clip.sourceInSec : outLen * speed
    )
    const delayMs = Math.max(0, Math.round((clip.timelineStartSec - input.spanStartSec) * 1000))
    inputArgs.push('-ss', formatSec(Math.max(0, clip.sourceInSec)), '-t', formatSec(sourceLen), '-i', clip.path)
    const label = `ai${index}`
    const fx = clipAudioFilterChain({
      audio: clip.audio,
      speed: clip.speed,
      outputDurationSec: outLen,
      ...(input.arnndnModelPath ? { arnndnModelPath: input.arnndnModelPath } : {})
    })
    statements.push(
      `[${input.baseIndex + index}:a]atrim=duration=${formatSec(sourceLen)},asetpts=PTS-STARTPTS` +
        `${fx.length > 0 ? `,${fx}` : ''},` +
        `aresample=async=1:first_pts=0,adelay=delays=${delayMs}:all=1[${label}]`
    )
    labels.push(`[${label}]`)
    if (clip.role === 'bgm') bgmLabels.push(label)
    else voiceLabels.push(label)
  })

  const mastering = loudnormFilter(input.mastering)
  const finish = (): AudioMixPlan => {
    if (!mastering) return { inputArgs, filter: statements.join(';'), label: 'amix' }
    statements.push(`[amix]${mastering}[aout]`)
    return { inputArgs, filter: statements.join(';'), label: 'aout' }
  }

  // ---- 无 BGM：保持 v7 的语句顺序与标签（响度只是尾部追加一条）
  if (bgmLabels.length === 0) {
    const sources = input.baseLabel ? [input.baseLabel, ...labels] : labels
    if (sources.length === 1) {
      statements.push(`${sources[0]}atrim=duration=${spanLen},asetpts=PTS-STARTPTS[amix]`)
    } else {
      statements.push(
        `${sources.join('')}amix=inputs=${sources.length}:duration=longest:dropout_transition=0:normalize=0[mx]`
      )
      statements.push(`[mx]atrim=duration=${spanLen},asetpts=PTS-STARTPTS[amix]`)
    }
    return finish()
  }

  // ---- BGM：两条总线各自先混，再按 ducking 档位合并
  /** 单路总线直接复用原标签；多路才生成 amix。入参/返回都是不带方括号的标签。 */
  const mixBus = (sources: string[], name: string): string | null => {
    if (sources.length === 0) return null
    if (sources.length === 1) return sources[0]!
    statements.push(
      `${sources.map((label) => `[${label}]`).join('')}` +
        `amix=inputs=${sources.length}:duration=longest:dropout_transition=0:normalize=0[${name}]`
    )
    return name
  }

  const voiceBus = mixBus(
    input.baseLabel ? [stripLabel(input.baseLabel), ...voiceLabels] : voiceLabels,
    'vbus'
  )
  const bgmBus = mixBus(bgmLabels, 'bbus')
  const ducking = duckingStrengthOf(input.clips)

  let finalBus: string
  if (voiceBus !== null && bgmBus !== null && ducking) {
    // voice 同时做 sidechain 与最终混音：必须先 split，否则同一标签被消费两次
    statements.push(`[${voiceBus}]asplit=2[vsc][vmix]`)
    statements.push(duckingFilter(ducking, bgmBus, 'vsc', 'bduck'))
    statements.push(
      `[vmix][bduck]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mx]`
    )
    finalBus = 'mx'
  } else if (voiceBus !== null && bgmBus !== null) {
    statements.push(
      `[${voiceBus}][${bgmBus}]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[mx]`
    )
    finalBus = 'mx'
  } else {
    finalBus = (voiceBus ?? bgmBus)!
  }
  statements.push(`[${finalBus}]atrim=duration=${spanLen},asetpts=PTS-STARTPTS[amix]`)
  return finish()
}

/** `[ab]` → `ab`（总线只接受裸标签）。 */
function stripLabel(label: string): string {
  return label.startsWith('[') && label.endsWith(']') ? label.slice(1, -1) : label
}

/** v7：透明出口的音频选项（帧流是 0 号输入，音频从 1 号开始） */
export interface TransparentAudioOptions {
  clips: AudioMixClip[]
  spanStartSec: number
  spanEndSec: number
  /** v10：成片响度标准化（off/缺省 = 不注入 loudnorm） */
  mastering?: AudioMastering
  /** M8：`denoise = 'ai'` 的 RNNoise 模型路径 */
  arnndnModelPath?: string
}

/**
 * 透明出口的音频参数：存在音频段时返回 argv 片段（输入 + filter_complex + map + 编码），
 * 不存在时返回 null（调用方保持原 argv，包括 `-an`）。
 */
export function buildTransparentAudioArgs(audio: TransparentAudioOptions | undefined): string[] | null {
  if (!audio || audio.clips.length === 0) return null
  const plan = buildAudioMixPlan({
    clips: audio.clips,
    baseIndex: 1,
    spanStartSec: audio.spanStartSec,
    spanEndSec: audio.spanEndSec,
    mastering: audio.mastering,
    ...(audio.arnndnModelPath ? { arnndnModelPath: audio.arnndnModelPath } : {})
  })
  if (!plan) return null
  return [
    ...plan.inputArgs,
    '-filter_complex',
    `[0:v]null[v];${plan.filter}`,
    '-map',
    '[v]',
    '-map',
    `[${plan.label}]`,
    '-c:a',
    'aac',
    '-b:a',
    '192k'
  ]
}

/**
 * 段画面的 alpha 相乘链（M8 mask 先、M8-P0 matte 后；两者可同时存在）。
 *
 * - 只有 mask：标签/语句与旧版完全一致（id 用调用方传入的 maskId，单轨 `s{i}`、多轨 `m{i}`）；
 * - 只有 matte：id 用 `t{i}`；
 * - 两者同时：先 mask 再 matte（乘法可交换，但语句顺序固定并测试锁定）；
 * - `opaqueBackground=true`（单轨且无 fx）时链尾合黑底回 yuv420p，否则保留 RGBA。
 */
function maskedAlphaForSegment(input: {
  index: number
  seg: ConcatSegment
  sourceLabel: string
  maskInputIndex?: number
  matteInputIndex?: number
  /** mask 链的标签后缀前缀（保持旧 argv 一致：单轨 s、多轨 m） */
  maskIdPrefix: string
  sourceInSec: number
  sourceOutSec: number
  frameSize: { width: number; height: number }
  fps: Fps
  durationSec: number
  opaqueBackground: boolean
}): { statements: string[]; label: string; hasAlpha: boolean } {
  const hasMask = input.maskInputIndex !== undefined && segmentWantsMask(input.seg)
  const hasMatte = input.matteInputIndex !== undefined && segmentWantsMatte(input.seg)
  if (!hasMask && !hasMatte) {
    return { statements: [], label: input.sourceLabel, hasAlpha: false }
  }
  const maskChain = hasMask
    ? buildMediaMaskFilterChain({
        id: `${input.maskIdPrefix}${input.index}`,
        sourceLabel: input.sourceLabel,
        maskInputIndex: input.maskInputIndex as number,
        frameSize: input.frameSize,
        fps: input.fps,
        durationSec: input.durationSec,
        // 只有 mask 且需要不透明收尾时，沿用旧行为（一条链内直接合黑底）
        opaqueBackground: input.opaqueBackground && !hasMatte
      })
    : null
  const matteChain = hasMatte
    ? buildMediaMaskFilterChain({
        id: `t${input.index}`,
        sourceLabel: maskChain ? maskChain.outputLabel : input.sourceLabel,
        maskInputIndex: input.matteInputIndex as number,
        ...(matteKindOf(input.seg) === 'video'
          ? {
              kind: 'video' as const,
              sourceInSec: input.sourceInSec,
              sourceOutSec: input.sourceOutSec,
              frameCount: Math.max(1, Math.round((input.sourceOutSec - input.sourceInSec) * fpsRatio(input.fps)))
            }
          : {}),
        frameSize: input.frameSize,
        fps: input.fps,
        durationSec: input.durationSec,
        opaqueBackground: input.opaqueBackground && !maskChain
      })
    : null
  const statements = [...(maskChain ? maskChain.statements : []), ...(matteChain ? matteChain.statements : [])]
  if (!(hasMask && hasMatte && input.opaqueBackground)) {
    return { statements, label: (matteChain ?? maskChain)!.outputLabel, hasAlpha: true }
  }
  // 两者同时 + 单轨不透明：两条链都保持 RGBA，链尾统一合黑底
  const finish = buildAlphaOpaqueFinish({
    id: `f${input.index}`,
    sourceLabel: matteChain!.outputLabel,
    frameSize: input.frameSize,
    fps: input.fps,
    durationSec: input.durationSec
  })
  return { statements: [...statements, ...finish.statements], label: finish.outputLabel, hasAlpha: true }
}

/**
 * 单轨每段视频链（旧路径与转场路径共用，避免两条链分叉）：
 * trim → fps → stab → speed →（有画布）归一 → fx → 链尾 yuv420p。
 * `sourceInSec/sourceOutSec` 由调用方给出：旧路径用核心区间，转场路径用扩展手柄区间。
 *
 * M8：有遮罩/外部 matte 时在「归一化之后、fx 几何变换之前」做 alpha 相乘 —— 与预览把
 * mask 挂在媒体元素上（transform/filter 之前）的口径一致：遮罩随画面一起缩放/位移/旋转。
 */
function singleTrackVideoChains(input: {
  index: number
  seg: ConcatSegment
  sourceInSec: number
  sourceOutSec: number
  rate: string
  canvasFilter: string | null
  frameSize: { width: number; height: number }
  fps: Fps
  outputLabel: string
  baseLabel: string
  /** M8：遮罩输入路序号（undefined = 无遮罩） */
  maskInputIndex?: number
  /** M8-P0：外部 matte 输入路序号（undefined = 无 matte） */
  matteInputIndex?: number
}): { chains: string[]; label: string } {
  const stabChain = segmentWantsStab(input.seg)
    ? `,${stabTransformFilter(input.seg.stab!, input.seg.stabFile!)}`
    : ''
  const speedChain = clipVideoSpeedFilter(input.seg.speed)
  const speedPart = speedChain ? `,${speedChain}` : ''
  const prefix = segmentTrimFpsPrefix(input.sourceInSec, input.sourceOutSec, input.rate)
  const normalize = input.canvasFilter ?? 'setsar=1'
  const durationSec = Math.max(0, (input.sourceOutSec - input.sourceInSec) / speedValueOf(input.seg.speed))
  const needsFx = needsVideoFx(input.seg)
  const masked = maskedAlphaForSegment({
    index: input.index,
    seg: input.seg,
    sourceLabel: input.baseLabel,
    ...(input.maskInputIndex !== undefined ? { maskInputIndex: input.maskInputIndex } : {}),
    ...(input.matteInputIndex !== undefined ? { matteInputIndex: input.matteInputIndex } : {}),
    maskIdPrefix: 's',
    sourceInSec: input.sourceInSec,
    sourceOutSec: input.sourceOutSec,
    frameSize: input.frameSize,
    fps: input.fps,
    durationSec,
    opaqueBackground: !needsFx
  })
  if (!needsFx) {
    if (!masked.hasAlpha) {
      return {
        chains: [
          `[${input.index}:v]${prefix}${stabChain}${speedPart}` +
            `${input.canvasFilter ? `,${input.canvasFilter}` : ',setsar=1'},format=yuv420p[${input.outputLabel}]`
        ],
        label: input.outputLabel
      }
    }
    // 无 fx：归一化后在元素空间做 alpha 相乘，再合黑底回到 yuv420p（concat 需要统一像素格式）
    return {
      chains: [
        `[${input.index}:v]${prefix}${stabChain}${speedPart},${normalize}[${input.baseLabel}]`,
        ...masked.statements
      ],
      label: masked.label
    }
  }
  const fx = buildMediaClipVideoFx({
    baseLabel: masked.hasAlpha ? masked.label : input.baseLabel,
    outputLabel: input.outputLabel,
    video: input.seg.video,
    ...(input.seg.key ? { key: input.seg.key } : {}),
    ...(input.seg.keyframes ? { keyframes: input.seg.keyframes } : {}),
    frame: input.frameSize,
    fps: input.fps,
    durationSec,
    transparentBackground: false
  })
  return {
    chains: [
      `[${input.index}:v]${prefix}${stabChain}${speedPart},${normalize}[${input.baseLabel}]`,
      ...masked.statements,
      ...fx.statements
    ],
    label: input.outputLabel
  }
}

/** 单轨每段音频链（音频永远是核心源区间 + 切点硬切，绝不使用转场手柄）。 */
function segmentAudioChains(input: {
  index: number
  seg: ConcatSegment
  sourceInSec: number
  sourceOutSec: number
  outputLabel: string
  outLen: number
  /** M8：`denoise = 'ai'` 的 RNNoise 模型路径 */
  arnndnModelPath?: string
}): string[] {
  if (input.seg.hasAudio) {
    const audioFx = clipAudioFilterChain({
      audio: input.seg.audio,
      speed: input.seg.speed,
      outputDurationSec: input.outLen,
      ...(input.arnndnModelPath ? { arnndnModelPath: input.arnndnModelPath } : {})
    })
    return [
      `[${input.index}:a]atrim=start=${formatSec(input.sourceInSec)}:end=${formatSec(input.sourceOutSec)},` +
        `asetpts=PTS-STARTPTS${audioFx.length > 0 ? `,${audioFx}` : ''},` +
        `aresample=async=1:first_pts=0[${input.outputLabel}]`
    ]
  }
  const len = formatSec(Math.max(0, input.outLen))
  return [
    `anullsrc=channel_layout=stereo:sample_rate=48000[${input.outputLabel}src]`,
    `[${input.outputLabel}src]atrim=duration=${len},asetpts=PTS-STARTPTS[${input.outputLabel}]`
  ]
}

/**
 * 多素材基座滤镜链：逐段 trim+setpts 归零→（有空隙时）黑场补齐→
 * concat 成 [vb]/[ab]，再 setpts 抬到 span 起点、fps 规整、overlay 透明层。
 * concat 前先统一帧率/SAR/像素格式/音频采样格式，避免参数不一致的素材直接报错。
 * 段链不按时间轴平移 PTS：concat 自己按顺序累加时长，再偏移会二次累加。
 */
function buildSingleTrackBasis(
  input: Omit<MediaBasisOverlayInput, 'overlayPath'>
): string {
  const rate = fpsToArg(input.fps)
  const start = formatSec(input.spanStartSec)
  const size = `${input.frameSize.width}x${input.frameSize.height}`
  const chains: string[] = []
  const parts: string[] = []
  const ordered: string[] = []
  // v10：显式画布才注入归一；缺省保持旧的「不缩放、只 setsar」段链（argv 逐字节不变）
  const canvasFilter = input.canvas
    ? buildCanvasNormalizeFilter({
        width: input.canvas.width,
        height: input.canvas.height,
        fit: input.canvas.fit,
        transparent: false
      })
    : null
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
    const label = `s${i}`
    // v9：变速后的输出长度（= 时间轴长度）；音频滤镜的渐出起点与补静音长度都按它算
    const speed = speedValueOf(seg.speed)
    const outLen = Math.max(0, (seg.sourceOutSec - seg.sourceInSec) / speed)
    // v8：防抖段在 fps 重采样之后、setsar 之前插入 transform（与 detect 同一帧序列）
    // v9：画面变速挂在 fps 之后（.trf 按帧序号索引，不能在重采样前改 PTS）
    // M8：有遮罩时段链内部在「归一化后、fx 几何变换前」做 alpha 相乘（随画面一起变换）
    const video = singleTrackVideoChains({
      index: i,
      seg,
      sourceInSec: seg.sourceInSec,
      sourceOutSec: seg.sourceOutSec,
      rate,
      canvasFilter,
      frameSize: input.frameSize,
      fps: input.fps,
      outputLabel: needsVideoFx(seg) ? `fx${i}` : `pre${label}`,
      baseLabel: `bv${i}`,
      ...alphaInputIndicesFor(input.segments, i)
    })
    chains.push(...video.chains)
    // concat 会把输入自身的起点再累加一次，段链里绝不能再按时间轴平移 PTS：
    // 否则第二段视频/音频会被推到 2× 偏移处（实测两段各 0.5s 成片变 1.5s）。
    // 段间空隙已由 pushGap 补黑场/静音，concat 本身就是按顺序累加时长。
    parts.push(`[${video.label}]null[vs${i}]`)
    if (seg.hasAudio) {
      const audioFx = clipAudioFilterChain({
        audio: seg.audio,
        speed: seg.speed,
        outputDurationSec: outLen,
        ...(input.arnndnModelPath ? { arnndnModelPath: input.arnndnModelPath } : {})
      })
      chains.push(
        `[${i}:a]atrim=start=${segIn}:end=${segOut},asetpts=PTS-STARTPTS${audioFx.length > 0 ? `,${audioFx}` : ''},` +
          `aresample=async=1:first_pts=0[prea${label}]`
      )
    } else {
      const len = formatSec(Math.max(0, seg.timelineEndSec - seg.timelineStartSec))
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000[n${label}]`)
      parts.push(`[n${label}]atrim=duration=${len},asetpts=PTS-STARTPTS[prea${label}]`)
    }
    // 音频直连 concat（`null` 是纯视频滤镜，音频没有对应的一行透传写法）
    ordered.push(`[vs${i}][prea${label}]`)
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
    // M7-E：透明层与媒体基座的合成顺序由 graphicsZ 决定（缺省 aboveMedia，与旧 argv 一致）
    ...subtitleOverlayChains(input, 'v0'),
    // 水印输入固定是「透明层序号 + 1」（与下面两个 builder 的 `-i` 顺序同一口径）
    ...(input.watermark
      ? buildWatermarkFilterChain({
          label: Number(input.overlayLabel) + 1,
          prevLabel: subtitleOut,
          watermark: input.watermark,
          output: input.frameSize,
          ...(input.bitDepth ? { bitDepth: input.bitDepth } : {}),
          ...(input.colorRange ? { colorRange: input.colorRange } : {})
        })
      : [])
  ].join(';')
}

/**
 * v10 转场基座（单轨）：视频按 run 用 `xfade` 串接（无转场的切点仍 `concat`），
 * 音频**永远按核心源区间独立 concat**（切点硬切，不参与 xfade），最后把
 * `[vb]/[ab]` 接到与原路径相同的「平移 → overlay → 水印」尾部。
 */
function buildSingleTrackTransitionBasis(
  input: Omit<MediaBasisOverlayInput, 'overlayPath'>,
  ctx: TransitionPlanContext
): string {
  const rate = fpsToArg(input.fps)
  const start = formatSec(input.spanStartSec)
  const size = `${input.frameSize.width}x${input.frameSize.height}`
  const chains: string[] = []
  const parts: string[] = []
  const videoParts: string[] = []
  const audioParts: string[] = []
  const canvasFilter = input.canvas
    ? buildCanvasNormalizeFilter({
        width: input.canvas.width,
        height: input.canvas.height,
        fit: input.canvas.fit,
        transparent: false
      })
    : null
  let gapNo = 0
  let cursor = input.spanStartSec

  const pushGap = (gapLen: number): void => {
    if (gapLen <= 1e-6) return
    const vLabel = `tgv${gapNo}`
    const aLabel = `tga${gapNo}`
    gapNo += 1
    const len = formatSec(gapLen)
    chains.push(`color=c=black:s=${size}:r=${rate}:d=${len}[pre${vLabel}]`)
    parts.push(
      `[pre${vLabel}]fps=${rate},setsar=1,format=yuv420p,trim=duration=${len},setpts=PTS-STARTPTS[${vLabel}]`
    )
    chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000[pre${aLabel}]`)
    parts.push(
      `[pre${aLabel}]atrim=duration=${len},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[${aLabel}]`
    )
    videoParts.push(`[${vLabel}]`)
    audioParts.push(`[${aLabel}]`)
  }

  for (const run of ctx.plan.runs) {
    if (run.startSec > cursor + 1e-6) {
      pushGap(run.startSec - cursor)
      cursor = run.startSec
    }
    const active = run.segments.filter(
      (segment) => segment.coreDurationSec > 1e-6 && ctx.segments.get(segment.index) !== undefined
    )
    if (active.length === 0) continue
    const videoLabels: string[] = []
    for (const segment of active) {
      const seg = ctx.segments.get(segment.index)!
      const label = `trv${segment.index}`
      // M8：遮罩在段链内部、fx 几何之前生效（转场段同样用扩展手柄区间做归一化）
      const video = singleTrackVideoChains({
        index: segment.index,
        seg,
        // 视频 trim 用扩展手柄；音频仍用核心源区间（见下）
        sourceInSec: segment.sourceInExtSec,
        sourceOutSec: segment.sourceOutExtSec,
        rate,
        canvasFilter,
        frameSize: input.frameSize,
        fps: input.fps,
        outputLabel: label,
        baseLabel: `tbv${segment.index}`,
        ...alphaInputIndicesFor(input.segments, segment.index)
      })
      chains.push(...video.chains)
      videoLabels.push(video.label)

      const audioLabel = `tra${segment.index}`
      const audioPartsForSegment = segmentAudioChains({
        index: segment.index,
        seg,
        sourceInSec: seg.sourceInSec,
        sourceOutSec: seg.sourceOutSec,
        outputLabel: audioLabel,
        outLen: segment.coreDurationSec,
        ...(input.arnndnModelPath ? { arnndnModelPath: input.arnndnModelPath } : {})
      })
      chains.push(...audioPartsForSegment)
      // 音频按核心区间顺序 concat（空隙已由 pushGap 补静音），
      // 绝不能在 concat 前再按时间轴平移：concat 会把输入自身起点又累加一次，
      // 导致第二段之后的音频被推到 2× 偏移处（实测 2×3s 成片只有前 3s 有声）。
      audioParts.push(`[${audioLabel}]`)
    }

    let current = videoLabels[0]!
    for (let i = 1; i < active.length; i += 1) {
      const segment = active[i]!
      const next = videoLabels[i]!
      const out = `trr${run.runIndex}_${i}`
      if (segment.transition) {
        chains.push(
          `[${current}][${next}]xfade=transition=${segment.transition.xfade}` +
            `:duration=${formatSec(segment.transition.durationSec)}` +
            `:offset=${formatSec(segment.transition.offsetInRunSec)}[${out}]`
        )
      } else {
        chains.push(`[${current}][${next}]concat=n=2:v=1:a=0[${out}]`)
      }
      current = out
    }
    const runOut = `tru${run.runIndex}`
    parts.push(
      `[${current}]setpts=PTS+${formatSec(Math.max(0, run.startSec - input.spanStartSec))}/TB[${runOut}]`
    )
    videoParts.push(`[${runOut}]`)
    cursor = run.startSec + active.reduce((sum, segment) => sum + segment.coreDurationSec, 0)
  }

  if (cursor < input.spanEndSec - 1e-6) pushGap(input.spanEndSec - cursor)
  if (videoParts.length === 0) pushGap(input.spanEndSec - input.spanStartSec)
  if (audioParts.length === 0) pushGap(input.spanEndSec - input.spanStartSec)

  const videoConcat =
    videoParts.length > 1
      ? `${videoParts.join('')}concat=n=${videoParts.length}:v=1:a=0[vb]`
      : `${videoParts[0]}null[vb]`
  const audioConcat =
    audioParts.length > 1
      ? `${audioParts.join('')}concat=n=${audioParts.length}:v=0:a=1[ab]`
      : `${audioParts[0]}null[ab]`
  const subtitleOut = input.watermark ? 'vsub' : 'v'
  return [
    ...chains,
    ...parts,
    videoConcat,
    audioConcat,
    `[vb]setpts=PTS-${start}/TB,fps=${rate}[v0]`,
    // M7-E：透明层与媒体基座的合成顺序由 graphicsZ 决定（缺省 aboveMedia）
    ...subtitleOverlayChains(input, 'v0'),
    ...(input.watermark
      ? buildWatermarkFilterChain({
          label: Number(input.overlayLabel) + 1,
          prevLabel: subtitleOut,
          watermark: input.watermark,
          output: input.frameSize,
          ...(input.bitDepth ? { bitDepth: input.bitDepth } : {}),
          ...(input.colorRange ? { colorRange: input.colorRange } : {})
        })
      : [])
  ].join(';')
}

/**
 * 多轨每段图层链（旧路径与转场路径共用）：
 * trim → fps → stab → speed → 透明归一（rgba + pad black@0.0）→ fx → 链尾 rgba。
 *
 * M8：有遮罩时在「归一化之后、fx 几何变换之前」做 alpha 相乘（保留 RGBA：隐藏区透出下层），
 * 与预览把 mask 挂在媒体元素上（transform 之前）同一口径。
 */
function multiTrackVideoChains(input: {
  seg: ConcatSegment
  index: number
  sourceInSec: number
  sourceOutSec: number
  rate: string
  canvasFilter: string | null
  frameSize: { width: number; height: number }
  size: string
  fps: Fps
  plainLabel: string
  baseLabel: string
  fxLabel: string
  /** M8：遮罩输入路序号（undefined = 无遮罩 → 旧图层链逐字节不变） */
  maskInputIndex?: number
  /** M8-P0：外部 matte 输入路序号（undefined = 无 matte） */
  matteInputIndex?: number
}): { chains: string[]; label: string } {
  const stabChain = segmentWantsStab(input.seg)
    ? `,${stabTransformFilter(input.seg.stab!, input.seg.stabFile!)}`
    : ''
  const speedChain = clipVideoSpeedFilter(input.seg.speed)
  const speedPart = speedChain ? `,${speedChain}` : ''
  const legacyNormalize =
    // 旧字面量：contain + 透明补边（零画布时必须逐字节一致）
    `scale=${input.frameSize.width}:${input.frameSize.height}:force_original_aspect_ratio=decrease` +
    `,setsar=1,format=rgba,pad=${input.size}:(ow-iw)/2:(oh-ih)/2:color=black@0.0`
  // 默认路径（含画布）保持旧链；有画布时先转 rgba 再做归一（pad 的 black@0.0 需要 alpha）。
  const normalizeChain = input.canvasFilter ? `format=rgba,${input.canvasFilter}` : legacyNormalize
  const prefix = segmentTrimFpsPrefix(input.sourceInSec, input.sourceOutSec, input.rate)
  const needsFx = needsVideoFx(input.seg)
  const normalizeLabel = needsFx ? input.baseLabel : input.plainLabel
  const normalizeStatement = `[${input.index}:v]${prefix}${stabChain}${speedPart},${normalizeChain}[${normalizeLabel}]`
  const durationSec = Math.max(
    0,
    (input.sourceOutSec - input.sourceInSec) / speedValueOf(input.seg.speed)
  )
  // M8/M8-P0：透明图层只做 alpha 相乘、不合黑底（隐藏区 alpha=0 透出下层轨道）
  const masked = maskedAlphaForSegment({
    index: input.index,
    seg: input.seg,
    sourceLabel: normalizeLabel,
    ...(input.maskInputIndex !== undefined ? { maskInputIndex: input.maskInputIndex } : {}),
    ...(input.matteInputIndex !== undefined ? { matteInputIndex: input.matteInputIndex } : {}),
    maskIdPrefix: 'm',
    sourceInSec: input.sourceInSec,
    sourceOutSec: input.sourceOutSec,
    frameSize: input.frameSize,
    fps: input.fps,
    durationSec,
    opaqueBackground: false
  })
  if (!needsFx) {
    return {
      chains: [normalizeStatement, ...masked.statements],
      label: masked.label
    }
  }
  const fx = buildMediaClipVideoFx({
    baseLabel: masked.label,
    outputLabel: input.fxLabel,
    video: input.seg.video,
    ...(input.seg.key ? { key: input.seg.key } : {}),
    ...(input.seg.keyframes ? { keyframes: input.seg.keyframes } : {}),
    frame: input.frameSize,
    fps: input.fps,
    durationSec,
    transparentBackground: true
  })
  return {
    chains: [normalizeStatement, ...masked.statements, ...fx.statements],
    label: fx.outputLabel
  }
}

/**
 * v3 多轨：每条媒体轨先各自合成一张全帧 RGBA 层（透明补隙 + 片段 trim/缩放），
 * 再按 trackIndex 升序把图层从底到顶 overlay 到不透明黑底上，最后字幕、水印。
 *
 * 纪律：
 * - 图层时长恒等于 span，段间空隙用 `color=black@0.0` 补透明；overlay 用
 *   `eof_action=pass:shortest=0`，任何一层先结束都不会截断输出；
 * - 原声不在这里混：多轨内嵌原声由渲染侧按「最上层可见且未静音」压平后走 audioClips，
 *   本函数只输出一路等长静音 `[ab]` 供 buildAudioMixPlan 作为基座（无音频段时 `-map [ab]`）；
 * - 水印仍然最后叠，输入序号沿用「透明层序号 + 1」口径。
 */
function buildMultiTrackBasis(input: Omit<MediaBasisOverlayInput, 'overlayPath'>): string {
  const rate = fpsToArg(input.fps)
  const size = `${input.frameSize.width}x${input.frameSize.height}`
  const spanLen = formatSec(Math.max(0.01, input.spanEndSec - input.spanStartSec))
  const chains: string[] = []
  const parts: string[] = []
  const layerLabels: string[] = []
  // v10：显式画布才把旧 contain 链换成可配置 fit；缺省逐字节保留原 scale+pad 字面量
  const canvasFilter = input.canvas
    ? buildCanvasNormalizeFilter({
        width: input.canvas.width,
        height: input.canvas.height,
        fit: input.canvas.fit,
        transparent: true
      })
    : null

  // 输入序号必须保留原 segments 下标（`-i` 顺序由调用方决定）
  const byTrack = new Map<number, { seg: ConcatSegment; index: number }[]>()
  input.segments.forEach((seg, index) => {
    const track = Math.max(0, Math.round(seg.trackIndex ?? 0))
    const list = byTrack.get(track) ?? []
    list.push({ seg, index })
    byTrack.set(track, list)
  })

  const tracks = [...byTrack.keys()].sort((a, b) => a - b)
  let gapNo = 0
  let layerNo = 0
  for (const track of tracks) {
    const group = (byTrack.get(track) ?? []).sort((a, b) => a.seg.timelineStartSec - b.seg.timelineStartSec)
    const layerParts: string[] = []
    let cursor = input.spanStartSec

    const pushGap = (len: number): void => {
      if (len <= 1e-6) return
      const label = `mg${gapNo}`
      gapNo += 1
      chains.push(`color=c=black@0.0:s=${size}:r=${rate}:d=${formatSec(len)},format=rgba[${label}]`)
      layerParts.push(`[${label}]`)
    }

    // v10：该轨有转场且能解析出 xfade → 该层用 run 内的 xfade 链（透明图层）；
    // 无转场/解析失败 → 保持下面的旧逐段 concat 代码逐字节不变。
    if (group.some((entry) => entry.seg.transitionIn !== undefined)) {
      const transitionCtx = planTransitionExportForConcat({
        segments: group.map((entry) => entry.seg),
        indices: group.map((entry) => entry.index),
        fps: input.fps,
        spanStartSec: input.spanStartSec,
        spanEndSec: input.spanEndSec
      })
      if (transitionCtx.hasTransitions) {
        for (const run of transitionCtx.plan.runs) {
          if (run.startSec > cursor + 1e-6) {
            pushGap(run.startSec - cursor)
            cursor = run.startSec
          }
          const active = run.segments.filter(
            (segment) =>
              segment.coreDurationSec > 1e-6 && transitionCtx.segments.get(segment.index) !== undefined
          )
          if (active.length === 0) continue
          const runLabels: string[] = []
          for (const segment of active) {
            const seg = transitionCtx.segments.get(segment.index)!
            const video = multiTrackVideoChains({
              seg,
              index: segment.index,
              sourceInSec: segment.sourceInExtSec,
              sourceOutSec: segment.sourceOutExtSec,
              rate,
              canvasFilter,
              frameSize: input.frameSize,
              size,
              fps: input.fps,
              plainLabel: `tmc${segment.index}`,
              baseLabel: `tbv${segment.index}`,
              fxLabel: `tfx${segment.index}`,
              ...alphaInputIndicesFor(input.segments, segment.index)
            })
            chains.push(...video.chains)
            runLabels.push(video.label)
          }
          let current = runLabels[0]!
          for (let i = 1; i < active.length; i += 1) {
            const segment = active[i]!
            const next = runLabels[i]!
            const out = `mtr${run.runIndex}_${i}`
            if (segment.transition) {
              chains.push(
                `[${current}][${next}]xfade=transition=${segment.transition.xfade}` +
                  `:duration=${formatSec(segment.transition.durationSec)}` +
                  `:offset=${formatSec(segment.transition.offsetInRunSec)}[${out}]`
              )
            } else {
              chains.push(`[${current}][${next}]concat=n=2:v=1:a=0[${out}]`)
            }
            current = out
          }
          const runOut = `mru${run.runIndex}`
          parts.push(
            `[${current}]setpts=PTS+${formatSec(Math.max(0, run.startSec - input.spanStartSec))}/TB[${runOut}]`
          )
          layerParts.push(`[${runOut}]`)
          cursor = run.startSec + active.reduce((sum, segment) => sum + segment.coreDurationSec, 0)
        }
        if (cursor < input.spanEndSec - 1e-6) pushGap(input.spanEndSec - cursor)
        if (layerParts.length > 0) {
          const layer = `ml${layerNo}`
          layerNo += 1
          if (layerParts.length === 1) {
            parts.push(`${layerParts[0]}null[${layer}]`)
          } else {
            parts.push(`${layerParts.join('')}concat=n=${layerParts.length}:v=1:a=0[${layer}]`)
          }
          layerLabels.push(`[${layer}]`)
        }
        continue
      }
    }

    for (const { seg, index } of group) {
      const from = Math.max(seg.timelineStartSec, input.spanStartSec, cursor)
      const to = Math.min(seg.timelineEndSec, input.spanEndSec)
      if (to - from <= 1e-6) continue
      if (from > cursor + 1e-6) pushGap(from - cursor)
      const speed = speedValueOf(seg.speed)
      const sourceIn = seg.sourceInSec + (from - seg.timelineStartSec) * speed
      const sourceOut = seg.sourceInSec + (to - seg.timelineStartSec) * speed
      const video = multiTrackVideoChains({
        seg,
        index,
        sourceInSec: sourceIn,
        sourceOutSec: sourceOut,
        rate,
        canvasFilter,
        frameSize: input.frameSize,
        size,
        fps: input.fps,
        plainLabel: `mc${layerNo}_${index}`,
        baseLabel: `bv${index}`,
        fxLabel: `fx${index}`,
        ...alphaInputIndicesFor(input.segments, index)
      })
      chains.push(...video.chains)
      layerParts.push(`[${video.label}]`)
      cursor = Math.max(cursor, to)
    }
    if (cursor < input.spanEndSec - 1e-6) pushGap(input.spanEndSec - cursor)
    if (layerParts.length === 0) continue

    const layer = `ml${layerNo}`
    layerNo += 1
    if (layerParts.length === 1) {
      // concat n=1 在部分 FFmpeg 版本上会报参数错误，单段直接打标签
      parts.push(`${layerParts[0]}null[${layer}]`)
    } else {
      parts.push(`${layerParts.join('')}concat=n=${layerParts.length}:v=1:a=0[${layer}]`)
    }
    layerLabels.push(`[${layer}]`)
  }

  // 不透明黑底：所有轨道都可能在该时刻透明，最终输出必须是 yuv420p（不留 alpha）
  chains.push(`color=c=black:s=${size}:r=${rate}:d=${spanLen},format=rgba[mb]`)
  const subtitleOut = input.watermark ? 'vsub' : 'v'
  let current = 'mb'
  layerLabels.forEach((label, index) => {
    const out = `mo${index}`
    parts.push(`[${current}]${label}overlay=0:0:alpha=straight:format=auto:eof_action=pass:shortest=0[${out}]`)
    current = out
  })
  parts.push(`[${current}]format=yuv420p[mv]`)
  // M7-E：多轨基座与透明层的合成顺序由 graphicsZ 决定（缺省 aboveMedia）
  parts.push(...subtitleOverlayChains(input, 'mv'))

  // 多轨原声已由渲染侧压平进 audioClips：这里补一路等长静音，保证 [ab] 永远存在
  chains.push('anullsrc=channel_layout=stereo:sample_rate=48000[masrc]')
  parts.push(`[masrc]atrim=duration=${spanLen},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[ab]`)

  return [
    ...chains,
    ...parts,
    ...(input.watermark
      ? buildWatermarkFilterChain({
          label: Number(input.overlayLabel) + 1,
          prevLabel: subtitleOut,
          watermark: input.watermark,
          output: input.frameSize,
          ...(input.bitDepth ? { bitDepth: input.bitDepth } : {}),
          ...(input.colorRange ? { colorRange: input.colorRange } : {})
        })
      : [])
  ].join(';')
}

/**
 * 多素材基座滤镜链：单轨（全部 trackIndex = 0）保持旧的 trim+concat 行为；
 * 只要出现上层媒体轨，就改走逐轨 RGBA 图层合成（v3 多轨）。
 */
export function buildMediaBasisFilterComplex(
  input: Omit<MediaBasisOverlayInput, 'overlayPath'>
): string {
  if (input.segments.some((seg) => (seg.trackIndex ?? 0) > 0)) return buildMultiTrackBasis(input)
  // v10：只有「确实存在并解析出转场的段」才切到 xfade 链；
  // 没有任何 `transitionIn` 时连计划都不算，旧 argv 逐字节不变。
  if (input.segments.some((seg) => seg.transitionIn !== undefined)) {
    const ctx = planTransitionExportForConcat({
      segments: input.segments,
      fps: input.fps,
      spanStartSec: input.spanStartSec,
      spanEndSec: input.spanEndSec
    })
    if (ctx.hasTransitions) return buildSingleTrackTransitionBasis(input, ctx)
  }
  return buildSingleTrackBasis(input)
}

/**
 * M8/M8-P0：按段顺序追加遮罩与外部 matte 输入。
 *
 * 输入顺序必须是「各段媒体 → 各段 mask → 各段 matte → 透明层/帧流 → 水印 → 音频」：
 * 下游用 `maskInputIndexFor` / `matteInputIndexFor` 与
 * `overlayLabel = segments.length + maskCount + matteCount` 同一口径编号。
 * 无任何 maskPath/mattePath 时不追加任何参数（argv 与旧版逐字节一致）。
 */
function pushMaskInputs(args: string[], segments: readonly ConcatSegment[], fps: Fps): void {
  for (const seg of segments) {
    const maskPath = seg.maskPath
    if (!segmentWantsMask(seg) || maskPath === undefined) continue
    args.push(...buildMaskInputArgs(maskPath, fps))
  }
  // M8-P0：外部 matte 紧跟在全部 mask 输入之后（顺序与编号函数一致）
  for (const seg of segments) {
    if (!segmentWantsMatte(seg)) continue
    args.push(...buildMatteInputArgs(seg, fps))
  }
}

/** 多输入叠加（两阶段法）：N 路媒体 + 循环透明 MOV 帧序列，trim+concat 基座后叠加。 */
export function buildOverlayMp4MultiInput(
  input: MediaBasisOverlayInput,
  encoder?: string | null
): string[] {
  const audioArgs = overlayAudioArgs(input.audioMode, input.mastering, input.audioBitrateKbps)
  // v10：转场图像需要把 `-loop` 撑到扩展后的源出点（静态内容可无限延长）
  const transitionPlans = input.segments.some((seg) => seg.transitionIn !== undefined)
    ? transitionSegmentPlansByTrack({
        segments: input.segments,
        fps: input.fps,
        spanStartSec: input.spanStartSec,
        spanEndSec: input.spanEndSec
      })
    : null
  const args: string[] = [...common({})]
  input.segments.forEach((seg, index) => {
    // v7：图像没有帧流，必须用 `-loop 1 -t <时长>` 把它撑成一段视频
    // v9：这个 `-t` 是**变速前**的长度（源窗口），所以用源入出点而不是时间轴长度
    if (seg.isImage) {
      const ext = transitionPlans?.get(index)
      const extended = ext && (ext.headHandleSec > 0 || ext.tailHandleSec > 0)
      const length = extended
        ? Math.max(0.01, ext.sourceOutExtSec)
        : Math.max(0.01, seg.sourceOutSec - seg.sourceInSec)
      args.push('-loop', '1', '-t', formatSec(length))
    }
    args.push('-i', seg.refVideoPath)
  })
  // M8：遮罩 PNG 紧跟在各段媒体输入之后、透明 MOV 之前
  pushMaskInputs(args, input.segments, input.fps)
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
  // v7：音频轨追加在水印之后；没有音频段时 audioPlan 为 null，原 argv 一字不变
  const audioPlan = buildAudioMixPlan({
    clips: input.audioClips ?? [],
    baseIndex: Number(input.overlayLabel) + 1 + (input.watermark ? 1 : 0),
    spanStartSec: input.spanStartSec,
    spanEndSec: input.spanEndSec,
    baseLabel: '[ab]',
    mastering: input.mastering,
    ...(input.arnndnModelPath ? { arnndnModelPath: input.arnndnModelPath } : {})
  })
  if (audioPlan) args.push(...audioPlan.inputArgs)
  const basisFilter = buildMediaBasisFilterComplex(input)
  const mastering = audioPlan ? null : loudnormFilter(input.mastering)
  args.push(
    '-filter_complex',
    audioPlan
      ? `${basisFilter};${audioPlan.filter}`
      : mastering
        ? `${basisFilter};[ab]${mastering}[aout]`
        : basisFilter,
    '-map',
    '[v]',
    '-map',
    audioPlan ? `[${audioPlan.label}]` : mastering ? '[aout]' : '[ab]',
    ...overlayEncodeArgs(input, encoder ?? null),
    '-fps_mode',
    input.fpsMode,
    ...overlayColorArgs(input),
    ...audioArgs,
    '-movflags',
    '+faststart',
    input.outputPath
  )
  return args
}

/** 多输入直接管道合成：N 路媒体 + stdin 帧流（image2pipe/rawvideo）。 */
export function buildOverlayMp4MultiInputDirectPipe(
  input: Omit<MediaBasisOverlayInput, 'overlayPath'> & { frameFormat: 'raw' | 'png' },
  encoder?: string | null
): string[] {
  const audioArgs = overlayAudioArgs(input.audioMode, input.mastering, input.audioBitrateKbps)
  const frameInput =
    input.frameFormat === 'raw'
      ? rawPipeInputArgs(input.fps, input.frameSize.width, input.frameSize.height)
      : pipeInputArgs(input.fps)
  const transitionPlans = input.segments.some((seg) => seg.transitionIn !== undefined)
    ? transitionSegmentPlansByTrack({
        segments: input.segments,
        fps: input.fps,
        spanStartSec: input.spanStartSec,
        spanEndSec: input.spanEndSec
      })
    : null
  const args: string[] = [...common({})]
  input.segments.forEach((seg, index) => {
    if (seg.isImage) {
      const ext = transitionPlans?.get(index)
      const extended = ext && (ext.headHandleSec > 0 || ext.tailHandleSec > 0)
      const length = extended
        ? Math.max(0.01, ext.sourceOutExtSec)
        : Math.max(0.01, seg.sourceOutSec - seg.sourceInSec)
      args.push('-loop', '1', '-t', formatSec(length))
    }
    args.push('-i', seg.refVideoPath)
  })
  // M8：遮罩 PNG 紧跟在各段媒体输入之后、stdin 帧流之前
  pushMaskInputs(args, input.segments, input.fps)
  args.push(...frameInput)
  if (input.watermark) args.push(...buildWatermarkInputArgs(input.watermark, input.fps))
  const audioPlan = buildAudioMixPlan({
    clips: input.audioClips ?? [],
    baseIndex: Number(input.overlayLabel) + 1 + (input.watermark ? 1 : 0),
    spanStartSec: input.spanStartSec,
    spanEndSec: input.spanEndSec,
    baseLabel: '[ab]',
    mastering: input.mastering,
    ...(input.arnndnModelPath ? { arnndnModelPath: input.arnndnModelPath } : {})
  })
  if (audioPlan) args.push(...audioPlan.inputArgs)
  const basisFilter = buildMediaBasisFilterComplex(input)
  const mastering = audioPlan ? null : loudnormFilter(input.mastering)
  args.push(
    '-filter_complex',
    audioPlan
      ? `${basisFilter};${audioPlan.filter}`
      : mastering
        ? `${basisFilter};[ab]${mastering}[aout]`
        : basisFilter,
    '-map',
    '[v]',
    '-map',
    audioPlan ? `[${audioPlan.label}]` : mastering ? '[aout]' : '[ab]',
    ...overlayEncodeArgs(input, encoder ?? null),
    '-fps_mode',
    input.fpsMode,
    ...overlayColorArgs(input),
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
  size?: { width: number; height: number },
  audio?: TransparentAudioOptions
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
    ...(buildTransparentAudioArgs(audio) ?? ['-an']),
    '-f',
    'mov',
    outputPath
  ]
}

export interface OverlayInput {
  refVideoPath: string
  /** 透明 MOV 路径（仅两阶段合成 builder 使用） */
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
  /** M7-E：图形层 z 档；缺省 aboveMedia（旧 argv 逐字节不变） */
  graphicsZ?: GraphicsZ
  /** 水印（可选）：固定在输入序号 2（参考视频 0 / 透明层或管道 1 之后） */
  watermark?: WatermarkInput
  /** v10：画质档；缺省 = high（CRF 18，与现有默认一致） */
  quality?: ExportQuality
  /** 视频编码格式；缺省 = AVC/H.264；M9 增加 AV1 */
  videoCodec?: VideoCodec
  /** 视频码率（kbps）；有值时走码率模式 */
  videoBitrateKbps?: number
  /** 音频码率（kbps）；有值时 AAC 分支使用该码率 */
  audioBitrateKbps?: number
  /** M9：CRF 直给（0–51）；缺省按画质档 */
  crf?: number
  /** M9：软件编码 preset（x264/x265 名称；AV1 映射到 SVT-AV1 档位） */
  encoderPreset?: string
  /** M9：输出位深（10 走 yuv420p10le） */
  bitDepth?: 8 | 10
  /** M9：色彩范围标签（full → -color_range pc） */
  colorRange?: 'limited' | 'full'
  /** v10：成片响度标准化（off/缺省 = 不注入 loudnorm，argv 与旧版一致） */
  mastering?: AudioMastering
}

/** 无 frameSize 时的回退输出尺寸（与旧单输入路径的默认值一致）。 */
const FALLBACK_OUTPUT: Resolution = { width: 1920, height: 1080 }

/** overlay 滤镜链尾必须落到 8-bit 4:2:0（计划 C3：format=auto 会给出 10-bit 4:4:4）。 */
/**
 * M7-E：透明帧层（字幕条 + 文本元素）与媒体基座的合成顺序。
 *
 * - `aboveMedia`（缺省）：媒体基座在下、透明帧按时间窗叠在上 —— 与旧 argv 逐字节一致；
 * - `belowMedia`：透明帧作为基座，媒体基座整体叠在它上面（媒体不透明处会盖住字幕/文本，
 *   形成"图形层垫底"的层级），媒体结束处由 `eof_action=pass` 露出字幕层。
 */
function subtitleOverlayChains(
  input: {
    overlayLabel?: string
    spanStartSec: number
    spanEndSec: number
    fps: Fps
    watermark?: WatermarkInput
    graphicsZ?: GraphicsZ
    /** M9-B：链尾目标像素格式/范围（缺省 = 旧版 yuv420p，逐字节一致） */
    bitDepth?: 8 | 10
    colorRange?: 'limited' | 'full'
  },
  baseLabel: string
): string[] {
  const rate = fpsToArg(input.fps)
  const start = formatSec(input.spanStartSec)
  const end = formatSec(input.spanEndSec)
  const overlayLabel = input.overlayLabel ?? '1'
  const subtitleOut = input.watermark ? 'vsub' : 'v'
  const tail = outputTailFilters(input)
  if (input.graphicsZ === 'belowMedia') {
    return [
      `[${overlayLabel}:v]fps=${rate},setsar=1[obase]`,
      `[obase][${baseLabel}]overlay=0:0:alpha=straight:format=auto:eof_action=pass,${tail}[${subtitleOut}]`
    ]
  }
  return [
    `[${overlayLabel}:v]setpts=PTS+${start}/TB[ov]`,
    `[${baseLabel}][ov]overlay=0:0:alpha=straight:format=auto:eof_action=pass:enable='between(t,${start},${end})',${tail}[${subtitleOut}]`
  ]
}
export function buildFilterComplex(
  spanStartSec: number,
  spanEndSec: number,
  fps: Fps,
  watermark?: WatermarkInput,
  output: Resolution = FALLBACK_OUTPUT,
  graphicsZ?: GraphicsZ,
  /** M9-B：链尾目标像素格式/范围（缺省 = 旧版 yuv420p，逐字节一致） */
  color?: { bitDepth?: 8 | 10; colorRange?: 'limited' | 'full' }
): string {
  const rate = fpsToArg(fps)
  const subtitleOut = watermark ? 'vsub' : 'v'
  return [
    `[0:v]fps=${rate},setsar=1[v0]`,
    // M7-E：图形层 z 档（缺省 aboveMedia = 与旧版逐字节一致）
    ...subtitleOverlayChains(
      {
        spanStartSec,
        spanEndSec,
        fps,
        ...(watermark ? { watermark } : {}),
        ...(graphicsZ ? { graphicsZ } : {}),
        ...(color ?? {})
      },
      'v0'
    ),
    ...(watermark
      ? buildWatermarkFilterChain({
          label: 2,
          prevLabel: subtitleOut,
          watermark,
          output,
          ...(color ?? {})
        })
      : [])
  ].join(';')
}

/** 单输入叠加出口的响度参数：`-af` 直接作用在 `-map 0:a?` 选出的音轨。 */
function audioMasteringArgs(mastering: AudioMastering | undefined): string[] {
  const filter = loudnormFilter(mastering)
  return filter ? ['-af', filter] : []
}

/** 输出音频编码参数：开启 loudnorm 时不能 `-c:a copy`（滤镜作用不到复制流）。 */
function overlayAudioArgs(
  mode: 'copy' | 'aac',
  mastering: AudioMastering | undefined,
  audioBitrateKbps?: number
): string[] {
  const bitrate = `${audioBitrateKbps ?? 192}k`
  const filter = loudnormFilter(mastering)
  if (filter) return ['-c:a', 'aac', '-b:a', bitrate]
  return mode === 'copy' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', bitrate]
}

/** 叠加合成（两阶段：参考视频 + 临时透明 MOV）。 */
export function buildOverlayMp4(input: OverlayInput, encoder?: string | null): string[] {
  const audioArgs = overlayAudioArgs(input.audioMode, input.mastering, input.audioBitrateKbps)
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
      input.frameSize ?? FALLBACK_OUTPUT,
      input.graphicsZ,
      { bitDepth: input.bitDepth, colorRange: input.colorRange }
    ),
    '-map',
    '[v]',
    '-map',
    '0:a?',
    ...audioMasteringArgs(input.mastering),
    ...overlayEncodeArgs(input, encoder ?? null),
    '-fps_mode',
    input.fpsMode,
    ...overlayColorArgs(input),
    ...audioArgs,
    '-movflags',
    '+faststart',
    input.outputPath
  ]
}

/** 直接管道合成：stdin 帧流作为 overlay 输入（长素材 / 磁盘不足时启用）。 */
export function buildOverlayMp4DirectPipe(
  input: Omit<OverlayInput, 'overlayPath'>,
  encoder?: string | null
): string[] {
  const audioArgs = overlayAudioArgs(input.audioMode, input.mastering, input.audioBitrateKbps)
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
      input.frameSize ?? FALLBACK_OUTPUT,
      input.graphicsZ,
      { bitDepth: input.bitDepth, colorRange: input.colorRange }
    ),
    '-map',
    '[v]',
    '-map',
    '0:a?',
    ...audioMasteringArgs(input.mastering),
    ...overlayEncodeArgs(input, encoder ?? null),
    '-fps_mode',
    input.fpsMode,
    ...overlayColorArgs(input),
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
  return raw.length > 0 ? raw : 'socut'
}
