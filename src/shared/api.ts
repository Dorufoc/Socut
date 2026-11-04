import type {
  CompatFlags,
  ExportRequest,
  Fps,
  FontRecord,
  FrameEnd,
  FrameRequest,
  FrameResponse,
  JobProgress,
  JobResult,
  Project,
  SizeEstimate,
  VideoMeta,
  VideoProbeResult
} from './types'

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
  /** 应用内端到端冒烟模式（FOCUSNEWS_SMOKE=1，仅开发） */
  smoke: SmokeConfig | null
  /** 逐帧动画评审表输出路径（FOCUSNEWS_REVIEW_SHEET，仅开发；null 表示不生成） */
  reviewSheet: string | null
  /** 评审表背景帧 PNG（FOCUSNEWS_REVIEW_BACKDROP，仅开发） */
  reviewBackdrop: string | null
  /** 预览/导出逐像素一致性回归报告输出路径（FOCUSNEWS_PIXELCHECK，仅开发，M1-7） */
  pixelCheck: string | null
  /** 错误呈现取证报告输出路径（FOCUSNEWS_SHOT_ERROR，仅开发，M4-2）：发起一次必然失败的导出 */
  errorDemo: string | null
  /** 参考视频缺失取证（FOCUSNEWS_SHOT_REFMISSING=<可探到的参考视频路径>，仅开发）：
   * 借用它的元数据但把路径指向不存在的文件，让完整性检查弹出重新定位模态 */
  refMissingDemo: string | null
  /** 视觉检查报告路径（FOCUSNEWS_VISUAL_CHECK，仅开发；null 表示不运行） */
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
   * export/cancel 场景的出口类型（FOCUSNEWS_SMOKE_KIND）。
   * pngSequence 是计划里的第三个出口，也是取消时唯一按**目录**清理半成品的分支，
   * 两者都必须能跑与能回收，不能只证透明 MOV。
   */
  exportKind: 'transparentMov' | 'pngSequence'
  /**
   * export 场景的帧交付方式（FOCUSNEWS_SMOKE_DELIVERY）。
   * 'pngSequence' 是透明 MOV 的回退路径（帧先落盘再由 FFmpeg 编 ProRes），
   * 与管道主路径走完全不同的代码，必须单独跑过。
   */
  frameDelivery: 'pipe' | 'pngSequence'
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
}

export interface PickVideoResult {
  path: string
  probe: VideoProbeResult
}

export interface EstimateInput {
  width: number
  height: number
  fps: Fps
  frames: number
  outputDir: string
}

export interface Unsubscribe {
  (): void
}

export interface FocusNewsApi {
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
    saveAs(project: Project): Promise<{ path: string } | null>
    autosaveRead(): Promise<Project | null>
    autosaveWrite(project: Project): Promise<void>
  }
  fonts: {
    list(): Promise<FontRecord[]>
    import(): Promise<{ record: FontRecord } | null>
    readBytes(fontId: string): Promise<ArrayBuffer>
    remove(fontId: string): Promise<void>
  }
  video: {
    pickAndProbe(): Promise<PickVideoResult | null>
    probe(path: string): Promise<VideoProbeResult | null>
    /** 参考视频是否仍在原路径（规格 §8） */
    exists(path: string): Promise<boolean>
    /**
     * 参考视频预览地址（focusnews-media://，带 Range 流）：
     * 主进程校验文件存在且是视频扩展名后登记；文件不可用或扩展名不支持时返回 null。
     */
    previewUrl(path: string): Promise<string | null>
    /** VFR → CFR，返回 jobId，进度经由 onProgress 上报 */
    cfrConvert(path: string, fps: Fps, meta: VideoMeta): Promise<{ jobId: string; outputPath: string }>
  }
  export: {
    estimate(input: EstimateInput): Promise<SizeEstimate>
    start(request: ExportRequest): Promise<{ jobId: string }>
    cancel(jobId: string): Promise<void>
    /** 主进程 pull 第 N 帧（或任务结束通知） */
    onFrameRequest(handler: (message: FrameRequest | FrameEnd) => void): Unsubscribe
    /** 回传一帧 PNG 字节 */
    sendFrame(response: FrameResponse): void
  }
  job: {
    onProgress(handler: (progress: JobProgress) => void): Unsubscribe
    onResult(handler: (result: JobResult) => void): Unsubscribe
  }
}

declare global {
  interface Window {
    focusnews: FocusNewsApi
  }
}
