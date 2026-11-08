import { clipsOnMediaTrack, mediaTrackOrder, visibleMediaTracks } from '@shared/tracks'
import { mediaKindOf } from '@shared/audioClips'
import { topActiveMediaClip } from '@shared/mediaClips'
import { sourceTimeAt } from '@shared/mediaClipAudio'
import { fpsRatio } from '@shared/fps'
import { resolveExportCanvas } from '@shared/exportPresets'
import type {
  CoverExportRequest,
  CoverExportResult,
  CoverMediaLayer,
  ExportCanvasSelection,
  Project
} from '@shared/types'
import { buildRenderJob } from './jobBuilder'
import { NativeStage } from './stage'
import { overlayCanvasFor } from './exportRunner'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 封面帧导出（渲染侧，非交互）：
 * 当前播放头一帧的字幕透明层 + 可见媒体层 → 主进程合成 PNG。
 * 应用内面板与 CLI 共用；UI 的 notice/busy 由 hook 包一层。
 */

export interface CoverExportInput {
  outputDir: string
  selection: ExportCanvasSelection
  /** 指定取帧时间；缺省 = 当前播放头 */
  atSec?: number
}

function coverFileName(project: Project, suffix: string, width: number, height: number): string {
  const name = project.name || 'focusnews'
  return `${name}-cover-${suffix}-${width}x${height}.png`
}

function visibleCoverLayers(project: Project, atSec: number): CoverMediaLayer[] {
  const order = mediaTrackOrder(project.mediaTracks)
  const layers: CoverMediaLayer[] = []
  for (const track of visibleMediaTracks(project.mediaTracks)) {
    const trackClips = clipsOnMediaTrack(project.mediaClips, track.id)
    const clip = topActiveMediaClip(trackClips, atSec, order)
    if (!clip) continue
    const item = project.media.find((media) => media.id === clip.mediaId)
    if (!item) continue
    const kind = mediaKindOf(item)
    if (kind === 'audio') continue
    layers.push({
      path: item.path,
      kind: kind === 'image' ? 'image' : 'video',
      sourceTimeSec: sourceTimeAt(clip, atSec),
      ...(kind === 'image' ? { imageDurationSec: clip.timelineEndSec - clip.timelineStartSec } : {}),
      ...(clip.video ? { video: clip.video } : {})
    })
  }
  return layers
}

export async function runCoverExport(input: CoverExportInput): Promise<CoverExportResult> {
  const project = useProjectStore.getState().project
  const fonts = useProjectStore.getState().fonts
  const atSec = input.atSec ?? useUiStore.getState().displayTimeSec

  // 封面允许「只有字幕、没有媒体」：此时画布退到工程分辨率，主进程在黑底上叠字幕。
  const target = overlayCanvasFor(project, input.selection) ?? {
    canvas: resolveExportCanvas({
      selection: input.selection,
      primaryMeta: null,
      projectResolution: project.resolution
    }),
    fps: project.fps
  }
  const { canvas, fps } = target
  const spec = await buildRenderJob({
    project,
    fontIndex: fonts,
    resolution: { width: canvas.width, height: canvas.height },
    fps,
    mode: canvas.mode,
    scope: { kind: 'timeline' }
  })
  const frame = Math.min(Math.max(0, Math.round(atSec * fpsRatio(fps))), Math.max(0, spec.endFrame - 1))
  const stage = new NativeStage(spec.width, spec.height)
  stage.render(spec, frame, {})
  const overlayPng = new Uint8Array(await stage.pngBuffer())

  const request: CoverExportRequest = {
    outputPath: `${input.outputDir}/${coverFileName(project, canvas.suffix, canvas.width, canvas.height)}`,
    width: canvas.width,
    height: canvas.height,
    fit: canvas.fit,
    overlayPng,
    layers: visibleCoverLayers(project, atSec),
    ...(project.watermark?.enabled
      ? {
          watermark: {
            path: project.watermark.path,
            sourceWidth: project.watermark.sourceWidth,
            sourceHeight: project.watermark.sourceHeight
          }
        }
      : {})
  }
  return window.focusnews.export.cover(request)
}
