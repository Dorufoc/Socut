import { useCallback } from 'react'
import { detectCompat } from '@shared/probe'
import { createId } from '@shared/projectSchema'
import { frameTimeSec, rationalToNumber } from '@shared/fps'
import { nearestFps } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { formatBytes } from '@shared/sizeEstimate'
import type { ExportKind, ExportRequest, FrameSpec, Fps, TransparentCodec } from '@shared/types'
import { askHugeExport, askVfrSecondConfirm } from '../dialog/ask'
import type { DialogAnswer } from '../state/uiStore'
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

/** 门禁校验（规格 §6：未确认不得导入或导出）。 */
function assertGate(): void {
  const project = useProjectStore.getState().project
  const ref = project.refVideo
  if (!ref) return
  const flags = detectCompat(ref.meta)
  if (flags.non169 && !ref.non169Ack) throw new GateError(TEXT.modalNon169.body)
  if (flags.hdr && !ref.hdrAck) throw new GateError(TEXT.modalHdr.body)
  if (flags.vfr && ref.vfrPolicy === 'none') throw new GateError(TEXT.modalVfr.body)
}

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

    const ref = project.refVideo
    const isOverlay = input.kind === 'overlayMp4'
    if (isOverlay && !ref) throw new GateError('叠加导出需要先在时间轴导入参考视频')

    // 叠加合成强制跟随参考视频参数（规格 §2.3 / §11）
    const resolution = isOverlay && ref ? { width: ref.meta.width, height: ref.meta.height } : project.resolution
    const fps =
      isOverlay && ref
        ? nearestFps(rationalToNumber(ref.meta.avgFrameRate) ?? ref.meta.rFrameRate.num / ref.meta.rFrameRate.den)
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
    if (isOverlay && ref && ref.vfrPolicy === 'raw') {
      const ok = await confirmVfrRaw()
      if (!ok) throw new GateError('已取消导出')
      fpsMode = 'vfr'
    }

    const jobId = createId('job')
    registerExportJob(jobId, spec)

    const request: ExportRequest = {
      jobId,
      target: { kind, outputDir: input.outputDir, fileName: input.fileName },
      frameSpec,
      frameDelivery,
      codec: input.codec ?? 'prores4444',
      ...(isOverlay && ref
        ? {
            overlay: {
              refVideoPath: ref.path,
              refMeta: ref.meta,
              audioMode: ref.meta.audioCodec === null ? 'aac' : detectCompat(ref.meta).audioTranscodeNeeded ? 'aac' : 'copy',
              fpsMode,
              spanStartSec: frameTimeSec(spec.startFrame, fps),
              spanEndSec: frameTimeSec(spec.endFrame, fps),
              directPipe
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
