import { describe, expect, it } from 'vitest'
import { buildOverlayMp4MultiInput, buildProxyArgs, proxyScaleFilter } from '@shared/ffmpegArgs'
import { FPS_30, MEDIA_PROXY } from '@shared/constants'
import {
  isProxyFileOf,
  proxyFileName,
  proxyJobId,
  proxySignature,
  proxyToken
} from '@shared/mediaProxy'

/**
 * v10（Task 10）：4K / MXF 预览代理的 argv 与缓存口径。
 *
 * 锁定四件事：
 * 1. 代理规格（短边 ≤720、长边 ≤1280、30fps、CRF 23、veryfast、AAC 128k、faststart）；
 * 2. 输入可以是 MXF 路径（FFmpeg 原生解码，Chromium 不能）；
 * 3. 签名/令牌含源 size+mtime，源文件替换即失效；文件名按 mediaId 前缀可整批回收；
 * 4. **导出 argv 仍使用原片路径**——代理只服务预览。
 */

const SOURCE = 'D:/media/现场素材.MXF'
const OUTPUT = 'D:/user/proxies/m-1-abcdef12.mp4'

function vfOf(args: string[]): string {
  const index = args.indexOf('-vf')
  return index >= 0 ? (args[index + 1] ?? '') : ''
}

describe('buildProxyArgs', () => {
  it('基础规格：30fps、CRF 23、veryfast、AAC 128k、faststart、mp4', () => {
    const args = buildProxyArgs({ inputPath: SOURCE, outputPath: OUTPUT })

    expect(args.slice(0, 2)).toEqual(['-hide_banner', '-y'])
    expect(args).toContain('-loglevel')
    expect(args[args.indexOf('-loglevel') + 1]).toBe('error')
    // 进度解析依赖 -progress pipe:1（主进程据此更新进度卡）
    expect(args).toContain('-progress')
    expect(args).toContain('pipe:1')

    expect(args[args.indexOf('-i') + 1]).toBe(SOURCE)
    const vf = vfOf(args)
    expect(vf).toContain('fps=30')
    expect(vf).toContain('setsar=1')
    expect(vf).toContain('format=yuv420p')
    // 缩放表达式：长边 1280 / 短边 720 同时夹取（竖屏 720×1280、横屏 1280×720）
    expect(vf).toContain(`min(${MEDIA_PROXY.maxLongSide},${MEDIA_PROXY.maxShortSide}*iw/ih)`)
    expect(vf).toContain(`min(${MEDIA_PROXY.maxShortSide},${MEDIA_PROXY.maxLongSide}*iw/ih)`)
    expect(vf).toContain('h=-2')

    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264')
    expect(args[args.indexOf('-crf') + 1]).toBe('23')
    expect(args[args.indexOf('-preset') + 1]).toBe('veryfast')
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
    expect(args[args.indexOf('-b:a') + 1]).toBe('128k')
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart')
    expect(args[args.indexOf('-f') + 1]).toBe('mp4')
    expect(args[args.length - 1]).toBe(OUTPUT)
  })

  it('无音轨源用 -an（不写音频编码参数）', () => {
    const args = buildProxyArgs({ inputPath: SOURCE, outputPath: OUTPUT, hasAudio: false })
    expect(args).toContain('-an')
    expect(args).not.toContain('-c:a')
    expect(args).not.toContain('128k')
  })

  it('代理缩放表达式：横屏/竖屏/4:3 都按短边 720、长边 1280 保持宽高比', () => {
    const filter = proxyScaleFilter()
    expect(filter.startsWith(`scale=w='`)).toBe(true)
    expect(filter).toContain('trunc(')
    // h=-2 让 FFmpeg 按比例补偶数高度，避免显式双值把画面拉扁
    expect(filter).toContain(`h=-2,fps=30,setsar=1`)
  })
})

describe('签名 / 令牌 / 文件名', () => {
  it('签名含源路径 + size/mtime + 规格；任一变化即失效', () => {
    const base = proxySignature({ sourcePath: SOURCE, sourceBytes: 1024, sourceMtimeMs: 5000 })
    expect(proxySignature({ sourcePath: SOURCE, sourceBytes: 1024, sourceMtimeMs: 5000 })).toBe(base)
    expect(proxySignature({ sourcePath: SOURCE, sourceBytes: 1025, sourceMtimeMs: 5000 })).not.toBe(base)
    expect(proxySignature({ sourcePath: SOURCE, sourceBytes: 1024, sourceMtimeMs: 5001 })).not.toBe(base)
    expect(proxySignature({ sourcePath: 'D:/media/b.mp4', sourceBytes: 1024, sourceMtimeMs: 5000 })).not.toBe(base)
    expect(base).toContain(`short=${MEDIA_PROXY.maxShortSide}`)
    expect(base).toContain(`long=${MEDIA_PROXY.maxLongSide}`)
    expect(base).toContain(`fps=${MEDIA_PROXY.fps}`)
  })

  it('令牌是 8 位十六进制 FNV；同输入同令牌，源指纹变化即变', () => {
    const sig = proxySignature({ sourcePath: SOURCE, sourceBytes: 1024, sourceMtimeMs: 5000 })
    const token = proxyToken(sig, 1024, 5000)
    expect(token).toMatch(/^[0-9a-f]{8}$/)
    expect(proxyToken(sig, 1024, 5000)).toBe(token)
    expect(proxyToken(sig, 2048, 5000)).not.toBe(token)
    expect(proxyToken(sig, 1024, 5001)).not.toBe(token)
  })

  it('文件名按 mediaId 前缀 + 令牌；非法字符安全化，前缀匹配只命中本素材', () => {
    expect(proxyFileName('m-1', 'deadbeef')).toBe('m-1-deadbeef.mp4')
    expect(proxyFileName('../evil id', 'deadbeef')).toBe('___evil_id-deadbeef.mp4')
    expect(proxyJobId('m-1')).toBe('proxy-m-1')
    expect(proxyJobId('../evil')).toBe('proxy-___evil')

    expect(isProxyFileOf('m-1', 'm-1-deadbeef.mp4')).toBe(true)
    expect(isProxyFileOf('m-1', 'm-10-deadbeef.mp4')).toBe(false)
    expect(isProxyFileOf('m-1', 'm-1-deadbeef.trf')).toBe(false)
  })
})

describe('导出仍读原片', () => {
  it('叠加导出 argv 的输入是原片路径，不含代理文件', () => {
    const proxyPath = 'D:/user/proxies/m1-deadbeef.mp4'
    const argv = buildOverlayMp4MultiInput({
      segments: [
        {
          refVideoPath: SOURCE,
          timelineStartSec: 0,
          timelineEndSec: 1,
          sourceInSec: 0,
          sourceOutSec: 1,
          hasAudio: true
        }
      ],
      spanStartSec: 0,
      spanEndSec: 1,
      overlayLabel: '1',
      overlayPath: 'D:/tmp/overlay.mov',
      outputPath: 'D:/out/final.mp4',
      fps: FPS_30,
      frameSize: { width: 320, height: 240 },
      audioMode: 'aac',
      fpsMode: 'cfr'
    })
    expect(argv).toContain(SOURCE)
    expect(argv).not.toContain(proxyPath)
    expect(argv).not.toContain('proxies')
  })
})
