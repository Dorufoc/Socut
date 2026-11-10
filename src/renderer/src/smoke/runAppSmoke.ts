import { createId, createClip, createDefaultProject } from '@shared/projectSchema'
import { frameTimeSec, snapTimeToFrame } from '@shared/fps'
import { getPreset } from '@shared/presets'
import type { SmokeConfig, SmokeReport } from '@shared/api'
import type { ExportRequest, FontRecord, JobResult } from '@shared/types'
import { buildRenderJob } from '../render/jobBuilder'
import { runGateSmoke } from './runGateSmoke'
import { frameSpecOf, frameStats, registerExportJob, resetFrameStats } from '../render/frameSource'
import { ensureFontRegistered } from '../hooks/useFontLoader'

/**
 * 应用内端到端冒烟（M0-8 / M1 判据）：
 * 走**完全相同的真实管线** —— 预设 → Yoga 布局 → renderFrame 到原生分辨率 OffscreenCanvas
 * → convertToBlob → MessagePort 回传 → 主进程 stdin → ProRes 4444 → ffprobe 校验。
 * 结果上报主进程后由主进程带状态码退出。
 */

export async function runAppSmoke(config: SmokeConfig): Promise<void> {
  try {
    if (config.scenario === 'gate') await runGateScenario(config)
    else if (config.scenario === 'overlay') await runOverlaySmoke(config)
    else await runExportSmoke(config)
  } catch (error) {
    // 任何异常也要上报，否则主件只能靠看门狗超时而拿不到原因
    await report({
      jobId: 'exception',
      outputPath: '',
      framesTotal: 0,
      elapsedMs: 0,
      bytesWritten: 0,
      ok: false,
      scenario: config.scenario,
      errorCode: 'SMOKE_EXCEPTION',
      errorMessage: error instanceof Error ? error.stack ?? error.message : String(error)
    })
    throw error
  }
}

/** 字体注册必须先完成，否则 Canvas 会回落默认字形（预览与导出就会不一致） */
async function registerFonts(fontIndex: FontRecord[]): Promise<void> {
  for (const record of fontIndex) {
    try {
      await ensureFontRegistered(record)
    } catch {
      // 单个字体缺失不阻断冒烟
    }
  }
}

/**
 * 叠加合成冒烟（验收第 4/5/6 条）：导入参考视频 → 参数全部跟随参考 →
 * span 限定重渲染 → overlay 合成 → 主进程用独立探测交叉校验。
 * 门禁（CompatModal）在这里按“已确认”处理：它属于 UI 阻断行为，由 M3-2 覆盖。
 */
async function runOverlaySmoke(config: SmokeConfig): Promise<void> {
  if (!config.refVideoPath) throw new Error('overlay 场景缺少参考视频路径（SOCUT_SMOKE_REF）')
  const startedAt = performance.now()
  const fontIndex: FontRecord[] = await window.socut.fonts.list()
  if (fontIndex.length === 0) throw new Error('内置字体未就位（npm run fetch:fonts）')
  await registerFonts(fontIndex)

  const probe = await window.socut.video.probe(config.refVideoPath)
  if (!probe) throw new Error(`参考视频探测失败：${config.refVideoPath}`)
  // 本场景会排两个片段（各占时长一半 + 中间 0.4s 间隙）；参考太短会让布局退化，
  // 造成“出点提前”这种让人误会的失败，所以直接报前置条件不足。
  if (probe.meta.durationSec < 4) {
    throw new Error(
      `overlay 场景需要 ≥ 4s 的参考视频（实际 ${probe.meta.durationSec.toFixed(2)}s）；请用 ref-720p23976.mp4 / ref-1080p.mp4 这类夹具`
    )
  }
  const fps = probe.suggestedFps

  const project = createDefaultProject('app-smoke-overlay')
  project.resolution = { width: probe.meta.width, height: probe.meta.height }
  project.fps = fps
  project.refVideo = {
    path: config.refVideoPath,
    meta: probe.meta,
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: probe.flags.vfr ? 'converted' : 'none',
    compactMode: 'auto',
    importedAt: new Date().toISOString()
  }

  // 两个片段 + 中间 0.4s 间隙：同时验证多片段、间隙全透明与 span 限定
  const duration = probe.meta.durationSec
  const first = createClip({ startTime: 0.5, fps })
  first.presetId = 'stackedNews'
  first.content = { title: '叠加冒烟：全省夏粮收购启动', subtitle: '本产物由应用内端到端冒烟生成' }
  first.startTime = snapTimeToFrame(0.5, fps)
  first.endTime = snapTimeToFrame(Math.max(1.5, duration / 2 - 0.2), fps)
  first.animation = { ...getPreset('stackedNews').animation }

  const second = createClip({ startTime: duration / 2 + 0.4, fps })
  second.presetId = 'breakingRed'
  second.content = { title: '突发：地铁 4 号线临时限速', subtitle: '运营方正在调整运行图' }
  second.startTime = snapTimeToFrame(duration / 2 + 0.4, fps)
  second.endTime = snapTimeToFrame(Math.max(duration / 2 + 1, duration - 0.5), fps)
  second.animation = { ...getPreset('breakingRed').animation }

  project.clips = [first, second]

  const spec = await buildRenderJob({
    project,
    fontIndex,
    resolution: { width: probe.meta.width, height: probe.meta.height },
    fps,
    scope: { kind: 'timeline' },
    frameFormat: 'raw',
    // 与生产叠加出口同口径（计划 C7）
    restrictToActiveSpan: true
  })
  const framesTotal = spec.endFrame - spec.startFrame

  const jobId = createId('smoke')
  resetFrameStats()
  registerExportJob(jobId, spec)
  const fileName = `app-smoke-overlay-${probe.meta.width}x${probe.meta.height}.mp4`
  const spanStartSec = frameTimeSec(spec.startFrame, fps)
  const spanEndSec = frameTimeSec(spec.endFrame, fps)
  const firstRendered = spec.clips[0]
  const lastRendered = spec.clips[spec.clips.length - 1]
  const request: ExportRequest = {
    jobId,
    target: { kind: 'overlayMp4', outputDir: config.outputDir, fileName },
    frameSpec: frameSpecOf(spec),
    codec: 'prores4444',
    overlay: {
      refVideoPath: config.refVideoPath,
      refMeta: probe.meta,
      // 与生产一致：非 aac/mp3 或无音轨时直接走 AAC（计划 C4）；
      // force-copy 则故意跳过预检，用来取证「copy 运行期失败 → 单次 AAC 重试 + 提示」（验收第 7 条）
      audioMode: config.forceCopyAudio
        ? 'copy'
        : probe.meta.audioCodec === null || probe.flags.audioTranscodeNeeded
          ? 'aac'
          : 'copy',
      fpsMode: 'cfr',
      spanStartSec,
      spanEndSec
    }
  }
  const resultPromise = waitForJobResult(jobId, 150_000)
  await window.socut.export.start(request)
  const result = await resultPromise

  await report({
    jobId,
    outputPath: result?.outputs[0] ?? `${config.outputDir}/${fileName}`,
    framesTotal,
    elapsedMs: performance.now() - startedAt,
    bytesWritten: result?.progress.bytesWritten ?? 0,
    ok: result?.ok ?? false,
    scenario: 'overlay',
    spanStartSec,
    spanEndSec,
    spanInFrames: firstRendered?.animation.inFrames ?? 0,
    spanOutFrames: lastRendered?.animation.outFrames ?? 0,
    notices: result?.progress.notices ?? [],
    stats: frameStats(),
    errorCode: result?.error?.code,
    errorMessage: result?.error?.message,
    stderrTail: result?.error?.stderrTail
  })
}

/**
 * 门禁场景：不渲染，只跑导入门禁（验收第 5/6 条）。
 * 上报的是事实数据，判定交给主进程交叉复测。
 */
async function runGateScenario(config: SmokeConfig): Promise<void> {
  const startedAt = performance.now()
  const outcome = await runGateSmoke(config.fixtureDir ?? '')
  await report({
    jobId: 'gate',
    outputPath: outcome.cfrOutputPath ?? '',
    framesTotal: 0,
    elapsedMs: performance.now() - startedAt,
    bytesWritten: 0,
    ok: outcome.failures.length === 0,
    scenario: 'gate',
    gate: outcome
  })
}

async function runExportSmoke(config: SmokeConfig): Promise<void> {
  const startedAt = performance.now()
  const fontIndex: FontRecord[] = await window.socut.fonts.list()
  if (fontIndex.length === 0) {
    await report({
      jobId: 'none',
      outputPath: '',
      framesTotal: 0,
      elapsedMs: 0,
      bytesWritten: 0,
      ok: false,
      scenario: config.scenario,
      errorCode: 'NO_FONTS',
      errorMessage: '内置字体未就位（npm run fetch:fonts）'
    })
    return
  }

  // 字体注册必须先完成，否则 Canvas 会回落默认字形（预览与导出就会不一致）
  await registerFonts(fontIndex)

  const project = createDefaultProject('app-smoke')
  project.resolution = { width: config.width, height: config.height }
  project.fps = config.fps

  // 两个片段 + 中间 0.4s 间隙：同时验证多片段与「间隙全透明」
  const first = createClip({ startTime: 0, fps: config.fps })
  first.presetId = 'stackedNews'
  first.content = { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' }
  first.startTime = snapTimeToFrame(0, config.fps)
  first.endTime = snapTimeToFrame(config.durationSec / 2, config.fps)
  first.animation = { ...getPreset('stackedNews').animation }

  const second = createClip({ startTime: config.durationSec * 0.5 + 0.4, fps: config.fps })
  second.presetId = 'policyAuthority'
  second.content = { title: '台风“木兰”路径更新', subtitle: '中央气象台 06 时发布' }
  second.startTime = snapTimeToFrame(config.durationSec / 2 + 0.4, config.fps)
  second.endTime = snapTimeToFrame(config.durationSec, config.fps)
  second.animation = { ...getPreset('policyAuthority').animation }

  project.clips = [first, second]

  const spec = await buildRenderJob({
    project,
    fontIndex,
    resolution: { width: config.width, height: config.height },
    fps: config.fps,
    scope: { kind: 'timeline' },
    // 与生产 useExportJob 同口径：只有 PNG 序列出口的帧要落盘，必须给真 PNG
    frameFormat: config.exportKind === 'pngSequence' ? 'png' : 'raw'
  })
  const framesTotal = spec.endFrame - spec.startFrame

  const jobId = createId('smoke')
  resetFrameStats()
  registerExportJob(jobId, spec)
  const fileName =
    config.exportKind === 'pngSequence'
      ? `app-smoke-${config.width}x${config.height}-png`
      : `app-smoke-${config.width}x${config.height}.mov`
  const request: ExportRequest = {
    jobId,
    target: { kind: config.exportKind, outputDir: config.outputDir, fileName },
    frameSpec: frameSpecOf(spec),
    codec: 'prores4444'
  }
  // 结果订阅先于发起：避免极快任务下错过已完成事件
  const resultPromise = waitForJobResult(jobId, 150_000)
  await window.socut.export.start(request)

  // 取消场景：监控到**主进程已写出**若干帧后主动取消（验收第 8 条的取证入口）。
  // 不能改用渲染侧的 frameStats：帧先排入 IPC 队列，主进程可能一帧还没写盘就被取消，
  // 那样取证的只是“入队后取消”，证明不了背压/写盘路径（实测 PNG 目录出口会稳定复现）。
  let framesDoneBeforeCancel = 0
  if (config.scenario === 'cancel') {
    framesDoneBeforeCancel = await waitProgressFrames(jobId, 8)
    await window.socut.export.cancel(jobId)
  }

  const result = await resultPromise
  const elapsedMs = performance.now() - startedAt
  await report({
    jobId,
    outputPath: result?.outputs[0] ?? `${config.outputDir}/${fileName}`,
    framesTotal,
    elapsedMs,
    bytesWritten: result?.progress.bytesWritten ?? 0,
    ok: result?.ok ?? false,
    scenario: config.scenario,
    framesDoneBeforeCancel: config.scenario === 'cancel' ? framesDoneBeforeCancel : undefined,
    stats: frameStats(),
    errorCode: result?.error?.code,
    errorMessage: result?.error?.message,
    stderrTail: result?.error?.stderrTail
  })
}

/**
 * 等到主进程汇报「已写出 ≥ minFrames 帧」再返回，返回值就是那时的写盘帧数。
 * 超时（20s）也返回，交给上层断言去报错——不在这里静默等到任务结束。
 */
async function waitProgressFrames(jobId: string, minFrames: number): Promise<number> {
  return new Promise((resolve) => {
    let seen = 0
    const startedAt = performance.now()
    const finish = (): void => {
      clearInterval(timer)
      off()
      resolve(seen)
    }
    const off = window.socut.job.onProgress((progress) => {
      if (progress.jobId !== jobId) return
      seen = Math.max(seen, progress.framesDone)
      if (seen >= minFrames) finish()
    })
    const timer = setInterval(() => {
      if (performance.now() - startedAt > 20_000) finish()
    }, 50)
  })
}

async function waitForJobResult(jobId: string, timeoutMs: number): Promise<JobResult | null> {
  return new Promise((resolve) => {
    let settled = false
    const off = window.socut.job.onResult((incoming) => {
      if (incoming.jobId !== jobId) return
      settled = true
      off()
      resolve(incoming)
    })
    setTimeout(() => {
      if (settled) return
      off()
      resolve(null)
    }, timeoutMs)
  })
}

async function report(payload: SmokeReport): Promise<void> {
  try {
    await window.socut.app.smokeReport(payload)
  } catch (error) {
    // 主进程收不到上报时会被自身的超时看门狗终止
    console.error('冒烟上报失败', error)
  }
}
