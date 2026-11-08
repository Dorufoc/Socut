import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildCoverArgs } from '../../shared/coverArgs'
import { watermarkInputOf } from '../../shared/ffmpegArgs'
import type { CoverExportRequest, CoverExportResult } from '../../shared/types'
import { resolveFfmpegBinaries } from '../paths'
import { spawnJob } from '../procRegistry'
import type { SpawnedJob } from '../procRegistry'
import { createWorkspace, disposeWorkspace } from '../tempWorkspace'
import type { Workspace } from '../tempWorkspace'
import { log } from '../log'

/** 封面帧导出（v10）：媒体层 + 透明字幕 PNG + 水印合成为单帧 PNG。 */

function waitClose(job: SpawnedJob): Promise<number | null> {
  return new Promise((resolve, reject) => {
    job.child.once('error', reject)
    job.child.once('close', (code) => resolve(code))
  })
}

export async function exportCover(request: CoverExportRequest): Promise<CoverExportResult> {
  const outputPath = request.outputPath
  let workspace: Workspace | null = null
  try {
    if (!(request.width > 0) || !(request.height > 0)) throw new Error('封面目标尺寸无效')
    const binaries = await resolveFfmpegBinaries()
    if (!binaries.available) return { ok: false, path: outputPath, error: 'FFmpeg 不可用' }

    const jobId = `cover-${randomUUID()}`
    workspace = await createWorkspace(jobId)
    const overlayPath = path.join(workspace.dir, 'overlay.png')
    await fs.writeFile(overlayPath, Buffer.from(request.overlayPng))
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const args = buildCoverArgs({
      width: request.width,
      height: request.height,
      fit: request.fit,
      layers: request.layers,
      overlayPath,
      watermark: watermarkInputOf(request.watermark),
      outputPath
    })
    const job = spawnJob({
      jobId,
      label: `封面 ${request.width}x${request.height}`,
      binary: binaries.ffmpeg,
      args
    })
    const code = await waitClose(job)
    if (code !== 0) {
      throw new Error(`封面导出失败（FFmpeg 退出码 ${code ?? '未知'}）：${job.stderr.tail(1024)}`)
    }
    await log('info', `封面已导出：${outputPath}`)
    return { ok: true, path: outputPath }
  } catch (error) {
    await fs.rm(outputPath, { force: true }).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    await log('error', `封面导出失败：${message}`)
    return { ok: false, path: outputPath, error: message }
  } finally {
    if (workspace) await disposeWorkspace(workspace)
  }
}
