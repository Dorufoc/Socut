#!/usr/bin/env node
/**
 * M8：RNNoise 模型获取（FFmpeg `arnndn` 神经网络降噪用的 `.rnnn` 文件）。
 *
 * 与 FFmpeg / 字体 / whisper 同一套离线纪律：模型不进仓库（`resources/models/` 已 gitignore），
 * 由本脚本取回或用户自备；缺模型时导出会明确报错（不会静默退化成 afftdn）。
 *
 * 用法：
 *   npm run fetch:rnnoise                                默认取 std.rnnn（约 300KB 通用模型）
 *   RNNOSE_URL=<直链> npm run fetch:rnnoise              换源（内网镜像/指定语种模型）
 *   RNNOSE_LOCAL_FILE=D:/models/std.rnnn npm run fetch:rnnoise   离线交付：从本地复制
 *
 * 产出：resources/models/rnnoise/std.rnnn + manifest.json（来源与 SHA256）。
 * 取回后做一次 `/resources/ffmpeg/ffmpeg.exe -filters` 可用性提示（不跑真实滤镜，避免慢）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'resources', 'models', 'rnnoise')
const targetFile = path.join(targetDir, 'std.rnnn')
/** rnnoise 社区模型仓储（richardpl/arnndn-models）；abstractive/arnndn-models 是同一批文件的镜像。 */
const DEFAULT_URL = 'https://raw.githubusercontent.com/richardpl/arnndn-models/master/std.rnnn'
const MIN_BYTES = 64 * 1024

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
  console.log(`▶ 下载 ${url}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    // .rnnn 是二进制模型，最小 64KB：太小说明拿到的是 HTML/错误页
    if (buffer.length < MIN_BYTES) throw new Error(`下载内容过小（${buffer.length} bytes），可能不是 .rnnn 模型`)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

async function writeManifest(source, bytes, digest) {
  const manifest = {
    file: 'std.rnnn',
    source,
    bytes,
    sha256: digest,
    fetchedAt: new Date().toISOString()
  }
  await fs.writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function main() {
  await fs.mkdir(targetDir, { recursive: true })
  if (await exists(targetFile)) {
    const stat = await fs.stat(targetFile)
    console.log(`✓ 模型已存在：${targetFile}（${(stat.size / 1024).toFixed(0)} KB）`)
    return
  }

  const localFile = process.env.RNNOSE_LOCAL_FILE
  if (localFile) {
    if (!(await exists(localFile))) throw new Error(`本地模型不存在：${localFile}`)
    const buffer = await fs.readFile(localFile)
    if (buffer.length < MIN_BYTES) throw new Error(`本地文件过小（${buffer.length} bytes），不是 .rnnn 模型`)
    await fs.writeFile(targetFile, buffer)
    await writeManifest(localFile, buffer.length, sha256(buffer))
    console.log(`✓ 已复制本地模型 → ${targetFile}`)
    return
  }

  const url = process.env.RNNOSE_URL || DEFAULT_URL
  const expected = process.env.RNNOSE_SHA256
  const buffer = await download(url)
  const digest = sha256(buffer)
  if (expected && digest !== expected) throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${digest}`)
  await fs.writeFile(targetFile, buffer)
  await writeManifest(url, buffer.length, digest)
  console.log(`✓ 已安装模型 → ${targetFile}（${(buffer.length / 1024).toFixed(0)} KB，sha256=${digest.slice(0, 12)}…）`)
  console.log('  提示：设置里的「AI 降噪」导出时走 arnndn=m=<本文件>，随包打包会自动带上 resources/models/rnnoise/')
}

main().catch((error) => {
  console.error(`✗ RNNoise 模型获取失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
