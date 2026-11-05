import { createClip, createDefaultProject } from '@shared/projectSchema'
import { snapTimeToFrame } from '@shared/fps'
import { FPS_30 } from '@shared/constants'
import { getPreset } from '@shared/presets'
import type { FontRecord, RenderJobSpec } from '@shared/types'
import { buildRenderJob, renderJobToPngBlob } from '../render/jobBuilder'
import { NativeStage, drawCheckerboard } from '../render/stage'
import { motionAt } from '../render/animation'
import { contentBoundsOf } from '../render/layers'
import { ensureFontRegistered } from '../hooks/useFontLoader'

/**
 * 预览/导出像素一致性回归（计划 M1-7 判据的字面要求）。
 * tests/pixelParity.test.ts 证明的是「绘制指令确定」；这里补上真正的逐像素比对，
 * 并且把两件容易混为一谈的事分开量化：
 *
 *  A. **同一帧的两个出口必须逐字节相同**——预览舞台回读 vs 导出帧字节（rawRgba，即真正喂给 FFmpeg 的像素）。
 *     这是「单一像素生产者」的可证伪形式，容差 0。
 *  B. **PNG 容器往返误差**：导出 PNG 解码回像素与原生层比。Canvas 内部是预乘 alpha，
 *     PNG 是直通 alpha，往返在部分透明像素上必然产生 ≤若干 LSB 的舍入差；
 *     不透明/全透明像素要求完全一致，部分透明像素给容差（实测入场/出场帧 alpha<1 时最大 6）。
 *  C. **预览 blit（缩放显示）vs 导出 PNG 按同尺寸同算法缩放**：blitTo 会按 devicePixelRatio
 *     重算目标尺寸，比对必须在 blit 后的真实尺寸上进行（否则是拿不同大小的数组比，纯误报）。
 *  D. **擦除样式与自适应宽度的像素级证据**：在主条高度中段扫描不透明像素包围盒，
 *     入场帧右边界单调右推、左边界不动；出场帧左边界右推、右边界不动；
 *     并与 motionAt 的 wipeTo 逐帧对照（容差 2%）。同时记录短/长文案的条宽，
 *     证明「宽度跟随文字、超上限才换行」。
 *
 * 只在开发环境由 FOCUSNEWS_PIXELCHECK=<json 路径> 触发，主进程把报告里的 passed 翻译成退出码。
 */

/** 部分透明像素的 PNG 往返容差（通道级）。不透明/全透明像素要求 0。 */
const PNG_ROUNDTRIP_CHANNEL_TOLERANCE = 8
/** blit 与「同尺寸缩放导出图」之间的通道容差（含 PNG 往返 + 两次重采样）。 */
const SCALED_CHANNEL_TOLERANCE = PNG_ROUNDTRIP_CHANNEL_TOLERANCE + 2
/** 上述差异像素占比上限。 */
const SCALED_DIFF_RATIO_LIMIT = 0.01

interface DiffStats {
  diffPixels: number
  maxChannelDiff: number
  strictDiffPixels: number
  totalPixels: number
}

interface PixelData {
  data: Uint8ClampedArray
  width: number
  height: number
}

function compare(a: PixelData, b: PixelData): DiffStats {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`比对尺寸不一致：${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
  let diffPixels = 0
  let strictDiffPixels = 0
  let maxChannelDiff = 0
  const total = a.width * a.height
  for (let p = 0; p < total; p++) {
    const i = p * 4
    const alphaA = a.data[i + 3] ?? 0
    const alphaB = b.data[i + 3] ?? 0
    let frameDiff = 0
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0))
      if (delta > maxChannelDiff) maxChannelDiff = delta
      if (delta > 0) frameDiff = 1
    }
    diffPixels += frameDiff
    // 不透明与全透明像素没有任何预乘舍入空间，必须完全一致
    const opaqueOrClear = (alphaA === 255 && alphaB === 255) || (alphaA === 0 && alphaB === 0)
    if (opaqueOrClear && frameDiff === 1) strictDiffPixels += 1
  }
  return { diffPixels, maxChannelDiff, strictDiffPixels, totalPixels: total }
}

function bytesIdentical(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

async function decodeToPixels(bytes: ArrayBuffer, width: number, height: number): Promise<PixelData> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })
  if (!ctx) throw new Error('无法创建解码上下文')
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const image = ctx.getImageData(0, 0, width, height)
  return { data: image.data, width, height }
}

/** 把 PNG 字节按指定尺寸重采样到带棋盘格背景的画布（模拟显示层）。 */
async function scaledFromPng(bytes: ArrayBuffer, targetWidth: number, targetHeight: number): Promise<PixelData> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建缩放参考层')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawCheckerboard(ctx, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data: image.data, width: canvas.width, height: canvas.height }
}

interface FrameResult {
  frame: number
  /** A：预览原生层 vs 导出帧字节（必须逐字节相同） */
  exportBytesIdenticalToPreview: boolean
  /** B：导出 PNG 解码 vs 原生层 */
  pngRoundtrip: DiffStats
  /** C：预览 blit（真实尺寸）vs 导出 PNG 同尺寸缩放 */
  scaled: DiffStats & { blitSize: string }
}

/** 主条高度中段扫描带：避开与副条的负 margin 重叠区，只度量主条自己的擦除宽度。 */
function bandBox(
  image: PixelData,
  band: { y0: number; y1: number },
  minAlpha = 16
): { left: number; right: number; top: number; bottom: number } | null {
  let left = Number.POSITIVE_INFINITY
  let right = -1
  let top = Number.POSITIVE_INFINITY
  let bottom = -1
  const start = Math.max(0, Math.floor(band.y0))
  const end = Math.min(image.height - 1, Math.ceil(band.y1))
  for (let y = start; y <= end; y++) {
    const rowOffset = y * image.width * 4
    for (let x = 0; x < image.width; x++) {
      const alpha = image.data[rowOffset + x * 4 + 3] ?? 0
      if (alpha < minAlpha) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right < 0 ? null : { left, right, top, bottom }
}

export interface PixelCheckInput {
  outputPath: string
  width?: number
  height?: number
}

/** D 的一块采样：主条中段内的不透明像素包围盒（原生分辨率像素坐标）。 */
export interface WipeSample {
  localFrame: number
  phase: 'in' | 'steady' | 'out'
  left: number
  right: number
  /** (right - bar.x + 1) / bar.w，可直接与 motionAt 的 wipeTo / (1 - wipeFrom) 对照 */
  visibleRatio: number
  /** 同帧 motionAt 的擦除窗口（用于容差对照） */
  expectedRatio: number
}

/** D：擦除样式 + 标题宽度法则 + 副条自适应的像素级证据。 */
export interface WipeProbe {
  preset: string
  bar: { x: number; y: number; w: number; h: number }
  inFrames: number
  outFrames: number
  samples: WipeSample[]
  /** 主条实测宽 / root 实测宽（应相等）；左右边距实测值（应相等） */
  titleWidth: number
  /** 长文案主条实测宽（自适应：应宽于短文案且不超 root 右缘） */
  longTitleWidth: number
  rootWidth: number
  leftMargin: number
  rightMargin: number
  /** 副条仍按文字自适应：短文案 < 长文案 */
  shortSubWidth: number
  longSubWidth: number
  /** 垂直顺序：副条在主条上方（subBarTop < barTop） */
  barTop: number
  subBarTop: number
  longTitleLines: number
  shortTitleLines: number
}

export interface PixelCheckReport {
  generatedAt: string
  resolution: string
  fps: string
  devicePixelRatio: number
  frames: FrameResult[]
  wipe: WipeProbe
  tolerances: {
    exportBytesMustMatchExactly: true
    pngRoundtripChannelTolerance: number
    scaledChannelTolerance: number
    scaledDiffRatioLimit: number
  }
  passed: boolean
  failures: string[]
}

/** 擦除探针：与像素一致性用同一套生产者，只看主条中段的不透明包围盒。 */
const PROBE_CLIP_SEC = 3
const PROBE_PRESET = 'stackedNews'
/** 像素包围盒与 motionAt 的容差（含整像素取整与抗锯齿边缘） */
const PROBE_RATIO_TOLERANCE = 0.02

interface ProbeJob {
  spec: RenderJobSpec
  bar: { x: number; y: number; w: number; h: number }
  /** 副条盒：仍按文字自适应，用于对照主条的“满宽减等边距” */
  subBar: { x: number; y: number; w: number; h: number }
  /** 片段 root 盒：左右布局边距与 8vh 底部锚点的参照（不再是擦除跨度） */
  root: { x: number; w: number }
  /** 擦除跨度：与 renderFrame 同一口径，取实际绘制内容的横向包络 */
  sweep: { x: number; w: number }
  titleLines: number
  inFrames: number
  outFrames: number
  totalFrames: number
}

async function buildProbeJob(input: {
  content: { title: string; subtitle: string }
  fontIndex: FontRecord[]
  width: number
  height: number
}): Promise<ProbeJob> {
  const fps = FPS_30
  const preset = getPreset(PROBE_PRESET)
  const project = createDefaultProject('wipe-probe')
  project.resolution = { width: input.width, height: input.height }
  project.fps = fps
  const clip = createClip({ startTime: 0, fps, presetId: preset.id })
  clip.content = { ...input.content }
  clip.startTime = snapTimeToFrame(0, fps)
  clip.endTime = snapTimeToFrame(PROBE_CLIP_SEC, fps)
  clip.animation = { ...preset.animation }
  project.clips = [clip]

  const spec = await buildRenderJob({
    project,
    fontIndex: input.fontIndex,
    resolution: { width: input.width, height: input.height },
    fps,
    scope: { kind: 'timeline' }
  })
  const jobClip = spec.clips[0]
  if (!jobClip) throw new Error('擦除探针：渲染作业没有片段')
  const barBox = jobClip.boxes.find((box) => box.role === 'primaryBar')
  if (!barBox) throw new Error('擦除探针：找不到主条盒')
  const subBarBox = jobClip.boxes.find((box) => box.role === 'secondaryBar')
  if (!subBarBox) throw new Error('擦除探针：找不到副条盒')
  const rootBox = jobClip.boxes[0]
  if (!rootBox) throw new Error('擦除探针：找不到 root 盒')
  const titleBox = jobClip.boxes.find((box) => box.role === 'title')
  const titleLines = titleBox?.text
    ? Math.max(1, Math.round(titleBox.h / titleBox.text.lineHeightPx))
    : 1
  const sweep = contentBoundsOf(jobClip.boxes)
  return {
    spec,
    bar: { x: barBox.x, y: barBox.y, w: barBox.w, h: barBox.h },
    subBar: { x: subBarBox.x, y: subBarBox.y, w: subBarBox.w, h: subBarBox.h },
    root: { x: rootBox.x, w: rootBox.w },
    sweep,
    titleLines,
    inFrames: Math.max(1, jobClip.animation.inFrames),
    outFrames: Math.max(1, jobClip.animation.outFrames),
    totalFrames: spec.endFrame - spec.startFrame
  }
}

async function probeWipeAndHug(input: {
  fontIndex: FontRecord[]
  width: number
  height: number
  failures: string[]
}): Promise<WipeProbe> {
  const { fontIndex, width, height, failures } = input
  const shortJob = await buildProbeJob({
    content: { title: '新规发布', subtitle: '解读' },
    fontIndex,
    width,
    height
  })
  const longJob = await buildProbeJob({
    // 主条已是「满宽减等边距」，换行样本必须真的超过这个宽度（1080p 下 1536px）：
    // 22 字在满宽下反而放得下，故用 44 字，保证“超过就换行”这条判据真的被执行
    content: {
      title: '长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(2),
      subtitle: '省发展改革委负责人表示新规将覆盖交通能源与数据要素三大领域'
    },
    fontIndex,
    width,
    height
  })

  const stage = new NativeStage(width, height)
  const bandOf = (job: ProbeJob) => ({ y0: job.bar.y + job.bar.h * 0.25, y1: job.bar.y + job.bar.h * 0.75 })
  /** 副条中段的扫描带：用于证明“副条仍按文字自适应” */
  const subBandOf = (job: ProbeJob) => ({
    y0: job.subBar.y + job.subBar.h * 0.25,
    y1: job.subBar.y + job.subBar.h * 0.75
  })
  const measure = (job: ProbeJob, localFrame: number): ReturnType<typeof bandBox> => {
    stage.render(job.spec, job.spec.startFrame + localFrame, {})
    return bandBox(stage.imageData(), bandOf(job))
  }
  const measureSub = (job: ProbeJob, localFrame: number): ReturnType<typeof bandBox> => {
    stage.render(job.spec, job.spec.startFrame + localFrame, {})
    return bandBox(stage.imageData(), subBandOf(job))
  }

  const shortSteady = measure(shortJob, shortJob.inFrames + 5)
  const longSteady = measure(longJob, longJob.inFrames + 5)
  const shortSub = measureSub(shortJob, shortJob.inFrames + 5)
  const longSub = measureSub(longJob, longJob.inFrames + 5)
  if (!shortSteady || !longSteady || !shortSub || !longSub) {
    throw new Error('宽度探针：稳态帧没有拍到任何像素')
  }
  const titleWidth = shortSteady.right - shortSteady.left + 1
  const longTitleWidth = longSteady.right - longSteady.left + 1
  // 边距读数保留在报告里：leftMargin = 条左缘（应 == root.x）；
  // rightMargin 在自适应宽度下不再是布局量，仅作现场参考
  const leftMargin = shortSteady.left
  const rightMargin = width - 1 - shortSteady.right
  const shortSubWidth = shortSub.right - shortSub.left + 1
  const longSubWidth = longSub.right - longSub.left + 1

  // 标题宽度法则（自适应宽度版）：左缘钉在布局边距上，宽度随文案增长但不超 root；
  // root 仍是「画宽减左右等边距」，布局边距相等性在 root 自身验（而不是条宽）
  const rootRightMargin = width - shortJob.root.x - shortJob.root.w
  if (Math.abs(shortJob.root.x - rootRightMargin) > 1) {
    failures.push(`布局边距：root 左右不等（左 ${shortJob.root.x} / 右 ${rootRightMargin}）`)
  }
  if (shortSteady.left !== shortJob.root.x) {
    failures.push(`标题宽度：主条左缘 ${shortSteady.left} 应钉在 root 左缘 ${shortJob.root.x}`)
  }
  if (!(longSteady.right > shortSteady.right)) {
    failures.push(`标题宽度：长文案右边界 ${longSteady.right} 未比短文案 ${shortSteady.right} 更宽（应跟随文字自适应）`)
  }
  if (longSteady.right > shortJob.root.x + shortJob.root.w) {
    failures.push(`标题宽度：长文案 ${longSteady.right} 超出 root 右缘 ${shortJob.root.x + shortJob.root.w}`)
  }
  // 副条：仍按文字自适应
  if (!(longSubWidth > shortSubWidth + 8)) {
    failures.push(`副条自适应：长文案 ${longSubWidth} 未明显大于短文案 ${shortSubWidth}`)
  }
  if (longJob.titleLines < 2) {
    failures.push(`自动换行：长文案仍为 ${longJob.titleLines} 行（应≥ 2）`)
  }
  if (!(shortJob.subBar.y < shortJob.bar.y)) {
    failures.push(`布局顺序：副条应在主条上方（副条 y=${shortJob.subBar.y} / 主条 y=${shortJob.bar.y}）`)
  }

  const anim = shortJob.spec.clips[0]!.animation
  const samples: WipeSample[] = []
  const push = (localFrame: number, phase: WipeSample['phase']): void => {
    const box = measure(shortJob, localFrame)
    if (!box) return
    const motion = motionAt(anim, localFrame)
    // 与 renderFrame 同一口径：一条绝对擦除线被主条盒裁切后的可见区间；
    // 跨度取内容包络（条宽随文字自适应），不是 root 盒
    const lineLeft = shortJob.sweep.x + shortJob.sweep.w * motion.wipeFrom
    const lineRight = shortJob.sweep.x + shortJob.sweep.w * motion.wipeTo
    const expLeft = Math.max(shortJob.bar.x, lineLeft)
    const expRight = Math.min(shortJob.bar.x + shortJob.bar.w, lineRight)
    if (Math.abs(box.left - expLeft) > 1) {
      failures.push(`擦除线：帧 ${localFrame} 实测左边界 ${box.left} 与擦除线 ${Math.round(expLeft)} 不一致`)
    }
    samples.push({
      localFrame,
      phase,
      left: box.left,
      right: box.right,
      visibleRatio: Number(((box.right - box.left + 1) / shortJob.bar.w).toFixed(4)),
      expectedRatio: Number((Math.max(0, expRight - expLeft) / shortJob.bar.w).toFixed(4))
    })
  }
  for (let frame = 0; frame <= shortJob.inFrames; frame++) push(frame, 'in')
  push(shortJob.inFrames + 5, 'steady')
  for (let i = 1; i <= shortJob.outFrames; i += Math.max(1, Math.floor(shortJob.outFrames / 3))) {
    push(shortJob.totalFrames - shortJob.outFrames + i, 'out')
  }

  const entrance = samples.filter((s) => s.phase === 'in')
  const steady = samples.find((s) => s.phase === 'steady')
  const exit = samples.filter((s) => s.phase === 'out')

  // 入场：左边界固定在主条左边缘，右边界只增不减
  for (const sample of entrance) {
    if (Math.abs(sample.visibleRatio - sample.expectedRatio) > PROBE_RATIO_TOLERANCE) {
      failures.push(
        `擦除入场：帧 ${sample.localFrame} 实测右边界比 ${sample.visibleRatio} 与 motionAt ${sample.expectedRatio} 偏差超 ${PROBE_RATIO_TOLERANCE}`
      )
    }
  }
  for (let i = 1; i < entrance.length; i++) {
    const prev = entrance[i - 1]!
    const cur = entrance[i]!
    if (cur.right < prev.right) {
      failures.push(`擦除入场：帧 ${cur.localFrame} 右边界回退（${prev.right} → ${cur.right}）`)
    }
  }
  if (steady && steady.visibleRatio < 0.99) {
    failures.push(`擦除入场：稳态可见比 ${steady.visibleRatio} < 0.99（条块未完全露出）`)
  }
  // 出场：右边界留在原位，左边界向右推进
  for (const sample of exit) {
    if (steady && Math.abs(sample.right - steady.right) > 1) {
      failures.push(`擦除出场：帧 ${sample.localFrame} 右边界 ${sample.right} 跑出了稳态 ${steady.right}`)
    }
    if (steady && sample.left <= steady.left) {
      failures.push(`擦除出场：帧 ${sample.localFrame} 左边界未推进（${sample.left} ≤ ${steady.left}）`)
    }
    if (Math.abs(sample.visibleRatio - sample.expectedRatio) > PROBE_RATIO_TOLERANCE) {
      failures.push(
        `擦除出场：帧 ${sample.localFrame} 实测剩余比 ${sample.visibleRatio} 与 motionAt ${sample.expectedRatio} 偏差超 ${PROBE_RATIO_TOLERANCE}`
      )
    }
  }

  return {
    preset: PROBE_PRESET,
    bar: shortJob.bar,
    inFrames: shortJob.inFrames,
    outFrames: shortJob.outFrames,
    samples,
    titleWidth,
    longTitleWidth,
    rootWidth: shortJob.root.w,
    leftMargin,
    rightMargin,
    shortSubWidth,
    longSubWidth,
    barTop: shortJob.bar.y,
    subBarTop: shortJob.subBar.y,
    longTitleLines: longJob.titleLines,
    shortTitleLines: shortJob.titleLines
  }
}

export async function runPixelParityCheck(input: PixelCheckInput): Promise<PixelCheckReport> {
  const width = input.width ?? 1920
  const height = input.height ?? 1080
  const fps = FPS_30
  const failures: string[] = []
  const frames: FrameResult[] = []

  const fontIndex: FontRecord[] = await window.focusnews.fonts.list()
  if (fontIndex.length === 0) throw new Error('内置字体未就位（npm run fetch:fonts）')
  for (const record of fontIndex) {
    try {
      await ensureFontRegistered(record)
    } catch {
      // 单只字体缺失不阻断一致性检查
    }
  }

  const project = createDefaultProject('pixel-parity')
  project.resolution = { width, height }
  project.fps = fps
  const first = createClip({ startTime: 0, fps })
  first.presetId = 'stackedNews'
  first.content = { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' }
  first.startTime = snapTimeToFrame(0, fps)
  first.endTime = snapTimeToFrame(2, fps)
  first.animation = { ...getPreset('stackedNews').animation }
  const second = createClip({ startTime: 2.6, fps })
  second.presetId = 'financeData'
  second.content = { title: '上证指数 3 241.66', subtitle: '+0.86% · 成交额 3 812 亿元' }
  second.startTime = snapTimeToFrame(2.6, fps)
  second.endTime = snapTimeToFrame(4, fps)
  second.animation = { ...getPreset('financeData').animation }
  project.clips = [first, second]

  const spec = await buildRenderJob({
    project,
    fontIndex,
    resolution: { width, height },
    fps,
    scope: { kind: 'timeline' },
    frameFormat: 'png'
  })

  const firstClip = spec.clips[0]
  const secondClip = spec.clips[1]
  const inFrames = firstClip?.animation.inFrames ?? 8
  const outStart = (secondClip?.endFrame ?? spec.endFrame) - (secondClip?.animation.outFrames ?? 5)
  const candidates: (number | undefined)[] = [
    firstClip === undefined ? undefined : firstClip.startFrame + Math.floor(inFrames / 2),
    firstClip === undefined ? undefined : firstClip.startFrame + inFrames,
    Math.floor((spec.startFrame + spec.endFrame) / 2),
    outStart + 1,
    firstClip === undefined ? undefined : firstClip.endFrame + 1
  ]
  const sampleFrames = candidates.filter(
    (frame): frame is number => frame !== undefined && frame >= spec.startFrame && frame < spec.endFrame
  )

  const previewStage = new NativeStage(width, height)
  const exportStage = new NativeStage(width, height)
  const display = document.createElement('canvas')

  for (const frame of sampleFrames) {
    previewStage.render(spec, frame, {})
    exportStage.render(spec, frame, {})

    // A. 预览原生层 vs 导出帧字节（rawRgba 就是主路径真正写进 FFmpeg 的缓冲）
    const previewImage = previewStage.imageData()
    const exportRaw = exportStage.rawRgba()
    const exportBytesIdentical = bytesIdentical(previewImage.data.buffer as ArrayBuffer, exportRaw)
    if (!exportBytesIdentical) {
      failures.push(`帧 ${frame}：预览原生层与导出帧字节不一致（单一像素生产者被破坏）`)
    }

    // B. 导出 PNG 往返
    const pngBytes = await exportStage.pngBuffer()
    const decoded = await decodeToPixels(pngBytes, width, height)
    const roundtrip = compare(
      { data: previewImage.data, width, height },
      decoded
    )
    if (roundtrip.strictDiffPixels > 0) {
      failures.push(`帧 ${frame}：PNG 往返改变了 ${roundtrip.strictDiffPixels} 个不透明/全透明像素（应为 0）`)
    }
    if (roundtrip.maxChannelDiff > PNG_ROUNDTRIP_CHANNEL_TOLERANCE) {
      failures.push(
        `帧 ${frame}：PNG 往返最大通道差 ${roundtrip.maxChannelDiff} > ${PNG_ROUNDTRIP_CHANNEL_TOLERANCE}`
      )
    }

    // 两个 PNG 出口（导出编码器 vs 单帧出口）必须给出同样的字节
    const jobPngBlob = await renderJobToPngBlob(spec, frame)
    const jobPngBytes = await jobPngBlob.arrayBuffer()
    if (!bytesIdentical(pngBytes, jobPngBytes)) {
      failures.push(`帧 ${frame}：stage.pngBuffer 与 renderJobToPngBlob 的 PNG 字节不一致`)
    }

    // C. 预览 blit（blitTo 会按 DPR 重算尺寸，必须在真实结果尺寸上比）
    display.width = Math.round(width / 2)
    display.height = Math.round(height / 2)
    previewStage.blitTo(display)
    const blitCtx = display.getContext('2d', { willReadFrequently: true })
    if (!blitCtx) throw new Error('无法读取预览显示层')
    const blitPixels = blitCtx.getImageData(0, 0, display.width, display.height)
    const reference = await scaledFromPng(jobPngBytes, display.width, display.height)
    const scaled = compare(
      { data: blitPixels.data, width: blitPixels.width, height: blitPixels.height },
      reference
    )
    const ratio = scaled.diffPixels / Math.max(1, scaled.totalPixels)
    if (scaled.maxChannelDiff > SCALED_CHANNEL_TOLERANCE) {
      failures.push(
        `帧 ${frame}：blit(${display.width}x${display.height}) 与导出图同尺寸缩放最大通道差 ${scaled.maxChannelDiff} > ${SCALED_CHANNEL_TOLERANCE}`
      )
    }
    if (ratio > SCALED_DIFF_RATIO_LIMIT) {
      failures.push(
        `帧 ${frame}：缩放差异像素占比 ${(ratio * 100).toFixed(3)}% > ${SCALED_DIFF_RATIO_LIMIT * 100}%`
      )
    }

    frames.push({
      frame,
      exportBytesIdenticalToPreview: exportBytesIdentical,
      pngRoundtrip: roundtrip,
      scaled: { ...scaled, blitSize: `${display.width}x${display.height}` }
    })
  }

  const wipe = await probeWipeAndHug({ fontIndex, width, height, failures })

  const report: PixelCheckReport = {
    generatedAt: new Date().toISOString(),
    resolution: `${width}x${height}`,
    fps: `${fps.num}/${fps.den}`,
    devicePixelRatio: window.devicePixelRatio,
    frames,
    wipe,
    tolerances: {
      exportBytesMustMatchExactly: true,
      pngRoundtripChannelTolerance: PNG_ROUNDTRIP_CHANNEL_TOLERANCE,
      scaledChannelTolerance: SCALED_CHANNEL_TOLERANCE,
      scaledDiffRatioLimit: SCALED_DIFF_RATIO_LIMIT
    },
    passed: failures.length === 0,
    failures
  }

  const payload = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`)
  await window.focusnews.app.writeFileDev(input.outputPath, payload)
  return report
}
