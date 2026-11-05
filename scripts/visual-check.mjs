#!/usr/bin/env node
/**
 * 视觉检查（8 套字幕条预设 × 短/常规/长模拟文案）。
 *
 * 起一个 electron-vite dev 实例，由渲染进程用**生产渲染路径**出图并计算指标，
 * 报告写到 spikes/artifacts/visual-check/report.json；主进程按报告 passed 退出。
 *
 * 用法：
 *   npm run visual:check
 *
 * 产物：
 *   spikes/artifacts/visual-check/sheet.png        总览（人眼复核）
 *   spikes/artifacts/visual-check/<preset>-*.png   单例全帧
 *   spikes/artifacts/visual-check/report.json      机器报告（逐例指标与失败项）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'spikes', 'artifacts', 'visual-check')
const reportPath = path.join(outDir, 'report.json')
await fs.mkdir(outDir, { recursive: true })
// 先删旧报告：应用有单实例锁，本机开着 FocusNews 时冒烟实例会秒退且退出码 0，
// 不删就会拿上一轮的报告当本轮结果（假绿）
await fs.rm(reportPath, { force: true })

// 清掉所有自动化开关，避免上一次的 SMOKE / PIXELCHECK 抢走启动流程
const env = { ...process.env }
// 例外：隔离 profile（FOCUSNEWS_USER_DATA）是门禁与人工使用共存的关键，必须穿过清理
const isolatedUserData = env.FOCUSNEWS_USER_DATA ?? null
for (const key of Object.keys(env)) if (key.startsWith('FOCUSNEWS_')) delete env[key]
env.FOCUSNEWS_VISUAL_CHECK = reportPath
if (isolatedUserData) env.FOCUSNEWS_USER_DATA = isolatedUserData

const vite = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
console.log(`视觉检查输出目录：${outDir}`)
const child = spawn(process.execPath, [vite, 'dev'], { cwd: root, env, stdio: 'inherit' })

const timer = setTimeout(() => {
  console.error('✗ 视觉检查超时（180s）')
  child.kill()
  process.exitCode = 1
}, 180_000)

child.on('close', async (code) => {
  clearTimeout(timer)
  let reportRead = true
  try {
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
    console.log(
      `\n视觉检查：${report.cases.length} 例 · ${report.structures} 种结构 · ${
        report.passed ? 'PASS' : `FAIL（${report.failures} 项）`
      }`
    )
    console.log(`报告：${reportPath}`)
    console.log(`总览：${path.join(outDir, 'sheet.png')}`)
  } catch {
    reportRead = false
    console.error('✗ 没有读到本轮视觉检查报告（应用可能被单实例锁拦下而秒退，请先关掉正在运行的 FocusNews 窗口）')
  }
  process.exitCode = reportRead ? (code ?? 1) : 1
})
