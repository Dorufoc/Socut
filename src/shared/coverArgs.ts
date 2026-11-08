import { FPS_30 } from './constants'
import { fpsToArg } from './fps'
import { buildCanvasNormalizeFilter, buildWatermarkFilterChain, formatSec } from './ffmpegArgs'
import type { WatermarkInput } from './ffmpegArgs'
import { buildMediaClipVideoFx } from './mediaClipVideoFfmpeg'
import type { CoverMediaLayer, ExportFit } from './types'

/**
 * 封面帧合成参数（v10）。
 *
 * 输入：按轨道从底到顶的媒体层、透明字幕 PNG、可选水印。
 * 输出：单帧 PNG（`-frames:v 1 -update 1`）。
 * 该文件只构造 argv，不碰 Node/Electron，主进程与单测共用同一份口径。
 */

export const COVER_FRAME_SEC = 1 / 30

export interface CoverArgsInput {
  width: number
  height: number
  fit: ExportFit
  layers: CoverMediaLayer[]
  /** 渲染侧产出的透明字幕 PNG 路径（临时文件） */
  overlayPath: string
  watermark?: WatermarkInput
  outputPath: string
}

export function buildCoverArgs(input: CoverArgsInput): string[] {
  const size = `${input.width}x${input.height}`
  const rate = fpsToArg(FPS_30)
  const frameDur = formatSec(COVER_FRAME_SEC)
  const args: string[] = ['-hide_banner', '-y', '-loglevel', 'error']
  for (const layer of input.layers) {
    if (layer.kind === 'image') {
      args.push('-loop', '1', '-t', frameDur, '-i', layer.path)
    } else {
      args.push('-ss', formatSec(Math.max(0, layer.sourceTimeSec)), '-i', layer.path)
    }
  }
  const overlayIndex = input.layers.length
  args.push('-loop', '1', '-t', frameDur, '-i', input.overlayPath)
  if (input.watermark) args.push('-loop', '1', '-i', input.watermark.path)

  const chains: string[] = []
  const layerLabels: string[] = []
  const normalize = buildCanvasNormalizeFilter({
    width: input.width,
    height: input.height,
    fit: input.fit,
    transparent: true
  })
  input.layers.forEach((layer, index) => {
    const label = `cv${index}`
    chains.push(`[${index}:v]format=rgba,${normalize}[${label}]`)
    const fx = buildMediaClipVideoFx({
      baseLabel: label,
      outputLabel: `fx${index}`,
      video: layer.video,
      frame: { width: input.width, height: input.height },
      fps: FPS_30,
      durationSec: COVER_FRAME_SEC,
      transparentBackground: true
    })
    chains.push(...fx.statements)
    layerLabels.push(`[${fx.outputLabel}]`)
  })

  chains.push(`color=c=black:s=${size}:r=${rate}:d=${frameDur},format=rgba[base]`)
  let current = 'base'
  layerLabels.forEach((label, index) => {
    const out = `mo${index}`
    chains.push(`[${current}]${label}overlay=0:0:alpha=straight:format=auto:eof_action=pass:shortest=0[${out}]`)
    current = out
  })

  chains.push(`[${overlayIndex}:v]format=rgba[sub]`)
  chains.push(`[${current}][sub]overlay=0:0:alpha=straight:format=auto,format=rgba[st]`)
  if (input.watermark) {
    chains.push(
      ...buildWatermarkFilterChain({
        label: overlayIndex + 1,
        prevLabel: 'st',
        watermark: input.watermark,
        output: { width: input.width, height: input.height }
      })
    )
  } else {
    chains.push('[st]format=rgba[v]')
  }

  args.push(
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[v]',
    '-frames:v',
    '1',
    '-update',
    '1',
    input.outputPath
  )
  return args
}
