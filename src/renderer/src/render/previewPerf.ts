/**
 * 预览性能诊断计数（Task 1）。
 * 只做「普通对象自增」，不分配任何中间对象：这些计数会在每帧 rAF 里被碰到，
 * 一旦引入分配，诊断本身就会变成被测的开销。
 *
 * 模块顶层**不装任何定时器**：定时汇总由 `usePreviewLoop` 的 rAF 按窗口触发，
 * 否则 vitest 里 Import 这个模块就会留下永不停歇的 interval。
 */

export interface PreviewPerfCounters {
  /** 真正执行了原生层 render 的帧数 */
  renders: number
  /** 真正执行了 blitTo 的帧数（可能只换尺寸/透明底，不重画） */
  blits: number
  /** 整帧都没画的 rAF 次数（暂停且同一帧时应该持续增长） */
  skips: number
  /** 累计 render 耗时（ms） */
  renderMs: number
  /** 累计 blit 耗时（ms） */
  blitMs: number
  /** render+blit 超过 2 倍帧间隔的帧数 */
  longFrames: number
  /** 媒体层迟到翻转（由后续任务使用） */
  lateSwitches: number
  /** 播放回绕次数 */
  loopWraps: number
  /** 时间轴重绘（由后续任务使用） */
  timelineRenders: number
  /** 舞台重绘（由后续任务使用） */
  stageRenders: number
  /** 图层 tick（由后续任务使用） */
  layerTicks: number
  /** seek 请求数（由后续任务使用） */
  seekRequests: number
  /** 被合并的 seek 数（由后续任务使用） */
  seekCoalesced: number
}

export interface PreviewPerfSnapshot extends PreviewPerfCounters {
  /** 平均单帧 render 耗时（ms） */
  avgRenderMs: number
  /** 平均单帧 blit 耗时（ms） */
  avgBlitMs: number
}

/** 共享计数器：调用方直接 `previewPerf.renders += 1`，避免每帧创建对象。 */
export const previewPerf: PreviewPerfCounters = {
  renders: 0,
  blits: 0,
  skips: 0,
  renderMs: 0,
  blitMs: 0,
  longFrames: 0,
  lateSwitches: 0,
  loopWraps: 0,
  timelineRenders: 0,
  stageRenders: 0,
  layerTicks: 0,
  seekRequests: 0,
  seekCoalesced: 0
}

/** 原地清零（保持共享对象引用不变，计时窗口可以直接复用）。 */
export function resetPreviewPerf(): void {
  previewPerf.renders = 0
  previewPerf.blits = 0
  previewPerf.skips = 0
  previewPerf.renderMs = 0
  previewPerf.blitMs = 0
  previewPerf.longFrames = 0
  previewPerf.lateSwitches = 0
  previewPerf.loopWraps = 0
  previewPerf.timelineRenders = 0
  previewPerf.stageRenders = 0
  previewPerf.layerTicks = 0
  previewPerf.seekRequests = 0
  previewPerf.seekCoalesced = 0
}

/** 读数快照（额外给出平均值，方便日志直接看「一帧贵在哪」）。 */
export function previewPerfSnapshot(): PreviewPerfSnapshot {
  return {
    ...previewPerf,
    avgRenderMs: previewPerf.renders > 0 ? previewPerf.renderMs / previewPerf.renders : 0,
    avgBlitMs: previewPerf.blits > 0 ? previewPerf.blitMs / previewPerf.blits : 0
  }
}

/** 一行可读汇总（dev 日志直接用，不额外拼装）。 */
export function formatPreviewPerfSummary(snapshot: PreviewPerfSnapshot): string {
  return [
    `renders=${snapshot.renders}`,
    `blits=${snapshot.blits}`,
    `skips=${snapshot.skips}`,
    `render=${snapshot.avgRenderMs.toFixed(2)}ms`,
    `blit=${snapshot.avgBlitMs.toFixed(2)}ms`,
    `long=${snapshot.longFrames}`,
    `wraps=${snapshot.loopWraps}`,
    `late=${snapshot.lateSwitches}`,
    `timeline=${snapshot.timelineRenders}`,
    `stage=${snapshot.stageRenders}`,
    `layerTicks=${snapshot.layerTicks}`,
    `seek=${snapshot.seekRequests}/${snapshot.seekCoalesced}`
  ].join(' ')
}

/** 累计一帧的耗时；超过 2 倍帧间隔就算一次长帧（60Hz 下约 33ms）。 */
export function noteFrame(input: { renderMs: number; blitMs: number; frameIntervalSec: number }): void {
  previewPerf.renderMs += input.renderMs
  previewPerf.blitMs += input.blitMs
  if (input.renderMs + input.blitMs > 2 * input.frameIntervalSec * 1000) previewPerf.longFrames += 1
}

/**
 * 真机性能读数入口（SubTask 8.3）：CDP / devtools 控制台直接调用
 * `window.__socutPreviewPerf()` 读快照、`__socutPreviewPerfReset()` 清零。
 */
declare global {
  interface Window {
    __socutPreviewPerf?: () => PreviewPerfSnapshot
    __socutPreviewPerfReset?: () => void
  }
}

if (typeof window !== 'undefined') {
  window.__socutPreviewPerf = () => previewPerfSnapshot()
  window.__socutPreviewPerfReset = () => resetPreviewPerf()
}
