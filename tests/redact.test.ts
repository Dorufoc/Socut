import { describe, expect, it } from 'vitest'
import { maskArgument, maskArgv } from '@shared/redact'
import { buildOverlayMp4 } from '@shared/ffmpegArgs'
import { FPS_23_976 } from '@shared/constants'

/**
 * 失败命令行的展示与脱敏（规格 §9：「失败时把尾部 4KB 呈现给用户并附完整命令行（脱敏路径可选）」）。
 * 脱敏逻辑决定用户提单时会不会泄露本机目录，因此单独锁住。
 */
describe('命令行脱敏（规格 §9）', () => {
  it('绝对路径只保留文件名，参数结构不变', () => {
    expect(maskArgument('D:\\Users\\abc\\Desktop\\code\\FocusNews\\resources\\ffmpeg\\ffmpeg.exe')).toBe('…/ffmpeg.exe')
    expect(maskArgument('E:/素材/参考视频.mp4')).toBe('…/参考视频.mp4')
    expect(maskArgument('/home/user/out.mov')).toBe('…/out.mov')
  })

  it('开关、颜色、时间表达式与纯文件名原样保留', () => {
    for (const arg of ['-y', '-c:v', 'libx264', '#00ff00', '30/1', 'out.mov', 'yuva444p10le']) {
      expect(maskArgument(arg)).toBe(arg)
    }
  })

  it('filter_complex 里含 / 也不得被当成路径截断', () => {
    const filter = buildOverlayMp4({
      refVideoPath: 'D:/v/ref.mp4',
      overlayPath: 'D:/tmp/overlay.mov',
      outputPath: 'D:/out/final.mp4',
      fps: FPS_23_976,
      spanStartSec: 0.5,
      spanEndSec: 4.5,
      audioMode: 'copy',
      fpsMode: 'cfr'
    })
    const filterArg = filter[filter.indexOf('-filter_complex') + 1] ?? ''
    expect(maskArgument(filterArg)).toBe(filterArg)
  })

  it('整条 argv 脱敏后不再包含任何盘符目录', () => {
    const argv = [
      'D:\\ffmpeg\\ffmpeg.exe',
      '-i',
      'D:\\Users\\me\\Desktop\\ref.mp4',
      '-c:v',
      'libx264',
      'C:\\out\\final.mp4'
    ]
    const masked = maskArgv(argv).join(' ')
    expect(masked).not.toContain('Users')
    expect(masked).not.toContain('Desktop')
    // 参数结构仍在，复制出去还能看懂是哪个命令
    expect(masked).toContain('-i')
    expect(masked).toContain('-c:v')
    expect(masked).toContain('libx264')
    expect(masked.split(' ')).toHaveLength(argv.length)
  })
})
