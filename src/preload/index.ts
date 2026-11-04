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
  Project,
  VideoMeta
} from '../shared/types'
import type { EstimateInput, SmokeReport } from '../shared/api'

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
    probe: (path: string) => ipcRenderer.invoke(CHANNELS.videoProbe, path),
    exists: (path: string) => ipcRenderer.invoke(CHANNELS.videoExists, path) as Promise<boolean>,
    previewUrl: (path: string) => ipcRenderer.invoke(CHANNELS.videoPreviewUrl, path) as Promise<string | null>,
    cfrConvert: (path: string, fps: Fps, meta: VideoMeta) =>
      ipcRenderer.invoke(CHANNELS.videoCfrConvert, path, fps, meta)
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
