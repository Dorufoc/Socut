/**
 * 显卡检测与渲染设备选择的唯一真值（主进程 / 渲染进程 / 测试共用）。
 *
 * 设计要点：
 * - 这里只放**纯函数**：分类、打分、选择、编码器参数映射都能脱离 Electron 单测；
 *   真正的枚举由主进程 app.getGPUInfo('complete') 与 ffmpeg -encoders 提供。
 * - 「高性能 = 独显 / 节能 = 核显」是 Chromium 官方开关语义
 *   （--force_high_performance_gpu / --force_low_power_gpu），
 *   应用只能在**启动前**追加开关，因此偏好必须持久化、重启后生效。
 * - 导出编码器按偏好显卡的厂商匹配（NVENC / QSV / AMF），拿不到就回退 libx264，
 *   绝不因为硬件编码不可用而让导出失败。
 */

/** 显卡厂商（按 PCI vendorId + 名称双重判定）。 */
export type GpuVendor = 'nvidia' | 'intel' | 'amd' | 'apple' | 'qualcomm' | 'microsoft' | 'unknown'

/** 显卡类型：独显 / 核显 / 软件渲染 / 未知。 */
export type GpuKind = 'discrete' | 'integrated' | 'software' | 'unknown'

/** 渲染设备偏好：自动 = 性能最高；高性能 = 强制独显；节能 = 强制核显。 */
export type GpuPreference = 'auto' | 'high-performance' | 'low-power'

/** 导出视频编码模式：auto = 有可用硬件编码器就用；software = 始终 libx264。 */
export type VideoEncoderMode = 'auto' | 'software'

/** 一张被系统枚举出来的显卡。 */
export interface GpuDeviceInfo {
  /** Chromium gpuDevice 数组下标（稳定标识，界面与偏好回显都用它） */
  index: number
  vendorId: number
  deviceId: number
  vendor: GpuVendor
  /** 厂商原始字符串（"NVIDIA Corporation" 等） */
  vendorName: string
  /** 设备名（"NVIDIA GeForce RTX 4060 Laptop GPU"） */
  name: string
  kind: GpuKind
  /** Chromium 当前是否正在使用这块卡 */
  active: boolean
  driverVersion: string
  /** 性能启发式分数，仅用于排序（独显 > 核显 > 软件渲染） */
  performanceScore: number
}

/** 本机支持的硬件编码器（来自 ffmpeg -encoders）。 */
export interface HardwareEncoderInfo {
  /** ffmpeg 编码器名：h264_nvenc / h264_qsv / h264_amf … */
  name: string
  vendor: GpuVendor
  codec: 'h264' | 'hevc' | 'av1'
}

/** 渲染设置（持久化到 userData/render-settings.json）。 */
export interface RenderSettings {
  gpuPreference: GpuPreference
  videoEncoder: VideoEncoderMode
}

/** 设置页 / 启动自检共用的一份显卡体检报告。 */
export interface GpuDiagnostics {
  devices: GpuDeviceInfo[]
  /** 当前 Chromium 实际使用的设备下标（找不到为 null） */
  activeDeviceIndex: number | null
  activeDeviceName: string
  /** 已持久化的偏好 */
  preference: GpuPreference
  /** 本次进程启动时实际追加的 Chromium 开关对应值 */
  appliedPreference: GpuPreference
  /** 偏好已改但尚未重启：界面提示「重启后生效」 */
  restartRequired: boolean
  /** Chromium 是否退回软件渲染 */
  softwareRendering: boolean
  hardwareEncoders: HardwareEncoderInfo[]
  /** 按偏好显卡 + 编码模式算出的最终选择（null = 走软件编码） */
  selectedEncoder: HardwareEncoderInfo | null
  encoderMode: VideoEncoderMode
  /** FFmpeg 是否至少有一个可用的 H.264 硬件编码器 */
  hardwareEncodingAvailable: boolean
}

/**
 * 默认偏好：高性能（强制独显）。
 * 混合显卡机器上 Chromium 默认跟随系统/主显示器，往往落到核显；
 * 本工具是剪辑/合成场景，默认就该吃独显。无独显时该开关由 Chromium 安全忽略。
 */
export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  gpuPreference: 'high-performance',
  videoEncoder: 'auto'
}

/** PCI vendorId（十进制，Chromium 给的就是十进制）。 */
const VENDOR_ID: Record<string, GpuVendor> = {
  '4318': 'nvidia', // 0x10DE
  '32902': 'intel', // 0x8086
  '4098': 'amd', // 0x1002
  '4203': 'apple', // 0x106B
  '20803': 'qualcomm', // 0x5143
  '5140': 'microsoft' // 0x1414（Microsoft Basic Render Driver）
}

/** 软件渲染设备名特征（Basic Render Driver / SwiftShader / llvmpipe）。 */
const SOFTWARE_MARKERS = /(basic render|software adapter|swiftshader|llvmpipe|microsoft basic)/i

/** 独显型号特征：名称里出现这些系列即为独立显卡。 */
const DISCRETE_MARKERS =
  /(geforce|rtx\s*\d|gtx\s*\d|quadro|tesla|radeon\s+rx|radeon\s+pro|firepro|arc(?:\(tm\))?\s*[ab]\d{3}|arc\s*pro)/i

/** 核显型号特征：Intel UHD/Iris/Arc Graphics、AMD 集显、Apple 统一内存、Qualcomm Adreno。 */
const INTEGRATED_MARKERS =
  /(uhd graphics|hd graphics|iris|arc(?:\(tm\))?\s*graphics|radeon\(tm\)\s*graphics|radeon graphics|vega\s*\d+\s*graphics|adreno|apple\s+m\d|integrated)/i

/** 这是不是一块真正的硬件显卡（软件渲染不算）。 */
export function isHardwareGpu(device: Pick<GpuDeviceInfo, 'kind'>): boolean {
  return device.kind === 'discrete' || device.kind === 'integrated' || device.kind === 'unknown'
}

/** vendorId / 厂商名 / 设备名 → 厂商枚举。 */
export function classifyGpuVendor(input: {
  vendorId?: number
  vendorString?: string
  deviceString?: string
}): GpuVendor {
  if (typeof input.vendorId === 'number' && VENDOR_ID[String(input.vendorId)]) {
    return VENDOR_ID[String(input.vendorId)] as GpuVendor
  }
  const text = `${input.vendorString ?? ''} ${input.deviceString ?? ''}`.toLowerCase()
  if (!text.trim()) return 'unknown'
  if (text.includes('nvidia')) return 'nvidia'
  if (text.includes('intel')) return 'intel'
  if (/(amd|advanced micro devices|ati|radeon)/.test(text)) return 'amd'
  if (text.includes('apple')) return 'apple'
  if (text.includes('qualcomm') || text.includes('adreno')) return 'qualcomm'
  if (text.includes('microsoft')) return 'microsoft'
  return 'unknown'
}

/** 设备名 → 独显 / 核显 / 软件渲染。找不到特征时返回 unknown，由打分兜底。 */
export function classifyGpuKind(name: string, vendor: GpuVendor): GpuKind {
  const text = (name ?? '').trim()
  if (SOFTWARE_MARKERS.test(text) || vendor === 'microsoft') return 'software'
  // 独显特征优先：避免 "Radeon RX" 被 "radeon graphics" 误判成核显
  if (DISCRETE_MARKERS.test(text)) return 'discrete'
  if (vendor === 'nvidia') {
    // NVIDIA 没有核显；落在这里的多半是驱动只给了通用名
    return 'discrete'
  }
  // Intel 除 Arc A/B/Pro 独显外都是核显（Meteor Lake 起驱动只报 "Intel(R) Graphics"）
  if (vendor === 'intel') return 'integrated'
  if (vendor === 'apple' || vendor === 'qualcomm') return 'integrated'
  if (INTEGRATED_MARKERS.test(text)) return 'integrated'
  return 'unknown'
}

/**
 * 性能启发式分数（只用于排序，不追求跨代精确）。
 * 独显 1000 基础分 + 型号数字/100；核显 200 基础分；软件渲染 0。
 */
export function gpuPerformanceScore(kind: GpuKind, name: string): number {
  const model = (name ?? '').match(/(\d{3,4})/)?.[1]
  const modelBoost = model ? Number(model) / 100 : 0
  switch (kind) {
    case 'discrete':
      return 1000 + modelBoost
    case 'integrated':
      return 200 + modelBoost
    case 'unknown':
      return 100 + modelBoost
    case 'software':
      return 0
    default:
      return 0
  }
}

/** 组装一份设备信息（Chromium 原始字段 → 我们的结构）。 */
export function describeGpuDevice(input: {
  index: number
  vendorId?: number
  deviceId?: number
  vendorString?: string
  deviceString?: string
  active?: boolean
  driverVersion?: string
}): GpuDeviceInfo {
  const vendor = classifyGpuVendor(input)
  const name = (input.deviceString ?? '').trim() || `${vendor === 'unknown' ? '未知' : vendor.toUpperCase()} 显卡`
  const kind = classifyGpuKind(name, vendor)
  return {
    index: input.index,
    vendorId: typeof input.vendorId === 'number' ? input.vendorId : 0,
    deviceId: typeof input.deviceId === 'number' ? input.deviceId : 0,
    vendor,
    vendorName: (input.vendorString ?? '').trim(),
    name,
    kind,
    active: input.active === true,
    driverVersion: (input.driverVersion ?? '').trim(),
    performanceScore: gpuPerformanceScore(kind, name)
  }
}

/** Chromium 原始枚举项：字段可能缺失；同一块卡可能重复出现。 */
export interface RawGpuDeviceInput {
  vendorId?: number
  deviceId?: number
  vendorString?: string
  deviceString?: string
  driverVersion?: string
  active?: boolean
}

/**
 * 合并 Chromium 的原始枚举项。
 *
 * 实测 `app.getGPUInfo('complete').gpuDevice` 会把同一块核显重复列出 3 次，
 * 还会带一条没有设备名的幽灵条目（driverVersion 0.0.0.0）。
 * 规则：存在具名设备时丢弃无名条目；按 vendorId:deviceId 去重并合并字段，
 * active 取或（任一重复项被标记为在用即视为在用）。去重后重新编号 index。
 */
export function mergeRawGpuDevices(raw: RawGpuDeviceInput[]): GpuDeviceInfo[] {
  const named = raw.filter((device) => (device.deviceString ?? '').trim().length > 0)
  const pool = named.length > 0 ? named : raw
  const merged = new Map<string, RawGpuDeviceInput>()
  for (const device of pool) {
    const key = `${device.vendorId ?? 0}:${device.deviceId ?? 0}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...device })
      continue
    }
    existing.active = existing.active === true || device.active === true
    existing.vendorString = existing.vendorString || device.vendorString
    existing.deviceString = existing.deviceString || device.deviceString
    existing.driverVersion = existing.driverVersion || device.driverVersion
  }
  return [...merged.values()].map((device, index) =>
    describeGpuDevice({
      index,
      vendorId: device.vendorId,
      deviceId: device.deviceId,
      vendorString: device.vendorString,
      deviceString: device.deviceString,
      active: device.active,
      driverVersion: device.driverVersion
    })
  )
}

/**
 * 按偏好挑出应该使用的设备下标。
 * - auto / high-performance：性能分最高（独显优先）
 * - low-power：性能分最低的**硬件**卡（核显优先）
 * 全是软件渲染时返回 null（Chromium 已无硬件可用，界面应提示）。
 */
export function selectPreferredGpuIndex(
  devices: GpuDeviceInfo[],
  preference: GpuPreference
): number | null {
  const hardware = devices.filter((device) => isHardwareGpu(device))
  if (hardware.length === 0) return null
  if (preference === 'low-power') {
    const integrated = hardware.filter((device) => device.kind === 'integrated')
    const pool = integrated.length > 0 ? integrated : hardware
    return pool.reduce((best, device) => (device.performanceScore < best.performanceScore ? device : best)).index
  }
  return hardware.reduce((best, device) => (device.performanceScore > best.performanceScore ? device : best)).index
}

/** 当前偏好命中的设备（界面「将使用」一行）。 */
export function preferredGpuOf(
  diagnostics: Pick<GpuDiagnostics, 'devices' | 'preference'>
): GpuDeviceInfo | null {
  const index = selectPreferredGpuIndex(diagnostics.devices, diagnostics.preference)
  return index === null ? null : diagnostics.devices.find((device) => device.index === index) ?? null
}

/** 已识别的硬件编码器清单（顺序即优先级：NVENC → QSV → AMF）。 */
export const KNOWN_HARDWARE_ENCODERS: readonly HardwareEncoderInfo[] = [
  { name: 'h264_nvenc', vendor: 'nvidia', codec: 'h264' },
  { name: 'h264_qsv', vendor: 'intel', codec: 'h264' },
  { name: 'h264_amf', vendor: 'amd', codec: 'h264' },
  { name: 'hevc_nvenc', vendor: 'nvidia', codec: 'hevc' },
  { name: 'hevc_qsv', vendor: 'intel', codec: 'hevc' },
  { name: 'hevc_amf', vendor: 'amd', codec: 'hevc' },
  { name: 'av1_nvenc', vendor: 'nvidia', codec: 'av1' },
  { name: 'av1_qsv', vendor: 'intel', codec: 'av1' },
  { name: 'av1_amf', vendor: 'amd', codec: 'av1' }
]

/**
 * 解析 `ffmpeg -hide_banner -encoders` 的 stdout。
 * 只认已知硬件编码器名（避免把 vaapi/videotoolbox 等平台相关项误报成 Windows 可用）。
 */
export function parseHardwareEncoders(stdout: string): HardwareEncoderInfo[] {
  const found: HardwareEncoderInfo[] = []
  const lines = stdout.split(/\r?\n/)
  for (const known of KNOWN_HARDWARE_ENCODERS) {
    const present = lines.some((line) => {
      const match = line.match(/^\s*[A-Z.]{2,6}\s+(\S+)/)
      return match?.[1] === known.name
    })
    if (present) found.push({ ...known })
  }
  return found
}

/**
 * 选出最终要用的硬件编码器：
 * - software 模式 → null（强制 libx264）
 * - auto → 优先匹配偏好显卡厂商的 H.264 编码器；否则按 NVENC/QSV/AMF 顺序取第一个
 * 只选 H.264：当前叠加出口固定输出 H.264 MP4，HEVC/AV1 会改变兼容性。
 */
export function pickHardwareEncoder(
  available: HardwareEncoderInfo[],
  options: { mode: VideoEncoderMode; preferredVendor?: GpuVendor }
): HardwareEncoderInfo | null {
  if (options.mode === 'software') return null
  const h264 = available.filter((encoder) => encoder.codec === 'h264')
  if (h264.length === 0) return null
  if (options.preferredVendor && options.preferredVendor !== 'unknown') {
    const matched = h264.find((encoder) => encoder.vendor === options.preferredVendor)
    if (matched) return matched
  }
  return h264[0] ?? null
}

/**
 * 硬件编码参数（H.264）。质量口径对齐现有 libx264 crf：NVIDIA 用 VBR+CQ，
 * QSV 用 global_quality，AMF 用 CQP。返回 null 表示不认识这个编码器。
 */
export function hardwareVideoEncodeArgs(encoderName: string, quality: number): string[] | null {
  const q = Math.max(1, Math.min(51, Math.round(quality)))
  if (encoderName === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0']
  }
  if (encoderName === 'h264_qsv') {
    return ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(q)]
  }
  if (encoderName === 'h264_amf') {
    const qp = String(Math.max(1, Math.min(51, q + 2)))
    return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', qp, '-qp_b', qp]
  }
  return null
}

/** 软件编码参数（现状逐字节保持：libx264 + crf + preset）。 */
export function softwareVideoEncodeArgs(quality: number, preset: string): string[] {
  return ['-c:v', 'libx264', '-crf', String(quality), '-preset', preset]
}

/**
 * 统一入口：给定编码器（null = 软件）与画质档，产出 `-c:v` 段。
 * 未知硬件编码器名一律回退软件编码，绝不产出无法执行的 argv。
 */
export function videoEncodeArgs(options: {
  encoder: string | null
  quality: number
  preset: string
}): string[] {
  if (options.encoder) {
    const hardware = hardwareVideoEncodeArgs(options.encoder, options.quality)
    if (hardware) return hardware
  }
  return softwareVideoEncodeArgs(options.quality, options.preset)
}

/** 设置文件反序列化：任何脏值都安全回落到默认，绝不因配置损坏而拒绝启动。 */
export function normalizeRenderSettings(raw: unknown): RenderSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_RENDER_SETTINGS }
  const value = raw as Record<string, unknown>
  const preference = value['gpuPreference']
  const encoder = value['videoEncoder']
  return {
    gpuPreference:
      preference === 'high-performance' || preference === 'low-power' || preference === 'auto'
        ? preference
        : DEFAULT_RENDER_SETTINGS.gpuPreference,
    videoEncoder:
      encoder === 'auto' || encoder === 'software' ? encoder : DEFAULT_RENDER_SETTINGS.videoEncoder
  }
}

/** Chromium 启动开关名（必须 appendSwitch 在 app ready 之前）。 */
export function gpuPreferenceSwitch(preference: GpuPreference): string | null {
  if (preference === 'high-performance') return 'force_high_performance_gpu'
  if (preference === 'low-power') return 'force_low_power_gpu'
  return null
}

/** 界面文案：设备类型 → 中文标签。 */
export function gpuKindLabel(kind: GpuKind): string {
  switch (kind) {
    case 'discrete':
      return '独立显卡'
    case 'integrated':
      return '集成显卡'
    case 'software':
      return '软件渲染'
    default:
      return '未知设备'
  }
}

/** 界面文案：偏好 → 中文标签。 */
export function gpuPreferenceLabel(preference: GpuPreference): string {
  switch (preference) {
    case 'high-performance':
      return '高性能（独显）'
    case 'low-power':
      return '节能（核显）'
    default:
      return '自动（跟随系统）'
  }
}

/** 界面文案：编码模式 → 中文标签。 */
export function videoEncoderLabel(mode: VideoEncoderMode): string {
  return mode === 'software' ? '仅软件编码' : '自动（优先硬件加速）'
}
