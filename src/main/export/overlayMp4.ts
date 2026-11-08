import fs from 'node:fs/promises'
import {
  buildOverlayMp4,
  buildOverlayMp4DirectPipe,
  buildOverlayMp4MultiInput,
  buildOverlayMp4MultiInputDirectPipe,
  buildStabDetectArgs,
  segmentsNeedMultiInput,
  stabSegmentKey,
  transitionSegmentPlansByTrack
} from '../../shared/ffmpegArgs'
import type { ConcatSegment, AudioMixClip, WatermarkInput } from '../../shared/ffmpegArgs'
import type { TransitionExportSegmentPlan } from '../../shared/transitions'
import { TEXT } from '../../shared/i18n'
import type { AudioMastering, ExportFit, ExportQuality, MediaClipStab, OverlaySegment, TransparentCodec, VideoMeta } from '../../shared/types'
import { spawnJob, terminateJob } from '../procRegistry'
import type { FfmpegBinaries } from '../paths'
import { ProgressParser } from '../progressParser'
import type { FrameChannelHandle } from './frameChannel'
import type { JobState } from './jobs'
import { pumpFrames, writeWithBackpressure } from './framePump'
import { awaitChildExit, FFmpegExitError, runTransparentMov, waitForClose } from './transparentMov'
import type { TransparentRunCtx } from './transparentMov'

/**
 * 导出 B：MP4 叠加压制（规格 §5.2）。
 * 关键纪律：字幕条按参考视频参数重新渲染，绝不复用透明 MOV 做缩放叠加。
 * 计划 C7：渲染区间限定为片段 span，合成时用 setpts 平移 + enable 时间窗。
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
  /** 临时透明 MOV（两阶段法产物，任务结束即清理） */
  overlayPath: string
  codec: TransparentCodec
  /** 直接管道合成时的帧形式与尺寸 */
  frameFormat: 'raw' | 'png'
  directPipe: boolean
  /** 导出编码器：硬件编码器名；null/缺省 = libx264（失败自动回退软件编码） */
  videoEncoder?: string | null
  /** 水印（可选）：同一张图作为最后一层 overlay，四条合成路径共用 */
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
  /** v10：画质档；缺省 = high（CRF 18，与现有默认一致） */
  quality?: ExportQuality
  /** v10：成片响度标准化（off/缺省 = 不注入 loudnorm） */
  audioMastering?: AudioMastering
  /** v8：任务临时目录；防抖段的 .trf 落在这里，detect 与合成 ffmpeg 进程以它为 cwd */
  workspaceDir: string
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

/** 本次 composite 用的参数组（单/多输入 × 两阶段/直管道 共 4 条路径）。 */
function buildCompositeArgs(
  ctx: OverlayRunCtx,
  audioMode: 'copy' | 'aac',
  stabFiles: Map<string, string>,
  encoder: string | null
): string[] {
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
    return ctx.directPipe
      ? buildOverlayMp4DirectPipe({
          refVideoPath: ctx.refVideoPath,
          outputPath: ctx.outputPath,
          fps: ctx.transparentCtx.fps,
          frameFormat: ctx.frameFormat,
          frameSize: ctx.frameSize,
          spanStartSec: ctx.spanStartSec,
          spanEndSec: ctx.spanEndSec,
          audioMode,
          fpsMode: ctx.fpsMode,
          watermark: ctx.watermark,
          quality: ctx.quality,
          mastering: ctx.audioMastering
        }, encoder)
      : buildOverlayMp4({
          refVideoPath: ctx.refVideoPath,
          overlayPath: ctx.overlayPath,
          outputPath: ctx.outputPath,
          fps: ctx.transparentCtx.fps,
          // 水印几何按输出尺寸换算，永远拿 frameSize（与基座同源，不会与画面分叉）
          frameSize: ctx.frameSize,
          spanStartSec: ctx.spanStartSec,
          spanEndSec: ctx.spanEndSec,
          audioMode,
          fpsMode: ctx.fpsMode,
          watermark: ctx.watermark,
          quality: ctx.quality,
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
  const basis = {
    segments,
    spanStartSec: ctx.spanStartSec,
    spanEndSec: ctx.spanEndSec,
    overlayLabel: String(segments.length),
    outputPath: ctx.outputPath,
    fps: ctx.transparentCtx.fps,
    frameSize: ctx.frameSize,
    audioMode,
    fpsMode: ctx.fpsMode,
    watermark: ctx.watermark,
    audioClips: ctx.audioClips,
    // v10：显式画布与画质档原样下传（缺省时不产生任何 argv 差异）
    canvas,
    quality: ctx.quality,
    mastering: ctx.audioMastering
  }
  return ctx.directPipe
    ? buildOverlayMp4MultiInputDirectPipe({ ...basis, frameFormat: ctx.frameFormat }, encoder)
    : buildOverlayMp4MultiInput({ ...basis, overlayPath: ctx.overlayPath }, encoder)
}

/** 阶段二：合成。返回退出码与 stderr 尾部，由上层决定音频回退重试。 */
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
    stdin: ctx.directPipe,
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
    if (ctx.directPipe) {
      const stdin = job.child.stdin
      if (!stdin) throw new Error('FFmpeg stdin 不可用')
      try {
        const result = await pumpFrames({
          channel: ctx.channel,
          startFrame: ctx.transparentCtx.startFrame,
          framesTotal: ctx.transparentCtx.framesTotal,
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
    }
    const code = await waitForClose(job)
    return { code, stderrTail: job.stderr.tail(4096), argv: job.argv }
  } finally {
    clearInterval(cancelWatch)
  }
}

export async function runOverlayMp4(ctx: OverlayRunCtx): Promise<'done' | 'cancelled'> {
  /**
   * v8：防抖 pass 1 先于一切渲染：无防抖段时 plan 为空，不启动任何额外进程、
   * 不改变后续任何 argv（零差异纪律）。失败直接抛出，由 engine 统一归因与清理。
   */
  const stabItems = planStabWork(ctx)
  const stabFiles = new Map(stabItems.map((item) => [item.key, item.file]))
  if (stabItems.length > 0) {
    ctx.state.notices.push(TEXT.stab.exportNote)
    ctx.onTick()
    if ((await runStabDetects(ctx, stabItems)) === 'cancelled') return 'cancelled'
  }

  if (!ctx.directPipe) {
    // 阶段一：按参考视频参数重新渲染透明 MOV（规格 §11 纪律 2）
    const transparent = await runTransparentMov(ctx.transparentCtx, ctx.channel)
    if (transparent === 'cancelled') {
      await fs.rm(ctx.overlayPath, { force: true }).catch(() => undefined)
      return 'cancelled'
    }
  }

  /**
   * 计划 C4：预检判定不可 copy 而直接走 AAC 时，**必须告知用户**（“并在 UI 提示已转码”）。
   * 没有这条提示，用户只会发现导出音频码率变了，却不知道是自己那条音轨不被容器接受。
   * 无音轨（audioCodec === null）不算转码，不提示；v2 拼接路径重编码同理。
   */
  // v3：混音段同样要求多输入（否则会把带过滤器的音频流当 copy 直通，见 buildCompositeArgs）
  // v10：显式画布也强制多输入（与 buildCompositeArgs 同口径），音频随之重编码
  const multi =
    (ctx.canvas !== undefined && (ctx.segments?.length ?? 0) > 0) ||
    segmentsNeedMultiInput(ctx.segments) ||
    ((ctx.audioClips?.length ?? 0) > 0 && (ctx.segments?.length ?? 0) > 0)
  const audio = effectiveAudioMode(ctx.audioMode, multi, ctx.audioMastering)
  if (audio !== ctx.audioMode) {
    ctx.state.notices.push(
      ctx.audioMastering === 'social' || ctx.audioMastering === 'broadcast'
        ? '响度标准化：音频转为 AAC 192k。'
        : '媒体轨含多段/剪裁：音频随基座一并重编码为 AAC 192k。'
    )
    ctx.onTick()
  }
  if (
    audio === 'aac' &&
    ctx.refMeta.audioCodec !== null &&
    multi === false &&
    // 响度已经单独提示过；这里只解释「原音轨本身不能 copy」
    !(ctx.audioMastering === 'social' || ctx.audioMastering === 'broadcast')
  ) {
    ctx.state.notices.push(`音频已转码为 AAC 192k（原音轨 ${ctx.refMeta.audioCodec} 不能直接复制）。`)
    ctx.onTick()
  }

  ctx.state.phase = 'muxing'
  ctx.state.timeTotalSec = Math.max(0, ctx.spanEndSec - ctx.spanStartSec)
  ctx.onTick()

  let activeEncoder: string | null = ctx.videoEncoder ?? null
  let run = await composite(ctx, audio, stabFiles, activeEncoder)

  // 硬件编码器在真实素材上仍可能失败（驱动/会话/参数不支持）→ 回退软件编码再跑一次
  if (activeEncoder !== null && run.code !== null && run.code !== 0) {
    ctx.state.notices.push('硬件编码不可用，已自动回退软件编码（libx264）。')
    ctx.onTick()
    await fs.rm(ctx.outputPath, { force: true }).catch(() => undefined)
    activeEncoder = null
    run = await composite(ctx, audio, stabFiles, activeEncoder)
  }

  // 计划 C4：copy 运行期失败（无音轨 / 不兼容编码）→ 单次 AAC 重试
  if (audio === 'copy' && run.code !== null && run.code !== 0) {
    ctx.state.notices.push('音频直接复制失败，已改用 AAC 192k 重新合成。')
    await fs.rm(ctx.outputPath, { force: true }).catch(() => undefined)
    run = await composite(ctx, 'aac', stabFiles, activeEncoder)
  }

  if (ctx.isCancelled()) {
    await terminateJob(ctx.state.id)
    await cleanup(ctx)
    return 'cancelled'
  }
  if (run.code === null) {
    // 取消路径
    await cleanup(ctx)
    return 'cancelled'
  }
  if (run.code !== 0) {
    await cleanup(ctx)
    throw new FFmpegExitError(run.code, run.stderrTail, run.argv)
  }
  if (!ctx.directPipe) {
    await fs.rm(ctx.overlayPath, { force: true }).catch(() => undefined)
  }
  return 'done'
}

async function cleanup(ctx: OverlayRunCtx): Promise<void> {
  await fs.rm(ctx.overlayPath, { force: true }).catch(() => undefined)
  await fs.rm(ctx.outputPath, { force: true }).catch(() => undefined)
}
