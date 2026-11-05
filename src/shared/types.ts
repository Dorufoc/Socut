/**
 * 全局数据模型（规格 §4.6）。
 * 本文件只允许出现纯类型与少量常量类型，不得 import Node / Electron / DOM 特有能力，
 * 以保证主进程、渲染进程、preload 与测试可以共用同一份定义。
 */

// ---------------------------------------------------------------------------
// 基础：分辨率 / 帧率
// ---------------------------------------------------------------------------

export interface Resolution {
  width: number
  height: number
}

/** 帧率以分数存储，全程整数运算（规格 §4.4 / §11）。 */
export interface Fps {
  /** 分子，如 30000 */
  num: number
  /** 分母，如 1001 */
  den: number
}

export interface ResolutionPreset {
  key: string
  label: string
  note: string
  resolution: Resolution
}

export interface FpsPreset {
  key: string
  label: string
  fps: Fps
}

// ---------------------------------------------------------------------------
// 尺寸令牌与单位体系（规格 §4.3）
// ---------------------------------------------------------------------------

/**
 * 尺寸令牌：
 * - `number`：绝对像素（目标分辨率下）
 * - `"36vw"` / `"6.2vh"`：视口百分比
 * - `"72%"`：父容器百分比（透传给 Yoga 的 Percent 单位）
 * - `"96px@1080p"`：以 1080p 为基准的像素值，按高度等比换算
 * - `"safe-bottom"` / `"safe-side"` / `"safe-title-bottom"`：广播安全区
 * - `"clamp(28px@1080p, 4.4vh, 72px@1080p)"`：钳制表达式
 */
export type SizeToken = string | number

export const SIZE_TOKEN_UNITS = ['vw', 'vh', '%', 'px@1080p', 'px', 'safe'] as const

// ---------------------------------------------------------------------------
// 配色令牌（规格 §7）
// ---------------------------------------------------------------------------

export interface ColorTokens {
  /** 主色：主条底色 */
  primary: string
  /** 强调色：装饰线 / 色块 */
  accent: string
  /** 主标题文字色 */
  text: string
  /** 副标题文字色 */
  secondaryText: string
  /** 方框背景色（配合 barOpacity 使用） */
  barBackground: string
}

export type ColorTokenKey = keyof ColorTokens

/** 双色线性渐变（用于文字或条块）。 */
export interface GradientSpec {
  enabled: boolean
  from: string
  to: string
  /** 0° 为从左到右，顺时针递增 */
  angleDeg: number
}

// ---------------------------------------------------------------------------
// 预设布局树
// ---------------------------------------------------------------------------

export type LayoutKind = 'row' | 'col' | 'bar' | 'text' | 'rule' | 'spacer' | 'block'

export type LayoutRole =
  | 'root'
  | 'primaryBar'
  | 'secondaryBar'
  | 'decoration'
  | 'title'
  | 'subtitle'
  | 'spacer'
  | 'block'
  | 'rule'

export type FlexDirection = 'row' | 'column'
export type JustifyContent = 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around'
export type AlignItems = 'flex-start' | 'center' | 'flex-end' | 'stretch'
export type PositionType = 'static' | 'relative' | 'absolute'
export type TextAlign = 'left' | 'center' | 'right'

export interface Insets {
  left?: SizeToken
  right?: SizeToken
  top?: SizeToken
  bottom?: SizeToken
}

/** 文本节点的可绘制属性。 */
export interface TextNodeStyle {
  /** 取哪个字段作为内容：主标题或副标题 */
  contentKey: 'title' | 'subtitle'
  /** 字号令牌（通常带 clamp 与 vh 上限，保证竖屏不失控） */
  size: SizeToken
  /** 行高（倍数） */
  lineHeight: number
  /** 字距，绝对像素令牌 */
  tracking?: SizeToken
  /** 字体角色（结合 fontId 解析出 family/weight） */
  fontRole: FontRoleKey
  align?: TextAlign
  /** 单行省略：>1 时按行数截断，MVP 仅支持 1 或 2 */
  maxLines?: number
  ellipsis?: boolean
}

/** 填充（背景/描边）声明。 */
export interface FillSpec {
  /** 引用配色令牌键；用户覆盖作用于令牌层（规格 §7） */
  token: ColorTokenKey
  opacity?: number
  gradient?: GradientSpec
}

export interface LayoutNode {
  kind: LayoutKind
  role: LayoutRole
  /** 节点不透明度（动画会在此基础乘以进度） */
  opacity?: number
  position?: PositionType
  top?: SizeToken
  left?: SizeToken
  right?: SizeToken
  bottom?: SizeToken
  width?: SizeToken
  height?: SizeToken
  minWidth?: SizeToken
  maxWidth?: SizeToken
  minHeight?: SizeToken
  maxHeight?: SizeToken
  aspectRatio?: number
  flexDirection?: FlexDirection
  justifyContent?: JustifyContent
  alignItems?: AlignItems
  alignSelf?: AlignItems
  flexGrow?: number
  flexShrink?: number
  flexBasis?: SizeToken
  padding?: Insets
  margin?: Insets
  gap?: SizeToken
  /** 圆角（0 为直角，广播级样式默认 0） */
  radius?: SizeToken
  fill?: FillSpec
  /** 装饰线的端点渐隐比例（0~1） */
  fadeEnd?: number
  text?: TextNodeStyle
  children?: LayoutNode[]
}

export type FontRoleKey = 'title' | 'subtitle'

export interface FontRole {
  /** 内置字体键（解析为 fontId 的默认值），或 'auto' 表示跟随片段 fontId */
  builtinKey: string | 'auto'
  weight: number
  /** 片段未指定字体时的回退内置字体键 */
  fallbackBuiltinKey: string
}

export type EasingKey =
  | 'linear'
  | 'outQuad'
  | 'outCubic'
  | 'outQuart'
  | 'outQuint'
  | 'outExpo'
  | 'smootherstep'

/** 预设声明的动画节奏；时长以秒存储、UI 以帧编辑（规格 §4.6 + §7）。 */
export interface AnimationSpec {
  inDuration: number
  outDuration: number
  easing: EasingKey
  /** 文字遮罩出现所需帧数（2–3 帧） */
  textRevealFrames: number
  /** 入场位移（画方向：沿 x/y 的偏移令牌，通常为 px@1080p） */
  displacement: { x: SizeToken; y: SizeToken }
  /** 装饰线独立提前入场帧数 */
  ruleLeadInFrames?: number
}

export type PresetId =
  | 'policyAuthority'
  | 'stackedNews'
  | 'calmEditorial'
  | 'financeData'
  | 'globalSimple'
  | 'localWarm'
  | 'breakingRed'
  | 'personProfile'

export type SafeAreaKey = 'action' | 'title'

export interface Preset {
  id: PresetId
  /** 中文显示名（只用风格词，不使用任何电视台名称） */
  name: string
  description: string
  tokens: ColorTokens
  fonts: Record<FontRoleKey, FontRole>
  animation: AnimationSpec
  /** 底部锚定的安全区类型 */
  safeArea: SafeAreaKey
  layout: LayoutNode
  /** 分支补丁：竖屏紧凑 / 超宽上限（规格 §4.3） */
  patches: PresetPatches
}

export interface PresetPatches {
  compact: LayoutPatch[]
  ultrawide: LayoutPatch[]
}

/** 布局补丁：按 role 定位节点并覆盖样式字段。 */
export interface LayoutPatch {
  role: LayoutRole
  /** 当为 true 时，该节点在紧凑分支中被隐藏 */
  hidden?: boolean
  style?: Partial<Pick<LayoutNode, 'width' | 'maxWidth' | 'height' | 'gap' | 'padding' | 'margin' | 'radius'>>
  text?: Partial<Pick<TextNodeStyle, 'size' | 'maxLines' | 'ellipsis' | 'align'>>
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

export type FontSource = 'builtin' | 'user'

/** 字体库元数据（userData/fonts/fonts.json）。 */
export interface FontRecord {
  fontId: string
  family: string
  displayName: string
  weight: number
  style: 'normal' | 'italic'
  bytes: number
  sha1: string
  fileName: string
  source: FontSource
  importedAt: string
}

export interface FontLoadState {
  fontId: string
  status: 'idle' | 'loading' | 'ready' | 'failed'
  /** 加载失败原因（用于 UI） */
  error?: string
}

// ---------------------------------------------------------------------------
// 工程
// ---------------------------------------------------------------------------

export interface ClipContent {
  title: string
  subtitle: string
}

export interface StyleOverrides {
  /** 令牌层覆盖（规格 §7：用户自定义作用于令牌层） */
  tokens?: Partial<ColorTokens>
  /** 方框透明度 0~1（规格 §3.1） */
  barOpacity?: number
  titleGradient?: GradientSpec
  subtitleGradient?: GradientSpec
  /** 手动强制紧凑分支（默认由宽高比自动判定） */
  compact?: boolean
  /**
   * 片段级字号缩放（相对预设解析值，1 = 不动）。
   * 只影响本片段：title 作用于主标题、subtitle 作用于副标题；
   * 缩放后仍受 `fontSizeCapPx` 硬上限约束（4K / 竖屏不会失控）。
   */
  fontScale?: { title?: number; subtitle?: number }
}

/** 时间以秒存储（高精度数值），入出点提交时已吸附到帧边界。 */
export interface SubtitleClip {
  id: string
  startTime: number
  endTime: number
  presetId: PresetId
  styleOverrides: StyleOverrides
  content: ClipContent
  animation: AnimationSpec
  fontId: string
}

export type VfrPolicy = 'none' | 'converted' | 'raw'

/**
 * @deprecated v2 开始工程不再持有单一参考视频，统一改走 `MediaItem` 池 + `MediaClip` 时间线。
 * 保留类型只为旧工程读取时的迁移入口（`normalizeProject` 读取后写回 `media/mediaClips`）。
 */
export interface RefVideo {
  /** 编辑与导出实际使用的文件（VFR 转换后为 CFR 文件） */
  path: string
  /** 原始导入路径（VFR 转 CFR 时保留） */
  sourcePath?: string
  meta: VideoMeta
  /** 非 16:9 模态确认（规格 §6.1） */
  non169Ack: boolean
  /** HDR 模态确认（规格 §6.2） */
  hdrAck: boolean
  vfrPolicy: VfrPolicy
  /** 竖屏/超宽确认后置入，驱动预设分支（规格 §6.1） */
  compactMode: 'auto' | 'compact' | 'ultrawide' | 'standard'
  importedAt: string
}

/**
 * 素材池里的一枚参考视频（v2）。兼容门禁确认位下放到枚级，
 * 时间轴上同一个 MediaItem 可被多个 MediaClip 以不同源入出点引用。
 */
export interface MediaItem {
  id: string
  /** 编辑与导出实际使用的文件（VFR 转换后为 CFR 文件） */
  path: string
  /** 原始导入路径（VFR 转 CFR 时保留） */
  sourcePath?: string
  /** 展示名（默认取 basename，可重命名） */
  name: string
  meta: VideoMeta
  non169Ack: boolean
  hdrAck: boolean
  vfrPolicy: VfrPolicy
  compactMode: 'auto' | 'compact' | 'ultrawide' | 'standard'
  /** 主进程抽帧缩略图的自定义协议地址（focusnews-thumb://<mediaId>）；无图时为空字符串 */
  thumbnailUrl: string
  importedAt: string
}

/**
 * 时间轴上行：一枚媒体片段。时间轴坐标与源坐标分别以 `timeline*Sec` 与 `source*Sec` 命名，
 * 遵循旧约定写入前已 `snapTimeToFrame`，时长以秒为准。
 */
export interface MediaClip {
  id: string
  mediaId: string
  /** 时间轴上的起始/结束秒 */
  timelineStartSec: number
  timelineEndSec: number
  /** 对应源视频的入出点秒（与时长一致：timelineEndSec - timelineStartSec === sourceOutSec - sourceInSec） */
  sourceInSec: number
  sourceOutSec: number
}

/**
 * 时间帧预览条（Thumbnail Strip）的一次生成请求（v5）。
 *
 * 这是**运行时派生数据，不写进工程 JSON**：长图内容取决于「素材 + 源区间 + 格数」，
 * 而格数又取决于卡片当前的像素宽（缩放级别）。一旦落盘就会过期（换机器、改入出点、
 * 拖宽轨道后都是另一张图），与水印几何同一纪律：只存输入，不存结果。
 */
export interface MediaStripRequest {
  /** 素材池 id（缓存回收与文件命名的前缀） */
  mediaId: string
  /** 抽帧用的实际文件（VFR 转 CFR 后为转换产物） */
  path: string
  sourceInSec: number
  sourceOutSec: number
  /** 拼接格数（主进程不信任这个值，会自己再夹一次上限） */
  frames: number
}

/** 生成结果：失败（源文件不在 / FFmpeg 缺失 / 抽帧报错）统一 url=null，渲染层显示占位符。 */
export interface MediaStripResult {
  /** focusnews-strip://<token>；不可用时 null */
  url: string | null
  /** 主进程实际使用的格数（可能与请求不同，渲染层以此为准） */
  frames: number
  /** 缓存令牌：同一 key 二次请求不会重跑 FFmpeg */
  key: string
  /** 命中磁盘缓存（本轮未起子进程） */
  cached: boolean
}

/**
 * 水印（Watermark）：一张本机图片作为台标叠加在合成画面的左上角（仅叠加出口）。
 * 显示尺寸与偏移**不**存在这里——它们由 `computeWatermarkGeometry` 按
 * 「1080P 基准 + 原图 32% + 30px 边距」随输出分辨率实时换算，避免工程里留下过期像素。
 */
export interface WatermarkSettings {
  enabled: boolean
  /** 图片绝对路径（导出时作为一路 `-i` 输入交给 FFmpeg） */
  path: string
  /** 展示名（默认取 basename，可重命名） */
  name: string
  /** 图片原始像素宽（几何换算的输入；导入时用 ffprobe 探测） */
  sourceWidth: number
  /** 图片原始像素高 */
  sourceHeight: number
  importedAt: string
}

export interface Project {
  version: number
  name: string
  resolution: Resolution
  fps: Fps
  clips: SubtitleClip[]
  /** 字体库快照（内置 + 用户导入） */
  fonts: FontRecord[]
  /** v2：多素材池（同枚素材可被多个 MediaClip 引用） */
  media: MediaItem[]
  /** v2：时间轴上行（媒体轨）；与 `clips` 下行共享尺规/播放头 */
  mediaClips: MediaClip[]
  /** 水印设置；缺省 = 未导入水印（合成链与旧工程逐字节一致） */
  watermark?: WatermarkSettings
  /** UI 状态（不参与渲染）；leftTab 记住上次离开左侧栏的位置，随工程走 */
  ui?: { leftTab?: 'media' | 'watermark' | 'captions' | 'export' | 'progress' } & Record<string, unknown>
  /**
   * @deprecated v1 遗留字段，`normalizeProject` 自动迁移到 `media/mediaClips`，写入时不再产出。
   * 保留类型为 ftype 旧工程 JSON 能直接反序列化。
   */
  refVideo?: RefVideo
}

// ---------------------------------------------------------------------------
// 视频探测与兼容性（规格 §6）
// ---------------------------------------------------------------------------

export interface Rational {
  num: number
  den: number
}

export interface VideoMeta {
  path: string
  containerName: string
  width: number
  height: number
  /** 样本宽高比，可能缺失 */
  sar: Rational | null
  /** SAR 修正后的显示宽高比（规格 C8） */
  displayRatio: number
  rFrameRate: Rational
  avgFrameRate: Rational
  pixFmt: string
  colorPrimaries: string | null
  colorSpace: string | null
  colorTransfer: string | null
  colorRange: string | null
  videoCodec: string
  audioCodec: string | null
  audioChannels: number | null
  durationSec: number
  nbFrames: number | null
  bitRateKbps: number | null
}

export interface CompatFlags {
  non169: boolean
  portrait: boolean
  ultraWide: boolean
  hdr: boolean
  vfr: boolean
  noAudio: boolean
  /** 音频无法直接 copy（非 aac/mp3） */
  audioTranscodeNeeded: boolean
}

export interface VfrEvidence {
  expectedGapSec: number
  maxGapSec: number
  sampledPackets: number
}

export interface VideoProbeResult {
  meta: VideoMeta
  flags: CompatFlags
  vfrEvidence?: VfrEvidence
  /** 建议的目标帧率（用于 CFR 转换） */
  suggestedFps: Fps
}

// ---------------------------------------------------------------------------
// 渲染任务（解析后的可绘制规格，预览与导出共用）
// ---------------------------------------------------------------------------

export interface LayoutBoxText {
  content: string
  fontId: string
  /** 已注册的 CSS family 名（FontFace 注册后的 family） */
  family: string
  weight: number
  sizePx: number
  lineHeightPx: number
  trackingPx: number
  align: TextAlign
  maxLines: number
  ellipsis: boolean
  color: string
  gradient?: GradientSpec
}

export interface LayoutBoxFill {
  color: string
  opacity: number
  gradient?: GradientSpec
}

export interface LayoutBox {
  role: LayoutRole
  /** 绘制方式（由声明节点 kind 带下来，渲染层据此选则绘制函数） */
  kind: LayoutKind
  /** 绝对像素，原生分辨率坐标系 */
  x: number
  y: number
  w: number
  h: number
  radiusPx: number
  opacity: number
  fill?: LayoutBoxFill
  fadeEnd?: number
  text?: LayoutBoxText
}

export interface ResolvedAnimation {
  inFrames: number
  outFrames: number
  totalFrames: number
  easing: EasingKey
  textRevealFrames: number
  /** @deprecated 动画已统一为「整体左→右擦除」，位移不再参与渲染；字段保留只为旧工程可读 */
  displacementXPx: number
  /** @deprecated 同上 */
  displacementYPx: number
  ruleLeadInFrames: number
}

export interface ResolvedClip {
  id: string
  presetId: PresetId
  startFrame: number
  endFrame: number
  boxes: LayoutBox[]
  animation: ResolvedAnimation
  /** 是否参与本次导出（单片段导出时用于过滤） */
  selected: boolean
}

export interface RenderJobSpec {
  width: number
  height: number
  fps: Fps
  /** 导出时交付给主进程的帧字节形式 */
  frameFormat: FrameFormat
  /** 绝对帧序号区间（含 start，不含 end） */
  startFrame: number
  endFrame: number
  clips: ResolvedClip[]
  /** 紧凑分支实际生效值，便于 UI 显示 */
  aspectMode: AspectMode
}

export type AspectMode = 'standard' | 'compact' | 'ultrawide'

// ---------------------------------------------------------------------------
// 导出任务与进度
// ---------------------------------------------------------------------------

export type ExportKind = 'transparentMov' | 'overlayMp4' | 'pngSequence'

export interface ExportTarget {
  kind: ExportKind
  /** 输出目录（由用户选择） */
  outputDir: string
  fileName: string
}

/** 帧编码形式：raw = 未压缩 RGBA（无 PNG 编码开销）；png = 带 alpha 的 PNG 字节 */
export type FrameFormat = 'raw' | 'png'

/** 渲染规格中与主进程编码相关的部分（随 ExportRequest 过 IPC） */
export interface FrameSpec {
  width: number
  height: number
  fps: Fps
  /** 绝对帧区间（含 start，不含 end） */
  startFrame: number
  endFrame: number
  /** 主进程期望的帧字节形式（与 pipeInputArgs/rawPipeInputArgs 一致） */
  frameFormat: FrameFormat
}

export type TransparentCodec = 'prores4444' | 'qtrle'

/** 叠加导出中一段媒体基座：源文件 + 源入出点 + 在时间轴上的目标位置。 */
export interface OverlaySegment {
  refVideoPath: string
  /** 时间轴上本次输出的 [spanStartSec, spanEndSec] 内，本段占据的区间 */
  timelineStartSec: number
  timelineEndSec: number
  /** 从源文件的这个入点开始取帧 */
  sourceInSec: number
  /** 到源文件的这个出点结束 */
  sourceOutSec: number
}

export interface ExportRequest {
  jobId: string
  target: ExportTarget
  /** 帧来源规格；渲染进程按同一 jobId 保存完整 RenderJobSpec 并按帧应答 */
  frameSpec: FrameSpec
  /** 透明 MOV：image2pipe 主路径 / PNG 序列回退 */
  frameDelivery: 'pipe' | 'pngSequence'
  /** 管道内的帧形式（默认 raw：实测 PNG 编码是 1080p 吞吐率瓶颈） */
  pipeTransport?: 'raw' | 'png'
  /** 透明出口编码（默认 ProRes 4444；qtrle 为兼容模式回退） */
  codec?: TransparentCodec
  /** 叠加合成：多段 trim+concat 后作为基座，上留 overlay 字幕。 */
  overlay?: {
    /**
     * v2：多段媒体时间线，按 `timelineStartSec` 升序。
     * 主进程将逐段 trim 后 concat 作为基座；`segments.length === 1` 且 `sourceInSec === 0` 时回退旧单输入。
     * 阶段 7 前，导出管线仍从 `refVideoPath` 读取单输入，`segments` 作为新模型下的补充入口。
     */
    segments?: OverlaySegment[]
    /** v1 遗留字段：主进程导出入口（新模型下 = `segments[0]?.refVideoPath`）；阶段 7 将删除。 */
    refVideoPath: string
    /** 各段共享的参考元数据（首段为准；导出前已在渲染侧对 media 拉平） */
    refMeta: VideoMeta
    audioMode: 'copy' | 'aac'
    fpsMode: 'cfr' | 'vfr'
    /** span 秒区间（计划 C7） */
    spanStartSec: number
    spanEndSec: number
    /** 直接管道合成后端（默认 false：临时透明 MOV 两阶段） */
    directPipe: boolean
    /**
     * 水印：合成在字幕条之上（最后一层 overlay）。
     * 缺省即不追加输入与滤镜链，argv 与无水印路径逐字节一致。
     */
    watermark?: { path: string; sourceWidth: number; sourceHeight: number }
  }
}

export type JobPhase =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'muxing'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface JobProgress {
  jobId: string
  phase: JobPhase
  framesDone: number
  framesTotal: number
  /** 来自 -progress pipe:1 的 out_time_us（微秒），未采信值为 0 */
  outTimeUs: number
  /** 展示进度 0~1，取帧写入与编码时间的较小值 */
  percent: number
  bytesWritten: number
  elapsedMs: number
  /** 提示（如「音频已转码为 AAC 192k」） */
  notices: string[]
}

export interface JobResult {
  jobId: string
  ok: boolean
  outputPath?: string
  /** 叠加合成的实际输出路径 */
  outputs: string[]
  error?: JobErrorInfo
  progress: JobProgress
}

export interface JobErrorInfo {
  code: string
  message: string
  /** stderr 尾部（规格 §5.3） */
  stderrTail: string
  /** 失败时的完整命令行（便于复现） */
  argv?: string[]
  fatal: boolean
}

/** 4K60 等体积预估（规格 §2.3） */
export interface SizeEstimate {
  bytes: number
  /** 建议改用 PNG 序列出口 */
  recommendPng: boolean
  /** 磁盘可用字节（预检结果） */
  freeBytes?: number
  sufficientDisk: boolean
}

// ---------------------------------------------------------------------------
// 帧通道消息（主进程 pull，渲染进程 push）
// ---------------------------------------------------------------------------

export interface FrameRequest {
  jobId: string
  index: number
}

export interface FrameResponse {
  jobId: string
  index: number
  /** PNG 字节（无错时必须提供；结构化克隆一次拷贝） */
  buffer?: ArrayBuffer
  error?: string
}

export interface FrameEnd {
  jobId: string
  reason: 'cancelled' | 'failed'
}
