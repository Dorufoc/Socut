import { useCallback } from 'react'
import { detectCompat } from '@shared/probe'
import { resolveVisibleMediaClips } from '@shared/mediaClips'
import { mediaKindOf } from '@shared/audioClips'
import { speedValueOf } from '@shared/mediaClipAudio'
import { createId } from '@shared/projectSchema'
import { frameTimeSec, rationalToNumber } from '@shared/fps'
import { nearestFps } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { formatBytes } from '@shared/sizeEstimate'
import type {
  ExportKind,
  ExportRequest,
  FrameSpec,
  Fps,
  MediaItem,
  OverlaySegment,
  Project,
  TransparentCodec,
  VideoMeta
} from '@shared/types'
import { askHugeExport, askVfrSecondConfirm } from '../dialog/ask'
import type { DialogAnswer } from '../state/uiStore'
import { gateBlocked } from '../state/uiStore'
import { buildRenderJob } from '../render/jobBuilder'
import { frameSpecOf, registerExportJob } from '../render/frameSource'
import { useProjectStore } from '../state/projectStore'
import { useExportStore } from '../state/exportStore'
import { useUiStore } from '../state/uiStore'

/** 导出任务发起（渲染侧编排：门禁 → 规格构建 → 体积预估 → 交给主进程）。 */

export interface StartExportInput {
  kind: ExportKind
  outputDir: string
  fileName: string
  frameDelivery?: 'pipe' | 'pngSequence'
  /** 管道内帧形式：raw（默认，无 PNG 压缩开销）或 png */
  pipeTransport?: 'raw' | 'png'
  codec?: TransparentCodec
  directPipe?: boolean
}

export class GateError extends Error {}

/**
 * 门禁校验（规格 §6：未确认不得导入或导出）。
 * v2：确认位在枚级——逐枚检查素材池，任一未确认即阻断（gateBlocked 同一实现）。
 */
function assertGate(): void {
  const project = useProjectStore.getState().project
  if (project.media.length === 0 && project.refVideo) {
    // v1 兼容：冒烟取证直接写 refVideo，没有素材池时沿用旧口径
    const legacy = gateBlocked([
      {
        id: 'legacy-ref',
        path: project.refVideo.path,
        name: project.refVideo.path.split(/[\\/]/).pop() ?? project.refVideo.path,
        meta: project.refVideo.meta,
        non169Ack: project.refVideo.non169Ack,
        hdrAck: project.refVideo.hdrAck,
        vfrPolicy: project.refVideo.vfrPolicy,
        compactMode: project.refVideo.compactMode,
        thumbnailUrl: '',
        importedAt: project.refVideo.importedAt
      }
    ])
    if (legacy.blocked) throw new GateError(legacy.reason ?? '门禁未通过')
    return
  }
  const gate = gateBlocked(project.media)
  if (gate.blocked) throw new GateError(gate.reason ?? '门禁未通过')
}

/** 导出基座的媒体时间轴（v2）：mediaClips → 按时间轴升序的 trim 段列表。 */
export interface OverlayBase {
  segments: OverlaySegment[]
  /** 段数 > 1 或存在空隙/非零源入点时，主进程改走多输入 trim+concat */
  multi: boolean
  /** 首段元数据（分辨率/帧率跟随基准，规格 §2.3） */
  primaryMeta: VideoMeta
  /** 参与拼接的源里是否存在无音轨段（有则不能逐段 copy） */
  anyNoAudio: boolean
  /** 任一段的源仍是未转换 VFR */
  anyVfrRaw: boolean
  audioTranscodeNeeded: boolean
}

function buildOverlayBase(project: Project): OverlayBase | null {
  const pool = new Map<string, MediaItem>(project.media.map((item) => [item.id, item]))
  // v7 多层：先按层号把重叠段解开（上层盖下层），再交给“不重叠 + concat”的基座链
  let clips = resolveVisibleMediaClips(project.mediaClips).map((clip) => {
    const item = pool.get(clip.mediaId)
    return {
      refVideoPath: item?.path ?? '',
      timelineStartSec: clip.timelineStartSec,
      timelineEndSec: clip.timelineEndSec,
      sourceInSec: clip.sourceInSec,
      sourceOutSec: clip.sourceOutSec,
      // v8：只把「开着防抖」的段带进导出请求；缺键 = 主进程行为与现状逐字节一致
      ...(clip.stab?.enabled === true ? { stab: clip.stab } : {}),
      // v9：音量/渐变/变速同样只在「动过」时带键（全默认时 argv 与旧版逐字节一致）
      ...(clip.audio ? { audio: clip.audio } : {}),
      ...(clip.speed ? { speed: clip.speed } : {}),
      isImage: item ? mediaKindOf(item) === 'image' : false,
      meta: item?.meta ?? null,
      vfrRaw: item?.vfrPolicy === 'raw'
    }
  })
  if (project.mediaClips.length === 0 && project.media[0]) {
    // v2 过渡：有素材但尚未排轨 → 按旧习惯把第一枚素材整段作为基座
    const item = project.media[0]
    clips = [
      {
        refVideoPath: item.path,
        timelineStartSec: 0,
        timelineEndSec: item.meta.durationSec,
        sourceInSec: 0,
        sourceOutSec: item.meta.durationSec,
        isImage: mediaKindOf(item) === 'image',
        meta: item.meta,
        vfrRaw: item.vfrPolicy === 'raw'
      }
    ]
  } else if (project.mediaClips.length === 0 && project.refVideo) {
    // v1 兼容路径
    const ref = project.refVideo
    clips = [
      {
        refVideoPath: ref.path,
        timelineStartSec: 0,
        timelineEndSec: ref.meta.durationSec,
        sourceInSec: 0,
        sourceOutSec: ref.meta.durationSec,
        isImage: false,
        meta: ref.meta,
        vfrRaw: ref.vfrPolicy === 'raw'
      }
    ]
  }
  if (clips.length === 0) return null
  clips.sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const first = clips[0]
  const primaryMeta = first?.meta ?? null
  if (!primaryMeta) return null
  let cursor = first?.timelineStartSec ?? 0
  let hasGap = false
  for (const clip of clips) {
    if (clip.timelineStartSec > cursor + 1e-6) hasGap = true
    cursor = Math.max(cursor, clip.timelineEndSec)
  }
  const multi =
    clips.length > 1 ||
    hasGap ||
    (first?.sourceInSec ?? 0) > 1e-6 ||
    (first?.timelineStartSec ?? 0) > 1e-6 ||
    // 图像段要求多输入路径（单输入 builder 不支持 `-loop 1`）
    clips.some((clip) => clip.isImage)
  return {
    segments: clips.map(({ meta, vfrRaw, ...seg }) => {
      void meta
      void vfrRaw
      return seg
    }),
    multi,
    primaryMeta,
    anyNoAudio: clips.some((clip) => clip.meta?.audioCodec == null),
    anyVfrRaw: clips.some((clip) => clip.vfrRaw),
    audioTranscodeNeeded: clips.some((clip) => (clip.meta ? detectCompat(clip.meta).audioTranscodeNeeded : false))
  }
}

/** v1 兼容：旧取证脚本写的 refVideo 拉平成一枚虚拟素材，门禁口径与新模型共用（见 assertGate）。*/

async function confirmHugeExport(
  width: number,
  height: number,
  frames: number,
  fps: Fps,
  outputDir: string,
  kind: ExportKind
): Promise<{ choice: DialogAnswer; estimateBytes: number; freeBytes?: number }> {
  const estimate = await window.focusnews.export.estimate({ width, height, fps, frames, outputDir })
  if (kind === 'pngSequence') return { choice: 'ok', estimateBytes: estimate.bytes, freeBytes: estimate.freeBytes }
  if (estimate.sufficientDisk && !estimate.recommendPng) {
    return { choice: 'ok', estimateBytes: estimate.bytes, freeBytes: estimate.freeBytes }
  }
  // 规格 §2.3：4K60 透明 MOV 导出前须显示预估文件大小，并提供 PNG 序列替代出口
  const label =
    `${TEXT.modalHugeExport.bodyPrefix} ${formatBytes(estimate.bytes)}，` +
    (estimate.sufficientDisk
      ? TEXT.modalHugeExport.bodySuffix
      : `目标磁盘可用 ${formatBytes(estimate.freeBytes ?? 0)}，不足以安全写入。`)
  const choice = await askHugeExport(label, `${width}x${height} · ${frames} 帧`, {
    allowPng: kind === 'transparentMov',
    diskShort: !estimate.sufficientDisk
  })
  return { choice, estimateBytes: estimate.bytes, freeBytes: estimate.freeBytes }
}

async function confirmVfrRaw(): Promise<boolean> {
  return askVfrSecondConfirm(TEXT.modalVfr.secondConfirmBody)
}

export function useExportJob() {
  const start = useCallback(async (input: StartExportInput): Promise<string> => {
    assertGate()

    const project = useProjectStore.getState().project
    const fonts = useProjectStore.getState().fonts
    const selectedClipId = useProjectStore.getState().selectedClipId
    const exportScope = useUiStore.getState().exportScope

    /**
     * 水印走同一条「文件不可用就提前说」纪律（规格 §8 的素材完整性口径）：
     * 否则要到 FFmpeg 打开输入时才失败，用户只能看到一串 stderr。
     * 透明字幕条出口不烧录水印，所以只在叠加出口前检查。
     */
    const watermark = project.watermark
    if (input.kind === 'overlayMp4' && watermark?.enabled) {
      const alive = await window.focusnews.video.exists(watermark.path)
      if (!alive) throw new GateError(`水印图片已不可用：${watermark.name}（请在水印页重新导入，或先关掉开关）`)
    }

    const isOverlay = input.kind === 'overlayMp4'
    const base = isOverlay ? buildOverlayBase(project) : null
    if (isOverlay && !base) throw new GateError('叠加导出需要先把素材放入媒体轨（或至少导入一枚素材）')

    /** 跟随基准（规格 §2.3）：v2 取媒体轨首段的源元数据；无媒体轨时退回首枚素材/旧 refVideo（buildOverlayBase 已拉平） */
    const primaryMeta = base?.primaryMeta ?? null

    // 叠加合成强制跟随参考视频参数（规格 §2.3 / §11）
    const resolution = isOverlay && primaryMeta ? { width: primaryMeta.width, height: primaryMeta.height } : project.resolution
    const fps =
      isOverlay && primaryMeta
        ? nearestFps(
            rationalToNumber(primaryMeta.avgFrameRate) ?? primaryMeta.rFrameRate.num / primaryMeta.rFrameRate.den
          )
        : project.fps

    const scope: Parameters<typeof buildRenderJob>[0]['scope'] =
      exportScope === 'timeline' ? { kind: 'timeline' } : { kind: 'clips', clipIds: selectedClipId ? [selectedClipId] : [] }

    /**
     * 帧形式必须跟着“帧到底交给谁”：
     * 计划 C17 把管道主路径改成未压缩 rawvideo（PNG 压缩是吐吐量瓶颈），
     * 但**落盘的路径**（PNG 序列出口、以及 frameDelivery='pngSequence' 的透明 MOV 回退）
     * 写的就是文件名带 .png 的文件，拿到 raw 字节会产出“921600B 的假 PNG”（应用内实捕）。
     */
    const framesToDisk = input.kind === 'pngSequence' || input.frameDelivery === 'pngSequence'

    const spec = await buildRenderJob({
      project,
      fontIndex: fonts,
      resolution,
      fps,
      scope,
      frameFormat: framesToDisk ? 'png' : input.pipeTransport ?? 'raw',
      // 计划 C7：叠加出口只渲染首个入点→末个出点，开头的全透明间隙不进管线
      restrictToActiveSpan: isOverlay
    })
    const frames = Math.max(0, spec.endFrame - spec.startFrame)
    if (frames === 0) throw new GateError('没有可导出的片段（时间轴为空）')

    const frameSpec: FrameSpec = frameSpecOf(spec)
    const estimate = await confirmHugeExport(spec.width, spec.height, frames, fps, input.outputDir, input.kind)
    if (estimate.choice === 'cancel') throw new GateError('已取消导出')
    let kind: ExportKind = input.kind
    const frameDelivery = input.frameDelivery ?? 'pipe'
    let directPipe = input.directPipe === true
    if (estimate.choice === 'png') {
      if (input.kind === 'overlayMp4') {
        // 磁盘紧张：改用直接管道合成，不落中间透明 MOV
        directPipe = true
      } else {
        kind = 'pngSequence'
      }
    }

    let fpsMode: 'cfr' | 'vfr' = 'cfr'
    if (isOverlay && base?.anyVfrRaw) {
      const ok = await confirmVfrRaw()
      if (!ok) throw new GateError('已取消导出')
      fpsMode = 'vfr'
    }

    const jobId = createId('job')
    registerExportJob(jobId, spec)

    /**
     * 音频策略（v2 枚级）：单段且首段从 0s 起才允许直接 copy（与旧单输入一致）；
     * 多段/trim 路径的音频要重编码时间轴，或者任一段无音轨/编码不可 copy → 统一 AAC。
     */
    const audioMode: 'copy' | 'aac' =
      !base || base.multi || base.anyNoAudio || base.audioTranscodeNeeded ? 'aac' : 'copy'

    /**
     * v7：音频轨 → 导出输入。
     *
     * 四点口径：
     * 1. 只保留与本次 span 有重叠的段；
     * 2. 被 span 切开的段要把 sourceInSec 同步平移（否则会从头开始放，与预览对不上），
     *    平移量乘上倍速（v9：时间轴 1s 吃掉 speed 秒源）；
     * 3. 带 sourceOutSec / audio / speed（只在动过时）；
     * 4. PNG 序列出口不写音频（帧序列没有容器可承载），其余两种出口都带。
     */
    const spanStart = frameTimeSec(spec.startFrame, fps)
    const spanEnd = frameTimeSec(spec.endFrame, fps)
    const audioMix =
      kind === 'pngSequence'
        ? []
        : (project.audioClips ?? [])
            .map((clip) => {
              const item = project.media.find((m) => m.id === clip.mediaId)
              if (!item) return null
              const start = Math.max(clip.timelineStartSec, spanStart)
              const end = Math.min(clip.timelineEndSec, spanEnd)
              if (end - start <= 1e-3) return null
              const speed = speedValueOf(clip.speed)
              const sourceIn = clip.sourceInSec + (start - clip.timelineStartSec) * speed
              return {
                path: item.path,
                timelineStartSec: start,
                timelineEndSec: end,
                sourceInSec: sourceIn,
                sourceOutSec: sourceIn + (end - start) * speed,
                ...(clip.audio ? { audio: clip.audio } : {}),
                ...(clip.speed ? { speed: clip.speed } : {})
              }
            })
            .filter((clip): clip is NonNullable<typeof clip> => clip !== null)


    const request: ExportRequest = {
      jobId,
      target: { kind, outputDir: input.outputDir, fileName: input.fileName },
      frameSpec,
      frameDelivery,
      codec: input.codec ?? 'prores4444',
      ...(audioMix.length > 0 ? { audioClips: audioMix } : {}),
      ...(isOverlay && base && primaryMeta
        ? {
            overlay: {
              segments: base.segments,
              /** v1 兼容字段：首段即旧单输入路径的参考视频 */
              refVideoPath: base.segments[0]?.refVideoPath ?? '',
              refMeta: primaryMeta,
              audioMode,
              fpsMode,
              spanStartSec: frameTimeSec(spec.startFrame, fps),
              spanEndSec: frameTimeSec(spec.endFrame, fps),
              directPipe,
              // 水印：主进程按本次输出尺寸等比换算后作为最后一层 overlay
              ...(watermark?.enabled
                ? {
                    watermark: {
                      path: watermark.path,
                      sourceWidth: watermark.sourceWidth,
                      sourceHeight: watermark.sourceHeight
                    }
                  }
                : {})
            }
          }
        : {})
    }

    await window.focusnews.export.start(request)
    return jobId
  }, [])

  const startWith = useCallback(
    async (input: StartExportInput): Promise<string> => {
      // 记下发起参数，失败时面板可一键重试（计划 M4-2）
      useExportStore.getState().setLastInput(input)
      return start(input)
    },
    [start]
  )

  /** 重跑上一次导出（重建规格与新 jobId，不重放旧 jobId） */
  const retryLast = useCallback(async (): Promise<string | null> => {
    const last = useExportStore.getState().lastInput as StartExportInput | null
    if (!last) return null
    return start(last)
  }, [start])

  const cancel = useCallback(async (jobId: string): Promise<void> => {
    await window.focusnews.export.cancel(jobId)
  }, [])

  return { start: startWith, retryLast, cancel }
}

