import type {
  AudioPeaksRequest,
  AudioPeaksResult,
  CompatFlags,
  CoverExportRequest,
  CoverExportResult,
  ExportKind,
  ExportRequest,
  Fps,
  FontRecord,
  FrameEnd,
  FrameRequest,
  FrameResponse,
  FreezeFrameRequest,
  FreezeFrameResult,
  JobProgress,
  JobResult,
  MediaProxyRequest,
  MediaProxyResult,
  MediaProxyStatusResult,
  MediaStripRequest,
  MediaStripResult,
  Project,
  SizeEstimate,
  StabPreviewRequest,
  StabPreviewResult,
  VideoMeta,
  VideoProbeResult
} from './types'
import type { RecentProjectCard } from './recentProjects'
import type { GpuDiagnostics, GpuPreference, RenderSettings, VideoEncoderMode } from './gpu'
import type { CliCommandRequest, CliResponse } from './cliProtocol'
import type { WhisperSegment } from './whisper'

/** preload 暴露给渲染进程的唯一 API 面（contextIsolation，零 Node 泄露）。 */

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  platform: string
  packaged: boolean
  ffmpegVersion: string
  ffmpegPath: string
  ffprobePath: string
  /** 随包还是开发环境的系统 FFmpeg（后者必须在 UI 明示） */
  ffmpegSource: string
  ffmpegAvailable: boolean
  ffmpegHint: string
  userDataPath: string
  /** 用户导入字体的持久目录 */
  fontsPath: string
  /** 启动自检发现的预设校验问题（正常应为空数组） */
  presetIssues: string[]
  title: string
  appName: string
  /** 应用内端到端冒烟模式（SOCUT_SMOKE=1，仅开发） */
  smoke: SmokeConfig | null
  /** 逐帧动画评审表输出路径（SOCUT_REVIEW_SHEET，仅开发；null 表示不生成） */
  reviewSheet: string | null
  /** 评审表背景帧 PNG（SOCUT_REVIEW_BACKDROP，仅开发） */
  reviewBackdrop: string | null
  /** 预览/导出逐像素一致性回归报告输出路径（SOCUT_PIXELCHECK，仅开发，M1-7） */
  pixelCheck: string | null
  /** 错误呈现取证报告输出路径（SOCUT_SHOT_ERROR，仅开发，M4-2）：发起一次必然失败的导出 */
  errorDemo: string | null
  /** 参考视频缺失取证（SOCUT_SHOT_REFMISSING=<可探到的参考视频路径>，仅开发）：
   * 借用它的元数据但把路径指向不存在的文件，让完整性检查弹出重新定位模态 */
  refMissingDemo: string | null
  /** 视觉检查报告路径（SOCUT_VISUAL_CHECK，仅开发；null 表示不运行） */
  visualCheck: string | null
}

export interface SmokeConfig {
  /** 产物与报告输出目录（主件已知） */
  outputDir: string
  width: number
  height: number
  fps: Fps
  /** 时间轴总时长（秒） */
  durationSec: number
  /**
   * export：跑完完整导出并校验产物（验收第 2/3 条）
   * cancel：导出中途取消，校验无孤儿子进程、半成品与临时目录已清理（验收第 8 条）
   * overlay：MP4 叠加压制（验收第 4/5/6 条），需要 refVideoPath
   * gate：非 16:9 / HDR / VFR 门禁端到端取证（验收第 5/6 条），需要 fixtureDir
   */
  scenario: 'export' | 'cancel' | 'overlay' | 'gate'
  /** overlay 场景的参考视频绝对路径 */
  refVideoPath: string | null
  /** gate 场景的夹具目录（make-probe-fixtures 的中间视频所在处） */
  fixtureDir: string | null
  /**
   * export/cancel 场景的出口类型（SOCUT_SMOKE_KIND）。
   * pngSequence 是计划里的第三个出口，也是取消时唯一按**目录**清理半成品的分支，
   * 两者都必须能跑与能回收，不能只证透明 MOV。
   */
  exportKind: 'transparentMov' | 'pngSequence'
  /**
   * overlay 场景：跳过音频预检、强制走 `-c:a copy`。
   * 用来取证验收第 7 条后半句：copy 运行期失败 → 只重试一次 AAC 并提示用户
   *（配 alac 音轨的参考视频才能稳复现）。
   */
  forceCopyAudio: boolean
}

/** 渲染侧冒烟完成后上报的事实（主件负责用 ffprobe 交叉校验）。 */
export interface SmokeReport {
  jobId: string
  outputPath: string
  framesTotal: number
  elapsedMs: number
  bytesWritten: number
  /** 导出结果快照 */
  ok: boolean
  scenario: 'export' | 'cancel' | 'overlay' | 'gate'
  /** 取消场景：上报时已经交付的帧数（证明是在中途取消而非跑完） */
  framesDoneBeforeCancel?: number
  /** overlay 场景：应用自己声称的字幕区间（秒），由主进程用逐帧 PSNR 实测对拍（验收第 4 条） */
  spanStartSec?: number
  spanEndSec?: number
  /** 首片段入场帧数 / 末片段出场帧数：实测可见区间允许因淡入淡出而比几何区间窄这么多 */
  spanInFrames?: number
  spanOutFrames?: number
  /** 渲染侧帧耗时分解（帧数 / 绘制 ms / PNG 编码 ms / 缓冲池耗尽次数） */
  stats?: Record<string, number>
  /** gate 场景的逐用例事实（主进程再独立复测 CFR 产物） */
  gate?: GateOutcome
  /** 任务过程中的提示（验收第 7 条：音频回退必须让用户看到） */
  notices?: string[]
  errorCode?: string
  errorMessage?: string
  stderrTail?: string
}

/** 门禁取证的逐用例结果（由渲染侧如实上报，主进程交叉复测）。 */
export interface GateCase {
  fixture: string
  /** 期望弹出的模态：non169 / hdr / vfr */
  expectedKind: string
  appearedKind: string | null
  flags: CompatFlags
  /** 未确认时 gateBlocked 应为 true */
  blockedBeforeAck: boolean
  blockedReason: string | null
  /** 选「取消」后应为 null（不写入工程） */
  refAfterCancel: string | null
  refAfterAck: string | null
  vfrPolicyAfterAck: string | null
  sourcePathAfterAck: string | null
  /** 确认后应为 false（门禁放行） */
  blockedAfterAck: boolean
}

export interface GateOutcome {
  cases: GateCase[]
  /** VFR「转换并导入」的 CFR 产物路径，主进程用 ffprobe 断言 r==avg（验收第 6 条） */
  cfrOutputPath: string | null
  /** 渲染侧自己判定的失败项（为空不代表主进程会放行） */
  failures: string[]
}

export interface OpenProjectResult {
  path: string
  project: Project
  /** 最近工程索引里的稳定 id（打开后自动保存与封面都按它记账） */
  entryId: string
}

export interface SaveProjectResult {
  path: string
  entryId: string
}

export interface NewProjectResult {
  entry: RecentProjectCard
  project: Project
}

/** 截取预览画面作为封面时，渲染进程量到的 .stage__frame 矩形（CSS 像素 / DIP） */
export interface CoverCaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PickVideoResult {
  path: string
  probe: VideoProbeResult
}

/** v2 素材库批量导入：多选后逐文件探测；探测失败的文件不在列表里。 */
export type PickManyVideoResult = PickVideoResult[]

/** 水印图片导入结果：主进程用 ffprobe 拿到原图宽高后返回（几何换算的唯一输入）。 */
export interface WatermarkPickResult {
  path: string
  name: string
  sourceWidth: number
  sourceHeight: number
}

/**
 * M8-P0：外部 matte 导入结果（selected = 用户选了文件；取消返回 null）。
 * - 路径一定是绝对路径（工程 JSON 与素材同一惯例）；
 * - kind 由主进程按扩展名给出 image/video，渲染侧直接落库，避免 UI 再猜；
 * - width/height 只有静态图 matte 才有（供检查器显示尺寸，视频不探测元数据）。
 */
/**
 * M8-P1：AI 人像抠像（Selfie Segmenter）请求/结果。
 * 渲染侧只提交「片段源窗口 + 尺寸」；解码/推理/编码/缓存全在主进程。
 */
export interface AiMatteRequest {
  clipId: string
  sourcePath: string
  sourceInSec: number
  sourceOutSec: number
  fps: Fps
  /** 源素材像素宽高（用于推导 matte 输出尺寸：长边 512、偶数） */
  sourceWidth: number
  sourceHeight: number
}

export interface AiMatteJobResult {
  status: 'queued' | 'cached'
  jobId: string
  /** 缓存命中时直接可用；排队时 null（完成后经 jobResult 的 outputs[0] 回传） */
  path: string | null
}

export interface AiMatteStatusResult {
  runtime: { ok: boolean; reason?: string }
  model: { ok: boolean; path: string; sizeBytes?: number; sha256?: string; reason?: string }
  ready: boolean
}

export interface MattePickResult {
  path: string
  name: string
  kind: 'image' | 'video'
  width?: number
  height?: number
}

export interface EstimateInput {
  width: number
  height: number
  fps: Fps
  frames: number
  outputDir: string
  /**
   * 出口类型：叠加 MP4 用 H.264 口径预估（产物约为 ProRes 的 1/20），
   * 其余出口沿用 ProRes 4444 口径。缺省 = transparentMov（旧口径）。
   */
  kind?: ExportKind
  /** 视频码率（kbps）：有值时按码率口径估算，替代 kind 的经验值 */
  videoBitrateKbps?: number
  /** 音频码率（kbps）：缺省按 192 计 */
  audioBitrateKbps?: number
}

export interface Unsubscribe {
  (): void
}

/**
 * M11：渲染侧「自动字幕」的 IPC 面。
 *
 * 转写是**整份媒体文件**上的长任务（主进程先抽 16k WAV 再喂 whisper.cpp），
 * 进度与取消都按渲染侧生成的 `requestId` 配对：面板重复点按/切换选中时，
 * 别的请求的进度不会画到当前进度条上。
 */
export interface CaptionTranscribeRequest {
  /** 渲染侧生成的请求 id（同一时刻只允许一个在跑；用于进度过滤与取消） */
  requestId: string
  /** 要转写的媒体文件绝对路径（通常是选中媒体片段引用的素材） */
  mediaPath: string
  /** 识别语言（zh/en/…；缺省自动检测——中文素材建议显式给 zh，见 M11 真机记录） */
  language?: string
  /** 模型文件覆盖（缺省走 userData/whisper.json 或随包模型） */
  modelPath?: string
}

export interface CaptionProgressEvent {
  requestId: string
  /** 0..100（whisper.cpp 的 progress 百分比；准备抽音阶段恒为 0） */
  percent: number
  stage: 'prepare' | 'transcribe'
}

export interface CaptionTranscribeResult {
  requestId: string
  ok: boolean
  /** 源时间轴（相对媒体文件起点）的 cue；落到工程时间轴前的映射/裁剪由渲染侧负责 */
  cues: WhisperSegment[]
  /** whisper 检测或指定的语言；未知为 null */
  language: string | null
  /** 失败错误码原样透传（WHISPER_BINARY_MISSING / WHISPER_MODEL_MISSING / … / CANCELLED） */
  errorCode: string | null
  errorMessage: string | null
}

/**
 * M11：设置页「语音资产」的展示模型（不改工程、只读主进程状态）。
 *
 * 离线纪律：这里只**呈现**本地资产与候选路径，选择二进制/模型走系统文件对话框
 * （`whisper.pickBinary/pickModel`），应用绝不自行联网下载。
 * RNNoise 模型（M8 AI 降噪）与 whisper 模型同属"离线资产"，一起在这里呈现，
 * 免得用户要在两个页面之间猜自己缺了哪个。
 */
export interface VoiceAssetStatus {
  /** whisper 二进制 + 模型都就绪时才为 true */
  ready: boolean
  binaryPath: string | null
  modelPath: string | null
  /** userData/whisper.json 里保存的语言；null = 自动检测 */
  language: string | null
  /** 配置文件路径（看得见才好排查） */
  configPath: string
  candidates: {
    binaries: string[]
    models: string[]
  }
  /** M8：RNNoise 模型（arnndn AI 降噪用） */
  rnnoise: {
    path: string | null
    candidates: string[]
  }
}

/** whisper 配置补丁：`null` = 清除该项（回到候选探测 / 自动检测）。 */
export interface VoiceAssetPatch {
  binaryPath?: string | null
  modelPath?: string | null
  /** 'auto' 等价于 null（自动检测语言） */
  language?: string | null
  threads?: number | null
}

export interface SocutApi {
  app: {
    info(): Promise<AppInfo>
    chooseDirectory(title?: string): Promise<string | null>
    revealPath(targetPath: string): Promise<void>
    writeLog(level: 'info' | 'warn' | 'error', message: string): Promise<void>
    /** 仅冒烟模式可用：上报后主件校验并退出应用 */
    smokeReport(report: SmokeReport): Promise<void>
    /**
     * 仅开发可用：把渲染侧产出的取证图片写盘（主进程限定目标必须在仓库 spikes/ 下）。
     * 返回写入字节数。
     */
    writeFileDev(filePath: string, bytes: Uint8Array): Promise<number>
    /** 仅开发：读仓库 spikes/ 下的取证素材；不存在时返回 null */
    readFileDev(filePath: string): Promise<Uint8Array | null>
  }
  project: {
    open(): Promise<OpenProjectResult | null>
    saveAs(project: Project): Promise<SaveProjectResult | null>
    /** CLI：保存到显式路径（不弹另存为对话框），并登记最近工程 */
    writeToPath(path: string, project: Project): Promise<SaveProjectResult>
    autosaveRead(): Promise<Project | null>
    /**
     * entryId 是「当前工程在最近工程索引里的身份」：
     * - 文件工程传它的 entryId：这次自动保存把 modifiedAt 记到那条记录上；
     * - 未另存的新工程传 null：主进程维护固定的 'autosave' 草稿卡片。
     */
    autosaveWrite(project: Project, entryId?: string | null): Promise<void>

    /** 启动页数据：按最近使用倒序返回（渲染层可再按名称排序） */
    recentList(): Promise<RecentProjectCard[]>
    /** 新建日期命名工程（同名自动加「（一）」「（二）」），并写入 userData/projects */
    createNew(): Promise<NewProjectResult>
    /** 按索引 id 打开（文件工程读文件，'autosave' 读自动存档） */
    openRecent(id: string): Promise<OpenProjectResult | null>
    /** 自定义名称：同时写回工程文件/自动存档，返回更新后的卡片 */
    renameRecent(id: string, name: string): Promise<RecentProjectCard | null>
    /** 只移出最近列表（不删除工程文件；'autosave' 会连同草稿一起丢弃） */
    removeRecent(id: string): Promise<void>
    /** 把预览画面截成封面；成功返回 socut-cover:// 地址 */
    captureCover(id: string, rect: CoverCaptureRect): Promise<string | null>
  }
  fonts: {
    list(): Promise<FontRecord[]>
    import(): Promise<{ record: FontRecord } | null>
    readBytes(fontId: string): Promise<ArrayBuffer>
    remove(fontId: string): Promise<void>
  }
  video: {
    pickAndProbe(): Promise<PickVideoResult | null>
    /** v2：多文件选择 + 逐文件探测（素材库批量导入） */
    pickManyAndProbe(): Promise<PickManyVideoResult>
    probe(path: string): Promise<VideoProbeResult | null>
    /** 参考视频是否仍在原路径（规格 §8） */
    exists(path: string): Promise<boolean>
    /**
     * 参考视频 / 水印图片预览地址（socut-media://，带 Range 流）：
     * 主进程校验文件存在且是受支持的扩展名后登记；不可用或不支持时返回 null。
     */
    previewUrl(path: string): Promise<string | null>
    /** VFR → CFR，返回 jobId，进度经由 onProgress 上报 */
    cfrConvert(path: string, fps: Fps, meta: VideoMeta): Promise<{ jobId: string; outputPath: string }>
    /**
     * v8.1：防抖预览代理：受理后后台两段式作业（进度/结果经 job 事件流，jobId 前缀 stab-，
     * 完成后 outputs[0] = 代理 mp4）；命中磁盘缓存时 status='cached' 直接给路径、不起子进程。
     */
    stabPreview(request: StabPreviewRequest): Promise<StabPreviewResult>
    /** v8.1：片段删除/关闭防抖时回收它的代理与运动数据 */
    stabPreviewRemove(clipId: string): Promise<void>
  }
  watermark: {
    /** 选一张本机图片作水印并探测原图尺寸；用户取消 null，尺寸不可读时报错 */
    pick(): Promise<WatermarkPickResult | null>
    /** CLI：按显式路径探测图片原始尺寸（不弹对话框） */
    probe(path: string): Promise<{ width: number; height: number }>
  }
  /**
   * 渲染显卡（v11）：枚举核显/独显、选择预览渲染设备（Chromium 开关，重启生效）
   * 与导出编码器模式（硬件 NVENC/QSV/AMF，失败自动回退 libx264）。
   */
  gpu: {
    /** 本机显卡清单 + 当前实际使用 + FFmpeg 可用硬件编码器 */
    diagnostics(): Promise<GpuDiagnostics>
    /** 保存偏好；restartRequired=true 表示需要重启应用才会切换渲染显卡 */
    setPreference(preference: GpuPreference): Promise<{ settings: RenderSettings; restartRequired: boolean }>
    /** 保存导出编码模式（立即生效于下一个导出任务） */
    setEncoder(mode: VideoEncoderMode): Promise<RenderSettings>
  }
  /**
   * M8-P1：AI 人像抠像（主进程 ONNX 推理生成灰度 matte 视频）。
   * `status` 只读体检（运行时/模型是否就绪）；`generate` 入队后经 job 事件流转进度/结果。
   */
  aiMatte: {
    status(): Promise<AiMatteStatusResult>
    generate(request: AiMatteRequest): Promise<AiMatteJobResult>
  }
  media: {
    /** v2：主进程 ffmpeg 抽帧生成素材卡片缩略图，返回 socut-thumb://<mediaId>（失败 null） */
    generateThumb(mediaId: string, videoPath: string, atSec?: number): Promise<string | null>
    /** v2：把工程里持久化的 thumb 地址重新登记回协议（主进程重启后 registry 为空） */
    thumbUrl(mediaId: string, url: string): Promise<string | null>
    /** v2：素材移出池时回收缩略图文件 */
    removeThumb(mediaId: string): Promise<void>
    /**
     * M8-P0：选择外部 matte 文件（图片或视频，用于导出侧 alpha 相乘）。
     * 用户取消返回 null；文件不可读/类型无法判断时抛可读错误（由检查器呈现）。
     */
    pickMatte(): Promise<MattePickResult | null>
    /**
     * M5：冻结帧抽帧（源视频某一时刻 → 全分辨率 PNG，落 userData/freezes）。
     * 失败时 path=null；调用方负责提示并回退（不抛错）。
     */
    extractFrame(request: FreezeFrameRequest): Promise<FreezeFrameResult>
    /**
     * v5：时间帧预览条（Thumbnail Strip）：主进程按源区间均匀抽帧并 tile 拼成一张长图，
     * 命中磁盘缓存不起子进程；不可用时 url=null（渲染层显示「无法预览」占位）。
     */
    strip(request: MediaStripRequest): Promise<MediaStripResult>
    /**
     * v9：频谱条幅度取样。主进程把 `[sourceInSec, sourceOutSec]` 解成单声道 PCM
     * 并折成等分桶峰值（0..1）；无音轨 / 不可用时 `peaks` 为空数组，卡片不画频谱条。
     */
    peaks(request: AudioPeaksRequest): Promise<AudioPeaksResult>
    /**
     * v10：4K / MXF 预览代理（整片 720p H.264；进度/结果经 job 事件流，jobId 前缀 proxy-）。
     * 命中磁盘缓存时 status='cached' 直接给路径、不起子进程。
     */
    proxy(request: MediaProxyRequest): Promise<MediaProxyResult>
    /** v10：代理新鲜度查询（源 size/mtime 变化即失效，渲染侧据此回落原片） */
    proxyStatus(request: MediaProxyRequest): Promise<MediaProxyStatusResult>
    /** v10：素材移出池时回收它的全部代理版本 */
    removeProxy(mediaId: string): Promise<void>
  }
  export: {
    estimate(input: EstimateInput): Promise<SizeEstimate>
    start(request: ExportRequest): Promise<{ jobId: string }>
    cancel(jobId: string): Promise<void>
    cover(request: CoverExportRequest): Promise<CoverExportResult>
    /** 主进程 pull 第 N 帧（或任务结束通知） */
    onFrameRequest(handler: (message: FrameRequest | FrameEnd) => void): Unsubscribe
    /** 回传一帧 PNG 字节 */
    sendFrame(response: FrameResponse): void
  }
  job: {
    onProgress(handler: (progress: JobProgress) => void): Unsubscribe
    onResult(handler: (result: JobResult) => void): Unsubscribe
  }
  /**
   * M11：自动字幕（whisper.cpp）——启动转写 / 进度订阅 / 取消。
   * 错误码（二进制缺失/模型缺失/媒体缺失/抽音失败/已取消等）原样透传，不抛异常。
   */
  caption: {
    transcribe(request: CaptionTranscribeRequest): Promise<CaptionTranscribeResult>
    onProgress(handler: (progress: CaptionProgressEvent) => void): Unsubscribe
    /** 按 requestId 取消；没有在跑的请求时返回 false */
    cancel(requestId: string): Promise<boolean>
  }
  /**
   * M11：设置页「语音资产」（whisper 二进制/模型 + RNNoise 模型）。
   * 只读状态 + 本地文件选择 + 配置落盘；不联网、不下载。
   */
  whisper: {
    /** 当前资产状态（二进制/模型/语言/候选路径 + RNNoise 模型） */
    status(): Promise<VoiceAssetStatus>
    /** 保存配置并返回最新状态；路径不存在时主进程直接拒绝（抛错给面板显示） */
    saveConfig(patch: VoiceAssetPatch): Promise<VoiceAssetStatus>
    /** 弹文件框挑 whisper 二进制（用户取消返回 null；不落配置） */
    pickBinary(): Promise<string | null>
    /** 弹文件框挑 ggml 模型（用户取消返回 null；不落配置） */
    pickModel(): Promise<string | null>
    /** 清除已保存配置（回到候选探测） */
    reset(): Promise<VoiceAssetStatus>
  }
  /**
   * CLI 控制面（主进程本地 HTTP 服务 → 渲染进程）：
   * 渲染进程注册命令路由后调用 ready()，主进程才开始转发外部命令。
   */
  cli: {
    onCommand(handler: (request: CliCommandRequest) => void): Unsubscribe
    respond(id: string, response: CliResponse): void
    ready(): void
  }
}

declare global {
  interface Window {
    socut: SocutApi
  }
}
