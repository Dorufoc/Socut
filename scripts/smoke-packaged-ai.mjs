#!/usr/bin/env node
/**
 * M8-P1：打包产物里的 AI 抠像运行时烟测（不需要打开 GUI）。
 *
 * 为什么单独一个脚本：onnxruntime-node 是**可选原生依赖**，打包时它被
 * `files` 白名单放进 asar、DLL/binding 由 `asarUnpack` 解到 app.asar.unpacked。
 * 单元测试只证明 `node_modules` 里的运行时装得对，证明不了「装进安装目录后还能
 * dlopen + 加载随包模型」。这里直接用安装目录里的 Electron 以 node 模式跑：
 *   1) app.asar 里主进程入口存在；
 *   2) 从 asar 路径 require('onnxruntime-node') 能拿到 InferenceSession
 *      （binding 的 .node 由 Electron 的 asar 支持重定向到 app.asar.unpacked）；
 *   3) 加载 resources/models/matte/selfie_segmenter.onnx 跑一次真实推理。
 *
 * 前置：先跑 `npm run package:win -- --dir --no-open`（或任意完整打包）产出 release/win-unpacked。
 * 用法：npm run smoke:packaged:ai
 * 退出码：0 = 通过；1 = 失败（CI/台账直接红）
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SELF), '..')
const EXE = process.platform === 'win32' ? '.exe' : ''
const SOCUT = path.join(ROOT, 'release', 'win-unpacked', `Socut${EXE}`)

/** 以 Electron 的 node 模式重跑自己（只有这种模式才具备 asar 支持 + 原生 dlopen 重定向）。 */
async function reexecUnderElectron() {
  if (!fs.existsSync(SOCUT)) {
    console.error(`✗ 找不到免安装目录：${SOCUT}`)
    console.error('  先执行：npm run package:win -- --dir --no-open')
    process.exit(1)
  }
  const child = spawn(SOCUT, [SELF, '--payload'], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode) => resolve(exitCode ?? 1))
  })
  process.exit(Number(code))
}

/** 在 Electron node 模式里执行：从打包后的 asar 加载运行时并真实推理。 */
async function payload() {
  const resources = path.join(path.dirname(process.execPath), 'resources')
  const appAsar = path.join(resources, 'app.asar')
  const mainEntry = path.join(appAsar, 'out', 'main', 'index.js')
  if (!fs.existsSync(mainEntry)) {
    console.error(`✗ asar 里缺少主进程入口：${mainEntry}`)
    process.exit(1)
  }
  console.log(`✓ asar 主进程入口存在：${path.relative(ROOT, mainEntry)}`)

  const require = createRequire(import.meta.url)
  const ort = require(path.join(appAsar, 'node_modules', 'onnxruntime-node'))
  if (typeof ort?.InferenceSession?.create !== 'function') {
    console.error('✗ 打包后的 onnxruntime-node 没有 InferenceSession.create（原生 binding 没解包？）')
    process.exit(1)
  }
  console.log('✓ 打包后的 onnxruntime-node 可加载（asar → app.asar.unpacked 重定向正常）')

  const modelPath = path.join(resources, 'models', 'matte', 'selfie_segmenter.onnx')
  const stat = fs.statSync(modelPath)
  console.log(`✓ 随包 AI matte 模型存在：${path.relative(ROOT, modelPath)}（${stat.size} 字节）`)

  const size = 256
  const session = await ort.InferenceSession.create(modelPath)
  const data = new Float32Array(3 * size * size).fill(0.5)
  const tensor = new ort.Tensor('float32', data, [1, 3, size, size])
  const outputs = await session.run({ [session.inputNames[0]]: tensor })
  const alpha = outputs[session.outputNames[0]]
  if (!alpha || alpha.data.length !== size * size) {
    console.error('✗ 打包后推理输出尺寸不对')
    process.exit(1)
  }
  let sum = 0
  for (const value of alpha.data) sum += value
  console.log(
    `✓ 打包后真实推理通过：输入 ${session.inputNames.join(',')} → 输出 ${session.outputNames.join(',')}，` +
      `alpha 均值 ${(sum / alpha.data.length).toFixed(4)}`
  )
  console.log('✓ AI 抠像运行时打包烟测通过')
}

if (process.argv.includes('--payload')) {
  await payload()
} else {
  await reexecUnderElectron()
}
