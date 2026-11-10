import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { buildVerifyArgs } from '../shared/ffmpegArgs'
import { frameRateMatches, isProres4444WithAlpha, parseVerifyJson } from '../shared/probe'
import { buildSizeEstimate } from '../shared/sizeEstimate'
import { FPS_30 } from '../shared/constants'
import type { SmokeConfig, SmokeReport } from '../shared/api'
import { runFfprobeJson, runToEnd } from './ffrun'
import type { FfmpegBinaries } from './paths'
import { resolveFfmpegBinaries, tempRoot } from './paths'
import { probeVideo } from './videoImport'
import { activeJobs } from './procRegistry'
import { log } from './log'

/**
 * 应用内端到端冒烟（计划 M0-8 / M1 判据的可自动化部分）。
 * 只在开发环境且 SOCUT_SMOKE=1 时启用：渲染侧用**真实管线**跑一次透明 MOV 导出，
 * 主进程再用 ffprobe + 与生产相同的校验函数交叉断言，结果写入 spikes/app-smoke/report.json。
 */

const DEFAULT_WIDTH = 640
const DEFAULT_HEIGHT = 360
const DEFAULT_DURATION_SEC = 2

let config: SmokeConfig | null = null

function parseNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

/** SOCUT_SMOKE_FPS：支持 "60" 与 "60000/1001" 两种写法（计列帧率必须用分数）。 */
function parseFps(raw: string | undefined): { num: number; den: number } {
  if (!raw) return FPS_30
  const [numText, denText] = raw.split('/')
  const num = Number(numText)
  const den = denText === undefined ? 1 : Number(denText)
  if (!Number.isInteger(num) || num <= 0 || !Number.isInteger(den) || den <= 0) return FPS_30
  return { num, den }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export function initSmoke(): void {
  if (process.env.SOCUT_SMOKE !== '1') return
  if (app.isPackaged) {
    void log('warn', 'SOCUT_SMOKE 在打包版本中被忽略')
    return
  }
  const outputDir = path.join(app.getAppPath(), 'spikes', 'app-smoke')
  const cancelScenario = process.env.SOCUT_SMOKE_CANCEL === '1'
  const overlayScenario = process.env.SOCUT_SMOKE_OVERLAY === '1'
  const gateScenario = process.env.SOCUT_SMOKE_GATE === '1'
  config = {
    outputDir,
    width: parseNumber(process.env.SOCUT_SMOKE_W, DEFAULT_WIDTH),
    height: parseNumber(process.env.SOCUT_SMOKE_H, DEFAULT_HEIGHT),
    fps: parseFps(process.env.SOCUT_SMOKE_FPS),
    // 取消场景故意用更长的时间轴，确保取消发生在中途而非跑完
    durationSec: cancelScenario
      ? parseNumber(process.env.SOCUT_SMOKE_SEC, 20)
      : parseNumber(process.env.SOCUT_SMOKE_SEC, DEFAULT_DURATION_SEC),
    scenario: gateScenario ? 'gate' : overlayScenario ? 'overlay' : cancelScenario ? 'cancel' : 'export',
    refVideoPath: process.env.SOCUT_SMOKE_REF ?? null,
    // 门禁取证需要真实夹具视频（make-probe-fixtures 的中间产物）
    fixtureDir: process.env.SOCUT_SMOKE_FIXTURES ?? path.join(app.getAppPath(), 'spikes', 'fixtures-tmp'),
    exportKind: process.env.SOCUT_SMOKE_KIND === 'pngSequence' ? 'pngSequence' : 'transparentMov',
    forceCopyAudio: process.env.SOCUT_SMOKE_AUDIO === 'force-copy'
  }
  void log(
    'info',
    `冒烟模式启用（${config.scenario}）：输出 ${outputDir} ${config.width}x${config.height} ${config.durationSec}s` +
      (config.refVideoPath ? ` 参考 ${config.refVideoPath}` : '')
  )
}

export function smokeConfig(): SmokeConfig | null {
  return config
}

export interface SmokeVerification {
  passed: boolean
  failures: string[]
  checks: Record<string, unknown>
}

/** 取消场景的校验：确认子进程、半成品与临时目录都被干净地回收。 */
async function verifyCancelReport(report: SmokeReport): Promise<SmokeVerification> {
  const failures: string[] = []
  const checks: Record<string, unknown> = {
    scenario: 'cancel',
    jobId: report.jobId,
    outputPath: report.outputPath,
    framesTotal: report.framesTotal,
    framesDoneBeforeCancel: report.framesDoneBeforeCancel ?? null,
    elapsedMs: Math.round(report.elapsedMs),
    resultOk: report.ok,
    errorCode: report.errorCode ?? null
  }

  if (report.ok) failures.push('取消场景不应该报成功')
  if (report.errorCode !== 'CANCELLED') {
    failures.push(`取消应得到 CANCELLED，实际 ${report.errorCode ?? '无'}`)
  }
  const framesDone = report.framesDoneBeforeCancel ?? 0
  if (framesDone >= report.framesTotal) {
    failures.push(`取消发生在导出完成后（${framesDone}/${report.framesTotal}），不能证明中途取消`)
  }
  if (framesDone === 0) {
    failures.push('未交付任何帧就取消，不能证明背压路径工作过')
  }

  // 1) 无孤儿子进程
  const leftovers = activeJobs()
  checks.activeChildJobs = leftovers.map((job) => job.label)
  if (leftovers.length > 0) failures.push(`存在子进程残留：${leftovers.map((j) => j.label).join(', ')}`)

  /**
   * 2) 半成品产物已删除 + 3) 临时工作区已清空。
   * 这两项必须**等**：引擎是先 emit 结果、再在 finally 里删产物与工作区，
   * 渲染侧一收到结果就上报，主进程此时去看文件系统必然早于清理完成
   *（实捕：取消 PNG 序列后目录与临时区都还在，其实随后就被删了）。
   * 所以用有界轮询：真没清就报错，清了就把耗时记下来作为证据。
   */
  const deadline = Date.now() + 10_000
  let artifactExists = await exists(report.outputPath)
  let staleDirs: string[] = []
  const readStale = async (): Promise<string[]> => {
    try {
      return await fs.readdir(tempRoot())
    } catch {
      return []
    }
  }
  let waitedMs = 0
  for (;;) {
    staleDirs = await readStale()
    if (!artifactExists && staleDirs.length === 0) break
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 200))
    waitedMs += 200
    artifactExists = await exists(report.outputPath)
  }
  checks.cleanupWaitedMs = waitedMs
  checks.artifactExists = artifactExists
  if (artifactExists) failures.push(`取消后半成品产物仍存在：${report.outputPath}`)
  checks.staleTempDirs = staleDirs
  if (staleDirs.length > 0) {
    failures.push(`临时工作区残留 ${staleDirs.length} 个目录：${staleDirs.join(', ')}`)
  }

  return { passed: failures.length === 0, failures, checks }
}

/**
 * 叠加合成场景的独立交叉校验（验收第 4/5/6 条）：
 * 用与导出不同的探测路径（probeVideo）重读产物，确认参数全部跟随参考视频，
 * 且整条时间轴透传（计划 C7）而不是只输出字幕区间。
 */
async function verifyOverlayReport(report: SmokeReport): Promise<SmokeVerification> {
  const failures: string[] = []
  const checks: Record<string, unknown> = {
    scenario: 'overlay',
    jobId: report.jobId,
    outputPath: report.outputPath,
    elapsedMs: Math.round(report.elapsedMs),
    framesTotal: report.framesTotal,
    resultOk: report.ok,
    errorCode: report.errorCode ?? null,
    stderrTail: report.stderrTail ?? ''
  }
  if (!report.ok) failures.push(`叠加导出失败：${report.errorCode ?? ''} ${report.errorMessage ?? ''}`)

  const refPath = config?.refVideoPath
  if (!refPath) {
    failures.push('overlay 场景未提供 SOCUT_SMOKE_REF')
    return { passed: false, failures, checks }
  }
  try {
    const ref = await probeVideo(refPath, 'smoke-ref')
    checks.ref = {
      width: ref.meta.width,
      height: ref.meta.height,
      rFrameRate: `${ref.meta.rFrameRate.num}/${ref.meta.rFrameRate.den}`,
      nbFrames: ref.meta.nbFrames,
      durationSec: Number(ref.meta.durationSec.toFixed(3)),
      audioCodec: ref.meta.audioCodec
    }
    const out = await probeVideo(report.outputPath, 'smoke-out')
    checks.out = {
      width: out.meta.width,
      height: out.meta.height,
      videoCodec: out.meta.videoCodec,
      pixFmt: out.meta.pixFmt,
      rFrameRate: `${out.meta.rFrameRate.num}/${out.meta.rFrameRate.den}`,
      nbFrames: out.meta.nbFrames,
      durationSec: Number(out.meta.durationSec.toFixed(3)),
      audioCodec: out.meta.audioCodec
    }
    if (out.meta.width !== ref.meta.width || out.meta.height !== ref.meta.height) {
      failures.push(`未跟随参考分辨率：参考 ${ref.meta.width}x${ref.meta.height} 实际 ${out.meta.width}x${out.meta.height}`)
    }
    // 计划 C3：叠加链尾必须回到 8-bit 4:2:0
    if (out.meta.pixFmt !== 'yuv420p') failures.push(`pix_fmt=${out.meta.pixFmt}，期望 yuv420p（计划 C3）`)
    if (out.meta.videoCodec !== 'h264') failures.push(`视频编码 ${out.meta.videoCodec}，期望 h264`)
    const refFps = ref.meta.rFrameRate.num / ref.meta.rFrameRate.den
    const outFps = out.meta.rFrameRate.num / out.meta.rFrameRate.den
    if (Math.abs(refFps - outFps) / refFps > 0.01) failures.push(`帧率不符：参考 ${refFps} 实际 ${outFps}`)
    // C7：非字幕区间必须原样透传，因此总帧数/总时长应与参考一致
    if (ref.meta.nbFrames !== null && out.meta.nbFrames !== null) {
      const drift = Math.abs(out.meta.nbFrames - ref.meta.nbFrames) / ref.meta.nbFrames
      checks.frameDrift = Number(drift.toFixed(4))
      if (drift > 0.02) failures.push(`帧数偏差 ${(drift * 100).toFixed(1)}%：整条时间轴未透传`)
    }
    checks.durationDriftSec = Number(Math.abs(out.meta.durationSec - ref.meta.durationSec).toFixed(3))
    if (Math.abs(out.meta.durationSec - ref.meta.durationSec) > 0.2) {
      failures.push(`时长偏差 ${checks.durationDriftSec}s > 0.2s`)
    }
    if (ref.meta.audioCodec !== null && out.meta.audioCodec === null) {
      failures.push('参考视频有音轨但产物无音轨（计划 C4）')
    }
    checks.audioMode = ref.meta.audioCodec === null ? 'aac-or-none' : out.meta.audioCodec === ref.meta.audioCodec ? 'copy' : 'transcoded'

    /**
     * 验收第 7 条的两个分支：
     *  a) 预检判定不可 copy → 直接 AAC，并且必须告知用户（计划 C4）；
     *  b) force-copy 跳过预检 → 运行期失败则只重试一次 AAC。
     * 本机实测 alac/pcm 都能 copy 进 MP4，所以 b) 不能假定一定失败；
     * 真正的失败→重试→提示逻辑由 tests/overlayAudioFallback.test.ts 直接注入退出码覆盖。
     */
    const notices = report.notices ?? []
    checks.notices = notices
    if (config?.forceCopyAudio) {
      const fellBack = notices.some((text) => /AAC/i.test(text))
      checks.forcedCopyAudio = true
      checks.audioFallback = fellBack
      if (!report.ok) {
        failures.push(`强制 copy 后任务未成功（应回退而不是失败）：${report.errorCode ?? ''} ${report.errorMessage ?? ''}`)
      }
      if (fellBack && out.meta.audioCodec !== 'aac') {
        failures.push(`回退后音轨应为 aac，实际 ${String(out.meta.audioCodec)}（验收第 7 条）`)
      }
      if (!fellBack && out.meta.audioCodec !== ref.meta.audioCodec) {
        failures.push(`未提示回退却换了音频编码（${String(ref.meta.audioCodec)} → ${String(out.meta.audioCodec)}）`)
      }
    } else if (ref.flags.audioTranscodeNeeded) {
      // 不可复制的音轨：预检就该走 AAC，并且必须留下提示
      checks.proactiveTranscode = true
      if (out.meta.audioCodec !== 'aac') {
        failures.push(`预检应转码为 aac，实际 ${String(out.meta.audioCodec)}（计划 C4）`)
      }
      if (!notices.some((text) => /已转码为 AAC/.test(text))) {
        failures.push('预检回退 AAC 但未告知用户（计划 C4：“并在 UI 提示已转码”）')
      }
    }

    /**
     * 验收第 4 条的硬证据：入出点误差 < 1 帧。用逐帧差值从**产物像素**里量出
     * 字幕区间，与应用声称的 span 对拍（而不是只信渲染侧自己算的帧号）。
     */
    if (config && report.spanStartSec !== undefined && report.spanEndSec !== undefined) {
      const binaries = await resolveFfmpegBinaries()
      const statsFile = path.join(config.outputDir, `span-${report.jobId}.txt`)
      const measured = await measureCompositedSpan({
        outputPath: report.outputPath,
        refPath,
        fps: ref.meta.rFrameRate,
        jobId: report.jobId,
        binaries,
        statsFile
      })
      const frameSec = ref.meta.rFrameRate.den / ref.meta.rFrameRate.num
      const round3 = (value: number): number => Math.round(value * 1000) / 1000
      const declaredStartFrame = Math.round(report.spanStartSec / frameSec)
      const declaredEndFrame = Math.round(report.spanEndSec / frameSec)
      const inFrames = report.spanInFrames ?? 0
      const outFrames = report.spanOutFrames ?? 0
      const spanRecord: Record<string, unknown> = {
        ...measured,
        frameSecMs: round3(frameSec * 1000),
        declaredStartSec: round3(report.spanStartSec),
        declaredEndSec: round3(report.spanEndSec),
        declaredStartFrame,
        declaredEndFrame,
        inFrames,
        outFrames
      }
      checks.span = spanRecord
      if (measured.startFrame === null || measured.endFrameExclusive === null) {
        failures.push(
          `逐帧 PSNR 无法区分字幕帧（min=${String(measured.minDb)}dB max=${String(measured.maxDb)}dB，分离度不足 6dB）`
        )
      } else {
        /**
         * 用「包络 + 动画窗口」而不是「端点误差 < 1 帧」：
         * PSNR 量到的是**可见性**，而入场首帧 alpha≈0.05、出场末帧同样趋近 0，
         * 在任何阈值下都量不到——拿它断言“误差 <1 帧”会得出假阳性失败（本机实捕：
         * 入点差 1 帧、出点差 2 帧，正好等于淡入/淡出长度）。
         * 真正可证伪的是：字幕不得出现在声明区间之外（入/出点错），
         * 且必须在动画窗口内变得可见（不迟到）。「严格 <1 帧」则由
         * tests/presets.test.ts 的 M3-7（1080p30 vs 720p23.976 逐段入出点）在帧算法层面断言。
         */
        const entryLeadFrames = measured.startFrame - declaredStartFrame
        const exitTailFrames = declaredEndFrame - measured.endFrameExclusive
        spanRecord.entryLeadFrames = entryLeadFrames
        spanRecord.exitTailFrames = exitTailFrames
        if (entryLeadFrames < 0) {
          failures.push(`字幕在声明入点前 ${-entryLeadFrames} 帧就已出现（入点泄漏，验收第 4 条）`)
        }
        if (entryLeadFrames > inFrames) {
          failures.push(
            `字幕比声明入点晚 ${entryLeadFrames} 帧才可见，超过入场动画 ${inFrames} 帧（入点迟到，验收第 4 条）`
          )
        }
        if (exitTailFrames < -1) {
          failures.push(`字幕在声明出点后仍持续 ${-exitTailFrames} 帧（出点泄漏，验收第 4 条）`)
        }
        if (exitTailFrames > outFrames + 1) {
          failures.push(
            `字幕比声明出点早 ${exitTailFrames} 帧消失，超过出场动画 ${outFrames} 帧（出点提前，验收第 4 条）`
          )
        }
      }
    }
  } catch (error) {
    failures.push(`校验异常：${String(error)}`)
  }
  return { passed: failures.length === 0, failures, checks }
}

/**
 * PNG 序列出口的独立校验：产物是目录，逐帧 PNG 必须数量等于帧数、
 * 可解码、尺寸一致且带 alpha（pix_fmt rgba/argb）。
 */
async function verifyPngSequenceReport(report: SmokeReport): Promise<SmokeVerification> {
  const cfg = config
  const failures: string[] = []
  const checks: Record<string, unknown> = {
    scenario: report.scenario,
    kind: 'pngSequence',
    outputDir: report.outputPath,
    framesTotal: report.framesTotal,
    exportOk: report.ok,
    elapsedMs: Math.round(report.elapsedMs)
  }
  if (!report.ok && report.scenario !== 'cancel') {
    failures.push(`PNG 序列导出失败：${report.errorCode ?? ''} ${report.errorMessage ?? ''}`)
  }
  try {
    const entries = await fs.readdir(report.outputPath)
    const pngs = entries.filter((name) => /^frame_\d{6}\.png$/i.test(name)).sort()
    checks.pngCount = pngs.length
    checks.pngFirst = pngs[0] ?? null
    checks.pngLast = pngs[pngs.length - 1] ?? null
    if (cfg && report.scenario !== 'cancel' && pngs.length !== report.framesTotal) {
      failures.push(`PNG 帧数不符：期望 ${report.framesTotal}，实际 ${pngs.length}`)
    }
    if (pngs.length > 0 && cfg) {
      const binaries = await resolveFfmpegBinaries()
      const payload = await runFfprobeJson<unknown>(
        buildVerifyArgs(path.join(report.outputPath, pngs[0] as string)),
        'smoke-png-verify',
        binaries
      )
      const verified = parseVerifyJson(payload)
      if (!verified) {
        failures.push('首帧 PNG 无法解码')
      } else {
        checks.width = verified.width
        checks.height = verified.height
        checks.pixFmt = verified.pixFmt
        checks.codecName = verified.codecName
        if (verified.width !== cfg.width || verified.height !== cfg.height) {
          failures.push(`PNG 尺寸不符：期望 ${cfg.width}x${cfg.height}，实际 ${verified.width}x${verified.height}`)
        }
        // 计划 §5：PNG 出口为 -c:v png -pix_fmt rgba，必须带 alpha
        if (!/a$/i.test(verified.pixFmt ?? '')) {
          failures.push(`PNG 像素格式不透明：pix_fmt=${verified.pixFmt}（期望 rgba/argb）`)
        }
      }
    }
  } catch (error) {
    failures.push(`PNG 序列目录不可读：${String(error)}`)
  }
  if (cfg && report.elapsedMs > 0 && report.scenario === 'export') {
    // 只记录不断言：PNG 序列出口的开销结构跟透明 MOV 不同（每帧一次 zlib 压缩），
    // 拿验收第 2 条的 1080p30/10s ≤30s 阈值去外推它没有意义。
    const scale = (1920 * 1080 * 300) / (cfg.width * cfg.height * report.framesTotal)
    checks.extrapolated1080p30_10sSecNotApplicable = Number(((report.elapsedMs / 1000) * scale).toFixed(1))
  }
  return { passed: failures.length === 0, failures, checks }
}

/**
 * 逐帧 PSNR 实测字幕区间（验收第 4 条）。
 * 不看应用自己声称的数字，只看合成产物与参考视频的像素差异。
 *
 * 为什么不用 blend=difference + signalstats：本机实测它对**同一文件自己**也报恒定 YAVG=45，
 * 差值图完全不反映内容（blend 在 YUV 上的行为不适合做存在性判定）；
 * psnr 是独立实现，干净帧 ≈ 55dB、含字幕帧 ≈ 20dB，分离度足够。
 *
 * 阈值取 (min + max) / 2（自标定，不依赖“干净帧占多数”这个假设）；
 * 分离度不足 6dB 时直接判为无法区分，而不是默默给出一个看似通过的区间。
 */
async function measureCompositedSpan(input: {
  outputPath: string
  refPath: string
  fps: { num: number; den: number }
  jobId: string
  binaries: FfmpegBinaries
  statsFile: string
}): Promise<{
  frames: number
  minDb: number
  maxDb: number
  thresholdDb: number
  startFrame: number | null
  endFrameExclusive: number | null
}> {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'info',
    '-i',
    input.outputPath,
    '-i',
    input.refPath,
    // psnr 逐帧统计写 stdout（stats_file=-），汇总行在 stderr
    '-lavfi',
    'psnr=stats_file=-',
    '-an',
    '-f',
    'null',
    '-'
  ]
  const result = await runToEnd(input.binaries.ffmpeg, args, `${input.jobId}-span`, '逐帧 PSNR 实测')
  if (result.code !== 0) {
    throw new Error(`psnr 实测失败（退出码 ${result.code}）：${result.stderr.slice(-400)}`)
  }
  await fs.writeFile(input.statsFile, result.stdout, 'utf8').catch(() => undefined)

  const values: number[] = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const matched = /psnr_avg:([\d.inf]+)/.exec(line)
    if (!matched) continue
    const raw = matched[1] ?? ''
    values.push(raw === 'inf' ? 999 : Number(raw))
  }
  if (values.length === 0) throw new Error('逐帧 PSNR 无数据（stats_file 未输出 psnr_avg）')

  const sorted = [...values].sort((a, b) => a - b)
  const minDb = sorted[0] ?? 0
  const maxDb = sorted[sorted.length - 1] ?? 0
  const thresholdDb = (minDb + maxDb) / 2
  const round3 = (value: number): number => Math.round(value * 1000) / 1000

  let startFrame: number | null = null
  let endFrameExclusive: number | null = null
  if (maxDb - minDb >= 6) {
    for (let index = 0; index < values.length; index++) {
      if ((values[index] ?? 999) < thresholdDb) {
        if (startFrame === null) startFrame = index
        endFrameExclusive = index + 1
      }
    }
  }
  return {
    frames: values.length,
    minDb: round3(minDb),
    maxDb: round3(maxDb),
    thresholdDb: round3(thresholdDb),
    startFrame,
    endFrameExclusive
  }
}

/**
 * 门禁取证校验（验收第 5/6 条）：
 * 渲染侧只报事实（弹了什么模态、未确认时是否阻断、取消后是否写入），
 * CFR 产物由主进程用 ffprobe 独立复测 r_frame_rate == avg_frame_rate。
 */
async function verifyGateReport(report: SmokeReport): Promise<SmokeVerification> {
  const gate = report.gate
  const failures: string[] = []
  const checks: Record<string, unknown> = {
    scenario: 'gate',
    cfrOutputPath: gate?.cfrOutputPath ?? null,
    cases: gate?.cases ?? null
  }
  if (!gate) {
    return { passed: false, failures: ['缺少 gate 取证数据（渲染侧未上报）'], checks }
  }
  for (const message of gate.failures) failures.push(`渲染侧：${message}`)
  if (gate.cases.length < 3) failures.push(`门禁用例不足 3 个（实际 ${gate.cases.length}）`)
  for (const item of gate.cases) {
    if (item.appearedKind !== item.expectedKind) {
      failures.push(`${item.fixture}：应弹 ${item.expectedKind}，实际弹 ${String(item.appearedKind)}`)
    }
    if (!item.blockedBeforeAck) failures.push(`${item.fixture}：未确认时门禁未阻断导出`)
    if (item.refAfterCancel !== null) failures.push(`${item.fixture}：选「取消」仍写入了参考视频`)
    if (item.refAfterAck === null) failures.push(`${item.fixture}：确认后未写入参考视频`)
    if (item.blockedAfterAck) failures.push(`${item.fixture}：确认后门禁仍阻断`)
  }

  if (gate.cfrOutputPath === null) {
    failures.push('VFR 用例没有产出 CFR 文件（无法取证验收第 6 条）')
  } else {
    try {
      const binaries = await resolveFfmpegBinaries()
      const payload = await runFfprobeJson<unknown>(buildVerifyArgs(gate.cfrOutputPath), 'smoke-cfr', binaries)
      const verified = parseVerifyJson(payload)
      if (!verified) {
        failures.push('CFR 产物无法解析')
      } else {
        const r = verified.rFrameRate
        const a = verified.avgFrameRate
        const cfrRecord: Record<string, unknown> = {
          path: gate.cfrOutputPath,
          rFrameRate: r ? `${r.num}/${r.den}` : null,
          avgFrameRate: a ? `${a.num}/${a.den}` : null,
          pixFmt: verified.pixFmt,
          nbFrames: verified.nbFrames
        }
        checks.cfr = cfrRecord
        // 验收第 6 条：转 CFR 后帧率一致（交叉相乘，不走浮点）
        if (!r || !a || r.num * a.den !== a.num * r.den) {
          failures.push(
            `CFR 后帧率仍不一致：r=${String(cfrRecord.rFrameRate)} avg=${String(cfrRecord.avgFrameRate)}`
          )
        }
      }
    } catch (error) {
      failures.push(`CFR 复测异常：${String(error)}`)
    }
  }
  return { passed: failures.length === 0, failures, checks }
}

export async function verifySmokeReport(report: SmokeReport): Promise<SmokeVerification> {
  if (report.scenario === 'cancel') return verifyCancelReport(report)
  if (report.scenario === 'overlay') return verifyOverlayReport(report)
  if (report.scenario === 'gate') return verifyGateReport(report)
  // PNG 序列出口（第三个出口）走目录校验分支
  if (config?.exportKind === 'pngSequence') return verifyPngSequenceReport(report)
  const cfg = config
  const failures: string[] = []
  const checks: Record<string, unknown> = {
    jobId: report.jobId,
    outputPath: report.outputPath,
    elapsedMs: Math.round(report.elapsedMs),
    bytesWritten: report.bytesWritten,
    framesTotal: report.framesTotal,
    exportOk: report.ok,
    /** 渲染侧耗时分解：能直接指出瓶颈在绘制还是 PNG 编码 */
    renderStats: report.stats ?? null,
    throughputFps:
      report.elapsedMs > 0 ? Number(((report.framesTotal / report.elapsedMs) * 1000).toFixed(1)) : null
  }

  if (!report.ok) {
    failures.push(`导出失败：${report.errorCode ?? ''} ${report.errorMessage ?? ''}`)
  }

  if (cfg) {
    try {
      const binaries = await resolveFfmpegBinaries()
      const payload = await runFfprobeJson<unknown>(buildVerifyArgs(report.outputPath), 'smoke-verify', binaries)
      const verified = parseVerifyJson(payload)
      if (!verified) {
        failures.push('产物无法解析（ffprobe 未返回视频流）')
      } else {
        checks.width = verified.width
        checks.height = verified.height
        checks.pixFmt = verified.pixFmt
        checks.codecTag = verified.codecTag
        checks.nbFrames = verified.nbFrames
        checks.rFrameRate = `${verified.rFrameRate?.num ?? '?'}/${verified.rFrameRate?.den ?? '?'}`
        checks.colorRange = verified.colorRange
        if (verified.width !== cfg.width) failures.push(`宽度不符：期望 ${cfg.width} 实际 ${verified.width}`)
        if (verified.height !== cfg.height) failures.push(`高度不符：期望 ${cfg.height} 实际 ${verified.height}`)
        if (!isProres4444WithAlpha(verified)) {
          failures.push(`ProRes 4444 透明通道校验失败：tag=${verified.codecTag} pix_fmt=${verified.pixFmt}`)
        }
        if (!frameRateMatches(verified, cfg.fps)) failures.push('帧率不符')
        if (verified.nbFrames !== null && verified.nbFrames !== report.framesTotal) {
          failures.push(`帧数不符：主进程统计 ${report.framesTotal}，产物 ${verified.nbFrames}`)
        }
      }
    } catch (error) {
      failures.push(`校验异常：${String(error)}`)
    }
  }

  // 验收第 2 条口径：1080p30/10s ≤ 30s；冒烟用其他规格时按像素比换算等效阈值
  if (cfg && report.elapsedMs > 0) {
    const scale = (1920 * 1080 * 300) / (cfg.width * cfg.height * report.framesTotal)
    const equivalent1080p30_10s = (report.elapsedMs / 1000) * scale
    checks.extrapolated1080p30_10sSec = Number(equivalent1080p30_10s.toFixed(1))
    /**
     * 两种出口都是内存直送编码（v11 起不再有 PNG 中间帧落盘），
     * 因此统一适用 30s 上界。
     */
    if (equivalent1080p30_10s > 30) {
      failures.push(`外推 1080p30/10s 耗时 ${equivalent1080p30_10s.toFixed(1)}s > 30s（验收第 2 条）`)
    }
  }

  /**
   * M4-6：体积预估系数标定核对。预估不能比实际小（磁盘预检会失效），
   * 也不能高出实际一个数量级（会误弹「建议改用 PNG 序列」，规格 §2.3）。
   * 实测两点：1080p30/10s = 0.555 bit/pixel/frame，4K60/2s = 0.237（平坦区随分辨率变大压缩更好），
   * 系数以最高的 1080p 为基准×2，因此对 4K 必然高估（实测 4.4×）——对磁盘预检是安全的，
   * 而「是否误弹 PNG 建议」由阈值在具体时长上单独断言（tests/probe.test.ts）。
   */
  if (cfg && report.ok) {
    try {
      const stat = await fs.stat(report.outputPath)
      const estimate = buildSizeEstimate({
        width: cfg.width,
        height: cfg.height,
        fps: cfg.fps,
        frames: report.framesTotal
      })
      const ratio = stat.size > 0 ? estimate.bytes / stat.size : Number.POSITIVE_INFINITY
      checks.estimateBytes = estimate.bytes
      checks.actualBytes = stat.size
      checks.estimateOverActual = Number(ratio.toFixed(2))
      checks.measuredBitsPerPixelFrame = Number(
        ((stat.size * 8) / (cfg.width * cfg.height * report.framesTotal)).toFixed(3)
      )
      const pixelFrames = cfg.width * cfg.height * report.framesTotal
      // 小尺寸/短时长产物被容器头部固定开销主导，不参与标定判定
      if (pixelFrames >= 3e8) {
        if (ratio < 1) failures.push(`预估低于实际产物（${(ratio * 100).toFixed(0)}%）：磁盘预检会失效`)
        if (ratio > 5) failures.push(`预估高出实际 ${ratio.toFixed(1)}×：超出实测上界，会误弹 PNG 序列建议（规格 §2.3）`)
      }
    } catch (error) {
      failures.push(`体积标定核对异常：${String(error)}`)
    }
  }

  return { passed: failures.length === 0, failures, checks }
}

export async function writeSmokeReport(
  report: SmokeReport,
  verification: SmokeVerification
): Promise<string> {
  const dir = config?.outputDir ?? path.join(app.getPath('temp'), 'socut-smoke')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'report.json')
  const payload = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    report,
    verification
  }
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}
