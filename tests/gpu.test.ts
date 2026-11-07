import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RENDER_SETTINGS,
  classifyGpuKind,
  classifyGpuVendor,
  describeGpuDevice,
  gpuKindLabel,
  gpuPerformanceScore,
  gpuPreferenceLabel,
  gpuPreferenceSwitch,
  hardwareVideoEncodeArgs,
  isHardwareGpu,
  mergeRawGpuDevices,
  normalizeRenderSettings,
  parseHardwareEncoders,
  pickHardwareEncoder,
  preferredGpuOf,
  selectPreferredGpuIndex,
  softwareVideoEncodeArgs,
  videoEncodeArgs,
  videoEncoderLabel
} from '@shared/gpu'
import type { GpuDeviceInfo } from '@shared/gpu'

/** 一台典型 Intel + NVIDIA 混合显卡机器（下标 0 = 核显，1 = 独显）。 */
const hybrid = (): GpuDeviceInfo[] => [
  describeGpuDevice({
    index: 0,
    vendorId: 32902,
    deviceId: 18098,
    vendorString: 'Intel',
    deviceString: 'Intel(R) UHD Graphics 630',
    driverVersion: '27.20.100.9316'
  }),
  describeGpuDevice({
    index: 1,
    vendorId: 4318,
    deviceId: 10119,
    vendorString: 'NVIDIA Corporation',
    deviceString: 'NVIDIA GeForce RTX 4060 Laptop GPU',
    driverVersion: '31.0.15.5186',
    active: true
  })
]

/** ffmpeg -encoders 的真实输出片段（含软件与平台相关编码器作干扰项）。 */
const FFMPEG_ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 V....D h264_amf             AMD AMF H.264 Encoder (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_qsv             H.264 (Intel Quick Sync Video) (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 V....D av1_amf              AMD AMF AV1 encoder (codec av1)
`

/** 测试夹具取值：缺失即视为夹具损坏，直接失败而不是静默 undefined。 */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('测试夹具缺少预期项')
  return value
}

describe('classifyGpuVendor / classifyGpuKind', () => {
  it('优先按 PCI vendorId 判定厂商', () => {
    expect(classifyGpuVendor({ vendorId: 4318 })).toBe('nvidia')
    expect(classifyGpuVendor({ vendorId: 32902 })).toBe('intel')
    expect(classifyGpuVendor({ vendorId: 4098 })).toBe('amd')
    expect(classifyGpuVendor({ vendorId: 4203 })).toBe('apple')
    expect(classifyGpuVendor({ vendorId: 20803 })).toBe('qualcomm')
  })

  it('vendorId 缺失时按厂商名/设备名兜底', () => {
    expect(classifyGpuVendor({ vendorString: 'NVIDIA Corporation' })).toBe('nvidia')
    expect(classifyGpuVendor({ deviceString: 'AMD Radeon RX 7800 XT' })).toBe('amd')
    expect(classifyGpuVendor({ deviceString: 'Qualcomm Adreno (TM) 740' })).toBe('qualcomm')
    expect(classifyGpuVendor({})).toBe('unknown')
  })

  it('区分独显、核显与软件渲染', () => {
    expect(classifyGpuKind('NVIDIA GeForce RTX 4060 Laptop GPU', 'nvidia')).toBe('discrete')
    expect(classifyGpuKind('AMD Radeon RX 7800 XT', 'amd')).toBe('discrete')
    expect(classifyGpuKind('Intel(R) Arc(TM) A770 Graphics', 'intel')).toBe('discrete')
    expect(classifyGpuKind('Intel(R) UHD Graphics 630', 'intel')).toBe('integrated')
    expect(classifyGpuKind('AMD Radeon(TM) Graphics', 'amd')).toBe('integrated')
    expect(classifyGpuKind('Apple M3 Pro', 'apple')).toBe('integrated')
    expect(classifyGpuKind('Microsoft Basic Render Driver', 'microsoft')).toBe('software')
    expect(classifyGpuKind('Google SwiftShader', 'unknown')).toBe('software')
  })

  it('Intel 通用名 "Intel(R) Graphics" 判为核显（Meteor Lake 起的真实驱动输出）', () => {
    expect(classifyGpuKind('Intel(R) Graphics', 'intel')).toBe('integrated')
  })

  it('「Radeon RX」不能被「radeon graphics」抢先判成核显', () => {
    expect(classifyGpuKind('AMD Radeon RX 6600', 'amd')).toBe('discrete')
  })

  it('只有真正的硬件卡才算硬件 GPU', () => {
    expect(isHardwareGpu({ kind: 'discrete' })).toBe(true)
    expect(isHardwareGpu({ kind: 'integrated' })).toBe(true)
    expect(isHardwareGpu({ kind: 'unknown' })).toBe(true)
    expect(isHardwareGpu({ kind: 'software' })).toBe(false)
  })
})

describe('gpuPerformanceScore / describeGpuDevice', () => {
  it('独显分数高于核显，核显高于软件渲染', () => {
    expect(gpuPerformanceScore('discrete', 'RTX 4060')).toBeGreaterThan(gpuPerformanceScore('integrated', 'UHD 630'))
    expect(gpuPerformanceScore('integrated', 'UHD 630')).toBeGreaterThan(gpuPerformanceScore('software', 'Basic Render'))
    expect(gpuPerformanceScore('software', 'Basic Render Driver')).toBe(0)
  })

  it('缺字段时给出安全默认值而不是抛错', () => {
    const device = describeGpuDevice({ index: 3 })
    expect(device.index).toBe(3)
    expect(device.vendorId).toBe(0)
    expect(device.deviceId).toBe(0)
    expect(device.name).toContain('显卡')
    expect(device.active).toBe(false)
    expect(device.driverVersion).toBe('')
  })

  it('Chromium 原始字段完整映射', () => {
    const discrete = must(hybrid()[1])
    expect(discrete.name).toBe('NVIDIA GeForce RTX 4060 Laptop GPU')
    expect(discrete.vendor).toBe('nvidia')
    expect(discrete.kind).toBe('discrete')
    expect(discrete.active).toBe(true)
    expect(discrete.driverVersion).toBe('31.0.15.5186')
  })
})

describe('mergeRawGpuDevices', () => {
  it('同一块卡被 Chromium 重复枚举时按 vendorId:deviceId 去重', () => {
    const merged = mergeRawGpuDevices([
      { vendorId: 32902, deviceId: 32103, deviceString: 'Intel(R) Graphics', vendorString: 'Intel', active: false },
      { vendorId: 32902, deviceId: 32103, deviceString: 'Intel(R) Graphics', active: true },
      { vendorId: 32902, deviceId: 32103, deviceString: 'Intel(R) Graphics' },
      { vendorId: 4318, deviceId: 12056, deviceString: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU' }
    ])
    expect(merged).toHaveLength(2)
    expect(merged.map((device) => device.index)).toEqual([0, 1])
    expect(merged[0]?.vendorName).toBe('Intel')
    expect(merged[0]?.active).toBe(true)
    expect(merged[1]?.kind).toBe('discrete')
  })

  it('存在具名设备时丢弃无名的幽灵条目', () => {
    const merged = mergeRawGpuDevices([
      { vendorId: 32902, deviceId: 32103, deviceString: 'Intel(R) Graphics' },
      { vendorId: 32902, deviceId: 44317, driverVersion: '0.0.0.0' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.name).toBe('Intel(R) Graphics')
  })

  it('全部无名时保留原始条目而不是清空列表', () => {
    const merged = mergeRawGpuDevices([{ vendorId: 4318, deviceId: 1, active: true }])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.vendor).toBe('nvidia')
  })

  it('真实混合显卡机器（Intel 在用时默认仍选 RTX）', () => {
    const merged = mergeRawGpuDevices([
      { vendorId: 32902, deviceId: 32103, deviceString: 'Intel(R) Graphics', active: true },
      { vendorId: 4318, deviceId: 12056, deviceString: 'NVIDIA GeForce RTX 5070 Ti Laptop GPU' },
      { vendorId: 5140, deviceId: 140, deviceString: 'Microsoft Basic Render Driver' }
    ])
    expect(merged.map((device) => device.kind)).toEqual(['integrated', 'discrete', 'software'])
    expect(selectPreferredGpuIndex(merged, 'high-performance')).toBe(1)
    expect(selectPreferredGpuIndex(merged, 'low-power')).toBe(0)
  })
})

describe('selectPreferredGpuIndex / preferredGpuOf', () => {
  it('高性能与自动都选性能最高的独显', () => {
    expect(selectPreferredGpuIndex(hybrid(), 'high-performance')).toBe(1)
    expect(selectPreferredGpuIndex(hybrid(), 'auto')).toBe(1)
  })

  it('节能选核显', () => {
    expect(selectPreferredGpuIndex(hybrid(), 'low-power')).toBe(0)
  })

  it('没有核显时节能回落最先可用的硬件卡', () => {
    const onlyDiscrete = hybrid().filter((device) => device.kind === 'discrete')
    expect(selectPreferredGpuIndex(onlyDiscrete, 'low-power')).toBe(1)
  })

  it('只有软件渲染时返回 null', () => {
    const softwareOnly = [
      describeGpuDevice({ index: 0, vendorString: 'Microsoft', deviceString: 'Microsoft Basic Render Driver' })
    ]
    expect(selectPreferredGpuIndex(softwareOnly, 'high-performance')).toBeNull()
    expect(preferredGpuOf({ devices: softwareOnly, preference: 'auto' })).toBeNull()
  })

  it('preferredGpuOf 回传设备本体', () => {
    expect(preferredGpuOf({ devices: hybrid(), preference: 'low-power' })?.name).toContain('UHD')
  })
})

describe('parseHardwareEncoders', () => {
  it('只识别已知硬件编码器，并按优先级排序', () => {
    const names = parseHardwareEncoders(FFMPEG_ENCODERS).map((encoder) => encoder.name)
    expect(names).toEqual(['h264_nvenc', 'h264_qsv', 'h264_amf', 'hevc_nvenc', 'av1_amf'])
  })

  it('不把 vaapi / libx264 误报为 Windows 硬件编码器', () => {
    const names = parseHardwareEncoders(FFMPEG_ENCODERS).map((encoder) => encoder.name)
    expect(names).not.toContain('h264_vaapi')
    expect(names).not.toContain('libx264')
    expect(names).not.toContain('libx265')
  })

  it('空输出得到空数组', () => {
    expect(parseHardwareEncoders('')).toEqual([])
  })

  it('带 CRLF 也能解析', () => {
    const crlf = FFMPEG_ENCODERS.replace(/\n/g, '\r\n')
    expect(parseHardwareEncoders(crlf)).toHaveLength(5)
  })
})

describe('pickHardwareEncoder', () => {
  const available = parseHardwareEncoders(FFMPEG_ENCODERS)

  it('软件模式永远返回 null', () => {
    expect(pickHardwareEncoder(available, { mode: 'software', preferredVendor: 'nvidia' })).toBeNull()
  })

  it('优先匹配偏好显卡厂商', () => {
    expect(pickHardwareEncoder(available, { mode: 'auto', preferredVendor: 'intel' })?.name).toBe('h264_qsv')
    expect(pickHardwareEncoder(available, { mode: 'auto', preferredVendor: 'amd' })?.name).toBe('h264_amf')
  })

  it('厂商不匹配时按 NVENC → QSV → AMF 顺序回落', () => {
    expect(pickHardwareEncoder(available, { mode: 'auto', preferredVendor: 'unknown' })?.name).toBe('h264_nvenc')
    expect(pickHardwareEncoder(available, { mode: 'auto', preferredVendor: 'qualcomm' })?.name).toBe('h264_nvenc')
  })

  it('只有 HEVC/AV1 时返回 null（当前出口固定 H.264）', () => {
    const hevcOnly = parseHardwareEncoders(
      ' V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)\n'
    )
    expect(pickHardwareEncoder(hevcOnly, { mode: 'auto' })).toBeNull()
  })
})

describe('videoEncodeArgs', () => {
  it('encoder=null 时与现状逐字节一致', () => {
    expect(videoEncodeArgs({ encoder: null, quality: 18, preset: 'medium' })).toEqual([
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-preset',
      'medium'
    ])
    expect(videoEncodeArgs({ encoder: null, quality: 18, preset: 'medium' })).toEqual(
      softwareVideoEncodeArgs(18, 'medium')
    )
  })

  it('未知编码器名安全回退软件编码', () => {
    expect(videoEncodeArgs({ encoder: 'h264_vaapi', quality: 18, preset: 'medium' })).toEqual(
      softwareVideoEncodeArgs(18, 'medium')
    )
  })

  it('NVENC 使用 VBR + CQ，画质对齐 crf', () => {
    const args = videoEncodeArgs({ encoder: 'h264_nvenc', quality: 18, preset: 'medium' })
    expect(args.slice(0, 2)).toEqual(['-c:v', 'h264_nvenc'])
    expect(args).toContain('-cq')
    expect(args[args.indexOf('-cq') + 1]).toBe('18')
    expect(args).toContain('-b:v')
    expect(args).not.toContain('-crf')
  })

  it('QSV 使用 global_quality，AMF 使用 CQP', () => {
    expect(hardwareVideoEncodeArgs('h264_qsv', 18)).toEqual([
      '-c:v',
      'h264_qsv',
      '-preset',
      'medium',
      '-global_quality',
      '18'
    ])
    const amf = hardwareVideoEncodeArgs('h264_amf', 18)
    expect(amf?.slice(0, 4)).toEqual(['-c:v', 'h264_amf', '-quality', 'balanced'])
    expect(amf).toContain('-qp_i')
  })

  it('画质参数被夹到 1..51', () => {
    const high = hardwareVideoEncodeArgs('h264_nvenc', 99) ?? []
    expect(high[high.indexOf('-cq') + 1]).toBe('51')
    const low = hardwareVideoEncodeArgs('h264_nvenc', -5) ?? []
    expect(low[low.indexOf('-cq') + 1]).toBe('1')
  })

  it('不认识的编码器返回 null', () => {
    expect(hardwareVideoEncodeArgs('libx264', 18)).toBeNull()
  })
})

describe('normalizeRenderSettings', () => {
  it('脏数据全部回落默认值', () => {
    expect(normalizeRenderSettings(null)).toEqual(DEFAULT_RENDER_SETTINGS)
    expect(normalizeRenderSettings('nope')).toEqual(DEFAULT_RENDER_SETTINGS)
    expect(normalizeRenderSettings({ gpuPreference: 'turbo', videoEncoder: 'gpu' })).toEqual(
      DEFAULT_RENDER_SETTINGS
    )
  })

  it('合法值原样保留', () => {
    expect(normalizeRenderSettings({ gpuPreference: 'low-power', videoEncoder: 'software' })).toEqual({
      gpuPreference: 'low-power',
      videoEncoder: 'software'
    })
  })

  it('缺字段时只补缺的那个', () => {
    expect(normalizeRenderSettings({ gpuPreference: 'auto' })).toEqual({
      gpuPreference: 'auto',
      videoEncoder: DEFAULT_RENDER_SETTINGS.videoEncoder
    })
  })
})

describe('gpuPreferenceSwitch / 文案', () => {
  it('高性能与节能映射到 Chromium 开关，自动不追加开关', () => {
    expect(gpuPreferenceSwitch('high-performance')).toBe('force_high_performance_gpu')
    expect(gpuPreferenceSwitch('low-power')).toBe('force_low_power_gpu')
    expect(gpuPreferenceSwitch('auto')).toBeNull()
  })

  it('默认偏好为高性能独显', () => {
    expect(DEFAULT_RENDER_SETTINGS.gpuPreference).toBe('high-performance')
    expect(DEFAULT_RENDER_SETTINGS.videoEncoder).toBe('auto')
  })

  it('中文标签覆盖所有枚举', () => {
    expect(gpuKindLabel('discrete')).toBe('独立显卡')
    expect(gpuKindLabel('integrated')).toBe('集成显卡')
    expect(gpuKindLabel('software')).toBe('软件渲染')
    expect(gpuKindLabel('unknown')).toBe('未知设备')
    expect(gpuPreferenceLabel('high-performance')).toContain('高性能')
    expect(gpuPreferenceLabel('low-power')).toContain('节能')
    expect(gpuPreferenceLabel('auto')).toContain('自动')
    expect(videoEncoderLabel('auto')).toContain('硬件')
    expect(videoEncoderLabel('software')).toContain('软件')
  })
})
