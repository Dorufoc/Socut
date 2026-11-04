import { fpsToArg } from './fps'
import type { ExportTarget, Fps } from './types'

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

/** 兼容模式出口：qtrle 无损 RGBA（ProRes 在个别 DCC 出现预乘/色偏时的回退，规格 §风险表）。 */
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
}

/** overlay 滤镜链尾必须落到 8-bit 4:2:0（计划 C3：format=auto 会给出 10-bit 4:4:4）。 */
export function buildFilterComplex(spanStartSec: number, spanEndSec: number, fps: Fps): string {
  const rate = fpsToArg(fps)
  const start = formatSec(spanStartSec)
  const end = formatSec(spanEndSec)
  return [
    `[0:v]fps=${rate},setsar=1[v0]`,
    `[1:v]setpts=PTS+${start}/TB[ov]`,
    // alpha=straight（计划 C2）+ format=auto + 链尾 format=yuv420p（计划 C3）
    `[v0][ov]overlay=0:0:alpha=straight:format=auto:eof_action=pass:enable='between(t,${start},${end})',format=yuv420p[v]`
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
    '-filter_complex',
    buildFilterComplex(input.spanStartSec, input.spanEndSec, input.fps),
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
  const rate = fpsToArg(input.fps)
  const start = formatSec(input.spanStartSec)
  const end = formatSec(input.spanEndSec)
  const frameInput =
    (input.frameFormat ?? 'raw') === 'raw'
      ? rawPipeInputArgs(input.fps, input.frameSize?.width ?? 1920, input.frameSize?.height ?? 1080)
      : pipeInputArgs(input.fps)
  return [
    ...common({}),
    '-i',
    input.refVideoPath,
    ...frameInput,
    '-filter_complex',
    [
      `[0:v]fps=${rate},setsar=1[v0]`,
      // stdin 帧流自身时间基已是目标帧率，只需把 1:v 起始时间抬到 span 起点
      `[1:v]setpts=PTS+${start}/TB[ov]`,
      `[v0][ov]overlay=0:0:alpha=straight:format=auto:eof_action=pass:enable='between(t,${start},${end})',format=yuv420p[v]`
    ].join(';'),
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
