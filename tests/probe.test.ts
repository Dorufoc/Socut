import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeVfrSample, buildProbeResult, detectCompat, parseProbeJson, parseVerifyJson, isProres4444WithAlpha, frameRateMatches, isDeliveryYuv420p, suggestFps } from '@shared/probe'
import { ProgressParser, outTimeRatio } from '../src/main/progressParser'
import { buildSizeEstimate, diskPrecheck, estimateProres4444Bytes, formatBytes } from '@shared/sizeEstimate'
import {
  FPS_23_976,
  FPS_30,
  MEASURED_PRORES_4444_BITS_PER_PIXEL_FRAME,
  PRORES_ESTIMATE_SAFETY_FACTOR
} from '@shared/constants'
import type { VideoMeta } from '@shared/types'

/** ffprobe 解析、兼容性判定、进度解析与体积预估（规格 §5.2 / §6 / §5.3 / §2.3）。 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as unknown

function metaFromFixture(name: string): VideoMeta {
  const parsed = parseProbeJson(fixture(name), `D:/videos/${name}`)
  if (!parsed) throw new Error(`夹具解析失败：${name}`)
  return parsed
}

describe('ffprobe JSON 解析（真实夹具）', () => {
  it('读出分辨率、帧率分数、像素格式与 SAR 修正显示比', () => {
    const meta = metaFromFixture('probe-sar-43-anamorphic.json')
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(240)
    expect(meta.sar).toEqual({ num: 1, den: 1 })
    expect(meta.displayRatio).toBeCloseTo(4 / 3, 6)
    expect(meta.rFrameRate).toEqual({ num: 30, den: 1 })
    expect(meta.avgFrameRate).toEqual({ num: 30, den: 1 })
    expect(meta.pixFmt).toBe('yuv420p')
    expect(meta.videoCodec).toBe('h264')
    expect(meta.audioCodec).toBe('aac')
    expect(meta.nbFrames).toBe(30)
    expect(meta.durationSec).toBeCloseTo(1, 3)
  })

  it('4:3 素材被判为非 16:9 且走 standard 分支（不是竖屏）', () => {
    const meta = metaFromFixture('probe-sar-43-anamorphic.json')
    const flags = detectCompat(meta)
    expect(flags.non169).toBe(true)
    expect(flags.portrait).toBe(false)
    expect(flags.ultraWide).toBe(false)
    expect(flags.hdr).toBe(false)
    expect(flags.audioTranscodeNeeded).toBe(false)
  })

  it('HDR / 竖屏 / 无音轨 / alac 音频的判定（夹具内联对象）', () => {
    const base = metaFromFixture('probe-sdr-169.json')
    const hdr: VideoMeta = { ...base, colorTransfer: 'smpte2084', colorPrimaries: 'bt2020' }
    expect(detectCompat(hdr).hdr).toBe(true)
    const hlg: VideoMeta = { ...base, colorTransfer: 'arib-std-b67' }
    expect(detectCompat(hlg).hdr).toBe(true)
    const vertical: VideoMeta = { ...base, width: 1080, height: 1920, displayRatio: 9 / 16 }
    const verticalFlags = detectCompat(vertical)
    expect(verticalFlags.non169).toBe(true)
    expect(verticalFlags.portrait).toBe(true)
    const noAudio: VideoMeta = { ...base, audioCodec: null, audioChannels: null }
    expect(detectCompat(noAudio).noAudio).toBe(true)
    const alac: VideoMeta = { ...base, audioCodec: 'alac' }
    expect(detectCompat(alac).audioTranscodeNeeded).toBe(true)
  })
})

/**
 * 计划 §测试计划明列的六类 probe 夹具。这里全部跑**真实 ffprobe 输出**
 * （由 `node scripts/make-probe-fixtures.mjs` 用随包 FFmpeg 生成），
 * 而不是手写对象：手写只能验证我已经想到的字段形状，真实输出才能反出
 * 字段缺失/命名/位置（如无音轨时 streams 只有一条、HDR 标签在顶层还是 side_data）。
 */
describe('六类真实 ffprobe 夹具（计划 §测试计划）', () => {
  it('SDR/16:9 + aac：无任何门禁触发', () => {
    const meta = metaFromFixture('probe-sdr-169.json')
    expect([meta.width, meta.height]).toEqual([1920, 1080])
    expect(meta.displayRatio).toBeCloseTo(16 / 9, 4)
    expect(meta.pixFmt).toBe('yuv420p')
    expect(meta.audioCodec).toBe('aac')
    const flags = detectCompat(meta)
    expect(flags.non169).toBe(false)
    expect(flags.hdr).toBe(false)
    expect(flags.noAudio).toBe(false)
    expect(flags.audioTranscodeNeeded).toBe(false)
    expect(flags.vfr).toBe(false)
  })

  it('HDR（bt2020 + smpte2084 + 10bit）：真实字段被 parseProbeJson 读到并触发 hdr', () => {
    const meta = metaFromFixture('probe-hdr-bt2020-pq.json')
    expect(meta.colorPrimaries).toBe('bt2020')
    expect(meta.colorTransfer).toBe('smpte2084')
    expect(meta.colorSpace).toBe('bt2020nc')
    expect(meta.pixFmt).toBe('yuv420p10le')
    const flags = detectCompat(meta)
    expect(flags.hdr).toBe(true)
    expect(meta.audioCodec).toBeNull()
    expect(flags.noAudio).toBe(true)
  })

  it('竖屏 9:16：portrait 分支（不是单纯非 16:9）', () => {
    const meta = metaFromFixture('probe-portrait-916.json')
    expect([meta.width, meta.height]).toEqual([1080, 1920])
    expect(meta.displayRatio).toBeCloseTo(9 / 16, 6)
    const flags = detectCompat(meta)
    expect(flags.non169).toBe(true)
    expect(flags.portrait).toBe(true)
    expect(flags.ultraWide).toBe(false)
    expect(flags.hdr).toBe(false)
  })

  it('无音轨：streams 只有一条时仍能解析，且 noAudio 为真', () => {
    const meta = metaFromFixture('probe-no-audio.json')
    expect(meta.audioCodec).toBeNull()
    expect(meta.audioChannels).toBeNull()
    const flags = detectCompat(meta)
    expect(flags.noAudio).toBe(true)
    // 无音轨时不是“需要转码”，而是根本没有可复制的流（计列 C4 走 -map 0:a?）
    expect(flags.audioTranscodeNeeded).toBe(false)
  })

  it('alac 音轨：不在可 copy 名单 → 必须转码', () => {
    const meta = metaFromFixture('probe-alac-audio.json')
    expect(meta.audioCodec).toBe('alac')
    // 真实 ffprobe 的 format_name 对 .mov 给的是整族名字，不是 'mov'：
    // 任何“按容器名分支”的逻辑都不能拿这个字段做相等比较（已核对：生产代码只展示不判定）。
    expect(meta.containerName).toBe('mov,mp4,m4a,3gp,3g2,mj2')
    const flags = detectCompat(meta)
    expect(flags.audioTranscodeNeeded).toBe(true)
    expect(flags.noAudio).toBe(false)
  })

  it('pcm_s16le 音轨：同样不可 copy，且无音轨与“需转码”不能混淆', () => {
    const meta = metaFromFixture('probe-pcm-audio.json')
    expect(meta.audioCodec).toBe('pcm_s16le')
    const flags = detectCompat(meta)
    expect(flags.noAudio).toBe(false)
    expect(flags.audioTranscodeNeeded).toBe(true)
    // 无音轨那份必须相反：没有流可转，不是“需要转码”
    const silent = metaFromFixture('probe-no-audio.json')
    expect(detectCompat(silent).noAudio).toBe(true)
    expect(detectCompat(silent).audioTranscodeNeeded).toBe(false)
  })

  it('VFR：r 与 avg 分离，且 packet 抽样独立也能得出同一结论', () => {
    const meta = metaFromFixture('probe-vfr.json')
    expect(meta.rFrameRate).toEqual({ num: 60, den: 1 })
    // 真实 VFR 的 avg 与 r 明显分离（这里约 39.5）
    expect(meta.avgFrameRate.num / meta.avgFrameRate.den).toBeLessThan(50)
    expect(detectCompat(meta).vfr).toBe(true)

    // 第二条路径：与生产同命令的 packet 抽样（buildVfrSampleArgs 形状）
    const sampled = fixture('probe-vfr-packets.json') as { packets?: unknown }
    const analysis = analyzeVfrSample(sampled.packets, suggestFps(meta))
    expect(analysis.evidence.sampledPackets).toBeGreaterThan(10)
    expect(analysis.vfr, `maxGap=${analysis.evidence.maxGapSec.toFixed(4)}s`).toBe(true)
    // buildProbeResult 必须把两条证据合并到 flags.vfr
    expect(buildProbeResult(meta, sampled.packets).flags.vfr).toBe(true)
  })

  it('r_frame_rate ≠ avg_frame_rate 判为 VFR；抽样间隔异常也判为 VFR', () => {
    const base = metaFromFixture('probe-sdr-169.json')
    const vfr: VideoMeta = { ...base, avgFrameRate: { num: 29, den: 1 } }
    expect(detectCompat(vfr).vfr).toBe(true)
    const cfr = detectCompat(base)
    expect(cfr.vfr).toBe(false)
    const packets = [
      { pts_time: '0.000000' },
      { pts_time: '0.033333' },
      { pts_time: '0.133333' }, // 间隔 100ms，远超 1/30s
      { pts_time: '0.166666' }
    ]
    const analysis = analyzeVfrSample(packets, FPS_30)
    expect(analysis.vfr).toBe(true)
    expect(analysis.evidence.sampledPackets).toBe(4)
    const steady = analyzeVfrSample(
      [0, 1 / 30, 2 / 30, 3 / 30].map((t) => ({ pts_time: String(t) })),
      FPS_30
    )
    expect(steady.vfr).toBe(false)
  })

  it('suggestFps 吸附到支持的帧率档', () => {
    const base = metaFromFixture('probe-sdr-169.json')
    expect(suggestFps({ ...base, avgFrameRate: { num: 30000, den: 1001 } })).toEqual({ num: 30000, den: 1001 })
    expect(suggestFps({ ...base, avgFrameRate: { num: 25, den: 1 } })).toEqual({ num: 25, den: 1 })
    // 非既约分数 48/2 = 24 → 吸附到 24/1
    expect(suggestFps({ ...base, avgFrameRate: { num: 48, den: 2 } })).toEqual({ num: 24, den: 1 })
    // 23.98 归到 23.976 = 24000/1001
    expect(suggestFps({ ...base, avgFrameRate: { num: 2398, den: 100 } })).toEqual({ num: 24000, den: 1001 })
    const probe = buildProbeResult(base)
    expect(probe.suggestedFps.den).toBeGreaterThan(0)
  })
})

describe('产物校验解析（计划 C1/C3）', () => {
  it('ProRes 4444 判定要求 fourcc=ap4h 且像素格式带 alpha', () => {
    const good = parseVerifyJson({
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          pix_fmt: 'yuva444p12le',
          r_frame_rate: '30/1',
          avg_frame_rate: '30/1',
          nb_frames: '300',
          codec_name: 'prores',
          codec_tag_string: 'ap4h',
          color_range: 'tv',
          color_space: 'bt709'
        }
      ],
      format: { duration: '10.0' }
    })
    expect(good).not.toBeNull()
    if (!good) return
    expect(isProres4444WithAlpha(good)).toBe(true)
    expect(frameRateMatches(good, FPS_30)).toBe(true)
    expect(frameRateMatches(good, FPS_23_976)).toBe(false)
    const noAlpha = { ...good, codecTag: 'apch', pixFmt: 'yuva444p10le' }
    expect(isProres4444WithAlpha(noAlpha)).toBe(false)
    const tenBit444 = { ...good, pixFmt: 'yuv444p10le', codecTag: 'apcn' }
    expect(isProres4444WithAlpha(tenBit444)).toBe(false)
    expect(isDeliveryYuv420p({ ...good, pixFmt: 'yuv420p' })).toBe(true)
    expect(isDeliveryYuv420p(good)).toBe(false)
  })
})

describe('-progress 解析（规格 §5.3）', () => {
  const sample = [
    'frame=1',
    'fps=24.9',
    'stream_0_0_q=0.0',
    'bitrate=N/A',
    'total_size=1024',
    'out_time_us=33333',
    'out_time_ms=33333',
    'dup_frames=0',
    'drop_frames=0',
    'speed=3.2x',
    'progress=continue'
  ].join('\n')

  it('逐字节喂入仍能按行边界解析（半行不产生假进度）', () => {
    const parser = new ProgressParser()
    const bytes = Buffer.from(`${sample}
`, 'utf8')
    let emitted = 0
    for (let i = 0; i < bytes.length; i += 1) {
      if (parser.feed(bytes.subarray(i, i + 1))) emitted += 1
    }
    // 只有 out_time_us 那一行会触发一次快照（progress=continue 不算）
    expect(emitted).toBe(1)
    const current = parser.current()
    expect(current.outTimeUs).toBe(33333)
    expect(current.speed).toBe('3.2x')
    expect(current.ffmpegFrames).toBe(1)
    expect(current.ended).toBe(false)
  })

  it('只采信 out_time_us，忽略 out_time_ms', () => {
    const parser = new ProgressParser()
    const snapshot = parser.feed(Buffer.from(`out_time_ms=999999\nout_time_us=500000\nprogress=end\n`, 'utf8'))
    expect(snapshot?.outTimeUs).toBe(500000)
    expect(snapshot?.ended).toBe(true)
  })

  it('无更新时返回 null（不产生噪声事件）', () => {
    const parser = new ProgressParser()
    expect(parser.feed(Buffer.from('frame=2\n', 'utf8'))).toBeNull()
    expect(parser.feed(Buffer.from('progress=continue\n', 'utf8'))).toBeNull()
    expect(parser.current().outTimeUs).toBe(0)
  })

  it('out_time_us → 比例（超出视为 1）', () => {
    expect(outTimeRatio(500_000, 1)).toBeCloseTo(0.5, 6)
    expect(outTimeRatio(2_000_000, 1)).toBe(1)
    expect(outTimeRatio(10, 0)).toBe(0)
  })
})

describe('体积预估（规格 §2.3）', () => {
  it('随像素与帧数单调增长', () => {
    const small = estimateProres4444Bytes(1920, 1080, FPS_30, 300)
    const big = estimateProres4444Bytes(3840, 2160, { num: 60, den: 1 }, 600)
    expect(big).toBeGreaterThan(small * 4)
  })

  it('4K60 建议时机按实测标定：10s 不误报，30s 才建议 PNG 序列', () => {
    // 旧系数 2.335 下 4K60/10s 会被估到 1.45GB（实际 ~350MB）而误弹「改用 PNG」；
    // 标定后这个尺寸不应触发建议，真正大的时长（30s）才触发。
    const ten = buildSizeEstimate({
      width: 3840,
      height: 2160,
      fps: { num: 60, den: 1 },
      frames: 600,
      freeBytes: 5 * 1024 * 1024 * 1024
    })
    expect(ten.recommendPng, `4K60/10s 预估 ${formatBytes(ten.bytes)} 不应触发 PNG 建议`).toBe(false)
    const thirty = buildSizeEstimate({
      width: 3840,
      height: 2160,
      fps: { num: 60, den: 1 },
      frames: 1800,
      freeBytes: 5 * 1024 * 1024 * 1024
    })
    expect(thirty.recommendPng, `4K60/30s 预估 ${formatBytes(thirty.bytes)} 应触发 PNG 建议`).toBe(true)
    expect(thirty.sufficientDisk).toBe(true)
    expect(formatBytes(thirty.bytes)).toMatch(/GB|MB/)
  })

  it('预估与 M0/M4 实测产物保持同一量级（防止系数漂回误导值）', () => {
    // 实测基准：应用内 1080p30/10s 真实产物 43.2MB（两个预设 + CJK 文字）
    const measuredBytes = 43.2 * 1024 * 1024
    const estimate = estimateProres4444Bytes(1920, 1080, FPS_30, 300)
    const ratio = estimate / measuredBytes
    // 预估必须是保守上界（≥实测），但不能像旧值那样高出一个数量级（≤实测×4）
    expect(ratio, `预估/实测 = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(1)
    expect(ratio, `预估/实测 = ${ratio.toFixed(2)}`).toBeLessThanOrEqual(4)
    // 系数本身也必须等于「实测 × 安全系数」，不能与标定数据脱钩
    expect(PRORES_ESTIMATE_SAFETY_FACTOR).toBe(2)
    expect(estimateProres4444Bytes(1, 1, FPS_30, 1)).toBeLessThanOrEqual(1)
    expect(
      Math.round(MEASURED_PRORES_4444_BITS_PER_PIXEL_FRAME * PRORES_ESTIMATE_SAFETY_FACTOR * 1000) / 1000
    ).toBeCloseTo(1.11, 3)
  })

  it('磁盘不足判定使用 1.5× 安全系数', () => {
    const bytes = estimateProres4444Bytes(1920, 1080, FPS_30, 300)
    const tight = buildSizeEstimate({
      width: 1920,
      height: 1080,
      fps: FPS_30,
      frames: 300,
      freeBytes: bytes * 1.2
    })
    expect(tight.sufficientDisk).toBe(false)
  })

  /**
   * 计划 §5 的硬预检（主进程写盘前拦，不只是 UI 提示）。
   * 重点验证两个“不该拦”的分支：误拒比不拒更难发现。
   */
  it('硬预检：透明 MOV 与两阶段叠加会拦，PNG 序列与直管道不拦', () => {
    const estimate = estimateProres4444Bytes(1920, 1080, FPS_30, 300)
    const common = { width: 1920, height: 1080, fps: FPS_30, frames: 300 }

    const mov = diskPrecheck({ ...common, kind: 'transparentMov', directPipe: false, freeBytes: estimate * 1.2 })
    expect(mov.enforced).toBe(true)
    expect(mov.ok).toBe(false)
    expect(mov.requiredBytes).toBe(Math.round(estimate * 1.5))
    expect(mov.reason).toContain('目标盘可用')

    const overlay = diskPrecheck({ ...common, kind: 'overlayMp4', directPipe: false, freeBytes: estimate * 1.2 })
    expect(overlay.enforced).toBe(true)
    expect(overlay.ok).toBe(false)

    // PNG 序列本身就是磁盘紧张时的推荐出口，拿 ProRes 口径量它必然误拒
    const png = diskPrecheck({ ...common, kind: 'pngSequence', directPipe: false, freeBytes: 1024 })
    expect(png.enforced).toBe(false)
    expect(png.ok).toBe(true)

    // 直管道不落中间 MOV，产物是 H.264，ProRes 系数不适用
    const direct = diskPrecheck({ ...common, kind: 'overlayMp4', directPipe: true, freeBytes: 1024 })
    expect(direct.enforced).toBe(false)
    expect(direct.ok).toBe(true)

    // 空间充足时不拦
    const roomy = diskPrecheck({ ...common, kind: 'transparentMov', directPipe: false, freeBytes: estimate * 4 })
    expect(roomy.ok).toBe(true)
    expect(roomy.reason).toBeUndefined()

    // statfs 不可用：不拦，但必须说明“已跳过”，不能把未校验当成已校验
    const unknown = diskPrecheck({ ...common, kind: 'transparentMov', directPipe: false, freeBytes: undefined })
    expect(unknown.ok).toBe(true)
    expect(unknown.enforced).toBe(true)
    expect(unknown.reason).toContain('跳过')
    expect(formatBytes(estimate)).toMatch(/MB|GB/)
  })
})
