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

/**
 * 取证产物在本轮启动前先删掉。
 * 不这么做会假绿：应用有单实例锁，用户开着 Socut 时冒烟实例会**秒退且退出码 0**，
 * 于是上一轮留下的 report.json 被当成本轮结果读出来（实测读数：每步 frames=0 / 1.08s）。
 */
async function clearArtifacts(pickFile, extraFiles = []) {
  const targets = [pickFile, ...extraFiles].filter(Boolean)
  for (const target of targets) {
    await fs.rm(path.join(root, target), { force: true }).catch(() => undefined)
  }
  return targets
}

async function step(label, file, args, env, timeoutMs, pick, extraArtifacts = []) {
  const started = Date.now()
  const artifacts = await clearArtifacts(pick?.file, extraArtifacts)
  let result
  try {
    result = await run(file, args, env, timeoutMs)
  } catch (error) {
    results.push({ label, code: null, ok: false, note: `执行异常：${String(error)}` })
    console.log(`FAIL ${label} — 执行异常 ${String(error)}`)
    return false
  }
  const facts = pick ? await peek(pick.file, pick.select) : null
  // 取证文件没写出来 = 本轮根本没跑成（典型：单实例锁导致秒退），不能算通过
  let missing = null
  if (result.code === 0) {
    for (const target of artifacts) {
      const exists = await fs.stat(path.join(root, target)).then(() => true, () => false)
      if (!exists) {
        missing = target
        break
      }
    }
  }
  const ok = result.code === 0 && missing === null && (pick === undefined || facts !== null)
  results.push({
    label,
    code: result.code,
    ok,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    facts,
    ...(missing ? { note: `取证文件未产出：${missing}` } : {})
  })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} (exit ${result.code}, ${((Date.now() - started) / 1000).toFixed(1)}s)${facts ? ` ${JSON.stringify(facts)}` : ''}`)
  if (!ok) {
    const reason =
      missing !== null
        ? `取证文件未产出（${missing}）——若本机正开着 Socut 窗口，请先关掉再跑，单实例锁会让冒烟秒退`
        : facts === null && pick !== undefined
          ? `取证文件无法解析（${pick.file}）`
          : ''
    if (reason) console.log(`    ${reason}`)
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
  await step('vitest（666 用例，node + dom 两套）', node, [vitest, 'run'])

  // --- CLI 集成冒烟（不依赖 Electron）---
  await step('CLI 冒烟：1080p30/10s 透明 MOV', node, ['scripts/smoke-export.mjs', '--width', '1920', '--height', '1080', '--fps', '30/1', '--seconds', '10'])
  await step('CLI 冒烟：720p 叠加合成（C3/C4 锁定）', node, ['scripts/smoke-export.mjs', '--overlay', '--width', '1280', '--height', '720', '--fps', '24000/1001', '--seconds', '5'])

  if (!QUICK) {
    // 隔离 profile：单实例锁会让冒烟实例秒退（退出码仍 0），上一轮报告会被当成本轮结果
    const gateUserData = path.join(root, 'spikes', 'tmp-integration', 'gate-userdata')
    await fs.mkdir(gateUserData, { recursive: true })
    const base = { SOCUT_SMOKE: '1', SOCUT_USER_DATA: gateUserData, SOCUT_SMOKE_GATE: '0', SOCUT_SMOKE_OVERLAY: '0', SOCUT_SMOKE_CANCEL: '0', SOCUT_SMOKE_KIND: 'transparentMov', SOCUT_SMOKE_DELIVERY: 'pipe', SOCUT_SMOKE_AUDIO: '', SOCUT_PIXELCHECK: '', SOCUT_SHOT: '', SOCUT_SHOT_ERROR: '', SOCUT_SHOT_REFMISSING: '', SOCUT_REVIEW_SHEET: '' }
    const reportPick = {
      file: 'spikes/app-smoke/report.json',
      select: (json) => ({
        passed: json.verification?.passed,
        frames: json.report?.framesTotal,
        sec: Number(((json.report?.elapsedMs ?? 0) / 1000).toFixed(2)),
        extrapolated: json.verification?.checks?.extrapolated1080p30_10sSec ?? null
      })
    }

    await step('应用内：1080p30/10s 透明 MOV（验收 2/3）', node, [vite, 'dev'], { ...base, SOCUT_SMOKE_W: '1920', SOCUT_SMOKE_H: '1080', SOCUT_SMOKE_FPS: '30', SOCUT_SMOKE_SEC: '10' }, 600_000, reportPick)
    await step('应用内：4K60/2s 冒烟（M4-6）', node, [vite, 'dev'], { ...base, SOCUT_SMOKE_W: '3840', SOCUT_SMOKE_H: '2160', SOCUT_SMOKE_FPS: '60', SOCUT_SMOKE_SEC: '2' }, 600_000, reportPick)
    await step('应用内：取消透明 MOV（验收 8）', node, [vite, 'dev'], { ...base, SOCUT_SMOKE_CANCEL: '1', SOCUT_SMOKE_W: '640', SOCUT_SMOKE_H: '360', SOCUT_SMOKE_SEC: '20' }, 600_000, reportPick)
    await step('应用内：PNG 序列独立出口（C40）', node, [vite, 'dev'], { ...base, SOCUT_SMOKE_KIND: 'pngSequence', SOCUT_SMOKE_W: '640', SOCUT_SMOKE_H: '360', SOCUT_SMOKE_SEC: '2' }, 600_000, reportPick)
    await step('应用内：取消 PNG 序列（目录回收 C41）', node, [vite, 'dev'], { ...base, SOCUT_SMOKE_KIND: 'pngSequence', SOCUT_SMOKE_CANCEL: '1', SOCUT_SMOKE_W: '640', SOCUT_SMOKE_H: '360', SOCUT_SMOKE_SEC: '20' }, 600_000, reportPick)
    await step('应用内：MOV 的 pngSequence 回退（C42）', node, [vite, 'dev'], { ...base, SOCUT_SMOKE_DELIVERY: 'pngSequence', SOCUT_SMOKE_W: '640', SOCUT_SMOKE_H: '360', SOCUT_SMOKE_SEC: '2' }, 600_000, reportPick)
    await step('应用内：叠加 720p23.976（验收 4/5/6/7）', node, [vite, 'dev'], {
      ...base, SOCUT_SMOKE_OVERLAY: '1', SOCUT_SMOKE_REF: path.join(artifacts, 'ref-720p23976.mp4')
    }, 600_000, reportPick)
    await step('应用内：门禁端到端（验收 5/6）', node, [vite, 'dev'], { ...base, SOCUT_SMOKE_GATE: '1' }, 600_000, reportPick)
    await step('应用内：逐像素一致性（M1-7）', node, [vite, 'dev'], {
      ...base, SOCUT_SMOKE: '0', SOCUT_PIXELCHECK: path.join(outDir, 'pixel-parity.json')
    }, 600_000, {
      file: 'spikes/app-smoke/pixel-parity.json',
      select: (json) => ({ passed: json.passed, frames: json.frames?.length, dpr: json.devicePixelRatio, blitSize: json.frames?.[0]?.scaled?.blitSize })
    })
    await step('应用内：错误呈现取证（M4-2/§9）', node, [vite, 'dev'], {
      ...base, SOCUT_SMOKE: '0', SOCUT_SHOT_ERROR: '1'
    }, 600_000, {
      file: 'spikes/app-smoke/error-demo.json',
      select: (json) => ({ passed: json.passed, argvSegments: json.argvSegments, stderrTailBytes: json.stderrTailBytes })
    })
    await step('应用内：逐帧动画评审表出图（M4-7）', node, [vite, 'dev'], {
      ...base, SOCUT_SMOKE: '0', SOCUT_REVIEW_SHEET: path.join(artifacts, 'review-sheet-1080p.png'), SOCUT_REVIEW_BACKDROP: path.join(artifacts, 'review-backdrop.png')
    }, 600_000, undefined, ['spikes/artifacts/review-sheet-1080p.png'])
    // 视觉检查：8 预设 × 短/常规/长文案，出图 + 指标，失败时非 0 退出码
    // 注意要显式传隔离 profile：它自己会清掉所有 SOCUT_*，不传就会撞上用户正在开的实例（单实例锁 → 秒退）
    await step('应用内：字幕条视觉检查（8 预设 × 3 文案）', node, ['scripts/visual-check.mjs'], { SOCUT_USER_DATA: gateUserData }, 600_000, {
      file: 'spikes/artifacts/visual-check/report.json',
      select: (json) => ({ passed: json.passed, cases: json.cases?.length, failures: json.failures })
    }, ['spikes/artifacts/visual-check/sheet.png'])
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
