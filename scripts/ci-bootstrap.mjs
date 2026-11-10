#!/usr/bin/env node
/**
 * M12：CI 资源引导（GitHub Actions / 自建 runner 通用）。
 *
 * 仓库不提交二进制资源（FFmpeg 201MB + 字体），CI 第一次跑必须先取回；
 * 之后由 actions/cache 命中 resources/ffmpeg 与 resources/fonts，本脚本直接跳过。
 *
 * 用法：node scripts/ci-bootstrap.mjs
 * 退出码：0 = 资源齐备；1 = 取回失败（CI 直接红，不进入 verify）
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(label, file, args) {
  return new Promise((resolve, reject) => {
    console.log(`▶ ${label}`)
    const child = spawn(file, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true, env: process.env })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 失败（exit ${code}）`))))
  })
}

async function main() {
  const ffmpeg = path.join(ROOT, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  const ffprobe = path.join(ROOT, 'resources', 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  const fontsManifest = path.join(ROOT, 'resources', 'fonts', 'manifest.json')

  if (!existsSync(ffmpeg) || !existsSync(ffprobe)) {
    await run('取回随包 FFmpeg', process.execPath, ['scripts/fetch-ffmpeg.mjs'])
  } else {
    console.log(`✓ 随包 FFmpeg 已就位：${path.dirname(ffmpeg)}`)
  }
  if (!existsSync(fontsManifest)) {
    await run('取回内置字体', process.execPath, ['scripts/fetch-fonts.mjs'])
  } else {
    console.log('✓ 内置字体已就位')
  }

  const missing = [ffmpeg, ffprobe, fontsManifest].filter((file) => !existsSync(file))
  if (missing.length > 0) {
    console.error(`✗ CI 资源仍缺失：${missing.join('，')}`)
    process.exitCode = 1
    return
  }

  // M8：小模型资产（RNNoise 296KB + AI matte Selfie 452KB）体积可忽略，默认直接取回，
  // 这样 CI 里 "真模型 / 随包模型" 用例会真跑而不是 skip（下载失败只警告，用例自己 skip）。
  const smallModels = [
    ['取回 RNNoise 模型', 'scripts/fetch-rnnoise-model.mjs', path.join(ROOT, 'resources', 'models', 'rnnoise'), '.rnnn'],
    ['取回 AI matte 模型', 'scripts/fetch-matte-model.mjs', path.join(ROOT, 'resources', 'models', 'matte'), '.onnx']
  ]
  for (const [label, script, dir, ext] of smallModels) {
    let hasAsset = false
    try {
      hasAsset = readdirSync(dir).some((name) => name.toLowerCase().endsWith(ext))
    } catch {
      // 目录不存在 = 没资产
    }
    if (hasAsset) {
      console.log(`✓ ${label.replace('取回 ', '')}已就位`)
      continue
    }
    try {
      await run(label, process.execPath, [script])
    } catch (error) {
      console.warn(
        `⚠ ${label}失败（不影响 verify，相关真模型用例会 skip）：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  // M11 whisper 资产是**可选**的（二进制 ~4MB + 模型 141MB）：默认不拉，CI 里由
  // `SOCUT_FETCH_WHISPER=1` 显式开启（配了 actions/cache 的仓库才值得拉）。
  // 失败只警告：真资产验收用例会自动 skip，不阻断 verify。
  if (process.env.SOCUT_FETCH_WHISPER === '1') {
    const whisperExe = path.join(ROOT, 'resources', 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
    for (const [label, script] of [
      ['取回 whisper.cpp 二进制', 'scripts/fetch-whisper.mjs'],
      ['取回 ggml 模型', 'scripts/fetch-whisper-model.mjs']
    ]) {
      if (label.includes('二进制') && existsSync(whisperExe)) {
        console.log(`✓ whisper 二进制已就位：${path.dirname(whisperExe)}`)
        continue
      }
      try {
        await run(label, process.execPath, [script])
      } catch (error) {
        console.warn(`⚠ ${label}失败（不影响 verify，真资产用例会 skip）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  console.log('✓ CI 资源齐备')
}

main().catch((error) => {
  console.error(`✗ CI 资源引导失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
