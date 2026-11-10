#!/usr/bin/env node
/**
 * M11：whisper.cpp Windows 二进制获取（离线交付资产）。
 *
 * 语言识别本体由 whisper.cpp 提供；它不属于 npm 依赖，也不适合入库（exe/dll），
 * 所以和 FFmpeg 同一策略：**下载/复制到 resources/whisper/，manifest 记录来源与 SHA256**。
 *
 * 用法：
 *   npm run fetch:whisper                         默认取 v1.8.2 的 whisper-bin-x64.zip
 *   WHISPER_URL=<zip 直链> WHISPER_SHA256=<hex> npm run fetch:whisper
 *   WHISPER_LOCAL_DIR=D:/whisper/bin npm run fetch:whisper   离线交付：从本地目录复制
 *   GH_PROXY=https://mirror/ npm run fetch:whisper             GitHub 走前缀代理
 *
 * 产出：
 *   resources/whisper/whisper-cli.exe + 同目录 dll（ggml*.dll 等）
 *   resources/whisper/manifest.json（source / tag / sha256 / files）
 *
 * 本脚本最后会用 `--help` 自检一次可执行性；失败直接非 0 退出。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'resources', 'whisper')
const cacheDir = path.join(root, '.cache', 'whisper')

const TAG = 'v1.8.2'
const DEFAULT_ZIP = `https://github.com/ggml-org/whisper.cpp/releases/download/${TAG}/whisper-bin-x64.zip`
const REQUIRED = ['whisper-cli.exe']

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function download(url) {
  const proxy = process.env.GH_PROXY
  const finalUrl = proxy && url.includes('github.com') ? `${proxy.replace(/\/$/, '')}/${url}` : url
  console.log(`▶ 下载 ${finalUrl}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 600_000)
  try {
    const response = await fetch(finalUrl, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) throw new Error('下载内容为空')
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function extractZip(zipPath, outDir) {
  try {
    const result = await run('tar', ['-xf', zipPath, '-C', outDir])
    if (result.code === 0) return
    throw new Error(`tar 退出码 ${result.code}`)
  } catch (error) {
    console.warn(`⚠ tar 解压失败，改用 PowerShell Expand-Archive：${error.message}`)
    const result = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`
    ])
    if (result.code !== 0) throw new Error(`Expand-Archive 失败：${result.stderr.slice(0, 400)}`)
  }
}

/** 递归找出需要安装的文件（whisper-cli.exe + 同目录 dll），保留相对目录结构。 */
async function collectBinaries(dir, base = dir, out = []) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectBinaries(full, base, out)
      continue
    }
    // 官方 zip 里还有 bench/stream/server 等工具，安装包只需要 whisper-cli + dll
    if (/\.exe$/i.test(entry.name) && !REQUIRED.includes(entry.name)) continue
    if (!/\.(exe|dll)$/i.test(entry.name)) continue
    out.push({ full, relative: path.relative(base, full) })
  }
  return out
}

async function writeManifest(extra) {
  const manifest = {
    binary: 'whisper-cli.exe',
    tag: TAG,
    fetchedAt: new Date().toISOString(),
    ...extra,
    files: []
  }
  for (const name of REQUIRED) {
    const file = path.join(targetDir, name)
    const content = await fs.readFile(file)
    manifest.files.push({ name, bytes: content.length, sha256: sha256(content) })
  }
  await fs.writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function verifyBinary() {
  const exe = path.join(targetDir, 'whisper-cli.exe')
  const result = await run(exe, ['--help'])
  const text = `${result.stdout}\n${result.stderr}`
  if (result.code !== 0 && !/usage:/i.test(text)) {
    throw new Error(`whisper-cli --help 自检失败（exit ${result.code}）：${text.slice(0, 400)}`)
  }
  console.log('✓ whisper-cli 可执行（--help 自检通过）')
  const version = text.match(/whisper\.cpp[^\n]*/i)?.[0]?.trim()
  if (version) console.log(`  ${version}`)
}

async function main() {
  // 干净安装：先清空旧产出，避免上一次的 bench/stream 等工具残留进安装包
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(targetDir, { recursive: true })
  const localDir = process.env.WHISPER_LOCAL_DIR
  if (localDir) {
    console.log(`▶ 从本地目录复制：${localDir}`)
    const files = await collectBinaries(localDir)
    if (files.length === 0) throw new Error(`本地目录里没有 exe/dll：${localDir}`)
    for (const file of files) {
      const destination = path.join(targetDir, path.basename(file.full))
      await fs.copyFile(file.full, destination)
    }
    const extra = { source: localDir, sha256: null, note: '本地目录复制（离线交付）' }
    await writeManifest(extra)
    await verifyBinary()
    console.log(`✓ 已安装 ${files.length} 个文件到 resources/whisper/`)
    return
  }

  const url = process.env.WHISPER_URL || DEFAULT_ZIP
  const expected = process.env.WHISPER_SHA256
  await fs.mkdir(cacheDir, { recursive: true })
  const cacheFile = path.join(cacheDir, path.basename(new URL(url).pathname || 'whisper.zip'))
  let buffer
  if (await exists(cacheFile)) {
    const cached = await fs.readFile(cacheFile)
    if (!expected || sha256(cached) === expected) {
      console.log(`✓ 复用缓存 ${cacheFile}`)
      buffer = cached
    }
  }
  if (!buffer) {
    buffer = await download(url)
    const digest = sha256(buffer)
    if (expected && digest !== expected) {
      throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${digest}`)
    }
    await fs.writeFile(cacheFile, buffer)
    console.log(`✓ 已缓存（sha256=${digest}）`)
  }

  const temp = path.join(cacheDir, `extract-${Date.now()}`)
  await fs.rm(temp, { recursive: true, force: true })
  await fs.mkdir(temp, { recursive: true })
  const zipPath = path.join(temp, 'whisper.zip')
  await fs.writeFile(zipPath, buffer)
  const unpacked = path.join(temp, 'unpacked')
  await fs.mkdir(unpacked, { recursive: true })
  await extractZip(zipPath, unpacked)

  const binaries = await collectBinaries(unpacked)
  if (binaries.length === 0) throw new Error('压缩包里没有 exe/dll')
  const names = binaries.map((file) => path.basename(file.full))
  for (const required of REQUIRED) {
    if (!names.includes(required)) {
      throw new Error(`压缩包缺少 ${required}（实际：${names.join(', ')}）`)
    }
  }
  for (const file of binaries) {
    // 平坦安装（whisper.cpp 的 zip 里 exe 与 dll 同目录；子目录只用于 README）
    const destination = path.join(targetDir, path.basename(file.full))
    await fs.copyFile(file.full, destination)
  }
  await writeManifest({ source: url, sha256: sha256(buffer), note: `whisper.cpp ${TAG} 官方 Windows 构建` })
  await verifyBinary()
  console.log(`✓ 已安装 ${binaries.length} 个文件到 resources/whisper/`)
}

main().catch((error) => {
  console.error(`✗ whisper 获取失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
