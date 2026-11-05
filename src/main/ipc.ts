import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CHANNELS } from '../shared/ipcChannels'
import { APP_NAME, WINDOW_TITLE } from '../shared/constants'
import { validateAllPresets } from '../shared/presets'
import type { ExportRequest, Fps, MediaStripRequest, MediaStripResult, Project, VideoMeta } from '../shared/types'
import type { AppInfo, EstimateInput } from '../shared/api'
import { describeBinarySource, resolveFfmpegBinaries, userFontsDir } from './paths'
import { ffmpegVersion } from './ffrun'
import { log } from './log'
import { importFontDialog, listFonts, readFontBytes, removeFont } from './fontStore'
import {
  autosaveRead,
  autosaveWrite,
  fileExists,
  openProjectDialog,
  saveProjectAs
} from './projectStore'
import { pickAndProbeVideo, pickManyAndProbeVideos, probeVideo } from './videoImport'
import { pickAndProbeWatermark } from './watermark'
import { createPreviewUrl } from './media'
import { ensureThumbRegistered, generateThumbnail, removeThumbnail, thumbUrlFor } from './thumbProtocol'
import { generateStrip, removeStripsFor } from './stripProtocol'
import { cancelCfr, convertToCfr } from './cfrTranscode'
import { smokeConfig, verifySmokeReport, writeSmokeReport } from './smoke'
import { installFrameIpc } from './export/frameChannel'
import type { SmokeReport } from '../shared/api'
import type { ExportEngine } from './export/engine'

/** IPC 注册总入口（唯一使用 ipcMain 的位置）。所有 handler 均为异步。 */

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/** 开发取证文件的统一路径约束：仅非打包、且必须落在仓库 spikes/ 下。 */
function resolveDevPath(filePath: string, action: '读取' | '写入'): string {
  if (app.isPackaged) throw new Error(`dev 取证接口仅限开发环境（${action}）`)
  if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('缺少目标路径')
  const target = path.resolve(filePath)
  const spikesRoot = path.join(path.resolve(app.getAppPath()), 'spikes')
  if (!target.startsWith(spikesRoot + path.sep)) throw new Error(`只允许${action} ${spikesRoot} 下：${target}`)
  return target
}

export function registerIpc(engine: ExportEngine): void {
  // 帧回执监听只需注册一次（pull 模式的渲染侧应答入口）
  installFrameIpc()

  ipcMain.handle(CHANNELS.appInfo, async (): Promise<AppInfo> => {
    const binaries = await resolveFfmpegBinaries()
    const version = await ffmpegVersion(binaries)
    return {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      platform: process.platform,
      packaged: app.isPackaged,
      ffmpegVersion: version,
      ffmpegPath: binaries.ffmpeg,
      ffprobePath: binaries.ffprobe,
      ffmpegSource: describeBinarySource(binaries),
      ffmpegAvailable: binaries.available,
      ffmpegHint: binaries.hint ?? '',
      userDataPath: app.getPath('userData'),
      fontsPath: userFontsDir(),
      presetIssues: validateAllPresets().map((issue) => `${issue.presetId} · ${issue.path}：${issue.message}`),
      title: WINDOW_TITLE,
      appName: APP_NAME,
      smoke: smokeConfig(),
      reviewSheet: app.isPackaged ? null : (process.env.FOCUSNEWS_REVIEW_SHEET ?? null),
      reviewBackdrop: app.isPackaged ? null : (process.env.FOCUSNEWS_REVIEW_BACKDROP ?? null),
      pixelCheck: app.isPackaged ? null : (process.env.FOCUSNEWS_PIXELCHECK ?? null),
      errorDemo: app.isPackaged
        ? null
        : (process.env.FOCUSNEWS_SHOT_ERROR === '1'
          ? path.join(app.getAppPath(), 'spikes', 'app-smoke', 'error-demo.json')
          : (process.env.FOCUSNEWS_SHOT_ERROR ?? null)),
      refMissingDemo: app.isPackaged ? null : (process.env.FOCUSNEWS_SHOT_REFMISSING ?? null),
      visualCheck: app.isPackaged ? null : (process.env.FOCUSNEWS_VISUAL_CHECK ?? null)
    }
  })

  /**
   * 仅开发：渲染侧把逐帧动画评审表（M4-7）写盘。
   * 目标路径限定在仓库 spikes/ 下，避免变成一个任意义文件写入的后门。
   */
  ipcMain.handle(CHANNELS.devWriteFile, async (_event, filePath: string, bytes: Uint8Array): Promise<number> => {
    const target = resolveDevPath(filePath, '写入')
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, buffer)
    await log('info', `取证图片已写入 ${target}（${(buffer.length / 1024).toFixed(0)}KB）`)
    console.log(`✓ 取证图片：${target}`)
    const expected = process.env.FOCUSNEWS_REVIEW_SHEET
    if (expected && target === path.resolve(expected)) {
      // 评审表就是本次运行的唯一目的：写完即退，给 stdout 留 flush 时间
      setTimeout(() => app.exit(0), 300)
    }
    const pixelTarget = process.env.FOCUSNEWS_PIXELCHECK
    if (pixelTarget && target === path.resolve(pixelTarget)) {
      // 像素一致性回归：把报告里的 passed 翻译成退出码，否则只能靠人读 JSON
      let passed = false
      try {
        const parsed = JSON.parse(buffer.toString('utf8')) as { passed?: boolean; failures?: string[] }
        passed = parsed.passed === true
        for (const failure of parsed.failures ?? []) console.error(`✗ 像素一致性：${failure}`)
      } catch (error) {
        console.error(`✗ 像素一致性报告无法解析：${String(error)}`)
      }
      console.log(passed ? '✓ 预览/导出逐像素一致（M1-7）' : '✗ 预览/导出像素不一致（M1-7）')
      setTimeout(() => app.exit(passed ? 0 : 1), 300)
    }
    const errorTarget = process.env.FOCUSNEWS_SHOT_ERROR
    if (errorTarget && target === path.resolve(errorTarget === '1' ? path.join(app.getAppPath(), 'spikes', 'app-smoke', 'error-demo.json') : errorTarget)) {
      // 错误呈现取证：失败面板拿不到完整命令行就算失败（规格 §9）
      let passed = false
      try {
        const parsed = JSON.parse(buffer.toString('utf8')) as { passed?: boolean; failures?: string[] }
        passed = parsed.passed === true
        for (const failure of parsed.failures ?? []) console.error(`✗ 错误呈现：${failure}`)
      } catch (error) {
        console.error(`✗ 错误呈现报告无法解析：${String(error)}`)
      }
      console.log(passed ? '✓ 失败面板可展示完整命令行（M4-2 / §9）' : '✗ 失败面板缺少命令行（M4-2 / §9）')
      setTimeout(() => app.exit(passed ? 0 : 1), 300)
    }
    const visualTarget = process.env.FOCUSNEWS_VISUAL_CHECK
    if (visualTarget && target === path.resolve(visualTarget)) {
      // 视觉检查：把报告里的 passed 翻译成退出码，失败项逐条打到 stdout
      let passed = false
      try {
        const parsed = JSON.parse(buffer.toString('utf8')) as {
          passed?: boolean
          cases?: Array<{ failures?: string[] }>
        }
        passed = parsed.passed === true
        for (const item of parsed.cases ?? []) {
          for (const failure of item.failures ?? []) console.error(`✗ 视觉检查：${failure}`)
        }
      } catch (error) {
        console.error(`✗ 视觉检查报告无法解析：${String(error)}`)
      }
      console.log(passed ? '✓ 视觉检查通过（8 预设 × 短/常规/长）' : '✗ 视觉检查未通过')
      setTimeout(() => app.exit(passed ? 0 : 1), 300)
    }
    return buffer.length
  })

  /** 仅开发：读 spikes/ 下的取证素材（评审表背景帧）。 */
  ipcMain.handle(CHANNELS.devReadFile, async (_event, filePath: string): Promise<Uint8Array | null> => {
    const target = resolveDevPath(filePath, '读取')
    const buffer = await fs.readFile(target).catch(() => null)
    return buffer ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : null
  })

  ipcMain.handle(CHANNELS.smokeReport, async (_event, report: SmokeReport) => {
    if (!smokeConfig()) throw new Error('冒烟模式未启用')
    const verification = await verifySmokeReport(report)
    const file = await writeSmokeReport(report, verification)
    const summary = verification.passed
      ? `✓ 应用内冒烟通过（${report.framesTotal} 帧 / ${Math.round(report.elapsedMs)}ms · 外推 1080p30 10s = ${String(verification.checks.extrapolated1080p30_10sSec)}s）`
      : `✗ 应用内冒烟失败：${verification.failures.join('; ')}`
    console.log(summary)
    await log('info', `${summary}\n报告：${file}`)
    // 给 stdout flush 的时间，随后带状态码退出
    setTimeout(() => app.exit(verification.passed ? 0 : 1), 300)
  })

  ipcMain.handle(CHANNELS.chooseDirectory, async (event, title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? '选择输出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0] as string
    await fs.mkdir(dir, { recursive: true })
    void event
    return dir
  })

  ipcMain.handle(CHANNELS.revealPath, async (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) return
    const exists = await fileExists(target)
    if (exists) {
      shell.showItemInFolder(target)
      return
    }
    const dir = path.dirname(target)
    if (await fileExists(dir)) await shell.openPath(dir)
  })

  ipcMain.handle(CHANNELS.writeLog, async (_event, level: 'info' | 'warn' | 'error', message: string) => {
    await log(level === 'info' || level === 'warn' || level === 'error' ? level : 'info', String(message))
  })

  // ---------------------------------------------------------------- 工程
  ipcMain.handle(CHANNELS.projectOpen, async (event) => {
    const loaded = await openProjectDialog(senderWindow(event))
    return loaded
  })

  ipcMain.handle(CHANNELS.projectSaveAs, async (event, project: Project) => {
    const savedPath = await saveProjectAs(senderWindow(event), project)
    return savedPath ? { path: savedPath } : null
  })

  ipcMain.handle(CHANNELS.projectAutosaveRead, async () => autosaveRead())

  ipcMain.handle(CHANNELS.projectAutosaveWrite, async (_event, project: Project) => {
    await autosaveWrite(project)
  })

  // ---------------------------------------------------------------- 字体
  ipcMain.handle(CHANNELS.fontsList, async () => listFonts())

  ipcMain.handle(CHANNELS.fontImport, async (event) => {
    const record = await importFontDialog(senderWindow(event))
    return record ? { record } : null
  })

  ipcMain.handle(CHANNELS.fontReadBytes, async (_event, fontId: string) => readFontBytes(String(fontId)))

  ipcMain.handle(CHANNELS.fontRemove, async (_event, fontId: string) => {
    await removeFont(String(fontId))
  })

  // ---------------------------------------------------------------- 视频
  ipcMain.handle(CHANNELS.videoPickAndProbe, async (event) => {
    const picked = await pickAndProbeVideo(senderWindow(event))
    if (!picked) return null
    return { path: picked.path, probe: picked.probe }
  })

  /** v2 素材库：多选 + 逐文件探测（门禁确认在渲染侧逐枚完成）。 */
  ipcMain.handle(CHANNELS.videoPickManyAndProbe, async (event) => {
    const picked = await pickManyAndProbeVideos(senderWindow(event))
    return picked.map((item) => ({ path: item.path, probe: item.probe }))
  })

  ipcMain.handle(CHANNELS.videoProbe, async (_event, target: string) => {
    if (typeof target !== 'string' || !(await fileExists(target))) return null
    return probeVideo(target, 'manual-probe')
  })

  /** 规格 §8：参考视频被移动/删除时要提示重新定位，而不是等到导出才报错。 */
  ipcMain.handle(CHANNELS.videoExists, async (_event, target: string): Promise<boolean> =>
    typeof target === 'string' && target.length > 0 && (await fileExists(target))
  )

  /** 参考视频预览：校验存在 + 视频扩展名后登记，只向渲染进程交出 custom scheme 地址。 */
  ipcMain.handle(CHANNELS.videoPreviewUrl, async (_event, target: string): Promise<string | null> =>
    typeof target === 'string' && target.length > 0 ? createPreviewUrl(target) : null
  )

  /** v2：主进程 ffmpeg 抽帧缩略图；失败返回 null，素材库显示占位符。 */
  ipcMain.handle(CHANNELS.mediaGenerateThumb, async (_event, mediaId: string, videoPath: string, atSec?: number): Promise<string | null> => {
    if (typeof mediaId !== 'string' || typeof videoPath !== 'string') return null
    return generateThumbnail(mediaId, videoPath, typeof atSec === 'number' ? atSec : 1)
  })

  /** v2：工程里持久化的 focusnews-thumb:// 地址在主进程重启后需重新登记才可读。 */
  ipcMain.handle(CHANNELS.mediaThumbUrl, async (_event, mediaId: string, url: string): Promise<string | null> => {
    if (typeof mediaId !== 'string' || typeof url !== 'string') return null
    const reregistered = await ensureThumbRegistered(mediaId, url)
    return reregistered ?? thumbUrlFor(mediaId)
  })

  /** v2：素材移出池时回收缩略图与时间帧预览条（userData/thumbs 与 userData/strips）。 */
  ipcMain.handle(CHANNELS.mediaThumbRemove, async (_event, mediaId: string): Promise<void> => {
    if (typeof mediaId === 'string' && mediaId.length > 0) {
      await removeThumbnail(mediaId)
      // 预览条是按「素材+区间+格数」命名的，只能按 mediaId 前缀整批回收
      await removeStripsFor(mediaId)
    }
  })

  /**
   * v5：时间帧预览条（Thumbnail Strip）。主进程一次 FFmpeg 调用均匀抽帧并拼成一张长图，
   * 命中磁盘缓存时不起子进程；失败（源不在/FFmpeg 缺失/抽帧报错）返回 url=null，
   * 渲染层显示「无法预览」占位，不影响时间轴拖拽与剪辑。
   */
  ipcMain.handle(CHANNELS.mediaGenerateStrip, async (_event, request: MediaStripRequest): Promise<MediaStripResult> => {
    if (typeof request !== 'object' || request === null) {
      return { url: null, frames: 0, key: 'invalid', cached: false }
    }
    return generateStrip(request)
  })

  ipcMain.handle(CHANNELS.videoCfrConvert, async (event, target: string, fps: Fps, meta: VideoMeta) => {
    const job = await convertToCfr(String(target), fps, meta, senderWindow(event))
    return job
  })

  // ---------------------------------------------------------------- 水印

  /** 选一张本机图片作水印：主进程探测原图尺寸（几何换算的唯一输入）后交给渲染侧写入工程。 */
  ipcMain.handle(CHANNELS.watermarkPick, async (event) => pickAndProbeWatermark(senderWindow(event)))

  ipcMain.handle(CHANNELS.exportCancel, async (_event, jobId: string) => {
    await engine.cancel(String(jobId))
    await cancelCfr(String(jobId))
  })

  // ---------------------------------------------------------------- 导出
  ipcMain.handle(CHANNELS.exportEstimate, async (_event, input: EstimateInput) => engine.estimate(input))

  ipcMain.handle(CHANNELS.exportStart, async (event, request: ExportRequest) => {
    const window = senderWindow(event)
    if (!window) throw new Error('窗口不可用')
    return engine.submit(request, window)
  })
}
