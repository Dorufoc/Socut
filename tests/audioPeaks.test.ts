import { describe, expect, it } from 'vitest'
import {
  SPECTRUM_BUCKETS_MAX,
  SPECTRUM_BUCKETS_MIN,
  SPECTRUM_FLOOR_DB,
  SPECTRUM_MAX_BYTES,
  SPECTRUM_PX_PER_BAR,
  clipShowsSpectrum,
  normalizeSpectrumPeaks,
  peaksFromPcm,
  pickSpectrumSampleRate,
  spectrumBarHeights,
  spectrumBucketCount,
  spectrumCacheKey,
  spectrumPeaksFromPcm
} from '@shared/audioPeaks'
import type { MediaItem, VideoMeta } from '@shared/types'

/**
 * v9 频谱条的取样口径（主进程折桶 + 渲染层柱高）与「该不该画」的判定。
 *
 * 锁三件事：
 * 1. PCM → 桶峰值的数学（边界、满刻度、静音）；
 * 2. 成本闸门：桶数走档位、取样率受字节上限约束（不许把主进程撑爆）；
 * 3. 无音轨 / 图像素材必须**不画**，而不是画一条空槽。
 */

/** 单声道 s16le 字节（测试里手搓信号，不依赖真文件）。 */
function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true))
  return bytes
}

function meta(over: Partial<VideoMeta> = {}): VideoMeta {
  return {
    path: 'C:/media/a.mp4',
    containerName: 'mp4',
    width: 1920,
    height: 1080,
    sar: null,
    displayRatio: 16 / 9,
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 },
    pixFmt: 'yuv420p',
    colorPrimaries: null,
    colorSpace: null,
    colorTransfer: null,
    colorRange: null,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioChannels: 2,
    durationSec: 30,
    nbFrames: null,
    bitRateKbps: null,
    ...over
  }
}

function item(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media-1',
    path: 'C:/media/a.mp4',
    name: 'a.mp4',
    meta: meta(),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

describe('PCM → 桶峰值', () => {
  it('按样本数等分桶，取每桶的最大绝对值并归一到 0..1', () => {
    const peaks = peaksFromPcm(pcm([0, 16384, -32768, 8192]), 2)
    expect(peaks[0]).toBeCloseTo(0.5, 6)
    expect(peaks[1]).toBeCloseTo(1, 6)
  })

  it('空字节 / 半个样本 / 桶数多于样本数都不抛，只给 0', () => {
    expect(peaksFromPcm(new Uint8Array(0), 4)).toEqual([0, 0, 0, 0])
    expect(peaksFromPcm(new Uint8Array(3), 2)).toHaveLength(2)
    const sparse = peaksFromPcm(pcm([8192]), 4)
    expect(sparse).toHaveLength(4)
    expect(sparse.filter((value) => value > 0).length).toBeGreaterThan(0)
  })

  it('dB 折算：满刻度 1，底噪与静音落在 0，半刻度约 0.9（不是线性的 0.5）', () => {
    const normalized = normalizeSpectrumPeaks([0, 0.5, 1])
    expect(normalized[0]).toBe(0)
    expect(normalized[2]).toBeCloseTo(1, 6)
    // -6.02dBFS 相对 -60dBFS 地板
    expect(normalized[1]).toBeCloseTo((20 * Math.log10(0.5) - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB, 6)
    expect(normalized[1]).toBeGreaterThan(0.85)
  })

  it('低于地板（-60dBFS）的峰值一律当 0，底噪不会拉成满格', () => {
    const tiny = 1 / 1024 // -60.2dBFS
    expect(normalizeSpectrumPeaks([tiny])[0]).toBeCloseTo(0, 6)
  })

  it('spectrumPeaksFromPcm 就是「折桶 + dB 折算」的组合', () => {
    const bytes = pcm([0, 16384, -32768, 8192])
    expect(spectrumPeaksFromPcm(bytes, 2)).toEqual(normalizeSpectrumPeaks(peaksFromPcm(bytes, 2)))
  })
})

describe('成本闸门', () => {
  it('柱数按像素宽走档位（跨档才重新取样），并夹到上下限', () => {
    expect(spectrumBucketCount(0)).toBe(SPECTRUM_BUCKETS_MIN)
    expect(spectrumBucketCount(SPECTRUM_PX_PER_BAR * SPECTRUM_BUCKETS_MIN)).toBe(SPECTRUM_BUCKETS_MIN)
    expect(spectrumBucketCount(SPECTRUM_PX_PER_BAR * 50)).toBe(48)
    expect(spectrumBucketCount(4000)).toBe(SPECTRUM_BUCKETS_MAX)
  })

  it('取样率取「每柱至少 2 样本」的最低档；太长到装不下时返回 0', () => {
    expect(pickSpectrumSampleRate(0, 48)).toBeGreaterThan(0)
    expect(pickSpectrumSampleRate(6, 48)).toBe(2000)
    // 1500s @2kHz 单声道 s16le = 6MB，正好在上限内
    expect(pickSpectrumSampleRate(1500, 96)).toBe(2000)
    expect(pickSpectrumSampleRate(100000, 96)).toBe(0)
    const rate = pickSpectrumSampleRate(1500, 96)
    expect(1500 * rate * 2).toBeLessThanOrEqual(SPECTRUM_MAX_BYTES)
  })

  it('缓存键含素材路径与源区间：换源/改入出点都不会复用旧取样', () => {
    const base = { mediaId: 'm1', path: 'C:/a.mp4', sourceInSec: 1, sourceOutSec: 6, buckets: 48 }
    expect(spectrumCacheKey(base)).toBe(spectrumCacheKey(base))
    expect(spectrumCacheKey(base)).not.toBe(spectrumCacheKey({ ...base, path: 'C:/b.mp4' }))
    expect(spectrumCacheKey(base)).not.toBe(spectrumCacheKey({ ...base, sourceOutSec: 7 }))
    expect(spectrumCacheKey(base)).not.toBe(spectrumCacheKey({ ...base, buckets: 64 }))
  })
})

describe('柱高 = 幅度 × 音量 × 淡入淡出', () => {
  const flat = [1, 1, 1, 1]

  it('音量 50% 时柱高减半，0% 时整条平掉，200% 时夹在满格', () => {
    expect(spectrumBarHeights(flat, { volumePercent: 50, fadeInSec: 0, fadeOutSec: 0 }, 4)).toEqual([0.5, 0.5, 0.5, 0.5])
    expect(spectrumBarHeights(flat, { volumePercent: 0, fadeInSec: 0, fadeOutSec: 0 }, 4)).toEqual([0, 0, 0, 0])
    expect(spectrumBarHeights(flat, { volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 }, 4)).toEqual([1, 1, 1, 1])
  })

  it('渐入画出斜边（前半段渐入 = 每柱 0 → 1）', () => {
    const bars = spectrumBarHeights(flat, { volumePercent: 100, fadeInSec: 2, fadeOutSec: 0 }, 4)
    expect(bars[0]).toBe(0)
    expect(bars[1]).toBeCloseTo(0.5, 6)
    expect(bars[2]).toBeCloseTo(1, 6)
    expect(bars[3]).toBeCloseTo(1, 6)
  })

  it('缺省参数不动形状', () => {
    expect(spectrumBarHeights(flat, undefined, 4)).toEqual([1, 1, 1, 1])
    expect(spectrumBarHeights([], undefined, 4)).toEqual([])
  })
})

describe('该不该画频谱', () => {
  it('无音轨（audioCodec 为 null）不画', () => {
    expect(clipShowsSpectrum(item({ meta: meta({ audioCodec: null }) }))).toBe(false)
  })

  it('图像素材没有声音流，不画', () => {
    expect(clipShowsSpectrum(item({ kind: 'image' }))).toBe(false)
  })

  it('素材已移出池不画；纯音频素材可以画（它也有音轨）', () => {
    expect(clipShowsSpectrum(null)).toBe(false)
    expect(clipShowsSpectrum(undefined)).toBe(false)
    expect(clipShowsSpectrum(item({ kind: 'audio', meta: meta({ width: 0, height: 0, audioCodec: 'mp3' }) }))).toBe(true)
    expect(clipShowsSpectrum(item())).toBe(true)
  })
})
