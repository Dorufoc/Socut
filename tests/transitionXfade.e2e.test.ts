import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TRANSITIONS } from '@shared/transitions'

/**
 * M7-E：58 个 xfade 原语真机验证。
 *
 * 对目录里的**每个唯一 xfade 值**跑一次最小滤镜图（两段色块 + xfade），
 * 证明「检查器里能选出来的每一种转场，导出时 FFmpeg 都认」——
 * 这是 `blurV → vblur`（FFmpeg 9 没有这个原语）那类问题的兜底测试。
 */

const FFMPEG = path.resolve('resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const HAS_FFMPEG = existsSync(FFMPEG)

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

describe.skipIf(!HAS_FFMPEG)('58 个 xfade 原语真机可用', () => {
  it('目录里每个唯一 xfade 值都能被 FFmpeg 9 解析并生成输出（58 次）', async () => {
    const xfades = [...new Set(TRANSITIONS.map((meta) => meta.xfade))].sort()
    expect(xfades).toHaveLength(58)

    const failures: string[] = []
    for (const xfade of xfades) {
      const result = await run([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x64:d=0.6:r=5',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=64x64:d=0.6:r=5',
        '-filter_complex',
        `[0:v][1:v]xfade=transition=${xfade}:duration=0.3:offset=0.3[v]`,
        '-map',
        '[v]',
        '-f',
        'null',
        process.platform === 'win32' ? 'NUL' : '/dev/null'
      ])
      if (result.code !== 0) failures.push(`${xfade}: ${result.stderr.split('\n').slice(-2).join(' ').trim()}`)
    }
    expect(failures).toEqual([])
  }, 180_000)
})
