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
  FreezeFrameRequest,
  FreezeFrameResult,
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
import type { EstimateInput, SmokeReport, WatermarkPickResult, MattePickResult, AiMatteRequest, AiMatteJobResult, AiMatteStatusResult, CoverCaptureRect, NewProjectResult, OpenProjectResult, SaveProjectResult, CaptionTranscribeRequest, CaptionProgressEvent, CaptionTranscribeResult, VoiceAssetPatch, VoiceAssetStatus } from '../shared/api'
import type { GpuPreference, VideoEncoderMode } from '../shared/gpu'
import type { RecentProjectCard } from '../shared/recentProjects'
import type { CliCommandRequest, CliResponse } from '../shared/cliProtocol'

/**
 * preload：把主进程能力以最小面暴露给渲染进程（contextIsolation，零 Node 泄露）。
 * 不做任何业务判断——门禁、布局、渲染都在渲染进程。
 */

function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * CLI 命令在渲染侧注册路由之前就可能到达（窗口还在 React 挂载）。
 * preload 先接住并排队，等 onCommand 注册后一次性回放——否则命令会被静默丢掉。
 */
const pendingCliCommands: CliCommandRequest[] = []
let cliCommandHandler: ((request: CliCommandRequest) => void) | null = null

ipcRenderer.on(CHANNELS.cliCommand, (_event, request: CliCommandRequest) => {
  if (cliCommandHandler) cliCommandHandler(request)
  else pendingCliCommands.push(request)
})

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
    /** CLI：保存到显式路径（主进程原子写 + 最近工程登记） */
    writeToPath: (path: string, project: Project) =>
      ipcRenderer.invoke(CHANNELS.projectWriteToPath, path, project) as Promise<SaveProjectResult>,
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
    /** 把预览画面截成封面；成功返回 socut-cover:// 地址 */
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
    pick: () => ipcRenderer.invoke(CHANNELS.watermarkPick) as Promise<WatermarkPickResult | null>,
    /** CLI：按显式路径探测图片原始尺寸 */
    probe: (path: string) =>
      ipcRenderer.invoke(CHANNELS.watermarkProbe, path) as Promise<{ width: number; height: number }>
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
  aiMatte: {
    /** M8-P1：运行时/模型体检（未安装/缺模型 → ready=false + 可读 reason） */
    status: () => ipcRenderer.invoke(CHANNELS.aiMatteStatus) as Promise<AiMatteStatusResult>,
    /** M8-P1：生成 AI matte（jobId 前缀 matte-；进度/结果走 job 事件） */
    generate: (request: AiMatteRequest) =>
      ipcRenderer.invoke(CHANNELS.aiMatteGenerate, request) as Promise<AiMatteJobResult>
  },
  media: {
    /** v2：主进程 ffmpeg 抽帧缩略图，返回 socut-thumb://<mediaId>（失败 null） */
    generateThumb: (mediaId: string, videoPath: string, atSec?: number) =>
      ipcRenderer.invoke(CHANNELS.mediaGenerateThumb, mediaId, videoPath, atSec) as Promise<string | null>,
    /** v2：工程里持久化的 thumb 地址重新登记（主进程重启后 registry 为空） */
    thumbUrl: (mediaId: string, url: string) =>
      ipcRenderer.invoke(CHANNELS.mediaThumbUrl, mediaId, url) as Promise<string | null>,
    /** v2：素材移出池时回收缩略图文件 */
    removeThumb: (mediaId: string) => ipcRenderer.invoke(CHANNELS.mediaThumbRemove, mediaId) as Promise<void>,
    /** M8-P0：选择外部 matte（图片/视频）；取消返回 null，类型由主进程按扩展名判定 */
    pickMatte: () => ipcRenderer.invoke(CHANNELS.mediaPickMatte) as Promise<MattePickResult | null>,
    /**
     * M5：冻结帧抽帧。源视频某一时刻 → 全分辨率 PNG（userData/freezes），
     * 返回绝对路径与尺寸；不可用时 path=null（渲染层提示，不抛错）。
     */
    extractFrame: (request: FreezeFrameRequest) =>
      ipcRenderer.invoke(CHANNELS.mediaExtractFrame, request) as Promise<FreezeFrameResult>,
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
  },
  caption: {
    /**
     * M11：启动一次 whisper.cpp 转写（长任务）。
     * 失败不抛异常：错误码/可读消息在返回值的 errorCode/errorMessage 里原样透传。
     */
    transcribe: (request: CaptionTranscribeRequest) =>
      ipcRenderer.invoke(CHANNELS.captionTranscribe, request) as Promise<CaptionTranscribeResult>,
    /** 订阅转写进度（payload.requestId 由调用方过滤）；返回取消订阅函数 */
    onProgress: (handler: (progress: CaptionProgressEvent) => void) =>
      on<CaptionProgressEvent>(CHANNELS.captionProgress, handler),
    /** 按 requestId 取消在跑的转写；没有该请求时 resolve false */
    cancel: (requestId: string) =>
      ipcRenderer.invoke(CHANNELS.captionCancel, requestId) as Promise<boolean>
  },
  whisper: {
    /** M11：语音资产状态（whisper 二进制/模型 + RNNoise 模型 + 候选路径） */
    status: () => ipcRenderer.invoke(CHANNELS.whisperStatus) as Promise<VoiceAssetStatus>,
    /** 保存配置（`null` 清除该项）；路径不存在时主进程抛错（错误码原样透传） */
    saveConfig: (patch: VoiceAssetPatch) =>
      ipcRenderer.invoke(CHANNELS.whisperSaveConfig, patch) as Promise<VoiceAssetStatus>,
    /** 系统文件框挑 whisper 二进制；用户取消返回 null（不落配置） */
    pickBinary: () => ipcRenderer.invoke(CHANNELS.whisperPickBinary) as Promise<string | null>,
    /** 系统文件框挑 ggml 模型；用户取消返回 null（不落配置） */
    pickModel: () => ipcRenderer.invoke(CHANNELS.whisperPickModel) as Promise<string | null>,
    /** 清除已保存配置（回到候选探测） */
    reset: () => ipcRenderer.invoke(CHANNELS.whisperReset) as Promise<VoiceAssetStatus>
  },
  cli: {
    /**
     * 注册命令路由并回放 preload 期间排队的命令。
     * 注册即视为就绪：主进程收到 cli:ready 后才开始转发外部命令。
     */
    onCommand: (handler: (request: CliCommandRequest) => void): (() => void) => {
      cliCommandHandler = handler
      while (pendingCliCommands.length > 0) {
        const request = pendingCliCommands.shift()
        if (request) handler(request)
      }
      ipcRenderer.send(CHANNELS.cliReady)
      return () => {
        if (cliCommandHandler === handler) cliCommandHandler = null
      }
    },
    respond: (id: string, response: CliResponse) => {
      ipcRenderer.send(CHANNELS.cliResponse, { id, response })
    },
    ready: () => {
      ipcRenderer.send(CHANNELS.cliReady)
    }
  }
}

contextBridge.exposeInMainWorld('socut', api)

export type ExposedApi = typeof api
