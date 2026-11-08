import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { CHANNELS } from '../shared/ipcChannels'
import { APP_NAME, WINDOW_TITLE } from '../shared/constants'
import { validateAllPresets } from '../shared/presets'
import type { AudioPeaksRequest, AudioPeaksResult, CoverExportRequest, ExportRequest, Fps, MediaProxyRequest, MediaProxyResult, MediaProxyStatusResult, MediaStripRequest, MediaStripResult, Project, StabPreviewRequest, StabPreviewResult, VideoMeta } from '../shared/types'
import type { AppInfo, CoverCaptureRect, EstimateInput, SaveProjectResult } from '../shared/api'
import type { CliResponse } from '../shared/cliProtocol'
import type { CliControlServer } from './cliServer'
import { AUTOSAVE_ENTRY_ID, RECENT_ENTRY_ID_PATTERN, recentEntryIdForPath } from '../shared/recentProjects'
import { describeBinarySource, resolveFfmpegBinaries, userFontsDir } from './paths'
import { ffmpegVersion } from './ffrun'
import { log } from './log'
import { importFontDialog, listFonts, readFontBytes, removeFont } from './fontStore'
import {
  autosaveRead,
  autosaveWrite,
  fileExists,
  openProjectDialog,
  saveProjectAs,
  writeProjectFile
} from './projectStore'
import { pickAndProbeVideo, pickManyAndProbeVideos, probeVideo } from './videoImport'
import {
  createRecentProject,
  listRecentProjects,
  openRecentProject,
  registerAutosaveProject,
  registerFileProject,
  removeRecentProject,
  renameRecentProject,
  saveRecentCover,
  setAutosaveOwner,
  updateEntryFromProject
} from './recentProjectStore'
import { pickAndProbeWatermark, probeImageSize } from './watermark'
import { createPreviewUrl } from './media'
import { ensureThumbRegistered, generateThumbnail, removeThumbnail, thumbUrlFor } from './thumbProtocol'
import { generateStrip, removeStripsFor } from './stripProtocol'
import { generateAudioPeaks, removePeaksFor } from './audioPeaks'
import { cancelCfr, convertToCfr } from './cfrTranscode'
import { applyStabPreview, cancelStabPreview, removeStabPreviewForClip } from './stabPreview'
import { applyMediaProxy, cancelMediaProxy, removeMediaProxy, statusMediaProxy } from './mediaProxy'
import { smokeConfig, verifySmokeReport, writeSmokeReport } from './smoke'
import { getGpuDiagnostics } from './gpu'
import { getRenderSettings, getStartupPreference, saveRenderSettings } from './renderSettings'
import type { GpuDiagnostics, RenderSettings } from '../shared/gpu'
import { installFrameIpc } from './export/frameChannel'
import { exportCover } from './export/cover'
import type { SmokeReport } from '../shared/api'
import type { ExportEngine } from './export/engine'

/** IPC 注册总入口（唯一使用 ipcMain 的位置）。所有 handler 均为异步。 */

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

/** 封面裁剪矩形：四个分量都必须是有限数，宽高必须为正。 */
function isCaptureRect(rect: unknown): rect is CoverCaptureRect {
  if (typeof rect !== 'object' || rect === null) return false
  const value = rect as Record<string, unknown>
  const finite = (key: string): boolean => typeof value[key] === 'number' && Number.isFinite(value[key])
  if (!finite('x') || !finite('y') || !finite('width') || !finite('height')) return false
  return (value['width'] as number) > 0 && (value['height'] as number) > 0
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

export function registerIpc(engine: ExportEngine, cli?: CliControlServer | null): void {
  // 帧回执监听只需注册一次（pull 模式的渲染侧应答入口）
  installFrameIpc()

  // CLI 控制面：渲染侧命令路由的就绪握手与逐条结果回执
  ipcMain.on(CHANNELS.cliReady, () => {
    cli?.notifyRendererReady()
  })
  ipcMain.on(CHANNELS.cliResponse, (_event, payload: { id?: unknown; response?: CliResponse }) => {
    if (!payload || typeof payload.id !== 'string' || !payload.response) return
    cli?.handleResponse(payload.id, payload.response)
  })

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
    if (!loaded) return null
    // 历史登记失败不能阻断「打开工程」本身：退化为按路径即时算 id 返回
    try {
      const entry = await registerFileProject(loaded.path, loaded.project, { touchOpened: true })
      return { ...loaded, entryId: entry.id }
    } catch (error) {
      console.warn(`[recent] 登记打开工程失败：${String(error)}`)
      return { ...loaded, entryId: recentEntryIdForPath(loaded.path) }
    }
  })

  ipcMain.handle(CHANNELS.projectSaveAs, async (event, project: Project) => {
    const savedPath = await saveProjectAs(senderWindow(event), project)
    if (!savedPath) return null
    try {
      const entry = await registerFileProject(savedPath, project, { touchOpened: true })
      return { path: savedPath, entryId: entry.id }
    } catch (error) {
      console.warn(`[recent] 登记另存工程失败：${String(error)}`)
      return { path: savedPath, entryId: recentEntryIdForPath(savedPath) }
    }
  })

  /** CLI：保存到显式路径（不弹对话框），并尽量登记最近工程。 */
  ipcMain.handle(
    CHANNELS.projectWriteToPath,
    async (_event, target: string, project: Project): Promise<SaveProjectResult> => {
      if (typeof target !== 'string' || target.length === 0) throw new Error('缺少工程保存路径')
      const savedPath = await writeProjectFile(target, project)
      try {
        const entry = await registerFileProject(savedPath, project, { touchOpened: true })
        return { path: savedPath, entryId: entry.id }
      } catch (error) {
        console.warn(`[recent] 登记 CLI 保存工程失败：${String(error)}`)
        return { path: savedPath, entryId: recentEntryIdForPath(savedPath) }
      }
    }
  )

  ipcMain.handle(CHANNELS.projectAutosaveRead, async () => autosaveRead())

  ipcMain.handle(CHANNELS.projectAutosaveWrite, async (_event, project: Project, entryId?: string | null) => {
    // 自动存档本身保持原有失败语义（渲染侧需要知道落盘失败）
    await autosaveWrite(project)
    // 历史登记是附加能力：任何异常只记日志，绝不向渲染侧抛出
    try {
      await setAutosaveOwner(entryId ?? null)
      if (entryId == null) {
        await registerAutosaveProject(project)
      } else if (entryId === AUTOSAVE_ENTRY_ID) {
        await updateEntryFromProject(AUTOSAVE_ENTRY_ID, project, { touchModified: true })
      } else {
        await updateEntryFromProject(entryId, project, { touchModified: true })
      }
    } catch (error) {
      console.warn(`[recent] 自动保存历史更新失败：${String(error)}`)
    }
  })

  // ---------------------------------------------------------------- 最近工程（启动页）
  ipcMain.handle(CHANNELS.projectRecentList, async () => listRecentProjects())

  ipcMain.handle(CHANNELS.projectRecentCreate, async () => createRecentProject())

  ipcMain.handle(CHANNELS.projectRecentOpen, async (_event, id: string) =>
    openRecentProject(String(id))
  )

  ipcMain.handle(CHANNELS.projectRecentRename, async (_event, id: string, name: string) =>
    renameRecentProject(String(id), String(name))
  )

  ipcMain.handle(CHANNELS.projectRecentRemove, async (_event, id: string) => removeRecentProject(String(id)))

  /**
   * 拍封面：渲染侧量到预览画面矩形（CSS 像素 / DIP），主进程按内容区裁剪后
   * 走 capturePage；任何裁剪越界都夹紧，过小/空白帧返回 null（拍封面是尽力而为）。
   */
  ipcMain.handle(
    CHANNELS.projectRecentCaptureCover,
    async (event, id: string, rect: CoverCaptureRect): Promise<string | null> => {
      try {
        if (typeof id !== 'string' || !RECENT_ENTRY_ID_PATTERN.test(id)) return null
        if (!isCaptureRect(rect)) return null
        const window = BrowserWindow.fromWebContents(event.sender)
        if (!window) return null

        const size = window.getContentSize()
        const contentWidth = size[0] ?? 0
        const contentHeight = size[1] ?? 0
        if (contentWidth <= 0 || contentHeight <= 0) return null
        const x = Math.max(0, Math.min(Math.floor(rect.x), contentWidth - 1))
        const y = Math.max(0, Math.min(Math.floor(rect.y), contentHeight - 1))
        const width = Math.min(Math.floor(rect.width), contentWidth - x)
        const height = Math.min(Math.floor(rect.height), contentHeight - y)
        if (width < 16 || height < 16) return null

        const image = await window.webContents.capturePage({
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height)
        })
        if (image.isEmpty()) return null
        return await saveRecentCover(id, new Uint8Array(image.toPNG()))
      } catch (error) {
        console.warn(`[recent] 封面截取失败：${String(error)}`)
        return null
      }
    }
  )

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

  /** v2：素材移出池时回收缩略图、时间帧预览条与频谱取样（userData/thumbs 与 userData/strips）。 */
  ipcMain.handle(CHANNELS.mediaThumbRemove, async (_event, mediaId: string): Promise<void> => {
    if (typeof mediaId === 'string' && mediaId.length > 0) {
      await removeThumbnail(mediaId)
      // 预览条是按「素材+区间+格数」命名的，只能按 mediaId 前缀整批回收
      await removeStripsFor(mediaId)
      // 频谱取样只活在内存里（同一口径：按 mediaId 前缀整批回收）
      removePeaksFor(mediaId)
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

  /**
   * v9：频谱条幅度取样。不可用（无音轨 / 源不在 / FFmpeg 缺失）时 `peaks: []`，
   * 卡片不画柱子；一次取样失败绝不影响时间轴拖拽与剪辑。
   */
  ipcMain.handle(CHANNELS.mediaAudioPeaks, async (_event, request: AudioPeaksRequest): Promise<AudioPeaksResult> => {
    if (typeof request !== 'object' || request === null) {
      return { peaks: [], buckets: 0, key: 'invalid', cached: false, hasAudio: false }
    }
    return generateAudioPeaks(request)
  })

  /**
   * v10：4K / MXF 预览代理：后台整片转码 720p H.264，进度/结果经 job 事件流；
   * 命中磁盘缓存时不起子进程直接返回路径。受理失败（非视频/源不在/FFmpeg 缺失）抛错给渲染侧。
   */
  ipcMain.handle(CHANNELS.mediaProxy, async (event, request: MediaProxyRequest): Promise<MediaProxyResult> => {
    if (typeof request !== 'object' || request === null) throw new Error('缺少预览代理请求参数')
    return applyMediaProxy(request, senderWindow(event))
  })

  /** v10：代理新鲜度查询（不写盘、不起进程，只 stat 源与候选产物）。 */
  ipcMain.handle(
    CHANNELS.mediaProxyStatus,
    async (_event, request: MediaProxyRequest): Promise<MediaProxyStatusResult> => {
      if (typeof request !== 'object' || request === null) {
        return { fresh: false, path: null, signature: '' }
      }
      return statusMediaProxy(request)
    }
  )

  /** v10：素材移出池时回收它的全部代理版本（同时取消在跑作业，不留半成品）。 */
  ipcMain.handle(CHANNELS.mediaProxyRemove, async (_event, mediaId: string): Promise<void> => {
    if (typeof mediaId === 'string' && mediaId.length > 0) await removeMediaProxy(mediaId)
  })

  ipcMain.handle(CHANNELS.videoCfrConvert, async (event, target: string, fps: Fps, meta: VideoMeta) => {
    const job = await convertToCfr(String(target), fps, meta, senderWindow(event))
    return job
  })

  /**
   * v8.1：防抖预览代理：后台两段式作业（运动检测 → 代理转码），进度/结果经 job 事件流；
   * 命中磁盘缓存时不起子进程直接返回路径。受理失败（未开启/区间脏/源不在/FFmpeg 缺失）抛错给渲染侧。
   */
  ipcMain.handle(CHANNELS.videoStabPreview, async (event, request: StabPreviewRequest): Promise<StabPreviewResult> => {
    if (typeof request !== 'object' || request === null) throw new Error('缺少防抖预览请求参数')
    return applyStabPreview(request, senderWindow(event))
  })

  /** v8.1：片段删除/关闭防抖时回收它的代理与运动数据（userData/stab-preview 按 clipId 前缀）。 */
  ipcMain.handle(CHANNELS.videoStabPreviewRemove, async (_event, clipId: string): Promise<void> => {
    if (typeof clipId === 'string' && clipId.length > 0) await removeStabPreviewForClip(clipId)
  })

  // ---------------------------------------------------------------- 水印

  /** 选一张本机图片作水印：主进程探测原图尺寸（几何换算的唯一输入）后交给渲染侧写入工程。 */
  ipcMain.handle(CHANNELS.watermarkPick, async (event) => pickAndProbeWatermark(senderWindow(event)))

  /** CLI：按显式路径探测水印图片尺寸（不弹对话框）。 */
  ipcMain.handle(CHANNELS.watermarkProbe, async (_event, target: string) => {
    if (typeof target !== 'string' || target.length === 0) throw new Error('缺少水印图片路径')
    const stat = await fs.stat(target).catch(() => null)
    if (!stat?.isFile() || stat.size === 0) throw new Error(`图片不可读：${target}`)
    return probeImageSize(target)
  })

  // ---------------------------------------------------------------- 渲染显卡
  ipcMain.handle(CHANNELS.gpuDiagnostics, async (): Promise<GpuDiagnostics> => getGpuDiagnostics())

  ipcMain.handle(
    CHANNELS.gpuSetPreference,
    async (_event, preference: unknown): Promise<{ settings: RenderSettings; restartRequired: boolean }> => {
      if (preference !== 'auto' && preference !== 'high-performance' && preference !== 'low-power') {
        throw new Error('无效的显卡偏好')
      }
      const settings = saveRenderSettings({ ...getRenderSettings(), gpuPreference: preference })
      return { settings, restartRequired: preference !== getStartupPreference() }
    }
  )

  ipcMain.handle(CHANNELS.gpuSetEncoder, async (_event, mode: unknown): Promise<RenderSettings> => {
    if (mode !== 'auto' && mode !== 'software') throw new Error('无效的编码模式')
    return saveRenderSettings({ ...getRenderSettings(), videoEncoder: mode })
  })

  ipcMain.handle(CHANNELS.exportCancel, async (_event, jobId: string) => {
    await engine.cancel(String(jobId))
    await cancelCfr(String(jobId))
    // v8.1：防抖预览作业与导出共用取消入口（jobId 前缀 stab-，不在 engine 注册表里自然无副作用）
    await cancelStabPreview(String(jobId))
    // v10：预览代理作业（jobId 前缀 proxy-）同一取消入口；未命中注册表时无副作用
    await cancelMediaProxy(String(jobId))
  })

  // ---------------------------------------------------------------- 导出
  ipcMain.handle(CHANNELS.exportEstimate, async (_event, input: EstimateInput) => engine.estimate(input))

  /** v10：封面帧 PNG（媒体层 + 透明字幕 + 水印）；不占导出队列，单次子进程。 */
  ipcMain.handle(CHANNELS.exportCover, async (_event, request: CoverExportRequest) => exportCover(request))

  ipcMain.handle(CHANNELS.exportStart, async (event, request: ExportRequest) => {
    const window = senderWindow(event)
    if (!window) throw new Error('窗口不可用')
    return engine.submit(request, window)
  })
}
