#!/usr/bin/env node
/**
 * FocusNews 一键打包（Windows x64 NSIS 安装包）
 *
 * 与 dist-win.mjs 的区别：
 *  - 打包前做依赖/随包资源预检（缺 FFmpeg、字体、图标时给出可执行的修复命令）
 *  - 清理上次的 win-unpacked，避免旧文件残留进新包
 *  - 打包后输出体积、SHA256，并写入 release/last-package.json
 *  - 可选 --verify：立刻执行 verify-packaged.ps1（静默安装 → 启动 → 覆盖升级 → 卸载）
 *
 * 用法：
 *   npm run package:win                 # 构建 + NSIS 安装包
 *   npm run package:win -- --verify     # 额外做打包后验收（约 2 分钟）
 *   npm run package:win -- --dir        # 只出免安装目录，不打 NSIS
 *   npm run package:win -- --no-open    # 完成后不打开资源管理器
 *   npm run package:win -- --skip-check # 跳过 check:env 预检（不建议）
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(root, 'release')
const cacheDir = path.join(root, '.cache')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('-')))
const positional = argv.filter((arg) => !arg.startsWith('-'))
const unknown = [...flags].filter(
  (flag) => !['--help', '-h', '--verify', '--dir', '--no-open', '--skip-check'].includes(flag)
)

const help = `
FocusNews 一键打包

  npm run package:win                 构建并生成 NSIS 安装包
  npm run package:win -- --verify     打包后再做安装/启动/升级/卸载验收
  npm run package:win -- --dir        只生成免安装目录 release/win-unpacked
  npm run package:win -- --no-open    完成后不打开资源管理器
  npm run package:win -- --skip-check 跳过 check:env 预检

产物：release/FocusNews-<version>-Setup-win-x64.exe
`

if (flags.has('--help') || flags.has('-h')) {
  console.log(help.trim())
  process.exit(0)
}
if (unknown.length > 0) {
  console.error(`[error] 未知参数：${unknown.join(' ')}`)
  console.error(help.trim())
  process.exit(2)
}
if (positional.length > 0) {
  console.error(`[error] 不接受位置参数：${positional.join(' ')}`)
  console.error(help.trim())
  process.exit(2)
}
if (flags.has('--verify') && flags.has('--dir')) {
  console.error('[error] --dir 与 --verify 不能同时使用（验收需要 NSIS 安装包）。')
  process.exit(2)
}

const mode = {
  verify: flags.has('--verify'),
  dirOnly: flags.has('--dir'),
  open: !flags.has('--no-open'),
  check: !flags.has('--skip-check')
}

const env = {
  ...process.env,
  ELECTRON_BUILDER_CACHE: path.join(cacheDir, 'electron-builder'),
  ELECTRON_CACHE: path.join(cacheDir, 'electron'),
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

function log(message) {
  console.log(`[package] ${message}`)
}

function fail(message) {
  console.error(`[package] ✗ ${message}`)
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`需要 Node >= 22.12.0，当前 ${process.version}。请升级 Node 后重试。`)
  }
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function preflight() {
  if (process.platform !== 'win32') {
    throw new Error(`此脚本只支持 Windows（当前 ${process.platform}）。`)
  }
  assertNodeVersion()

  const deps = [
    ['node_modules/electron-vite/bin/electron-vite.js', '依赖缺失，请先运行：npm install'],
    ['node_modules/electron-builder/out/cli/cli.js', '依赖缺失，请先运行：npm install'],
    ['resources/ffmpeg/ffmpeg.exe', '缺少随包 FFmpeg，请运行：npm run fetch:ffmpeg'],
    ['resources/ffmpeg/ffprobe.exe', '缺少随包 ffprobe，请运行：npm run fetch:ffmpeg'],
    ['resources/fonts/manifest.json', '缺少内置字体，请运行：npm run fetch:fonts'],
    ['resources/icons/icon.ico', '缺少应用图标，请运行：npm run make:icon'],
    ['resources/icons/icon.png', '缺少运行时图标，请运行：npm run make:icon'],
    ['electron-builder.yml', '缺少 electron-builder.yml']
  ]
  const missing = []
  for (const [relative, hint] of deps) {
    if (!(await exists(path.join(root, relative)))) missing.push(`  - ${relative}\n    ${hint}`)
  }
  if (missing.length > 0) {
    throw new Error(`打包前置条件不满足：\n${missing.join('\n')}`)
  }
}

function run(file, args, label) {
  return new Promise((resolve, reject) => {
    log(`▶ ${label}`)
    const startedAt = Date.now()
    const child = spawn(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
    const onSignal = () => {
      child.kill('SIGTERM')
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    child.on('error', (error) => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      reject(error)
    })
    child.on('close', (code) => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      if (code === 0) {
        log(`✓ ${label}（${seconds}s）`)
        resolve()
      } else {
        reject(new Error(`${label} 失败，退出码 ${code}`))
      }
    })
  })
}

function runNode(relativeScript, args, label) {
  return run(process.execPath, [path.join(root, relativeScript), ...args], label)
}

async function cleanUnpacked() {
  const unpacked = path.join(releaseDir, 'win-unpacked')
  if (!(await exists(unpacked))) return
  log('清理上次的 release/win-unpacked ...')
  try {
    await fs.rm(unpacked, { recursive: true, force: true })
  } catch (error) {
    throw new Error(
      `无法删除 ${unpacked}，请先关闭正在运行的 FocusNews。\n${error.message}`
    )
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex').toUpperCase()
}

async function findInstaller(expectedName) {
  const expected = path.join(releaseDir, expectedName)
  if (await exists(expected)) {
    const stat = await fs.stat(expected)
    return { name: expectedName, size: stat.size, mtime: stat.mtimeMs }
  }
  const entries = await fs.readdir(releaseDir).catch(() => [])
  const candidates = []
  for (const name of entries) {
    if (!/^FocusNews-.*-Setup-win-x64\.exe$/i.test(name)) continue
    const stat = await fs.stat(path.join(releaseDir, name))
    candidates.push({ name, size: stat.size, mtime: stat.mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0] ?? null
}

async function main() {
  const startedAt = Date.now()
  log('FocusNews 一键打包启动')
  log(`项目目录：${root}`)
  log(`Node ${process.version} / ${process.platform} ${process.arch}`)
  log(`模式：${mode.dirOnly ? '仅免安装目录（--dir）' : 'NSIS 安装包'}${mode.verify ? ' + 打包后验收' : ''}`)
  console.log('')

  await preflight()
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

  if (mode.check) {
    await runNode('scripts/check-env.mjs', [], '环境与随包资源检查（check:env）')
  } else {
    log('已跳过 check:env（--skip-check）')
  }

  await fs.mkdir(releaseDir, { recursive: true })
  await cleanUnpacked()

  await runNode('node_modules/electron-vite/bin/electron-vite.js', ['build'], '构建主进程 / preload / 渲染层')

  const builderArgs = mode.dirOnly ? ['--dir'] : ['--win', '--x64']
  await runNode('node_modules/electron-builder/out/cli/cli.js', builderArgs, mode.dirOnly ? '生成免安装目录' : '生成 NSIS 安装包')

  let summary = null
  if (!mode.dirOnly) {
    const installer = await findInstaller(`FocusNews-${pkg.version}-Setup-win-x64.exe`)
    if (!installer) throw new Error('打包结束但未在 release/ 找到 Setup 安装包，请检查上方 electron-builder 输出。')

    const filePath = path.join(releaseDir, installer.name)
    const hash = await sha256(filePath)
    summary = {
      product: 'FocusNews',
      version: pkg.version,
      installer: filePath,
      sizeBytes: installer.size,
      sizeMB: Number((installer.size / 1024 / 1024).toFixed(2)),
      sha256: hash,
      builtAt: new Date().toISOString(),
      durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1))
    }
    await fs.writeFile(path.join(releaseDir, 'last-package.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

    console.log('')
    log('──────────────────────────────────────────────')
    log(`安装包：${filePath}`)
    log(`体积：${summary.sizeMB} MB（${installer.size} 字节）`)
    log(`SHA256：${hash}`)
    log(`用时：${summary.durationSec}s`)
    log('──────────────────────────────────────────────')
  }

  if (mode.verify) {
    const pwsh = process.platform === 'win32' ? 'pwsh' : 'powershell'
    await run(
      pwsh,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-packaged.ps1')],
      '打包后验收：静默安装 → 启动 → 覆盖升级 → 卸载'
    )
    if (summary) {
      summary.verify = 'passed'
      await fs.writeFile(path.join(releaseDir, 'last-package.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    }
  }

  if (summary && mode.open && process.stdout.isTTY && !process.env.CI) {
    spawn('explorer.exe', [`/select,${summary.installer}`], { detached: true, stdio: 'ignore' }).unref()
  }

  console.log('')
  log(`✓ 全部完成，总用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

main().catch((error) => {
  fail(error.message)
  console.error('[package] 如需完整日志，重新运行并保留上方输出。')
  process.exit(1)
})
