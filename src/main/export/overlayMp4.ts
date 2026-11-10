import fs from 'node:fs/promises'
import path from 'node:path'
import {
  buildOverlayMp4DirectPipe,
  buildOverlayMp4MultiInputDirectPipe,
  buildStabDetectArgs,
  matteInputCount,
  resolveMatteKind,
  segmentWantsMask,
  segmentWantsMatte,
  segmentsNeedMultiInput,
  stabSegmentKey,
  transitionSegmentPlansByTrack
} from '../../shared/ffmpegArgs'
import { speedValueOf } from '../../shared/mediaClipAudio'
import type { ConcatSegment, AudioMixClip, WatermarkInput } from '../../shared/ffmpegArgs'
import type { TransitionExportSegmentPlan } from '../../shared/transitions'
import { TEXT } from '../../shared/i18n'
import type {
  AudioMastering,
  ExportFit,
  ExportQuality,
  MediaClipStab,
  OverlaySegment,
  VideoCodec,
  VideoMeta
} from '../../shared/types'
import { spawnJob, terminateJob } from '../procRegistry'
import type { FfmpegBinaries } from '../paths'
import { assertAiDenoiseModel } from '../rnnoise'
import { softwareEncoderName } from '../../shared/gpu'
import { ProgressParser } from '../progressParser'
import type { FrameChannelHandle } from './frameChannel'
import type { JobState } from './jobs'
import { pumpFrames, writeWithBackpressure } from './framePump'
import { awaitChildExit, FFmpegExitError, waitForClose } from './transparentMov'
import type { TransparentRunCtx } from './transparentMov'

/**
 * 导出 B：MP4 叠加压制（规格 §5.2）。
 * 关键纪律：字幕条按参考视频参数重新渲染，绝不复用透明 MOV 做缩放叠加。
 * 计划 C7：渲染区间限定为片段 span，合成时用 setpts 平移 + enable 时间窗。
 *
 * v11（流式导出）：叠加出口只有一条路径——渲染完成的帧经内存直接写入
 * FFmpeg 的 stdin 实时编码，不再先落一份中间透明 MOV 再二次解码。
 * 两阶段法在 1080p 下产出的中间 ProRes 4444 约 190MB/s，是这个流程里最大的磁盘开销；
 * 去掉它以后临时目录只留防抖 `.trf`，磁盘占用与最终产物同量级甚至更低。
 */

export interface OverlayRunCtx {
  state: JobState
  binaries: FfmpegBinaries
  transparentCtx: TransparentRunCtx
  channel: FrameChannelHandle
  refVideoPath: string
  /** v2：媒体时间轴（按 timelineStartSec 升序）；多段/有空隙/非零入点时走 trim+concat 基座 */
  segments?: OverlaySegment[]
  /** 目标分辨率（多输入路径的空隙补黑尺寸） */
  frameSize: { width: number; height: number }
  refMeta: VideoMeta
  audioMode: 'copy' | 'aac'
  fpsMode: 'cfr' | 'vfr'
  spanStartSec: number
  spanEndSec: number
  outputPath: string
  /** 管道内帧形式（默认 raw）与尺寸 */
  frameFormat: 'raw' | 'png'
  /** 导出编码器：硬件编码器名；null/缺省 = libx264（失败自动回退软件编码） */
  videoEncoder?: string | null
  /** M7-E：图形层 z 档（belowMedia = 字幕/文本垫在媒体层下）；缺省 aboveMedia */
  graphicsZ?: 'aboveMedia' | 'belowMedia'
  /** 水印（可选）：同一张图作为最后一层 overlay，两条合成路径共用 */
  watermark?: WatermarkInput
  /** v7：音频轨；非空时即使单段也走多输入路径（单输入 builder 没有混音入口） */
  audioClips?: AudioMixClip[]
  /**
   * v10：显式目标画布；有值时强制走多输入路径（单输入 builder 没有画布归一入口），
   * 逐段按 fit 归一。缺省 = 旧行为，argv 逐字节不变。
   */
  canvas?: { width: number; height: number; fit?: ExportFit }
  /** v10：画布适配方式（canvas.fit 缺省时的回退） */
  fit?: ExportFit
  /** M9：CRF 直给 / 软件 preset / 位深 / 色彩范围（缺省 = 旧行为） */
  crf?: number
  encoderPreset?: string
  bitDepth?: 8 | 10
  colorRange?: 'limited' | 'full'
  /** v10：画质档；缺省 = high（CRF 18，与现有默认一致） */
  quality?: ExportQuality
  /** 视频编码格式；缺省 = AVC/H.264 */
  videoCodec?: VideoCodec
  /** 视频码率（kbps）；有值时走码率模式 */
  videoBitrateKbps?: number
  /** 音频码率（kbps）；有值时 AAC 分支使用该码率 */
  audioBitrateKbps?: number
  /** v10：成片响度标准化（off/缺省 = 不注入 loudnorm） */
  audioMastering?: AudioMastering
  /** v8：任务临时目录；防抖段的 .trf 落在这里，detect 与合成 ffmpeg 进程以它为 cwd */
  workspaceDir: string
  /**
   * M8：RNNoise 模型路径（`denoise = 'ai'` 用）。渲染侧只提交「要 AI 降噪」这个意图，
   * 绝对路径由主进程解析（`resolveRnnoiseModel`）；缺失时合成前直接报错，不静默降级。
   */
  arnndnModelPath?: string
  /**
   * M8：渲染侧光栅化的遮罩 PNG（`{ clipId, png }`）。主进程写进任务工作目录后，
   * 按「带 mask 的段在 segments 里的出现顺序」逐份接到 `maskPath` 上
   * （OverlaySegment 没有 clipId，clipId 只用于文件名与错误信息；数量不匹配直接报错，
   * 绝不把遮罩错配到别的段上）。
   */
  mediaMasks?: Array<{ clipId: string; png: Uint8Array }>
  isCancelled: () => boolean
  onTick: () => void
}

interface CompositeRun {
  code: number | null
  stderrTail: string
  argv: string[]
}

/** 拼接路径的音频一律重编码（concat 后不能 -c:a copy）；只有旧单输入保持 copy 语义。
 *  v10：开启响度标准化时也必须重编码（loudnorm 不能作用在复制流上）。 */
function effectiveAudioMode(
  requested: 'copy' | 'aac',
  multi: boolean,
  mastering: AudioMastering | undefined
): 'copy' | 'aac' {
  if (mastering === 'social' || mastering === 'broadcast') return 'aac'
  return multi ? 'aac' : requested
}

// ---------------------------------------------------------------------------
// M8：手绘遮罩 PNG 落盘 + 接到媒体段（maskPath）
// ---------------------------------------------------------------------------

/** clipId 文件名白名单：只保留字母/数字/下划线/短横线（防目录穿越），其余字符替换成 `_`。 */
const MASK_CLIP_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
/** PNG 文件签名：渲染侧 `convertToBlob` 的产物必须是真 PNG。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** clipId → 安全文件名主体：白名单外字符一律替换，最长 80 字符，空 id 用 clip 兜底。 */
export function sanitizeMaskClipId(clipId: string): string {
  const safe = clipId.replace(/[^\w-]/g, '_').slice(0, 80)
  return MASK_CLIP_ID_PATTERN.test(safe) ? safe : 'clip'
}

export interface MediaMaskFile {
  clipId: string
  /** 任务工作目录内的绝对路径（直接进 `-loop 1 ... -i`） */
  path: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * M8：把渲染侧传来的遮罩 PNG 写进本次任务的工作目录。
 *
 * 文件名固定 `mask-<clipId>.png`（clipId 先白名单过滤）。任何一步失败都抛出**可读**错误，
 * 让导出以「遮罩写入失败」收尾——绝不能因为写盘失败就悄悄导出一份没遮罩的成片。
 */
export async function writeMediaMaskFiles(
  masks: Array<{ clipId: string; png: Uint8Array }> | undefined,
  dir: string
): Promise<MediaMaskFile[]> {
  if (!masks || masks.length === 0) return []
  const files: MediaMaskFile[] = []
  for (const mask of masks) {
    const clipId = typeof mask.clipId === 'string' ? mask.clipId : ''
    const safeId = sanitizeMaskClipId(clipId)
    const bytes = Buffer.from(mask.png)
    if (bytes.length === 0) {
      throw new Error(`遮罩写入失败：片段 ${clipId || '(空 id)'} 的遮罩 PNG 为空`)
    }
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error(
        `遮罩写入失败：片段 ${clipId || '(空 id)'} 的遮罩不是 PNG（头部 0x${bytes.subarray(0, 4).toString('hex')}）`
      )
    }
    const file = path.join(dir, `mask-${safeId}.png`)
    try {
      await fs.writeFile(file, bytes)
    } catch (error) {
      throw new Error(`遮罩写入失败（片段 ${clipId || '(空 id)'}，目录 ${dir}）：${errorText(error)}`)
    }
    files.push({ clipId, path: file })
  }
  return files
}

/**
 * M8：把写好的遮罩文件按「带 mask 的段」出现顺序接到 `maskPath` 上。
 *
 * 无遮罩时原样返回同一个引用（不产生任何 argv/行为差异）。
 * 数量对不上就报错：这说明渲染侧请求与本进程解析的段列表不是同一份，
 * 按序号硬接会把 A 段的遮罩贴到 B 段上（比多一条错误信息糟糕得多）。
 */
export function attachMaskPaths(
  segments: OverlaySegment[] | undefined,
  files: readonly MediaMaskFile[]
): OverlaySegment[] | undefined {
  if (files.length === 0) return segments
  const list = segments ?? []
  const maskedIndexes = list.map((seg, index) => (seg.mask ? index : -1)).filter((index) => index >= 0)
  if (maskedIndexes.length !== files.length) {
    throw new Error(
      `遮罩数量与媒体段不匹配：收到 ${files.length} 份遮罩，但本次导出只有 ${maskedIndexes.length} 个带遮罩的段。` +
        '请在预览里重新确认遮罩后重试。'
    )
  }
  const next = [...list]
  maskedIndexes.forEach((segmentIndex, ordinal) => {
    const file = files[ordinal]!
    next[segmentIndex] = { ...next[segmentIndex]!, maskPath: file.path }
  })
  return next
}

/** v8：去重后的一道防抖分析工作项（同源 + 同帧序列 + 同档位只跑一次 pass 1）。 */
interface StabWorkItem {
  key: string
  /** 相对任务工作目录的 .trf 文件名 */
  file: string
  inputPath: string
  sourceInSec: number
  sourceOutSec: number
  stab: MediaClipStab
}

/**
 * v10：转场导出计划（主进程 stab 检测与合成共用同一份扩展手柄区间）。
 * 无任何 `transitionIn` 时返回 null，不改变旧行为。
 */
function transitionPlansOf(ctx: OverlayRunCtx): Map<number, TransitionExportSegmentPlan> | null {
  const segments = ctx.segments ?? []
  if (!segments.some((seg) => seg.transitionIn !== undefined)) return null
  return transitionSegmentPlansByTrack({
    segments,
    fps: ctx.transparentCtx.fps,
    spanStartSec: ctx.spanStartSec,
    spanEndSec: ctx.spanEndSec
  })
}

/**
 * M8-P0：外部 matte 的导出前预检（全部在起 FFmpeg 之前，失败给可读错误）。
 *
 * 口径：
 * - 路径必须是**绝对路径**（工程 JSON 与素材同一惯例），文件存在且非空；
 * - 类型：显式 `matteKind` 优先，缺省按扩展名推断，都判断不出 → 报错要求重新导入；
 * - 视频 matte 暂不支持：变速段（时间轴与 matte 帧序会错位）、静帧片段（没有源帧序）、
 *   转场切点（画面会取扩展手柄区间，matte 对齐规则未验证）。宁可显式拒绝，也不静默错位。
 */
export async function assertMatteInputs(segments: OverlaySegment[] | undefined): Promise<void> {
  const list = segments ?? []
  for (const [index, seg] of list.entries()) {
    if (!segmentWantsMatte(seg)) continue
    const target = seg.mattePath as string
    const label = `第 ${index + 1} 段（${path.basename(target)}）`
    if (!path.isAbsolute(target)) {
      throw new Error(`外部 matte 必须是绝对路径：${target}`)
    }
    const kind = resolveMatteKind(seg)
    if (!kind) {
      throw new Error(
        `无法判断外部 matte 的类型：${path.basename(target)}（扩展名不认识，请重新导入或显式指定 matteKind）`
      )
    }
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error(`外部 matte 文件不可用：${target}（文件不存在、不是文件或为空）`)
    }
    if (kind !== 'video') continue
    // ---- 以下只针对视频 matte（时间对齐限制）----
    if (seg.isImage) {
      throw new Error(`视频 matte 不能用于图像片段：${label}`)
    }
    const speed = speedValueOf(seg.speed)
    if (Math.abs(speed - 1) > 1e-9) {
      throw new Error(`视频 matte 暂不支持变速片段：${label}（speed=${speed}x）`)
    }
    const next = list[index + 1]
    const adjacentTransition =
      next !== undefined &&
      next.transitionIn !== undefined &&
      Math.abs(next.timelineStartSec - seg.timelineEndSec) < 1e-6 &&
      (next.trackIndex ?? 0) === (seg.trackIndex ?? 0)
    if (seg.transitionIn !== undefined || adjacentTransition) {
      throw new Error(
        `视频 matte 暂不支持转场片段：${label}（转场会用扩展手柄区间取帧，matte 对齐规则尚未支持）`
      )
    }
  }
}

/** v8：从本次导出的段列表里收集需分析的防抖工作项（无防抖段返回空数组，不改变任何行为）。 */
function planStabWork(ctx: OverlayRunCtx): StabWorkItem[] {
  const items: StabWorkItem[] = []
  const seen = new Set<string>()
  const transitionPlans = transitionPlansOf(ctx)
  for (const [index, seg] of (ctx.segments ?? []).entries()) {
    if (seg.stab?.enabled !== true) continue
    // v10：合成链的视频 trim 使用扩展手柄区间；detect 必须分析**同一段**源，
    // 否则 .trf 的帧序号与 transform 输入的帧序列错位。
    const ext = transitionPlans?.get(index)
    const sourceInSec = ext ? ext.sourceInExtSec : seg.sourceInSec
    const sourceOutSec = ext ? ext.sourceOutExtSec : seg.sourceOutSec
    const key = stabSegmentKey({ ...seg, sourceInSec, sourceOutSec }, ctx.transparentCtx.fps)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({
      key,
      file: `stab_${items.length}.trf`,
      inputPath: seg.refVideoPath,
      sourceInSec,
      sourceOutSec,
      stab: seg.stab
    })
  }
  return items
}

/**
 * v8：防抖 pass 1（运动检测）：逐工作项顺序起 ffmpeg（只解码不编码，`-f null`）。
 * 子进程用 `${jobId}-stabN` 子 id 注册：engine.cancel 只杀主 id，
 * 这里必须靠 cancel-watch 兑住子进程，防止取消后检测进程泄漏。
 */
async function runStabDetects(ctx: OverlayRunCtx, items: StabWorkItem[]): Promise<'done' | 'cancelled'> {
  for (const [index, item] of items.entries()) {
    if (ctx.isCancelled()) return 'cancelled'
    const jobId = `${ctx.state.id}-stab${index}`
    const parser = new ProgressParser()
    const job = spawnJob({
      jobId,
      label: `防抖预分析 ${index + 1}/${items.length}`,
      binary: ctx.binaries.ffmpeg,
      args: buildStabDetectArgs({
        inputPath: item.inputPath,
        sourceInSec: item.sourceInSec,
        sourceOutSec: item.sourceOutSec,
        fps: ctx.transparentCtx.fps,
        stab: item.stab,
        resultFile: item.file
      }),
      // .trf 用相对文件名：避开滤镜串里盘符冒号的转义陷阱
      cwd: ctx.workspaceDir,
      onStdoutChunk: (chunk) => {
        const snapshot = parser.feed(chunk)
        if (snapshot) {
          ctx.state.outTimeUs = snapshot.outTimeUs
          ctx.onTick()
        }
      }
    })
    const watch = setInterval(() => {
      if (ctx.isCancelled()) void terminateJob(jobId)
    }, 200)
    try {
      const code = await waitForClose(job)
      if (ctx.isCancelled()) {
        await terminateJob(jobId)
        return 'cancelled'
      }
      if (code !== 0) {
        throw new FFmpegExitError(code, job.stderr.tail(4096), job.argv)
      }
    } finally {
      clearInterval(watch)
    }
    ctx.state.notices.push(TEXT.stab.analyzeNotice(index + 1, items.length))
    ctx.onTick()
  }
  return 'done'
}

/** 本次 composite 用的参数组（单/多输入，两条都走 stdin 帧流）。 */
function buildCompositeArgs(
  ctx: OverlayRunCtx,
  audioMode: 'copy' | 'aac',
  stabFiles: Map<string, string>,
  encoder: string | null
): string[] {
  // M8：AI 降噪必须有 RNNoise 模型；宁可导出前失败，也不要让用户以为听到了 AI 降噪
  assertAiDenoiseModel(ctx, ctx.arnndnModelPath)
  // 有音频段就必须走多输入（单输入 builder 不带混音链），基线段仍按同一套 trim+concat；
  // 多轨工程即使没有音频段也要走多输入（旧单输入 builder 没有分层入口）；
  // v10：显式画布同样必须走多输入（单输入 builder 没有逐段归一入口）。
  const multi =
    (ctx.canvas !== undefined && (ctx.segments?.length ?? 0) > 0) ||
    segmentsNeedMultiInput(ctx.segments) ||
    ((ctx.audioClips?.length ?? 0) > 0 && (ctx.segments?.length ?? 0) > 0)
  const canvas = ctx.canvas
    ? { width: ctx.canvas.width, height: ctx.canvas.height, fit: ctx.canvas.fit ?? ctx.fit ?? 'contain' }
    : undefined
  if (!multi) {
    return buildOverlayMp4DirectPipe({
      refVideoPath: ctx.refVideoPath,
      outputPath: ctx.outputPath,
      fps: ctx.transparentCtx.fps,
      frameFormat: ctx.frameFormat,
      frameSize: ctx.frameSize,
      spanStartSec: ctx.spanStartSec,
      spanEndSec: ctx.spanEndSec,
      audioMode,
      fpsMode: ctx.fpsMode,
      ...(ctx.graphicsZ ? { graphicsZ: ctx.graphicsZ } : {}),
      watermark: ctx.watermark,
      quality: ctx.quality,
      videoCodec: ctx.videoCodec,
      videoBitrateKbps: ctx.videoBitrateKbps,
      audioBitrateKbps: ctx.audioBitrateKbps,
      ...(ctx.crf !== undefined ? { crf: ctx.crf } : {}),
      ...(ctx.encoderPreset ? { encoderPreset: ctx.encoderPreset } : {}),
      ...(ctx.bitDepth === 10 ? { bitDepth: 10 as const } : {}),
      ...(ctx.colorRange ? { colorRange: ctx.colorRange } : {}),
      mastering: ctx.audioMastering
    }, encoder)
  }
  const transitionPlans = transitionPlansOf(ctx)
  const segments: ConcatSegment[] = (ctx.segments ?? []).map((seg, index) => {
    const base = {
      ...seg,
      // 拼接路径里逐段音频是否存在的判定在渲染侧已完成（无音轨段不能进 copy）；
      // 这里按元数据保守假设全部有音轨：trim 后重编码，无音轨的素材由渲染侧避开 copy 分支。
      // v7：图像段必然没有音轨，必须补静音（否则 `[i:a]` 不存在会直接报错）。
      // v3：渲染侧已按轨道静音状态给出 hasAudio（缺省才回退到旧的「非图像即有音轨」）。
      hasAudio: seg.hasAudio ?? !seg.isImage
    }
    // v8：启用的段按去重键拿到已分析的 .trf（同一键共享同一份）；未分配则不写 stabFile，段链退回不防抖
    if (seg.stab?.enabled !== true) return base
    // v10：转场段的合成链用扩展手柄，.trf 键必须与 planStabWork 的 detect 区间一致
    const ext = transitionPlans?.get(index)
    const keySeg = ext
      ? { ...seg, sourceInSec: ext.sourceInExtSec, sourceOutSec: ext.sourceOutExtSec }
      : seg
    const stabFile = stabFiles.get(stabSegmentKey(keySeg, ctx.transparentCtx.fps))
    return stabFile ? { ...base, stabFile } : base
  })
  /**
   * M8/M8-P0：透明层/帧流的路序号 = 段数 + mask 输入数 + matte 输入数。
   * 输入顺序是「各段媒体 → 各段 mask → 各段 matte → stdin 帧流 → 水印 → 音频」，
   * 无遮罩/matte 时计数为 0，overlayLabel 与旧版完全一致（argv 逐字节不变）。
   */
  const maskCount = segments.filter((seg) => segmentWantsMask(seg)).length
  const matteCount = matteInputCount(segments)
  const basis = {
    segments,
    spanStartSec: ctx.spanStartSec,
    spanEndSec: ctx.spanEndSec,
    overlayLabel: String(segments.length + maskCount + matteCount),
    outputPath: ctx.outputPath,
    fps: ctx.transparentCtx.fps,
    frameSize: ctx.frameSize,
    audioMode,
    fpsMode: ctx.fpsMode,
    ...(ctx.graphicsZ ? { graphicsZ: ctx.graphicsZ } : {}),
    watermark: ctx.watermark,
    audioClips: ctx.audioClips,
    // v10：显式画布与画质档原样下传（缺省时不产生任何 argv 差异）
    canvas,
    quality: ctx.quality,
    videoCodec: ctx.videoCodec,
    videoBitrateKbps: ctx.videoBitrateKbps,
    audioBitrateKbps: ctx.audioBitrateKbps,
    ...(ctx.crf !== undefined ? { crf: ctx.crf } : {}),
    ...(ctx.encoderPreset ? { encoderPreset: ctx.encoderPreset } : {}),
    ...(ctx.bitDepth === 10 ? { bitDepth: 10 as const } : {}),
    ...(ctx.colorRange ? { colorRange: ctx.colorRange } : {}),
    mastering: ctx.audioMastering,
    ...(ctx.arnndnModelPath ? { arnndnModelPath: ctx.arnndnModelPath } : {})
  }
  return buildOverlayMp4MultiInputDirectPipe({ ...basis, frameFormat: ctx.frameFormat }, encoder)
}

/** 合成：帧流实时送入编码器 stdin。返回退出码与 stderr 尾部，由上层决定音频回退重试。 */
async function composite(
  ctx: OverlayRunCtx,
  audioMode: 'copy' | 'aac',
  stabFiles: Map<string, string>,
  encoder: string | null
): Promise<CompositeRun> {
  const parser = new ProgressParser()
  const args = buildCompositeArgs(ctx, audioMode, stabFiles, encoder)

  const job = spawnJob({
    jobId: ctx.state.id,
    label: `叠加合成 ${ctx.refMeta.width}x${ctx.refMeta.height} ${audioMode === 'copy' ? 'copy' : 'aac'}`,
    binary: ctx.binaries.ffmpeg,
    args,
    stdin: true,
    // v8：有防抖段时以任务工作目录为 cwd，滤镜里的相对 .trf 才能被解析；
    // 无防抖任务不传 cwd，命令行为与现状逐字节一致
    cwd: stabFiles.size > 0 ? ctx.workspaceDir : undefined,
    onStdoutChunk: (chunk) => {
      const snapshot = parser.feed(chunk)
      if (snapshot) {
        ctx.state.outTimeUs = snapshot.outTimeUs
        ctx.onTick()
      }
    }
  })

  const cancelWatch = setInterval(() => {
    if (ctx.isCancelled()) void terminateJob(ctx.state.id)
  }, 200)

  try {
    const stdin = job.child.stdin
    if (!stdin) throw new Error('FFmpeg stdin 不可用')
    try {
      const result = await pumpFrames({
        channel: ctx.channel,
        startFrame: ctx.transparentCtx.startFrame,
        framesTotal: ctx.transparentCtx.framesTotal,
        frameBytes: ctx.frameFormat === 'raw' ? ctx.frameSize.width * ctx.frameSize.height * 4 : undefined,
        isCancelled: ctx.isCancelled,
        onFrame: async (_absolute, buffer) => {
          await writeWithBackpressure(stdin, buffer)
          ctx.state.bytesWritten += buffer.length
        },
        onProgress: (framesDone) => {
          ctx.state.framesDone = framesDone
          ctx.onTick()
        }
      })
      if (result === 'cancelled') {
        ctx.channel.cancel('cancelled')
        ctx.channel.close()
        await terminateJob(ctx.state.id)
        return { code: null, stderrTail: 'cancelled', argv: job.argv }
      }
    } catch (error) {
      // 与透明出口同理：先报错的是本地 stdin 写入，真正原因在 FFmpeg 的 stderr 里。
      // 把它归一成 {code, stderrTail, argv}，上层才能给出可复现的错误。
      if (ctx.isCancelled()) {
        ctx.channel.cancel('cancelled')
        ctx.channel.close()
        await terminateJob(ctx.state.id)
        return { code: null, stderrTail: 'cancelled', argv: job.argv }
      }
      const code = await awaitChildExit(job, 5000)
      const tail = job.stderr.tail(4096)
      const original = error instanceof Error ? error.message : String(error)
      throw new FFmpegExitError(code, tail.length > 0 ? tail : original, job.argv, `${original}（FFmpeg 退出码 ${code ?? '未知'}）`)
    }
    stdin.end()
    ctx.channel.close()
    const code = await waitForClose(job)
    return { code, stderrTail: job.stderr.tail(4096), argv: job.argv }
  } finally {
    clearInterval(cancelWatch)
  }
}

export async function runOverlayMp4(ctx: OverlayRunCtx): Promise<'done' | 'cancelled'> {
  /**
   * M8：遮罩 PNG 先落盘、再接 maskPath。
   * 写盘失败或「遮罩份数 ≠ 带 mask 的段数」都在渲染开始前以可读错误失败，
   * 绝不带着缺失/错位的遮罩去跑合成（那会静默产出错误成片）。
   */
  const maskFiles = await writeMediaMaskFiles(ctx.mediaMasks, ctx.workspaceDir)
  for (const file of maskFiles) {
    try {
      await fs.access(file.path)
    } catch (error) {
      throw new Error(`遮罩文件不可用：${file.path}（片段 ${file.clipId}）：${errorText(error)}`)
    }
  }
  const runCtx: OverlayRunCtx =
    maskFiles.length > 0 ? { ...ctx, segments: attachMaskPaths(ctx.segments, maskFiles) } : ctx
  if (maskFiles.length > 0) {
    runCtx.state.notices.push(`手绘遮罩：${maskFiles.length} 段已启用（alpha 相乘合成）。`)
    runCtx.onTick()
  }
  // M8-P0：外部 matte 在起 FFmpeg 前预检（绝对路径/文件存在/类型可判定/时间对齐限制）
  await assertMatteInputs(runCtx.segments)
  const matteCount = matteInputCount(runCtx.segments ?? [])
  if (matteCount > 0) {
    runCtx.state.notices.push(`外部 matte：${matteCount} 段已启用（alpha 相乘合成；预览不显示 matte）。`)
    runCtx.onTick()
  }

  /**
   * v8：防抖 pass 1 先于一切渲染：无防抖段时 plan 为空，不启动任何额外进程、
   * 不改变后续任何 argv（零差异纪律）。失败直接抛出，由 engine 统一归因与清理。
   */
  const stabItems = planStabWork(runCtx)
  const stabFiles = new Map(stabItems.map((item) => [item.key, item.file]))
  if (stabItems.length > 0) {
    runCtx.state.notices.push(TEXT.stab.exportNote)
    runCtx.onTick()
    if ((await runStabDetects(runCtx, stabItems)) === 'cancelled') return 'cancelled'
  }

  /**
   * 计划 C4：预检判定不可 copy 而直接走 AAC 时，**必须告知用户**（“并在 UI 提示已转码”）。
   * 没有这条提示，用户只会发现导出音频码率变了，却不知道是自己那条音轨不被容器接受。
   * 无音轨（audioCodec === null）不算转码，不提示；v2 拼接路径重编码同理。
   */
  // v3：混音段同样要求多输入（否则会把带过滤器的音频流当 copy 直通，见 buildCompositeArgs）
  // v10：显式画布也强制多输入（与 buildCompositeArgs 同口径），音频随之重编码
  const multi =
    (runCtx.canvas !== undefined && (runCtx.segments?.length ?? 0) > 0) ||
    segmentsNeedMultiInput(runCtx.segments) ||
    ((runCtx.audioClips?.length ?? 0) > 0 && (runCtx.segments?.length ?? 0) > 0)
  const audio = effectiveAudioMode(runCtx.audioMode, multi, runCtx.audioMastering)
  const audioKbps = runCtx.audioBitrateKbps ?? 192
  if (audio !== runCtx.audioMode) {
    runCtx.state.notices.push(
      runCtx.audioMastering === 'social' || runCtx.audioMastering === 'broadcast'
        ? `响度标准化：音频转为 AAC ${audioKbps}k。`
        : `媒体轨含多段/剪裁：音频随基座一并重编码为 AAC ${audioKbps}k。`
    )
    runCtx.onTick()
  }
  if (
    audio === 'aac' &&
    runCtx.refMeta.audioCodec !== null &&
    multi === false &&
    // 响度已经单独提示过；这里只解释「原音轨本身不能 copy」
    !(runCtx.audioMastering === 'social' || runCtx.audioMastering === 'broadcast')
  ) {
    runCtx.state.notices.push(
      `音频已转码为 AAC ${audioKbps}k（原音轨 ${runCtx.refMeta.audioCodec} 不能直接复制）。`
    )
    runCtx.onTick()
  }

  runCtx.state.phase = 'muxing'
  runCtx.state.timeTotalSec = Math.max(0, runCtx.spanEndSec - runCtx.spanStartSec)
  runCtx.onTick()

  let activeEncoder: string | null = runCtx.videoEncoder ?? null
  if (activeEncoder !== null) {
    runCtx.state.notices.push(`硬件编码：${activeEncoder}（失败自动回退软件编码）。`)
    runCtx.onTick()
  }
  let run = await composite(runCtx, audio, stabFiles, activeEncoder)

  // 硬件编码器在真实素材上仍可能失败（驱动/会话/参数不支持）→ 回退**同格式**的软件编码再跑一次
  // （AV1 回退到 libaom-av1，不能悄悄降成 H.264 —— 用户选的是 AV1 交付）
  if (activeEncoder !== null && run.code !== null && run.code !== 0) {
    const fallback = softwareEncoderName(
      runCtx.videoCodec === 'av1' ? 'av1' : runCtx.videoCodec === 'hevc' ? 'hevc' : 'h264'
    )
    runCtx.state.notices.push(`硬件编码不可用，已自动回退软件编码（${fallback}）。`)
    runCtx.onTick()
    await fs.rm(runCtx.outputPath, { force: true }).catch(() => undefined)
    activeEncoder = null
    run = await composite(runCtx, audio, stabFiles, activeEncoder)
  }

  // 计划 C4：copy 运行期失败（无音轨 / 不兼容编码）→ 单次 AAC 重试
  if (audio === 'copy' && run.code !== null && run.code !== 0) {
    runCtx.state.notices.push(`音频直接复制失败，已改用 AAC ${audioKbps}k 重新合成。`)
    await fs.rm(runCtx.outputPath, { force: true }).catch(() => undefined)
    run = await composite(runCtx, 'aac', stabFiles, activeEncoder)
  }

  if (runCtx.isCancelled()) {
    await terminateJob(runCtx.state.id)
    await cleanup(runCtx)
    return 'cancelled'
  }
  if (run.code === null) {
    // 取消路径
    await cleanup(runCtx)
    return 'cancelled'
  }
  if (run.code !== 0) {
    await cleanup(runCtx)
    throw new FFmpegExitError(run.code, run.stderrTail, run.argv)
  }
  return 'done'
}

async function cleanup(ctx: OverlayRunCtx): Promise<void> {
  await fs.rm(ctx.outputPath, { force: true }).catch(() => undefined)
}
