import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS } from '../shared/ipcChannels'
import type {
  AudioPeaksRequest,
  AudioPeaksResult,
  CoverExportRequest,
  CoverExportResult,
  ExportRequest,
  FontRecord,
  FrameEnd,
  FrameRequest,
  FrameResponse,
  Fps,
  JobProgress,
  JobResult,
  MediaProxyRequest,
  MediaProxyResult,
  MediaProxyStatusResult,
  MediaStripRequest,
  MediaStripResult,
  Project,
  StabPreviewRequest,
  StabPreviewResult,
  VideoMeta
} from '../shared/types'
import type { EstimateInput, SmokeReport, WatermarkPickResult, CoverCaptureRect, NewProjectResult, OpenProjectResult, SaveProjectResult } from '../shared/api'
import type { GpuPreference, VideoEncoderMode } from '../shared/gpu'
import type { RecentProjectCard } from '../shared/recentProjects'

/**
 * preload：把主进程能力以最小面暴露给渲染进程（contextIsolation，零 Node 泄露）。
 * 不做任何业务判断——门禁、布局、渲染都在渲染进程。
 */

function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  app: {
    info: () => ipcRenderer.invoke(CHANNELS.appInfo),
    chooseDirectory: (title?: string) => ipcRenderer.invoke(CHANNELS.chooseDirectory, title),
    revealPath: (targetPath: string) => ipcRenderer.invoke(CHANNELS.revealPath, targetPath),
    writeLog: (level: 'info' | 'warn' | 'error', message: string) =>
      ipcRenderer.invoke(CHANNELS.writeLog, level, message),
    smokeReport: (report: SmokeReport) => ipcRenderer.invoke(CHANNELS.smokeReport, report),
    writeFileDev: (filePath: string, bytes: Uint8Array) =>
      ipcRenderer.invoke(CHANNELS.devWriteFile, filePath, bytes) as Promise<number>,
    readFileDev: (filePath: string) => ipcRenderer.invoke(CHANNELS.devReadFile, filePath) as Promise<Uint8Array | null>
  },
  project: {
    open: () => ipcRenderer.invoke(CHANNELS.projectOpen) as Promise<OpenProjectResult | null>,
    saveAs: (project: Project) =>
      ipcRenderer.invoke(CHANNELS.projectSaveAs, project) as Promise<SaveProjectResult | null>,
    autosaveRead: () => ipcRenderer.invoke(CHANNELS.projectAutosaveRead),
    /**
     * entryId 是当前工程在最近工程索引里的身份：
     * - 文件工程传它的 entryId：这次自动保存把 modifiedAt 记到那条记录上；
     * - 未另存的新工程传 null：主进程维护固定的 'autosave' 草稿卡片。
     */
    autosaveWrite: (project: Project, entryId?: string | null) =>
      ipcRenderer.invoke(CHANNELS.projectAutosaveWrite, project, entryId ?? null),

    /** 启动页：按最近使用倒序返回 */
    recentList: () => ipcRenderer.invoke(CHANNELS.projectRecentList) as Promise<RecentProjectCard[]>,
    /** 新建日期命名工程（同名自动加中文序号） */
    createNew: () => ipcRenderer.invoke(CHANNELS.projectRecentCreate) as Promise<NewProjectResult>,
    /** 按索引 id 打开（文件工程读文件，'autosave' 读自动存档） */
    openRecent: (id: string) =>
      ipcRenderer.invoke(CHANNELS.projectRecentOpen, id) as Promise<OpenProjectResult | null>,
    /** 自定义名称：写回工程文件/自动存档，返回更新后的卡片 */
    renameRecent: (id: string, name: string) =>
      ipcRenderer.invoke(CHANNELS.projectRecentRename, id, name) as Promise<RecentProjectCard | null>,
    /** 只移出最近列表（不删除工程文件；'autosave' 会连同草稿一起丢弃） */
    removeRecent: (id: string) => ipcRenderer.invoke(CHANNELS.projectRecentRemove, id),
    /** 把预览画面截成封面；成功返回 focusnews-cover:// 地址 */
    captureCover: (id: string, rect: CoverCaptureRect) =>
      ipcRenderer.invoke(CHANNELS.projectRecentCaptureCover, id, rect) as Promise<string | null>
  },
  fonts: {
    list: () => ipcRenderer.invoke(CHANNELS.fontsList) as Promise<FontRecord[]>,
    import: () => ipcRenderer.invoke(CHANNELS.fontImport),
    readBytes: (fontId: string) => ipcRenderer.invoke(CHANNELS.fontReadBytes, fontId) as Promise<ArrayBuffer>,
    remove: (fontId: string) => ipcRenderer.invoke(CHANNELS.fontRemove, fontId)
  },
  video: {
    pickAndProbe: () => ipcRenderer.invoke(CHANNELS.videoPickAndProbe),
    pickManyAndProbe: () =>
      ipcRenderer.invoke(CHANNELS.videoPickManyAndProbe) as Promise<
        { path: string; probe: import('../shared/types').VideoProbeResult }[]
      >,
    probe: (path: string) => ipcRenderer.invoke(CHANNELS.videoProbe, path),
    exists: (path: string) => ipcRenderer.invoke(CHANNELS.videoExists, path) as Promise<boolean>,
    previewUrl: (path: string) => ipcRenderer.invoke(CHANNELS.videoPreviewUrl, path) as Promise<string | null>,
    cfrConvert: (path: string, fps: Fps, meta: VideoMeta) =>
      ipcRenderer.invoke(CHANNELS.videoCfrConvert, path, fps, meta),
    /**
     * v8.1：防抖预览代理：后台两段式作业（进度经 job.onProgress/onResult，jobId 前缀 stab-），
     * 命中磁盘缓存不起子进程。
     */
    stabPreview: (request: StabPreviewRequest) =>
      ipcRenderer.invoke(CHANNELS.videoStabPreview, request) as Promise<StabPreviewResult>,
    /** v8.1：片段删除/关闭防抖时回收它的代理文件 */
    stabPreviewRemove: (clipId: string) =>
      ipcRenderer.invoke(CHANNELS.videoStabPreviewRemove, clipId) as Promise<void>
  },
  watermark: {
    /** 选一张本机图片作水印，主进程探测原图尺寸（用户取消 null） */
    pick: () => ipcRenderer.invoke(CHANNELS.watermarkPick) as Promise<WatermarkPickResult | null>
  },
  gpu: {
    /** 渲染显卡体检：设备清单 / 当前使用 / 可用硬件编码器 */
    diagnostics: () => ipcRenderer.invoke(CHANNELS.gpuDiagnostics),
    /** 保存渲染显卡偏好（Chromium 开关需重启生效） */
    setPreference: (preference: GpuPreference) =>
      ipcRenderer.invoke(CHANNELS.gpuSetPreference, preference),
    /** 保存导出编码模式（自动硬件编码 / 仅软件） */
    setEncoder: (mode: VideoEncoderMode) => ipcRenderer.invoke(CHANNELS.gpuSetEncoder, mode)
  },
  media: {
    /** v2：主进程 ffmpeg 抽帧缩略图，返回 focusnews-thumb://<mediaId>（失败 null） */
    generateThumb: (mediaId: string, videoPath: string, atSec?: number) =>
      ipcRenderer.invoke(CHANNELS.mediaGenerateThumb, mediaId, videoPath, atSec) as Promise<string | null>,
    /** v2：工程里持久化的 thumb 地址重新登记（主进程重启后 registry 为空） */
    thumbUrl: (mediaId: string, url: string) =>
      ipcRenderer.invoke(CHANNELS.mediaThumbUrl, mediaId, url) as Promise<string | null>,
    /** v2：素材移出池时回收缩略图文件 */
    removeThumb: (mediaId: string) => ipcRenderer.invoke(CHANNELS.mediaThumbRemove, mediaId) as Promise<void>,
    /**
     * v5：时间帧预览条（Thumbnail Strip）。主进程一次抽帧并拼成一张长图，
     * 命中磁盘缓存不起子进程；失败时 url=null，卡片显示占位符。
     */
    strip: (request: MediaStripRequest) =>
      ipcRenderer.invoke(CHANNELS.mediaGenerateStrip, request) as Promise<MediaStripResult>,
    /**
     * v9：频谱条取样（主进程折好的等分桶峰值）。
     * 不可用时 peaks=[]，卡片不画频谱条而不是抛错。
     */
    peaks: (request: AudioPeaksRequest) =>
      ipcRenderer.invoke(CHANNELS.mediaAudioPeaks, request) as Promise<AudioPeaksResult>,
    /**
     * v10：4K / MXF 预览代理：后台整片转码 720p H.264（进度/结果经 job 事件流，
     * jobId 前缀 proxy-）；命中磁盘缓存时 status='cached' 直接给路径、不起子进程。
     */
    proxy: (request: MediaProxyRequest) =>
      ipcRenderer.invoke(CHANNELS.mediaProxy, request) as Promise<MediaProxyResult>,
    /** v10：代理新鲜度查询（源 size/mtime 变化即失效） */
    proxyStatus: (request: MediaProxyRequest) =>
      ipcRenderer.invoke(CHANNELS.mediaProxyStatus, request) as Promise<MediaProxyStatusResult>,
    /** v10：素材移出池时回收它的全部代理版本 */
    removeProxy: (mediaId: string) =>
      ipcRenderer.invoke(CHANNELS.mediaProxyRemove, mediaId) as Promise<void>
  },
  export: {
    estimate: (input: EstimateInput) => ipcRenderer.invoke(CHANNELS.exportEstimate, input),
    start: (request: ExportRequest) => ipcRenderer.invoke(CHANNELS.exportStart, request),
    cancel: (jobId: string) => ipcRenderer.invoke(CHANNELS.exportCancel, jobId),
    cover: (request: CoverExportRequest) =>
      ipcRenderer.invoke(CHANNELS.exportCover, request) as Promise<CoverExportResult>,
    onFrameRequest: (handler: (message: FrameRequest | FrameEnd) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, message: FrameRequest | FrameEnd): void => handler(message)
      ipcRenderer.on(CHANNELS.frameRequest, listener)
      return () => ipcRenderer.removeListener(CHANNELS.frameRequest, listener)
    },
    sendFrame: (response: FrameResponse) => {
      ipcRenderer.send(CHANNELS.frameResponse, response)
    }
  },
  job: {
    onProgress: (handler: (progress: JobProgress) => void) => on<JobProgress>(CHANNELS.jobProgress, handler),
    onResult: (handler: (result: JobResult) => void) => on<JobResult>(CHANNELS.jobResult, handler)
  }
}

contextBridge.exposeInMainWorld('focusnews', api)

export type ExposedApi = typeof api
