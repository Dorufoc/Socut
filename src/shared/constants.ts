import type { Fps, FontRecord, Resolution, ResolutionPreset, FpsPreset } from './types'

export const PROJECT_VERSION = 2

export const APP_NAME = 'FocusNews'
export const WINDOW_TITLE = 'FocusNews 新闻字幕条'

/** 临时目录根名（app.getPath('temp') 下） */
export const TEMP_ROOT = 'focusnews'
export const USER_DATA_DIRS = {
  fonts: 'fonts',
  projects: 'projects',
  logs: 'logs',
  /** v2：素材卡片缩略图缓存（与 media 池 id 同名 jpg） */
  thumbs: 'thumbs'
} as const

export const FONTS_MANIFEST_FILE = 'fonts.json'
export const AUTOSAVE_FILE = 'autosave.focusnews.json'
export const AUTOSAVE_BACKUP_FILE = 'autosave.focusnews.bak.json'

/**
 * 字幕条**布局边距** = 安全区内缩 × 该系数。
 * 安全区（SMPTE/EBU）仍然用于辅助线与硬约束，但条块实际摆放按产品要求贴得更近：
 * 0.5 → 1080p 下标题档左右各 96px（而非 192px）、底部 54px（而非 108px）。
 * 只影响 `layout-*` 令牌；`safe-*` 令牌语义不变。
 */
export const LAYOUT_INSET_SCALE = 0.5

/**
 * 片段级字号缩放上下限（相对预设解析出的 px）。
 * 缩放在预设值之上做乘法，之后仍过 `fontSizeCapPx` 的可读性硬上限，
 * 所以“把字号拉到 200%”不会在 4K / 竖屏下突破字号上限。
 */
export const FONT_SCALE_MIN = 0.5
export const FONT_SCALE_MAX = 2

// ---------------------------------------------------------------------------
// 分辨率预设（规格 §2.1）
// ---------------------------------------------------------------------------

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { key: '360p', label: '360p', note: '640×360 · 16:9', resolution: { width: 640, height: 360 } },
  { key: '480p', label: '480p', note: '854×480 · 16:9', resolution: { width: 854, height: 480 } },
  { key: '720p', label: '720p', note: '1280×720', resolution: { width: 1280, height: 720 } },
  { key: '1080p', label: '1080p', note: '1920×1080 · 默认档', resolution: { width: 1920, height: 1080 } },
  { key: '2K', label: '2K', note: '2560×1440 · 非 DCI 2K', resolution: { width: 2560, height: 1440 } },
  { key: '4K', label: '4K', note: '3840×2160 · UHD', resolution: { width: 3840, height: 2160 } }
]

export const DEFAULT_RESOLUTION = { width: 1920, height: 1080 }

/** 参考视频分辨率对齐时用的标准档（长边就近吸附） */
export const STANDARD_HEIGHTS = [360, 480, 720, 1080, 1440, 2160]

// ---------------------------------------------------------------------------
// 帧率预设（规格 §2.2）
// ---------------------------------------------------------------------------

export const FPS_23_976: Fps = { num: 24000, den: 1001 }
export const FPS_24: Fps = { num: 24, den: 1 }
export const FPS_25: Fps = { num: 25, den: 1 }
export const FPS_29_97: Fps = { num: 30000, den: 1001 }
export const FPS_30: Fps = { num: 30, den: 1 }
export const FPS_50: Fps = { num: 50, den: 1 }
export const FPS_59_94: Fps = { num: 60000, den: 1001 }
export const FPS_60: Fps = { num: 60, den: 1 }

export const FPS_PRESETS: FpsPreset[] = [
  { key: '23.976', label: '23.976（24000/1001）', fps: FPS_23_976 },
  { key: '24', label: '24', fps: FPS_24 },
  { key: '25', label: '25', fps: FPS_25 },
  { key: '29.97', label: '29.97（30000/1001）', fps: FPS_29_97 },
  { key: '30', label: '30', fps: FPS_30 },
  { key: '50', label: '50', fps: FPS_50 },
  { key: '59.94', label: '59.94（60000/1001）', fps: FPS_59_94 },
  { key: '60', label: '60', fps: FPS_60 }
]

export const DEFAULT_FPS: Fps = FPS_30

export const fpsToRatio = (fps: Fps): number => fps.num / fps.den

export const fpsToString = (fps: Fps): string => `${fps.num}/${fps.den}`

export const fpsEquals = (a: Fps, b: Fps): boolean => a.num === b.num && a.den === b.den

/** 就近吸附到支持的帧率档（用于参考视频跟随与 CFR 转换） */
export function nearestFps(ratio: number): Fps {
  let best = FPS_25
  let bestDiff = Number.POSITIVE_INFINITY
  for (const preset of FPS_PRESETS) {
    const diff = Math.abs(fpsToRatio(preset.fps) - ratio)
    if (diff < bestDiff) {
      bestDiff = diff
      best = preset.fps
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// 广播安全区（规格 §7：默认锚定底部安全区）
// ---------------------------------------------------------------------------

/**
 * 动作安全区：每边内缩 3.5%（= SMPTE ST 2048-1 为 HDTV 定义的动作安全区）。
 * 注意与计划 §2 的 0.95（每边 2.5%）不同：此处故意采用更保守的标准值，差异已记入
 * docs/verification/M0.md 的偏差台账（C43）供产品侧定夺。
 */
export const ACTION_SAFE_RATIO = 0.93
/**
 * 字幕安全区（标题安全）：每边内缩 10%（= EBU R 95 的标题安全区）。
 * 计划 §2 写的是 0.90（每边 5%）；标题安全区必须比动作安全区更内缩，
 * 0.90/0.95 这对仍满足该关系，但 10% 是文字类内容更常用的保守值。
 */
export const TITLE_SAFE_RATIO = 0.8

/** 广播级底部锚定时，条块底边距画面下沿的额外留白（占高度比例） */
export const BOTTOM_ANCHOR_PADDING_RATIO = 0.012

// ---------------------------------------------------------------------------
// 宽高比分类阈值（计划 C8）
// ---------------------------------------------------------------------------

export const WIDE_TARGET_RATIO = 16 / 9
/** |ratio - 16/9| 超过该阈值视为非 16:9，触发模态 */
export const NON_169_TOLERANCE = 0.02
/** 小于该比值走竖屏紧凑分支 */
export const COMPACT_RATIO_MAX = 1.2
/** 大于该比值走超宽屏宽度上限 */
export const ULTRAWIDE_RATIO_MIN = 2.0

/** 竖屏紧凑：条宽约 88%（规格 §4.3） */
export const COMPACT_BAR_WIDTH_PERCENT = 88
/** 超宽屏：主条最大宽度上限（70% 宽，并再受 px@1080p 钳制） */
export const ULTRAWIDE_BAR_MAX_WIDTH_PERCENT = 70

// ---------------------------------------------------------------------------
// 水印（Watermark）
// ---------------------------------------------------------------------------

/**
 * 坐标基准分辨率：水印的尺寸与边距都按 1080P 定义，
 * 输出非 1080P 时按 `输出高 / 1080` 等比换算（与 `px@1080p` 尺寸令牌同一口径）。
 */
export const WATERMARK_BASE_RESOLUTION: Resolution = { width: 1920, height: 1080 }
/** 显示尺寸 = 原图尺寸 × 该比例（基准 1080P 下） */
export const WATERMARK_DISPLAY_SCALE = 0.32
/** 基准 1080P 下距顶部与左侧的边距（像素，左上角定位） */
export const WATERMARK_MARGIN_PX = 30
/** 可选作水印的图片扩展名（主进程文件对话框与预览协议共用；不含 svg——FFmpeg 无 librsvg 时读不了） */
export const WATERMARK_IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'gif',
  'tif',
  'tiff'
] as const

// ---------------------------------------------------------------------------
// 兼容性判定（规格 §6）
// ---------------------------------------------------------------------------

export const HDR_COLOR_TRANSFERS = ['smpte2084', 'arib-std-b67']
export const HDR_COLOR_PRIMARIES = ['bt2020', 'bt2020ncl', 'bt2020c']
export const VFR_RATIO_TOLERANCE = 0.01
/** 抽样 PTS 间隔超过期望帧间隔的该倍数视为 VFR */
export const VFR_GAP_FACTOR = 1.5
export const VFR_SAMPLE_PACKETS = 60
/** 可直接 -c:a copy 的音频编码 */
export const COPYABLE_AUDIO_CODECS = ['aac', 'mp3']

// ---------------------------------------------------------------------------
// ProRes 体积标定（M0-5 实测后更新 PRORES_4444_BITS_PER_PIXEL_FRAME）
// ---------------------------------------------------------------------------

/**
 * ProRes 4444 每像素每帧的比特数标定值（M0-5 / M4-6 实测，不是拍脑袋）。
 * 依据：应用内真实管线导出的 1080p30/10s（两个预设带动画 + CJK 文字）产物 43.2MB
 * → 43.2e6×8 / (1920×1080×300) ≈ 0.555 bit/pixel/frame（≈ 34.6 Mbps）。
 * 预估取实测 × 2 安全系数：字幕条素材以透明与平坦区域为主；
 * Apple 规格上限（1080p30 ProRes 4444 ≈ 10.9 bit/pixel/frame）不对应本产物。
 * 第二个标定点（M4-6 4K60 冒烟）：3840×2160@60/2s 产物 29.74MB → 0.237 bit/pixel/frame，
 * 平坦区占比随分辨率上升而压缩更好；系数故意以最高的 1080p 为基准，因此对 4K 高估（≈ 4.4×），
 * 这对磁盘预检是安全方向，而「建议改用 PNG」的阈值在具体时长上单独断言。
 * 旧值 2.335 会把 4K60/10s 预估成 1.45GB（实际 ~350MB）而错触发「建议改用 PNG 序列」，
 * 属于规格 §2.3 的误导性估计，因此按实测重新标定。
 */
export const MEASURED_PRORES_4444_BITS_PER_PIXEL_FRAME = 0.555
export const PRORES_ESTIMATE_SAFETY_FACTOR = 2
export const PRORES_4444_BITS_PER_PIXEL_FRAME =
  MEASURED_PRORES_4444_BITS_PER_PIXEL_FRAME * PRORES_ESTIMATE_SAFETY_FACTOR
/** 超过该预估体积（字节）时提示改用 PNG 序列出口（规格 §2.3） */
export const PNG_RECOMMEND_THRESHOLD_BYTES = 800 * 1024 * 1024
/** 磁盘预检系数：可用空间需 ≥ 预估 × 1.5 */
export const DISK_SAFETY_FACTOR = 1.5

// ---------------------------------------------------------------------------
// 子进程纪律
// ---------------------------------------------------------------------------

/** 取消时 SIGTERM 后等待时长，超时强杀 */
export const SIGTERM_GRACE_MS = 3000
/** 单帧拉取超时 */
export const FRAME_REQUEST_TIMEOUT_MS = 30_000
/** 整体任务无进展超时 */
export const JOB_STALL_TIMEOUT_MS = 120_000
/** stderr 环形缓冲上限 */
export const STDERR_TAIL_BYTES = 128 * 1024
/** 展示给用户的 stderr 尾部长度 */
export const STDERR_PRESENT_CHARS = 4096

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

/** 触发「加载中禁用导出」的字体字节阈值与耗时阈值（规格 §4.5） */
export const BIG_FONT_BYTES = 8 * 1024 * 1024
export const BIG_FONT_LOAD_MS = 300
/** 用户导入字体上限 */
export const MAX_IMPORT_FONT_BYTES = 100 * 1024 * 1024

/**
 * 内置字体清单。实际文件由 `scripts/fetch-fonts.mjs` 下载到 resources/fonts/，
 * 全部为可再分发许可证（SIL OFL / Apache 2.0）。
 */
export const BUILTIN_FONTS: Omit<FontRecord, 'importedAt' | 'bytes' | 'sha1' | 'source'>[] = [
  {
    fontId: 'builtin-notosanssc-400',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Regular',
    weight: 400,
    style: 'normal',
    fileName: 'NotoSansSC-Regular.otf'
  },
  {
    fontId: 'builtin-notosanssc-500',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Medium',
    weight: 500,
    style: 'normal',
    fileName: 'NotoSansSC-Medium.otf'
  },
  {
    fontId: 'builtin-notosanssc-700',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Bold',
    weight: 700,
    style: 'normal',
    fileName: 'NotoSansSC-Bold.otf'
  },
  {
    fontId: 'builtin-notosanssc-900',
    family: 'Noto Sans SC',
    displayName: '思源黑体 Black',
    weight: 900,
    style: 'normal',
    fileName: 'NotoSansSC-Black.otf'
  },
  {
    fontId: 'builtin-notoserifsc-700',
    family: 'Noto Serif SC',
    displayName: '思源宋体 Bold',
    weight: 700,
    style: 'normal',
    fileName: 'NotoSerifSC-Bold.otf'
  },
  {
    fontId: 'builtin-jetbrainsmono-400',
    family: 'JetBrains Mono',
    displayName: 'JetBrains Mono Regular',
    weight: 400,
    style: 'normal',
    // 可变字体：同一文件按两个 fontId 各注册一次（descriptor 固定到对应字重）
    fileName: 'JetBrainsMono-Variable.ttf'
  },
  {
    fontId: 'builtin-jetbrainsmono-700',
    family: 'JetBrains Mono',
    displayName: 'JetBrains Mono Bold',
    weight: 700,
    style: 'normal',
    fileName: 'JetBrainsMono-Variable.ttf'
  }
]

/** 片段未指定字体时的默认字体 */
export const DEFAULT_FONT_ID = 'builtin-notosanssc-700'

/**
 * FontFace 注册用的唯一 family 名（按 fontId 隔离）。
 * 避免同一 family 下不同字重相互干扰导致 Canvas 选中错误的字形。
 */
export const FONT_FAMILY_PREFIX = 'FocusNews'
export const cssFamilyFor = (fontId: string): string => `${FONT_FAMILY_PREFIX}-${fontId}`

// ---------------------------------------------------------------------------
// 编辑器与预览
// ---------------------------------------------------------------------------

/** 时间轴最小片段时长（秒），防止零时长 */
export const MIN_CLIP_DURATION_SEC = 0.2
/** 媒体轨上单段 MediaClip 的最小时长（与字幕轨保持一致，避免拆后零长） */
export const MIN_MEDIA_CLIP_SEC = 0.2
/** 新建片段默认时长（秒） */
export const DEFAULT_CLIP_DURATION_SEC = 5
/** 时间轴可编辑最大时长（无参考视频时） */
export const MAX_TIMELINE_SEC = 60

/**
 * 新建片段默认的入场/出场时长（秒）。
 * 存储以秒为准，跨帧率观感一致：24fps 自动 → 24 帧，30fps → 30 帧，
 * 非标准帧率（23.976 / 29.97 / 50 / 59.94）写入时自动吸附到当前帧率的整帧边界。
 */
export const DEFAULT_ANIMATION_IN_SEC = 1
export const DEFAULT_ANIMATION_OUT_SEC = 1
/**
 * 面板可编辑的入场/出场最长时长（秒）。
 * 与旧 30 帧硬顶不同：上限以秒为准，面板内部的帧步进会跟随当前帧率自动伸缩
 * (3s @ 60fps = 180 帧，@ 24fps = 24 帧)，保证“时长→帧”而不是“帧→时长”的口径。
 */
export const MAX_ANIMATION_SEC = 3

/** 自动保存 debounce */
export const AUTOSAVE_DEBOUNCE_MS = 800

/**
 * 品牌字体导入提示（规格 §4.5 / §8）。
 * 这些家族的免费商用声明只覆盖「使用」，未授予将字体文件随第三方软件再分发
 * （OPPO 甚至直接写了“不向他方提供其他下载渠道”），因此**不进安装包**；
 * 合规路径是用户自己从官方页下载后用应用内「导入字体」引入。
 * 逐家条款原文与判定见 docs/assets.md「品牌字体包」一节。
 */
export interface BrandFontHint {
  family: string
  officialPage: string
  reason: string
}

export const BRAND_FONT_IMPORT_HINTS: BrandFontHint[] = [
  {
    family: 'OPPO Sans',
    officialPage: 'https://open.oppomobile.com/new/developmentDoc/info?id=10221',
    reason: '声明含“不向他方提供其他下载渠道”，所以上游包只能由你本人下载后导入'
  },
  {
    family: '阿里巴巴普惠体 3.0',
    officialPage: 'https://fonts.alibabagroup.com/',
    reason: '免费商用，但未见到允许字体文件随软件再分发的明确条款'
  },
  {
    family: '腾讯体 Tencent Sans',
    officialPage: 'https://www.tencent.com/zh-cn/business/tencent-sans.html',
    reason: '免费商用，但未见到允许嵌入/再分发的条款文字'
  }
]
