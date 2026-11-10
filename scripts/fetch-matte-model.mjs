#!/usr/bin/env node
/**
 * M8-P1：AI 人像抠像模型获取（MediaPipe Selfie Segmenter 256²，ONNX）。
 *
 * 许可证与来源（必须与台账 M8-F 一致）：
 * - 模型：MediaPipe Selfie Segmenter（Google MediaPipe），Apache-2.0；
 * - ONNX 转换版：https://huggingface.co/onnx-community/mediapipe_selfie_segmentation （Apache-2.0）；
 * - 默认直链：.../resolve/main/onnx/model.onnx（约 451KB，输入 pixel_values 1×3×256×256 float32，
 *   输出 alphas 1×1×256×256，值域 0..1）。
 *
 * 与 FFmpeg / 字体 / whisper / rnnoise 同一套离线纪律：模型不进仓库（`resources/models/` 已 gitignore），
 * 由本脚本取回或用户自备；缺模型时检查器「AI 抠像」显示未就绪，导出前给明确错误，绝不静默降级。
 *
 * 用法：
 *   npm run fetch:matte:model                                默认下载 Selfie 模型
 *   MATTE_MODEL_URL=<直链> npm run fetch:matte:model         换源（内网镜像）
 *   MATTE_MODEL_LOCAL_FILE=D:/models/selfie_segmenter.onnx npm run fetch:matte:model   离线交付
 *   MATTE_MODEL_SHA256=<期望 sha256> npm run fetch:matte:model   强制校验
 *
 * 产出：resources/models/matte/selfie_segmenter.onnx + manifest.json（来源/许可/SHA256）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = path.join(root, 'resources', 'models', 'matte')
const targetFile = path.join(targetDir, 'selfie_segmenter.onnx')
const DEFAULT_URL =
  'https://huggingface.co/onnx-community/mediapipe_selfie_segmentation/resolve/main/onnx/model.onnx'
const LICENSE = 'Apache-2.0 (Google MediaPipe Selfie Segmenter; ONNX conversion by onnx-community)'
const MIN_BYTES = 256 * 1024
const MAX_BYTES = 8 * 1024 * 1024

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function validate(buffer) {
  if (buffer.length < MIN_BYTES) throw new Error(`文件过小（${buffer.length} bytes），可能不是 ONNX 模型`)
  if (buffer.length > MAX_BYTES) throw new Error(`文件过大（${buffer.length} bytes），超出 Selfie 模型预期`)
  // ONNX protobuf 没有 magic；用首字节粗判：0x08 是 field 1 varint（ir_version），HTML 错误页会是 '<'
  if (buffer[0] === 0x3c) throw new Error('下载内容是 HTML/错误页，不是 ONNX 模型')
}

async function download(url) {
  console.log(`▶ 下载 ${url}`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    validate(buffer)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

async function writeManifest(source, bytes, digest) {
  const manifest = {
    file: 'selfie_segmenter.onnx',
    model: 'MediaPipe Selfie Segmenter 256x256',
    license: LICENSE,
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

  const localFile = process.env.MATTE_MODEL_LOCAL_FILE
  if (localFile) {
    if (!(await exists(localFile))) throw new Error(`本地模型不存在：${localFile}`)
    const buffer = await fs.readFile(localFile)
    validate(buffer)
    await fs.writeFile(targetFile, buffer)
    await writeManifest(`local:${localFile}`, buffer.length, sha256(buffer))
    console.log(`✓ 已复制本地模型 → ${targetFile}`)
    return
  }

  const url = process.env.MATTE_MODEL_URL || DEFAULT_URL
  const expected = process.env.MATTE_MODEL_SHA256
  const buffer = await download(url)
  const digest = sha256(buffer)
  if (expected && digest !== expected) throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${digest}`)
  await fs.writeFile(targetFile, buffer)
  await writeManifest(url, buffer.length, digest)
  console.log(`✓ 已安装模型 → ${targetFile}（${(buffer.length / 1024).toFixed(0)} KB，sha256=${digest.slice(0, 12)}…）`)
  console.log(`  许可：${LICENSE}`)
  console.log('  提示：检查器「AI 抠像」导出前会在主进程用 onnxruntime-node 加载本模型，随包打包会自动带上 resources/models/matte/')
}

main().catch((error) => {
  console.error(`✗ AI matte 模型获取失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
