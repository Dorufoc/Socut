#!/usr/bin/env node
/**
 * 交付前环境与纪律检查（规格 §11 关键纪律的机器化部分）。
 * 1) 源码中禁止出现同步子进程调用族（只允许异步 spawn）；
 * 2) FFmpeg/ffprobe 必须位于 asar 之外（resources/ffmpeg/），并给出体积提示；
 * 3) 字体目录存在性检查；
 * 4) Node/Electron 版本与平台检查；
 * 5) 离线纪律：src/ 运行期代码不得联网，且生产 HTML 产物 CSP 已收紧；
 * 6) 渲染侧内存纪律（禁 toDataURL）与交付物齐备（图标、真实 ffprobe 夹具）。
 * 任一硬性项失败即退出码 1。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_DIRS = ['src', 'scripts']
const SKIP_EXT = ['.log', '.md']
const TEXT_EXT = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js'])

const FORBIDDEN = [
  { pattern: /\bexecSync\s*\(/, label: 'child_process.execSync（同步子进程）' },
  { pattern: /\bexecFileSync\s*\(/, label: 'child_process.execFileSync（同步子进程）' },
  { pattern: /\bspawnSync\s*\(/, label: 'child_process.spawnSync（同步子进程）' },
  { pattern: /require\(\s*['"]child_process['"]\s*\)\s*\.\s*(exec|execSync|execFileSync|spawnSync)\b/, label: 'child_process 同步族调用' },
  { pattern: /\bimport\s+\*\s+as\s+cp.*child_process.*\n[\s\S]*?\bcp\.(execSync|execFileSync|spawnSync)\s*\(/, label: '命名空间同步族调用' }
]

const MAX_FFMPEG_BYTES = 150 * 1024 * 1024

/**
 * 离线纪律（规格 §8：用户侧零外部依赖）：应用运行期代码不得发起任何网络请求，
 * 否则断网/内网机器上就会有不可预期的失败与卡死。
 * 只扫 src/（scripts/ 里的下载脚本本来就允许联网）。
 */
const OFFLINE_FORBIDDEN = [
  { pattern: /\bfetch\s*\(/, label: 'fetch（运行期不得联网）' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bnew\s+WebSocket\b/, label: 'WebSocket' },
  { pattern: /\bEventSource\b/, label: 'EventSource' },
  { pattern: /\bnavigator\.sendBeacon\b/, label: 'sendBeacon' },
  { pattern: /['"]node:(?:https|dns|tls|dgram)['"]/, label: 'Node 网络内置模块（运行期不得联网）' },
  { pattern: /\brequire\(['"](?:https?|net)['"]\)/, label: 'require 网络模块' }
]

/**
 * 渲染侧内存/帧交付纪律（计划 §3）：导出帧走 convertToBlob → arrayBuffer，
 * toDataURL 会把每帧多一次 base64 编码与双倍内存，明令禁止。
 */
const RENDERER_FORBIDDEN = [
  { pattern: /\btoDataURL\s*\(/, label: 'toDataURL（base64 使内存翻倍，计划 §3 禁用）' }
]

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist' || entry.name === 'release') continue
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

const problems = []
const warnings = []

async function scanSource() {
  for (const dir of SCAN_DIRS) {
    const base = path.join(root, dir)
    let stat
    try {
      stat = await fs.stat(base)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for await (const file of walk(base)) {
      const ext = path.extname(file)
      if (SKIP_EXT.includes(ext) || !TEXT_EXT.has(ext)) continue
      // 本文件自身包含被禁模式的正则字面量，必须跳过，否则会自我误报
      if (path.basename(file) === 'check-env.mjs') continue
      const content = await fs.readFile(file, 'utf8')
      for (const forbidden of FORBIDDEN) {
        if (forbidden.pattern.test(content)) {
          problems.push(`${path.relative(root, file)}：${forbidden.label}`)
        }
      }
      if (dir === 'src') {
        for (const forbidden of OFFLINE_FORBIDDEN) {
          if (forbidden.pattern.test(content)) {
            problems.push(`${path.relative(root, file)}：${forbidden.label}（离线交付纪律）`)
          }
        }
        // M10：JSON-RPC / 命名管道只允许出现在主进程控制面（src/main/），且必须绑回环
        if (/['"]node:net['"]/.test(content)) {
          const relative = path.relative(root, file).replace(/\\/g, '/')
          if (!relative.startsWith('src/main/')) {
            problems.push(`${relative}：node:net 只允许在主进程控制面（src/main/）使用（本地回环通信）`)
          }
        }
        // toDataURL 只可能在渲染侧出现，但全仓统一禁更便宜
        for (const forbidden of RENDERER_FORBIDDEN) {
          if (forbidden.pattern.test(content)) {
            problems.push(`${path.relative(root, file)}：${forbidden.label}`)
          }
        }
      }
    }
  }
}

async function checkBinaries() {
  const dir = path.join(root, 'resources', 'ffmpeg')
  const required = ['ffmpeg.exe', 'ffprobe.exe']
  let total = 0
  for (const name of required) {
    const file = path.join(dir, name)
    try {
      const stat = await fs.stat(file)
      total += stat.size
      if (stat.size > MAX_FFMPEG_BYTES) {
        warnings.push(
          `${name} 体积 ${(stat.size / 1024 / 1024).toFixed(0)}MB 超过 ${(MAX_FFMPEG_BYTES / 1024 / 1024).toFixed(0)}MB：` +
            `安装包将超出 250–300MB 预算，正式交付请改用 BtbN/gyan 的 essentials 或 gpl 精简构建（同源即可）。`
        )
      }
    } catch {
      problems.push(`缺少随包二进制 resources/ffmpeg/${name}（规格 §8：必须位于 asar 外部且随包分发）`)
    }
  }
  if (total > 0) console.log(`  随包 FFmpeg 合计 ${(total / 1024 / 1024).toFixed(0)}MB（未压缩）`)
}

/**
 * M11 whisper 资产（**可选**）：二进制与模型都是离线资产，不入库。
 * 缺失时只警告（语音识别不可用，但编辑器/导出/其他自动化都正常），
 * 避免干净检出或 CI 因为没拉 141MB 模型而红。
 */
async function checkWhisperAssets() {
  const exe = path.join(root, 'resources', 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
  const modelsDir = path.join(root, 'resources', 'models', 'whisper')
  let exeStat = null
  try {
    exeStat = await fs.stat(exe)
  } catch {
    warnings.push('resources/whisper 未就位：语音识别不可用（执行 npm run fetch:whisper 取回 whisper.cpp 二进制）')
  }
  let models = []
  try {
    models = (await fs.readdir(modelsDir)).filter((name) => name.endsWith('.bin'))
  } catch {
    // 目录不存在 = 没模型
  }
  if (models.length === 0) {
    warnings.push('resources/models/whisper 没有 ggml-*.bin：语音识别不可用（执行 npm run fetch:whisper:model）')
    return
  }
  let total = 0
  for (const name of models) {
    const stat = await fs.stat(path.join(modelsDir, name)).catch(() => null)
    if (stat) total += stat.size
  }
  const exePart = exeStat ? `${(exeStat.size / 1024 / 1024).toFixed(1)}MB 二进制` : '缺二进制'
  console.log(`  whisper 资产：${exePart} + ${models.length} 个模型 ${(total / 1024 / 1024).toFixed(0)}MB（会随包装入安装包）`)
}

/**
 * M8 RNNoise 模型（**可选**）：`arnndn` 的 `.rnnn` 文件，约 300KB。
 * 缺失时只警告：其他降噪档位（afftdn）照常可用，AI 降噪导出前会给出明确错误。
 */
async function checkRnnoiseAsset() {
  const dir = path.join(root, 'resources', 'models', 'rnnoise')
  let models = []
  try {
    models = (await fs.readdir(dir)).filter((name) => name.toLowerCase().endsWith('.rnnn'))
  } catch {
    // 目录不存在 = 没模型
  }
  if (models.length === 0) {
    warnings.push('resources/models/rnnoise 没有 .rnnn 模型：AI 降噪（arnndn）不可用（执行 npm run fetch:rnnoise）')
    return
  }
  let total = 0
  for (const name of models) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null)
    if (stat) total += stat.size
  }
  console.log(`  RNNoise 模型 ${models.length} 个（${(total / 1024).toFixed(0)}KB，AI 降噪可用）`)
}

/**
 * M8-P1 AI matte 模型（**可选**）：Selfie Segmenter ONNX（约 451KB，Apache-2.0）。
 * 缺失时只警告：编辑器/导出照常，检查器「AI 抠像」显示未就绪（可执行 npm run fetch:matte:model）。
 */
async function checkMatteModelAsset() {
  const dir = path.join(root, 'resources', 'models', 'matte')
  let models = []
  try {
    models = (await fs.readdir(dir)).filter((name) => name.toLowerCase().endsWith('.onnx'))
  } catch {
    // 目录不存在 = 没模型
  }
  if (models.length === 0) {
    warnings.push('resources/models/matte 没有 .onnx 模型：AI 抠像不可用（执行 npm run fetch:matte:model，约 451KB）')
    return
  }
  let total = 0
  for (const name of models) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null)
    if (stat) total += stat.size
  }
  console.log(`  AI matte 模型 ${models.length} 个（${(total / 1024).toFixed(0)}KB，AI 抠像可用）`)
}

async function checkFonts() {
  const dir = path.join(root, 'resources', 'fonts')
  try {
    const entries = await fs.readdir(dir)
    const fonts = entries.filter((name) => /\.(ttf|otf)$/i.test(name))
    if (fonts.length === 0) warnings.push('resources/fonts 下没有内置字体（执行 npm run fetch:fonts，或确认刻意不内置）')
    else console.log(`  内置字体 ${fonts.length} 个`)
  } catch {
    warnings.push('resources/fonts 不存在（执行 npm run fetch:fonts）')
  }
}

function checkRuntime() {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) problems.push(`Node ${process.version} 低于要求（Electron 45 需要 >= 22.12）`)
  if (process.platform !== 'win32') warnings.push(`当前平台 ${process.platform}：交付目标是 Windows x64`)
}

/**
 * 生产产物的 CSP：必须保留 default-src 'self'，且不得带开发用的 localhost/ws 白名单。
 * out/ 不存在时只警告（未跑过 build）。
 */
async function checkBuiltCsp() {
  const html = await fs.readFile(path.join(root, 'out', 'renderer', 'index.html'), 'utf8').catch(() => null)
  if (html === null) {
    warnings.push('out/renderer/index.html 不存在，跳过生产 CSP 校验（先跑 npm run build）')
    return
  }
  if (!html.includes("default-src 'self'")) problems.push('生产 index.html 缺少 CSP default-src \'self\'')
  if (/localhost:5173|connect-src\s+'self'\s+ws:/.test(html)) {
    problems.push("生产 index.html 的 CSP 仍允许 ws:/localhost:5173（应由 tightenCspInProd 收紧）")
    return
  }
  console.log('  生产 CSP 已收紧：default-src \'self\' / connect-src \'self\'')
}

/**
 * 图标与夹具交付物（计划工程结构 + §测试计划）。
 * icon.ico 缺失时 electron-builder 会静默用回 Electron 默认图标（日志只一行 info），
 * 夹具不足六类时 probe 解析路径就只被一种真实 ffprobe 输出验证过。
 */
async function checkDeliverables() {
  const ico = path.join(root, 'resources', 'icons', 'icon.ico')
  try {
    const buffer = await fs.readFile(ico)
    const count = buffer.length >= 6 ? buffer.readUInt16LE(4) : 0
    if (buffer.readUInt16LE(2) !== 1 || count < 4) {
      problems.push(`resources/icons/icon.ico 不是合法多尺寸图标（type/count=${count}），跑 npm run make:icon`)
    } else {
      console.log(`  应用图标 ${count} 个尺寸`)
    }
  } catch {
    problems.push('缺少 resources/icons/icon.ico（跑 npm run make:icon）')
  }

  const requiredFixtures = [
    'probe-sdr-169.json',
    'probe-hdr-bt2020-pq.json',
    'probe-portrait-916.json',
    'probe-no-audio.json',
    'probe-alac-audio.json',
    'probe-pcm-audio.json',
    'probe-vfr.json',
    'probe-vfr-packets.json'
  ]
  const missing = []
  for (const name of requiredFixtures) {
    const file = path.join(root, 'tests', 'fixtures', name)
    if (!(await exists(file))) missing.push(name)
  }
  if (missing.length > 0) {
    problems.push(`缺少真实 ffprobe 夹具：${missing.join(', ')}（跑 npm run make:fixtures）`)
  } else {
    console.log(`  真实 ffprobe 夹具 ${requiredFixtures.length} 份`)
  }
}

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

async function main() {
  await scanSource()
  await checkBinaries()
  await checkFonts()
  await checkWhisperAssets()
  await checkRnnoiseAsset()
  await checkMatteModelAsset()
  await checkBuiltCsp()
  await checkDeliverables()
  checkRuntime()

  // 资源目录不得被 files 白名单重复打包（electron-builder.yml 已限定 files: out/ + package.json）
  const builder = await fs.readFile(path.join(root, 'electron-builder.yml'), 'utf8').catch(() => '')
  if (builder && !builder.includes('extraResources')) {
    problems.push('electron-builder.yml 缺少 extraResources：FFmpeg 无法落到 asar 外')
  }
  if (builder && /^files:\s*\n\s*-\s*'\*\*/m.test(builder)) {
    problems.push('electron-builder.yml 的 files 使用 **/*：会把 resources/ 重复打进 asar（体积翻倍）')
  }

  for (const warning of warnings) console.warn(`⚠ ${warning}`)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`)
    process.exit(1)
  }
  console.log(`✓ 纪律检查通过（Node ${process.version}，警告 ${warnings.length} 条）`)
}

void main()
