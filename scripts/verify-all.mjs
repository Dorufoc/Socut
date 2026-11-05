#!/usr/bin/env node
/**
 * 一次性跑完全部可自动化验证（计划 M4-6「断言脚本化」的落地形态）。
 *
 * 之前每个取证场景都要手敲一条命令、人肉看退出码；这份脚本把门禁、CLI 冒烟、
 * 应用内八个场景、评审表出图串成一条链，产出一个可归档的总结文件：
 *   spikes/verify-all.json（每项退出码 + 关键读数）
 * 任一步失败即整体退出码 1，并明确指出是哪一步。
 *
 * 用法：
 *   npm run verify:all                 # 全量（含 NSIS 之前的所有验证）
 *   npm run verify:all -- --quick      # 跳过应用内场景（只跑门禁 + CLI 冒烟）
 * 前置：npm install、npm run fetch:ffmpeg、npm run fetch:fonts、npm run make:fixtures
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QUICK = process.argv.includes('--quick')
const outDir = path.join(root, 'spikes', 'app-smoke')
const artifacts = path.join(root, 'spikes', 'artifacts')

const results = []

function run(file, args, env = {}, timeoutMs = 900_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      reject(new Error(`超时 ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** 读回场景产出的 JSON，摘几行关键数字进总结（失败时不影响判定，只标注读不到）。 */
async function peek(file, pick) {
  try {
    const json = JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))
    return pick(json)
  } catch {
    return null
  }
}

async function step(label, file, args, env, timeoutMs, pick) {
  const started = Date.now()
  let result
  try {
    result = await run(file, args, env, timeoutMs)
  } catch (error) {
    results.push({ label, code: null, ok: false, note: `执行异常：${String(error)}` })
    console.log(`FAIL ${label} — 执行异常 ${String(error)}`)
    return false
  }
  const ok = result.code === 0
  const facts = pick ? await peek(pick.file, pick.select) : null
  results.push({
    label,
    code: result.code,
    ok,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    facts
  })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} (exit ${result.code}, ${((Date.now() - started) / 1000).toFixed(1)}s)${facts ? ` ${JSON.stringify(facts)}` : ''}`)
  if (!ok) {
    const tail = (result.stderr || result.stdout).split(/\r?\n/).filter(Boolean).slice(-6).join('\n    ')
    console.log(`    ${tail}`)
  }
  return ok
}

const node = process.execPath
const vite = 'node_modules/electron-vite/bin/electron-vite.js'
const vitest = 'node_modules/vitest/vitest.mjs'
const tsc = 'node_modules/typescript/bin/tsc'
const eslint = 'node_modules/eslint/bin/eslint.js'

async function main() {
  await fs.mkdir(outDir, { recursive: true })

  // --- 门禁 ---
  await step('check:env', node, ['scripts/check-env.mjs'])
  await step('lint', node, [eslint, '.'])
  for (const project of ['node', 'web', 'tests']) {
    await step(`typecheck:${project}`, node, [tsc, '--noEmit', '-p', `tsconfig.${project}.json`])
  }
  await step('vitest（164 用例，node 148 + dom 16）', node, [vitest, 'run'])

  // --- CLI 集成冒烟（不依赖 Electron）---
  await step('CLI 冒烟：1080p30/10s 透明 MOV', node, ['scripts/smoke-export.mjs', '--width', '1920', '--height', '1080', '--fps', '30/1', '--seconds', '10'])
  await step('CLI 冒烟：720p 叠加合成（C3/C4 锁定）', node, ['scripts/smoke-export.mjs', '--overlay', '--width', '1280', '--height', '720', '--fps', '24000/1001', '--seconds', '5'])

  if (!QUICK) {
    const base = { FOCUSNEWS_SMOKE: '1', FOCUSNEWS_SMOKE_GATE: '0', FOCUSNEWS_SMOKE_OVERLAY: '0', FOCUSNEWS_SMOKE_CANCEL: '0', FOCUSNEWS_SMOKE_KIND: 'transparentMov', FOCUSNEWS_SMOKE_DELIVERY: 'pipe', FOCUSNEWS_SMOKE_AUDIO: '', FOCUSNEWS_PIXELCHECK: '', FOCUSNEWS_SHOT: '', FOCUSNEWS_SHOT_ERROR: '', FOCUSNEWS_SHOT_REFMISSING: '', FOCUSNEWS_REVIEW_SHEET: '' }
    const reportPick = {
      file: 'spikes/app-smoke/report.json',
      select: (json) => ({
        passed: json.verification?.passed,
        frames: json.report?.framesTotal,
        sec: Number(((json.report?.elapsedMs ?? 0) / 1000).toFixed(2)),
        extrapolated: json.verification?.checks?.extrapolated1080p30_10sSec ?? null
      })
    }

    await step('应用内：1080p30/10s 透明 MOV（验收 2/3）', node, [vite, 'dev'], { ...base, FOCUSNEWS_SMOKE_W: '1920', FOCUSNEWS_SMOKE_H: '1080', FOCUSNEWS_SMOKE_FPS: '30', FOCUSNEWS_SMOKE_SEC: '10' }, 600_000, reportPick)
    await step('应用内：4K60/2s 冒烟（M4-6）', node, [vite, 'dev'], { ...base, FOCUSNEWS_SMOKE_W: '3840', FOCUSNEWS_SMOKE_H: '2160', FOCUSNEWS_SMOKE_FPS: '60', FOCUSNEWS_SMOKE_SEC: '2' }, 600_000, reportPick)
    await step('应用内：取消透明 MOV（验收 8）', node, [vite, 'dev'], { ...base, FOCUSNEWS_SMOKE_CANCEL: '1', FOCUSNEWS_SMOKE_W: '640', FOCUSNEWS_SMOKE_H: '360', FOCUSNEWS_SMOKE_SEC: '20' }, 600_000, reportPick)
    await step('应用内：PNG 序列独立出口（C40）', node, [vite, 'dev'], { ...base, FOCUSNEWS_SMOKE_KIND: 'pngSequence', FOCUSNEWS_SMOKE_W: '640', FOCUSNEWS_SMOKE_H: '360', FOCUSNEWS_SMOKE_SEC: '2' }, 600_000, reportPick)
    await step('应用内：取消 PNG 序列（目录回收 C41）', node, [vite, 'dev'], { ...base, FOCUSNEWS_SMOKE_KIND: 'pngSequence', FOCUSNEWS_SMOKE_CANCEL: '1', FOCUSNEWS_SMOKE_W: '640', FOCUSNEWS_SMOKE_H: '360', FOCUSNEWS_SMOKE_SEC: '20' }, 600_000, reportPick)
    await step('应用内：MOV 的 pngSequence 回退（C42）', node, [vite, 'dev'], { ...base, FOCUSNEWS_SMOKE_DELIVERY: 'pngSequence', FOCUSNEWS_SMOKE_W: '640', FOCUSNEWS_SMOKE_H: '360', FOCUSNEWS_SMOKE_SEC: '2' }, 600_000, reportPick)
    await step('应用内：叠加 720p23.976（验收 4/5/6/7）', node, [vite, 'dev'], {
      ...base, FOCUSNEWS_SMOKE_OVERLAY: '1', FOCUSNEWS_SMOKE_REF: path.join(artifacts, 'ref-720p23976.mp4')
    }, 600_000, reportPick)
    await step('应用内：门禁端到端（验收 5/6）', node, [vite, 'dev'], { ...base, FOCUSNEWS_SMOKE_GATE: '1' }, 600_000, reportPick)
    await step('应用内：逐像素一致性（M1-7）', node, [vite, 'dev'], {
      ...base, FOCUSNEWS_SMOKE: '0', FOCUSNEWS_PIXELCHECK: path.join(outDir, 'pixel-parity.json')
    }, 600_000, {
      file: 'spikes/app-smoke/pixel-parity.json',
      select: (json) => ({ passed: json.passed, frames: json.frames?.length, dpr: json.devicePixelRatio, blitSize: json.frames?.[0]?.scaled?.blitSize })
    })
    await step('应用内：错误呈现取证（M4-2/§9）', node, [vite, 'dev'], {
      ...base, FOCUSNEWS_SMOKE: '0', FOCUSNEWS_SHOT_ERROR: '1'
    }, 600_000, {
      file: 'spikes/app-smoke/error-demo.json',
      select: (json) => ({ passed: json.passed, argvSegments: json.argvSegments, stderrTailBytes: json.stderrTailBytes })
    })
    await step('应用内：逐帧动画评审表出图（M4-7）', node, [vite, 'dev'], {
      ...base, FOCUSNEWS_SMOKE: '0', FOCUSNEWS_REVIEW_SHEET: path.join(artifacts, 'review-sheet-1080p.png'), FOCUSNEWS_REVIEW_BACKDROP: path.join(artifacts, 'review-backdrop.png')
    }, 600_000)
    // 视觉检查：8 预设 × 短/常规/长文案，出图 + 指标，失败时非 0 退出码
    await step('应用内：字幕条视觉检查（8 预设 × 3 文案）', node, ['scripts/visual-check.mjs'], {}, 600_000)
  }

  const failed = results.filter((item) => !item.ok)
  const summary = {
    generatedAt: new Date().toISOString(),
    quick: QUICK,
    passed: failed.length === 0,
    steps: results.length,
    failedSteps: failed.map((item) => item.label),
    results
  }
  const file = path.join(root, 'spikes', 'verify-all.json')
  await fs.writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`\n${summary.passed ? 'VERIFY ALL PASS' : `VERIFY ALL FAIL: ${failed.length}/${results.length} 步未通过`} → ${path.relative(root, file)}`)
  if (!summary.passed) process.exit(1)
}

main().catch((error) => {
  console.error(`VERIFY ALL ABORTED: ${error.stack ?? error.message}`)
  process.exit(1)
})
