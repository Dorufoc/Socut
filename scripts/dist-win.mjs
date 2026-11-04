#!/usr/bin/env node
/**
 * 离线交付用的完整 NSIS 打包（M4-4）。
 * 把 electron-builder 与 Electron 二进制的缓存都落在仓库内（.cache/），
 * 这样在受限/沙箱环境下也不会因为无法写 %LOCALAPPDATA% 而失败，
 * 且交付机可整目录拷贝缓存做离线复现。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: path.join(root, '.cache', 'electron-builder'),
  ELECTRON_CACHE: path.join(root, '.cache', 'electron'),
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(file)} ${args.join(' ')} 退出码 ${code}`))
    })
  })
}

const steps = [
  ['node_modules/electron-vite/bin/electron-vite.js', ['build']],
  ['node_modules/electron-builder/out/cli/cli.js', ['--win', '--x64']]
]
if (process.argv.includes('--dir')) steps.splice(1, 1, ['node_modules/electron-builder/out/cli/cli.js', ['--dir']])

try {
  for (const [file, args] of steps) {
    console.log(`\n=== ${file} ${args.join(' ')} ===`)
    await run(file, args)
  }
  console.log('\n✓ 打包完成，产物见 release/')
} catch (error) {
  console.error(`\n✗ 打包失败：${error.message}`)
  process.exit(1)
}
