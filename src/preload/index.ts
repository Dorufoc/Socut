import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS } from '../shared/ipcChannels'
import type {
  ExportRequest,
  FontRecord,
  FrameEnd,
  FrameRequest,
  FrameResponse,
  Fps,
  JobProgress,
  JobResult,
  MediaStripRequest,
  MediaStripResult,
  Project,
  VideoMeta
} from '../shared/types'
import type { EstimateInput, SmokeReport, WatermarkPickResult } from '../shared/api'

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
    open: () => ipcRenderer.invoke(CHANNELS.projectOpen),
    saveAs: (project: Project) => ipcRenderer.invoke(CHANNELS.projectSaveAs, project),
    autosaveRead: () => ipcRenderer.invoke(CHANNELS.projectAutosaveRead),
    autosaveWrite: (project: Project) => ipcRenderer.invoke(CHANNELS.projectAutosaveWrite, project)
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
      ipcRenderer.invoke(CHANNELS.videoCfrConvert, path, fps, meta)
  },
  watermark: {
    /** 选一张本机图片作水印，主进程探测原图尺寸（用户取消 null） */
    pick: () => ipcRenderer.invoke(CHANNELS.watermarkPick) as Promise<WatermarkPickResult | null>
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
      ipcRenderer.invoke(CHANNELS.mediaGenerateStrip, request) as Promise<MediaStripResult>
  },
  export: {
    estimate: (input: EstimateInput) => ipcRenderer.invoke(CHANNELS.exportEstimate, input),
    start: (request: ExportRequest) => ipcRenderer.invoke(CHANNELS.exportStart, request),
    cancel: (jobId: string) => ipcRenderer.invoke(CHANNELS.exportCancel, jobId),
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
