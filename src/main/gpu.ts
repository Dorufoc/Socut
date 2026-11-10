import { app } from 'electron'
import {
  gpuPreferenceSwitch,
  mergeRawGpuDevices,
  parseHardwareEncoders,
  pickHardwareEncoder,
  preferredGpuOf
} from '../shared/gpu'
import type {
  GpuDeviceInfo,
  GpuDiagnostics,
  GpuPreference,
  HardwareEncoderInfo,
  RawGpuDeviceInput
} from '../shared/gpu'
import { resolveFfmpegBinaries } from './paths'
import { runToEnd } from './ffrun'
import { getRenderSettings, getStartupPreference, markStartupPreference } from './renderSettings'

/**
 * 主进程侧显卡能力枚举。
 *
 * 手动解析 `app.getGPUInfo('complete')` 的返回值（其真实类型是 `unknown`）：
 * Chromium 的字段名与结构随版本可能微调，这里对每个字段做类型收敛，
 * 任何缺失/异常都归一成安全默认值，绝不让设置页因探测失败白屏。
 * GPU 集合在一个进程内是静态的，因此结果按进程缓存。
 */

interface GpuDetection {
  devices: GpuDeviceInfo[]
  softwareRendering: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** auxAttributes 缺失时退回 GPUFeatureStatus：合成状态不以 enabled 开头即视为软件渲染。 */
function softwareRenderingFromFeatureStatus(): boolean {
  try {
    // Electron 可能返回 enabled / enabled_on / enabled_force 等全部算硬件合成
    return !app.getGPUFeatureStatus().gpu_compositing.startsWith('enabled')
  } catch {
    return true
  }
}

let cachedDetection: Promise<GpuDetection> | null = null

/** 单个 Chromium 枚举项 → 纯函数层的输入结构（字段全部做类型收敛）。 */
function readDevice(entry: unknown): RawGpuDeviceInput {
  const device = asRecord(entry) ?? {}
  return {
    vendorId: finiteNumberOf(device['vendorId']),
    deviceId: finiteNumberOf(device['deviceId']),
    // 部分 Chromium 版本 gpuDevice 里没有 vendorString，只有 driverVendor
    vendorString: textOf(device['vendorString']) ?? textOf(device['driverVendor']),
    deviceString: textOf(device['deviceString']),
    driverVersion: textOf(device['driverVersion']),
    active: device['active'] === true
  }
}

async function detectGpuDevicesOnce(): Promise<GpuDetection> {
  try {
    const info = asRecord(await app.getGPUInfo('complete'))
    const rawDevices = Array.isArray(info?.['gpuDevice']) ? (info['gpuDevice'] as unknown[]) : []
    const devices = mergeRawGpuDevices(rawDevices.map(readDevice))
    const aux = asRecord(info?.['auxAttributes'])
    const softwareRendering =
      typeof aux?.['softwareRendering'] === 'boolean'
        ? aux['softwareRendering'] === true
        : softwareRenderingFromFeatureStatus()
    return { devices, softwareRendering }
  } catch {
    // 探测失败时不要谎报「软件渲染」：用 feature status 兜底，拿不到才按软件渲染处理
    return { devices: [], softwareRendering: softwareRenderingFromFeatureStatus() }
  }
}

/** 枚举本机显卡（进程内缓存；失败返回空列表 + 软件渲染标记，绝不抛错）。 */
export function detectGpuDevices(): Promise<GpuDetection> {
  if (!cachedDetection) cachedDetection = detectGpuDevicesOnce()
  return cachedDetection
}

let cachedEncoders: Promise<HardwareEncoderInfo[]> | null = null

async function detectHardwareEncodersOnce(): Promise<HardwareEncoderInfo[]> {
  try {
    const binaries = await resolveFfmpegBinaries()
    if (!binaries.available) return []
    const result = await runToEnd(
      binaries.ffmpeg,
      ['-hide_banner', '-encoders'],
      'gpu-encoders',
      'ffmpeg -encoders'
    )
    return parseHardwareEncoders(result.stdout)
  } catch {
    return []
  }
}

/** 解析 ffmpeg -encoders 里的硬件编码器（进程内缓存；不可用返回空数组，绝不抛错）。 */
export function detectHardwareEncoders(): Promise<HardwareEncoderInfo[]> {
  if (!cachedEncoders) cachedEncoders = detectHardwareEncodersOnce()
  return cachedEncoders
}

/**
 * 启动期应用显卡偏好：按已持久化的设置追加 Chromium 开关。
 * 必须在 app ready（GPU 进程初始化）之前调用，因此在 module scope 执行。
 */
export function applyGpuPreferenceAtStartup(): GpuPreference {
  const preference = getRenderSettings().gpuPreference
  const switchName = gpuPreferenceSwitch(preference)
  if (switchName !== null) app.commandLine.appendSwitch(switchName)
  markStartupPreference(preference)
  return preference
}

/** 设置页体检报告：设备、当前偏好、启动时实际应用值、编码器与最终选择。 */
export async function getGpuDiagnostics(): Promise<GpuDiagnostics> {
  const detection = await detectGpuDevices()
  const hardwareEncoders = await detectHardwareEncoders()
  const settings = getRenderSettings()
  const active = detection.devices.find((device) => device.active) ?? null
  const preferred = preferredGpuOf({ devices: detection.devices, preference: settings.gpuPreference })
  const selectedEncoder = pickHardwareEncoder(hardwareEncoders, {
    mode: settings.videoEncoder,
    preferredVendor: preferred?.vendor
  })
  return {
    devices: detection.devices,
    activeDeviceIndex: active?.index ?? null,
    activeDeviceName: active?.name ?? '未知',
    preference: settings.gpuPreference,
    appliedPreference: getStartupPreference(),
    restartRequired: settings.gpuPreference !== getStartupPreference(),
    softwareRendering: detection.softwareRendering,
    hardwareEncoders,
    selectedEncoder,
    encoderMode: settings.videoEncoder,
    hardwareEncodingAvailable: hardwareEncoders.some((encoder) => encoder.codec === 'h264')
  }
}

/**
 * 导出前决定用哪个硬件编码器（null = 软件编码）。
 * `codec` 缺省 h264（叠加出口默认 H.264），HEVC 选择 hevc_nvenc/qsv/amf。
 * 每次调用都重新读设置（编码模式可即时切换），仅编码器清单与设备清单走缓存。
 * 任何异常都回落 null：硬件不可用绝不能让导出失败。
 */
export async function resolveExportEncoder(codec: 'h264' | 'hevc' | 'av1' = 'h264'): Promise<string | null> {
  try {
    const settings = getRenderSettings()
    if (settings.videoEncoder === 'software') return null
    const detection = await detectGpuDevices()
    const encoders = await detectHardwareEncoders()
    const preferred = preferredGpuOf({ devices: detection.devices, preference: settings.gpuPreference })
    return (
      pickHardwareEncoder(encoders, {
        mode: settings.videoEncoder,
        preferredVendor: preferred?.vendor,
        codec
      })?.name ?? null
    )
  } catch {
    return null
  }
}
