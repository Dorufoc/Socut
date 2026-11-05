import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { WATERMARK_IMAGE_EXTENSIONS } from '../shared/constants'
import { buildImageSizeArgs } from '../shared/ffmpegArgs'
import { parseImageSize } from '../shared/probe'
import type { WatermarkPickResult } from '../shared/api'
import { runFfprobeJson } from './ffrun'
import { resolveFfmpegBinaries } from './paths'
import { log } from './log'

/**
 * 水印（Watermark）导入：选一张本机图片并探测原始像素尺寸。
 *
 * 原图尺寸是几何换算的唯一输入（1080P 基准 → 显示为原图 32% → 距顶/左各 30px，
 * 非 1080P 输出按高度比等比换算），所以导入时**必须**拿到真实宽高：
 * 拿不到就直接失败让用户换图，而不是按猜的尺寸合成出一张错比例的水印。
 * 滤镜参数与换算全在 `shared/ffmpegArgs.ts`（纯函数 + argv 快照测试）。
 */

/** ffprobe 读图片宽高；不做任何视频字段（帧率/色彩）假设。 */
export async function probeImageSize(target: string): Promise<{ width: number; height: number }> {
  const binaries = await resolveFfmpegBinaries()
  const payload = await runFfprobeJson<unknown>(buildImageSizeArgs(target), 'watermark-probe', binaries)
  const size = parseImageSize(payload)
  if (!size) throw new Error(`无法读取图片尺寸：${path.basename(target)}`)
  return size
}

/** 选择水印图片并探测尺寸；用户取消返回 null，文件不可读时抛错（由 UI 呈现）。 */
export async function pickAndProbeWatermark(
  parent: BrowserWindow | null
): Promise<WatermarkPickResult | null> {
  const options = {
    title: '选择水印图片（PNG / JPG / WEBP …）',
    properties: ['openFile'] as ['openFile'],
    filters: [
      { name: '图片文件', extensions: [...WATERMARK_IMAGE_EXTENSIONS] },
      { name: '所有文件', extensions: ['*'] }
    ]
  }
  // 窗口级模态：与视频导入一致，避免用户以为点没反应
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const target = result.filePaths[0] as string
  const stat = await fs.stat(target).catch(() => null)
  if (!stat?.isFile() || stat.size === 0) throw new Error(`图片不可读：${path.basename(target)}`)
  const size = await probeImageSize(target)
  await log('info', `水印已导入：${path.basename(target)} 原图 ${size.width}x${size.height}`)
  return {
    path: target,
    name: path.basename(target),
    sourceWidth: size.width,
    sourceHeight: size.height
  }
}
