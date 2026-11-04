#!/usr/bin/env node
/**
 * FFmpeg 同源二进制获取脚本（计划 C6）。
 * 不使用 ffprobe-static（2022 停更、351MB 全平台、与 ffmpeg-static 版本错配），
 * 而是从同一个构建里取 ffmpeg.exe + ffprobe.exe，保证探测与编码行为一致。
 *
 * 用法：
 *   npm run fetch:ffmpeg                    默认下载精简同源构建（gyan release-essentials，含 libx264）
 *   FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip  改用完整构建
 *   npm run fetch:ffmpeg -- --from-path     从系统 PATH 复制（仅开发，UI 会明示）
 *   FFMPEG_LOCAL_DIR=D:/ffmpeg/bin npm run fetch:ffmpeg   离线交付：从本地目录复制
 *   FFMPEG_URL=<zip 或 exe 直链> FFMPEG_SHA256=<hex> npm run fetch:ffmpeg
 *   GH_PROXY=https://mirror/ npm run fetch:ffmpeg         GitHub 下载走前缀代理
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'resources', 'ffmpeg')
const cacheDir = path.join(root, '.cache', 'ffmpeg')

// 默认用精简同源构建（含 libx264，够 MP4 叠加与全部生产参数）：
// 体积实测——gyan essentials 100.5MB/个、BtbN master 162MB/个、gyan full 217MB/个，
// 只有 essentials 能把 NSIS 安装包拉回 250–300MB 预算内（实测 227.7MB）。
// 需要完整构建时显式覆盖：
//   FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip
const DEFAULT_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

const REQUIRED = ['ffmpeg.exe', 'ffprobe.exe']

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

/**
 * manifest 里的 note 必须描述**实际下载源**，不能写死成某个构建名。
 * 之前固定输出「BtbN ... gpl」，改用精简同源构建后档案与真值不符，
 * 而 GPL 源码要约（M4-3）要求交付记录与二进制一一对应。
 */
function describeBuild(url) {
  if (url.includes('BtbN/FFmpeg-Builds')) return 'BtbN FFmpeg-Builds win64 gpl 完整版（含 libx264/libx265）'
  if (url.includes('gyan.dev')) {
    return url.includes('essentials')
      ? 'Gyan FFmpeg release-essentials win64 gpl（含 libx264，体积约为完整版一半）'
      : 'Gyan FFmpeg release-full win64 gpl'
  }
  if (url.includes('ffmpeg-static')) return 'ffmpeg-static npm 镜像源'
  return `外部构建：${url}`
}

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

async function download(url) {
  const proxy = process.env.GH_PROXY
  const finalUrl = proxy && url.startsWith('https://github.com/') ? `${proxy.replace(/\/$/, '')}/${url}` : url
  console.log(`→ 下载 ${finalUrl}`)
  const response = await fetch(finalUrl, { redirect: 'follow' })
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${response.statusText}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  console.log(`  收到 ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)
  return buffer
}

function spawnAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, ...options })
    let out = ''
    let err = ''
    let settled = false
    // 无超时的话，一个挂死的子进程会永远吊住整个脚本（本机实捕：ffmpeg.exe -version 长期不退出）
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      reject(new Error(`${file} 超时（${options.timeoutMs ?? 30000}ms）`))
    }, options.timeoutMs ?? 30000)

    child.stdout?.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      err += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: out, stderr: err })
      else reject(new Error(`${file} 退出码 ${code}：${err.slice(-500)}`))
    })
  })
}

/**
 * 解压 zip：优先用 Windows 10/11 自带的 tar（bsdtar 支持 zip），
 * 失败再回退 PowerShell Expand-Archive（在部分受限/无人值守环境下模块无法自动加载）。
 */
async function extractZip(zipPath, outDir) {
  try {
    await spawnAsync('tar', ['-xf', zipPath, '-C', outDir])
    return
  } catch (error) {
    console.warn(`⚠ tar 解压失败，改用 PowerShell Expand-Archive：${error.message}`)
  }
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  await spawnAsync(shell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`
  ])
}

/** 递归查找目标文件名（构建包内层目录形如 <root>/bin/ffmpeg.exe）。 */
async function findRecursive(dir, names, found = new Map()) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await findRecursive(full, names, found)
    } else if (names.includes(entry.name.toLowerCase()) && !found.has(entry.name.toLowerCase())) {
      found.set(entry.name.toLowerCase(), full)
    }
  }
  return found
}

/**
 * 复制到目标目录：先删除旧文件再写。
 * Windows 上直接 copyFile 到存活的 exe 会得到 EBUSY（旧文件被进程持句柄），
 * 而 --force 的本意就是覆盖，所以下面会带重试地先 rm。
 */
async function installFile(source, destination, attempt = 0) {
  try {
    await fs.rm(destination, { force: true })
    await fs.copyFile(source, destination)
  } catch (error) {
    if (attempt >= 3) throw error
    console.warn(`⚠ ${path.basename(destination)} 占用中（${error.code ?? error.message}），2s 后重试 ${attempt + 1}/3`)
    await new Promise((r) => setTimeout(r, 2000))
    return installFile(source, destination, attempt + 1)
  }
}

/**
 * 历次中断/失败会残留 extract-<时间戳> 解包目录（本机实捕：两个 314MB 的遗留目录），
 * 每次开跑前先扫掉，避免 .cache 无限增长。
 */
async function sweepStaleExtracts(dir) {
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('extract-')) continue
    const full = path.join(dir, entry.name)
    await fs.rm(full, { recursive: true, force: true }).catch(() => undefined)
    console.log(`← 清理残留解包目录 ${entry.name}`)
  }
}

async function copyFromDirectory(sourceDir, note) {
  const found = await findRecursive(sourceDir, REQUIRED)
  for (const name of REQUIRED) {
    const source = found.get(name)
    if (!source) throw new Error(`目录内缺少 ${name}：${sourceDir}`)
    await installFile(source, path.join(targetDir, name))
  }
  await writeManifest({ source: sourceDir, sha256: null, note })
  console.log(`✓ 已复制 ${REQUIRED.join(' / ')} → ${targetDir}`)
}

async function fromSystemPath() {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = await spawnAsync(locator, ['ffmpeg']).catch(() => null)
  if (!result) throw new Error('系统 PATH 未找到 ffmpeg，请直接运行默认的下载流程')
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
  if (!first) throw new Error('无法解析 PATH 中的 ffmpeg 位置')
  await copyFromDirectory(path.dirname(first), '来自系统 PATH（仅开发环境，打包必须使用随包二进制）')
}

async function writeManifest(extra) {
  const manifest = { generatedAt: new Date().toISOString(), ...extra, files: [] }
  for (const name of REQUIRED) {
    const file = path.join(targetDir, name)
    if (await exists(file)) {
      const content = await fs.readFile(file)
      manifest.files.push({ name, bytes: content.length, sha256: sha256(content) })
    }
  }
  await fs.writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

async function main() {
  await fs.mkdir(targetDir, { recursive: true })

  const already = await Promise.all(REQUIRED.map((name) => exists(path.join(targetDir, name))))
  if (already.every(Boolean) && !process.argv.includes('--force')) {
    console.log('✓ resources/ffmpeg 已就位；如需重新获取请加 --force')
    return
  }

  if (process.argv.includes('--from-path')) {
    await fromSystemPath()
    return
  }

  const localDir = process.env.FFMPEG_LOCAL_DIR
  if (localDir) {
    await copyFromDirectory(localDir, '来自本地构建目录（离线交付）')
    return
  }

  const url = process.env.FFMPEG_URL || DEFAULT_ZIP
  await fs.mkdir(cacheDir, { recursive: true })
  await sweepStaleExtracts(cacheDir)
  const cacheFile = path.join(cacheDir, path.basename(new URL(url).pathname) || 'ffmpeg-download')

  // 重复构建时复用已下载件（离线/弱网友好），但必须与上一次的 SHA256 一致
  let buffer = null
  let digest = ''
  if (await exists(cacheFile)) {
    const cached = await fs.readFile(cacheFile)
    const cachedDigest = sha256(cached)
    const expected = process.env.FFMPEG_SHA256
    if (!expected || expected.toLowerCase() === cachedDigest) {
      buffer = cached
      digest = cachedDigest
      console.log(`← 复用缓存 ${(buffer.length / 1024 / 1024).toFixed(1)} MB：${cacheFile}`)
    }
  }
  if (!buffer) {
    buffer = await download(url)
    digest = sha256(buffer)
  }
  if (process.env.FFMPEG_SHA256 && process.env.FFMPEG_SHA256.toLowerCase() !== digest) {
    throw new Error(`SHA256 不匹配：期望 ${process.env.FFMPEG_SHA256}，实际 ${digest}`)
  }
  await fs.writeFile(cacheFile, buffer)

  if (url.toLowerCase().endsWith('.zip')) {
    const workDir = path.join(cacheDir, `extract-${Date.now()}`)
    await fs.mkdir(workDir, { recursive: true })
    try {
      await extractZip(cacheFile, workDir)
      const found = await findRecursive(workDir, REQUIRED)
      for (const name of REQUIRED) {
        const source = found.get(name)
        if (!source) throw new Error(`压缩包内未找到 ${name}`)
        await installFile(source, path.join(targetDir, name))
      }
    } finally {
      // 失败（EBUSY / 缺文件）也要回收，否则解包目录会越集越多
      await fs.rm(workDir, { recursive: true, force: true })
    }
    await writeManifest({ source: url, sha256: digest, note: describeBuild(url) })
  } else {
    const name = path.basename(new URL(url).pathname).toLowerCase()
    if (!REQUIRED.includes(name)) throw new Error(`直链文件名无法识别：${name}`)
    await fs.writeFile(path.join(targetDir, name), buffer)
    for (const required of REQUIRED) {
      if (required === name) continue
      if (!(await exists(path.join(targetDir, required)))) {
        throw new Error(`只取到 ${name}，仍缺 ${required}；请改用 zip 构建或设置 FFMPEG_LOCAL_DIR`)
      }
    }
    await writeManifest({ source: url, sha256: digest, note: '单文件直链' })
  }

  const probe = await spawnAsync(path.join(targetDir, 'ffmpeg.exe'), ['-version'], { timeoutMs: 60_000 }).catch((error) => {
    console.warn(`⚠ 本地运行校验未完成（不阻断，可人工复核）：${error.message}`)
    return null
  })
  if (probe) {
    const versionLine = probe.stdout.split('\n')[0].trim()
    console.log(`  ${versionLine}`)
    // 把版本行与许可证判定写回 manifest，作为 docs/assets.md 的可追溯证据
    const manifestFile = path.join(targetDir, 'manifest.json')
    try {
      const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
      manifest.versionLine = versionLine
      manifest.gplConfigured = /--enable-gpl/.test(probe.stdout)
      manifest.license = manifest.gplConfigured ? 'GPL-3.0-or-later（需随包提供源码要约）' : 'LGPL-2.1-or-later'
      await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      console.log(`  构建许可证判定：${manifest.gplConfigured ? 'GPL' : 'LGPL'}`)
    } catch (error) {
      console.warn(`⚠ manifest 版本信息补写失败（不阻断）：${error.message}`)
    }
  }
  console.log('✓ FFmpeg 就绪：', targetDir)
  console.log('  合规提示：GPL 构建需在交付物中提供 FFmpeg 源码获取途径（见 docs/assets.md）')
}

main().catch((error) => {
  console.error(`✗ fetch-ffmpeg 失败：${error.message}`)
  console.error('  离线场景：设置 FFMPEG_LOCAL_DIR=<含 ffmpeg.exe/ffprobe.exe 的目录>，或使用 --from-path。')
  process.exit(1)
})
