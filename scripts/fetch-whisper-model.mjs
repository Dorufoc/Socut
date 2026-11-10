#!/usr/bin/env node
/**
 * M11：whisper 模型获取（离线资产，默认不随仓库/安装包提交）。
 *
 * 默认取 HuggingFace 上 whisper.cpp 官方 ggml-base.bin（约 148MB）。
 * 说明：
 * - 模型较大，且 huggingface.co 在部分内网不可达 → 支持 `WHISPER_MODEL_URL` 覆盖；
 * - 也支持 `WHISPER_LOCAL_MODEL=C:/path/ggml-base.bin` 直接从本地复制（离线交付）；
 * - 目标目录：resources/models/whisper/ggml-base.bin（whisper 管理器的候选路径之一）。
 *
 * 注意：本脚本不属于 `npm run verify`（CI 只在需要真实转写时取模型），
 * 缺模型时 `whisper.status` 会显示 `ready:false`，`caption.transcribe` 给出可读错误。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'resources', 'models', 'whisper')
const cacheDir = path.join(root, '.cache', 'whisper-model')
const DEFAULT_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
const MIN_BYTES = 20 * 1024 * 1024

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
  const timer = setTimeout(() => controller.abort(), 1_800_000)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < MIN_BYTES) throw new Error(`下载内容过小（${buffer.length} bytes），可能不是模型`)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  await fs.mkdir(targetDir, { recursive: true })
  const target = path.join(targetDir, 'ggml-base.bin')
  if (await exists(target)) {
    const stat = await fs.stat(target)
    console.log(`✓ 模型已存在：${target}（${(stat.size / 1024 / 1024).toFixed(1)} MB）`)
    return
  }

  const localModel = process.env.WHISPER_LOCAL_MODEL
  if (localModel) {
    if (!(await exists(localModel))) throw new Error(`本地模型不存在：${localModel}`)
    await fs.copyFile(localModel, target)
    console.log(`✓ 已复制本地模型 → ${target}`)
    return
  }

  const url = process.env.WHISPER_MODEL_URL || DEFAULT_URL
  const expected = process.env.WHISPER_MODEL_SHA256
  await fs.mkdir(cacheDir, { recursive: true })
  const cacheFile = path.join(cacheDir, 'ggml-base.bin')
  let buffer
  if (await exists(cacheFile)) {
    const cached = await fs.readFile(cacheFile)
    if (cached.length >= MIN_BYTES && (!expected || sha256(cached) === expected)) {
      console.log(`✓ 复用缓存 ${cacheFile}`)
      buffer = cached
    }
  }
  if (!buffer) {
    buffer = await download(url)
    const digest = sha256(buffer)
    if (expected && digest !== expected) throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${digest}`)
    await fs.writeFile(cacheFile, buffer)
    console.log(`✓ 已缓存（sha256=${digest}）`)
  }
  await fs.writeFile(target, buffer)
  const manifest = {
    file: 'ggml-base.bin',
    source: url,
    bytes: buffer.length,
    sha256: sha256(buffer),
    fetchedAt: new Date().toISOString()
  }
  await fs.writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`✓ 已安装模型 → ${target}（${(buffer.length / 1024 / 1024).toFixed(1)} MB）`)
}

main().catch((error) => {
  console.error(`✗ whisper 模型获取失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
