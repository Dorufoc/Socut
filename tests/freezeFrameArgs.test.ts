import { describe, expect, it } from 'vitest'
import { buildFreezeFrameArgs } from '@shared/ffmpegArgs'

/** M5 冻结帧抽帧的 FFmpeg 参数口径（真机行为在 tests/ffmpegPipeline 之外的独立脚本验，这里先钉 argv 形状）。 */
describe('ffmpegArgs.buildFreezeFrameArgs', () => {
  const args = buildFreezeFrameArgs('C:/media/a.mp4', 'C:/freezes/a-2.png', 2.5)

  it('从源视频取单帧：-frames:v 1、无音频/字幕/数据流', () => {
    expect(args).toContain('-frames:v')
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1')
    expect(args).toContain('-an')
  })

  it('-ss 必须落在 -i 之后（先解码再 seek：要的是与时间轴一致的那一帧，不是关键帧近似）', () => {
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'))
    expect(args[args.indexOf('-ss') + 1]).toBe('2.500000')
  })

  it('不做任何缩放/滤镜（全分辨率 PNG 重新上轨），保持静默失败日志级别', () => {
    expect(args).not.toContain('-vf')
    expect(args[args.indexOf('-loglevel') + 1]).toBe('error')
  })

  it('输出路径是最后一个参数，且不覆盖输入', () => {
    expect(args[args.length - 1]).toBe('C:/freezes/a-2.png')
    expect(args.filter((arg) => arg === 'C:/media/a.mp4')).toHaveLength(1)
  })

  it('负时间夹到 0（脏数据不产生非法 seek）', () => {
    const clamped = buildFreezeFrameArgs('C:/a.mp4', 'C:/f.png', -3)
    expect(clamped[clamped.indexOf('-ss') + 1]).toBe('0.000000')
  })
})
