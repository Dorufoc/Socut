import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import {
  COPYABLE_AUDIO_CODECS,
  IMPORTABLE_AUDIO_EXTENSIONS,
  IMPORTABLE_IMAGE_EXTENSIONS,
  IMPORTABLE_VIDEO_EXTENSIONS,
  VFR_SAMPLE_PACKETS
} from '../shared/constants'
import { buildProbeArgs, buildVfrSampleArgs } from '../shared/ffmpegArgs'
import { buildProbeResult, parseAudioProbeJson, parseProbeJson } from '../shared/probe'
import type { Fps, VideoMeta, VideoProbeResult } from '../shared/types'
import { runFfprobeJson } from './ffrun'
import { resolveFfmpegBinaries } from './paths'
import { log } from './log'

/** 视频导入与探测（规格 §5.2 步骤 1、§6 兼容性判定输入）。 */

interface CacheEntry {
  key: string
  result: VideoProbeResult
  at: number
}

const cache = new Map<string, CacheEntry>()

function cacheKey(target: string, mtimeMs: number, sizeBytes: number): string {
  return `${target}|${mtimeMs.toFixed(3)}|${sizeBytes}`
}

/** 一次探测、全程复用（编辑/门禁/导出参数都读这里）。 */
export async function probeVideo(target: string, jobId = 'probe', force = false): Promise<VideoProbeResult> {
  const binaries = await resolveFfmpegBinaries()
  let stat: { mtimeMs: number; size: number } | null = null
  try {
    stat = await fs.stat(target)
  } catch {
    stat = null
  }
  if (stat) {
    const key = cacheKey(target, stat.mtimeMs, stat.size)
    const hit = cache.get(target)
    if (!force && hit && hit.key === key) return hit.result
  }

  const payload = await runFfprobeJson<unknown>(buildProbeArgs(target), `${jobId}-probe`, binaries)
  const meta = parseProbeJson(payload, target)
  if (!meta) {
    // v7：没有视频流不一定是坏文件——纯音频（mp3/wav/m4a…）走这条分支；
    // compat 由 buildProbeResult 从 meta 推导（无画面、无 HDR、帧率恒定），不会弹兼容性确认。
    const audioMeta = parseAudioProbeJson(payload, target)
    if (!audioMeta) throw new Error(`无法解析视频流：${target}`)
    const audioResult = buildProbeResult(audioMeta)
    if (stat) cache.set(target, { key: cacheKey(target, stat.mtimeMs, stat.size), result: audioResult, at: Date.now() })
    return audioResult
  }

  // VFR 需要 PTS 抽样佐证（成本远低于 -count_frames）
  let packets: unknown
  try {
    const sampled = await runFfprobeJson<unknown>(
      buildVfrSampleArgs(target, VFR_SAMPLE_PACKETS),
      `${jobId}-vfr`,
      binaries
    ) as { packets?: unknown }
    packets = sampled?.packets
  } catch (error) {
    await log('warn', `VFR 抽样失败（按帧率字段判定）：${String(error)}`)
  }

  const result = buildProbeResult(meta, packets)
  if (stat) cache.set(target, { key: cacheKey(target, stat.mtimeMs, stat.size), result, at: Date.now() })
  await log(
    'info',
    `探测 ${path.basename(target)}：${meta.width}x${meta.height} 显示比 ${meta.displayRatio.toFixed(4)} ` +
      `r=${meta.rFrameRate.num}/${meta.rFrameRate.den} avg=${meta.avgFrameRate.num}/${meta.avgFrameRate.den} ` +
      `非16:9=${result.flags.non169} HDR=${result.flags.hdr} VFR=${result.flags.vfr} 音频=${meta.audioCodec ?? '无'}`
  )
  return result
}

export function cachedProbe(target: string): VideoProbeResult | undefined {
  return cache.get(target)?.result
}

export function dropProbeCache(target?: string): void {
  if (target) cache.delete(target)
  else cache.clear()
}

/**
 * 可导入的容器扩展名（白名单在 shared/constants，与单测同一来源）。
 * `mxf` 是广播交付的主容器（XDCAM / AVC-Intra / DNxHD），ffprobe/ffmpeg 原生可读，
 * 导入、探测、导出全链路都能走；但 Chromium 没有 MXF 解封装器，预览需要代理转码。
 */
const VIDEO_EXTENSIONS: string[] = [
  ...IMPORTABLE_VIDEO_EXTENSIONS,
  ...IMPORTABLE_AUDIO_EXTENSIONS,
  ...IMPORTABLE_IMAGE_EXTENSIONS
]

/** 选择参考视频文件并探测（门禁确认在渲染进程完成，规格 §6）。 */
export async function pickAndProbeVideo(
  parent: BrowserWindow | null
): Promise<{ path: string; probe: VideoProbeResult } | null> {
  const options = {
    title: '选择参考视频（MP4/MOV/...）',
    properties: ['openFile'] as ['openFile'],
    filters: [{ name: '媒体文件', extensions: VIDEO_EXTENSIONS }, { name: '所有文件', extensions: ['*'] }]
  }
  // 窗口级模态：避开预览区被遮挡后用户误以为导入失败
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const target = result.filePaths[0] as string
  const probe = await probeVideo(target, 'pick')
  return { path: target, probe }
}

/**
 * v2 素材库：多选批量导入。逐文件探测，单文件探测失败不阻断整批（跳过并继续）；
 * 同一批内重复路径去重。
 */
export async function pickManyAndProbeVideos(
  parent: BrowserWindow | null
): Promise<{ path: string; probe: VideoProbeResult }[]> {
  const options = {
    title: '选择参考视频（可多选）',
    properties: ['openFile', 'multiSelections'] as ['openFile', 'multiSelections'],
    filters: [{ name: '媒体文件', extensions: VIDEO_EXTENSIONS }, { name: '所有文件', extensions: ['*'] }]
  }
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled) return []
  const out: { path: string; probe: VideoProbeResult }[] = []
  const seen = new Set<string>()
  for (const filePath of result.filePaths) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    try {
      const probe = await probeVideo(filePath, 'pick-many')
      out.push({ path: filePath, probe })
    } catch (error) {
      await log('warn', `批量导入跳过 ${path.basename(filePath)}：${String(error)}`)
    }
  }
  return out
}

/** 叠加导出所需的跟随参数（规格 §2.3：强制跟随参考视频，UI 只读）。 */
export interface OverlayFollowParams {
  resolution: { width: number; height: number }
  fps: Fps
  meta: VideoMeta
  audioMode: 'copy' | 'aac'
  fpsMode: 'cfr' | 'vfr'
}

export function deriveFollowParams(
  probe: VideoProbeResult,
  options: { vfrRawKept?: boolean } = {}
): OverlayFollowParams {
  const meta = probe.meta
  const audioMode = probe.flags.noAudio || probe.flags.audioTranscodeNeeded ? 'aac' : 'copy'
  return {
    resolution: { width: meta.width, height: meta.height },
    // 叠加必须按参考视频帧率重渲染（规格 §4.3 / §11）
    fps: probe.suggestedFps,
    meta,
    audioMode,
    fpsMode: options.vfrRawKept ? 'vfr' : 'cfr'
  }
}

/** 音频策略预检（计划 C4：不可复制时直接 AAC，避免 copy 运行期失败）。 */
export function decideAudioMode(meta: VideoMeta): { mode: 'copy' | 'aac'; notice: string | null } {
  if (meta.audioCodec === null) return { mode: 'aac', notice: null }
  const copyable = COPYABLE_AUDIO_CODECS.includes(meta.audioCodec)
  return copyable
    ? { mode: 'copy', notice: null }
    : {
        mode: 'aac',
        notice: `参考音频编码为 ${meta.audioCodec}，无法直接复制，已转码为 AAC 192k。`
      }
}
