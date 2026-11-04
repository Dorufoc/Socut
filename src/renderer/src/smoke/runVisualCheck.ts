import { PRESETS } from '@shared/presets'
import { FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { snapTimeToFrame } from '@shared/fps'
import type { FontRecord, LayoutBox, PresetId, RenderJobSpec } from '@shared/types'
import {
  checkVisualSample,
  contrastRatio,
  rightVoidRatio,
  textWidthRatio,
  type VisualSampleMetrics
} from '@shared/visualRules'
import { buildRenderJob } from '../render/jobBuilder'
import { NativeStage } from '../render/stage'

/**
 * 视觉检查（开发专用，FOCUSNEWS_VISUAL_CHECK=<report.json>）：
 * 用**生产同一套**渲染路径（buildRenderJob → computeClipBoxes → renderFrame）把
 * 8 套预设 × 短/常规/长三组模拟文案渲染成 PNG，并逐例计算可机器判定的视觉指标：
 * 文字占条宽比、右侧空白、条高/字号、副标题比例、上下内边距、安全区、文字对比度、行数。
 *
 * 输出：
 *   <dir>/<preset>-<variant>.png   单例全帧（带对比背景，供人眼复核）
 *   <dir>/sheet.png                8 × 3 总览表
 *   <dir>/report.json              机器报告（passed=false 时主进程以退出码 1 结束）
 */

type Variant = 'short' | 'normal' | 'long'

const VARIANT_LABEL: Record<Variant, string> = {
  short: '短文案',
  normal: '常规文案',
  long: '长文案'
}

interface SampleText {
  title: string
  subtitle: string
}

/** 每套预设用符合其语义的模拟文案（避免“财经预设拿人物文案”导致误判）。 */
const SAMPLE_TEXTS: Record<PresetId, Record<Variant, SampleText>> = {
  policyAuthority: {
    short: { title: '新规发布', subtitle: '本台记者' },
    normal: { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' },
    long: {
      title: '长三角一体化发展新规今日正式对外发布并即日起施行',
      subtitle: '省发展改革委负责人表示新规覆盖交通能源与数据要素'
    }
  },
  stackedNews: {
    short: { title: '夏粮收购', subtitle: '同比增 3.2%' },
    normal: { title: '全省夏粮收购全面启动', subtitle: '已收小麦 1240 万吨 · 同比增 3.2%' },
    long: {
      title: '全省夏粮收购全面启动，多地粮库延长收购时间',
      subtitle: '已收小麦 1240 万吨，同比增 3.2%，收购进度快于往年'
    }
  },
  calmEditorial: {
    short: { title: '老房去留', subtitle: '深度报道' },
    normal: { title: '城市更新中的老房子去留', subtitle: '深度报道 · 第三篇' },
    long: {
      title: '城市更新中的老房子去留：居民与开发商的三年拉锯',
      subtitle: '深度报道 · 第三篇 · 记者 王晓'
    }
  },
  financeData: {
    short: { title: '上证指数', subtitle: '3 241.66' },
    normal: { title: '上证指数 3 241.66', subtitle: '+0.86% · 3 812 亿' },
    long: { title: '中证新能源汽车产业指数', subtitle: '2 016.77 +2.31%' }
  },
  globalSimple: {
    short: { title: '能源展望', subtitle: '需求下调' },
    normal: { title: '国际能源署发布季节性展望', subtitle: '二季度需求预期下调' },
    long: {
      title: '国际能源署发布二季度全球能源市场季节性展望报告',
      subtitle: '需求预期下调，原油价格短线波动'
    }
  },
  localWarm: {
    short: { title: '早餐街', subtitle: '改造完工' },
    normal: { title: '老城区早餐街改造完工', subtitle: '居民：早上买豆浆不用绕路了' },
    long: {
      title: '老城区早餐街改造完工，42 家小店统一换上新招牌',
      subtitle: '居民：早上买豆浆不用绕路了，生意比原来好'
    }
  },
  breakingRed: {
    short: { title: '地铁限速', subtitle: '4 号线' },
    normal: { title: '突发：地铁 4 号线临时限速', subtitle: '运营方正在调整运行图' },
    long: {
      title: '突发：地铁 4 号线因信号故障全线临时限速',
      subtitle: '运营方正在调整运行图，预计晚高峰前恢复'
    }
  },
  personProfile: {
    short: { title: '王志远', subtitle: '结构生物学家' },
    normal: { title: '王志远', subtitle: '国家杰出青年基金获得者 · 结构生物学' },
    long: {
      title: '王志远',
      subtitle: '国家杰出青年基金获得者 · 结构生物学 · 清华大学教授'
    }
  }
}

/** 每套预设的结构签名（用于报告“8 套里到底有几种版式”）。 */
const STRUCTURE: Record<PresetId, string> = {
  policyAuthority: '单板+顶线+左条',
  stackedNews: '单板+宽左块+顶条',
  calmEditorial: '半透明轻底+细竖线',
  financeData: '双栏同排（标题+读数）',
  globalSimple: '浅色单板+顶线+左条',
  localWarm: '圆角单板+顶线+左条',
  breakingRed: '整高徽标块+红板',
  personProfile: '窄名牌+底部细线'
}

interface Bounds {
  x: number
  y: number
  right: number
  bottom: number
}

function union(boxes: LayoutBox[]): Bounds | null {
  if (boxes.length === 0) return null
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    right: Math.max(...boxes.map((box) => box.x + box.w)),
    bottom: Math.max(...boxes.map((box) => box.y + box.h))
  }
}

interface CaseMetrics extends VisualSampleMetrics {
  barWidth: number
  barHeight: number
  contentWidth: number
  contentRight: number
  bottomPx: number
  leftPx: number
}

function measureCase(boxes: LayoutBox[], width: number, height: number): CaseMetrics | null {
  const bar = boxes.find((box) => box.role === 'primaryBar')
  const title = boxes.find((box) => box.role === 'title' && box.text)
  const subtitle = boxes.find((box) => box.role === 'subtitle' && box.text)
  if (!bar || !title?.text || !subtitle?.text) return null

  // 内容 = 标题 + 副标题 + 条内的装饰色块（徽标/左条也承担视觉重量，不能算空白）
  const inBarBlocks = boxes.filter(
    (box) => box.kind === 'block' && box.role === 'decoration' && box.y >= bar.y - 1 && box.y + box.h <= bar.y + bar.h + 1
  )
  const content = union([title, subtitle, ...inBarBlocks])
  if (!content) return null

  const contentWidth = Math.max(0, content.right - bar.x)
  const contentRight = content.right
  const drawn = boxes.filter((box) => box.kind !== 'row' && box.kind !== 'col' && box.w > 0 && box.h > 0)
  const lowest = drawn.reduce((max, box) => Math.max(max, box.y + box.h), 0)

  const barFill = bar.fill?.color ?? 'rgba(0,0,0,1)'
  const subtitleBottom = Math.max(title.y + title.h, subtitle.y + subtitle.h)
  const titleLines = Math.max(1, Math.round(title.h / title.text.lineHeightPx))
  return {
    textRatio: textWidthRatio(contentWidth, bar.w),
    rightVoid: rightVoidRatio(contentRight, bar.x + bar.w, bar.w),
    barFontRatio: bar.h / (title.text.sizePx * titleLines),
    subFontRatio: subtitle.text.sizePx / title.text.sizePx,
    padTop: title.y - bar.y,
    padBottom: bar.y + bar.h - subtitleBottom,
    bottomRatio: (height - lowest) / height,
    leftRatio: bar.x / width,
    titleContrast: contrastRatio(title.text.color, barFill),
    subtitleContrast: contrastRatio(subtitle.text.color, barFill),
    titleLines,
    barWidth: Math.round(bar.w),
    barHeight: Math.round(bar.h),
    contentWidth: Math.round(contentWidth),
    contentRight: Math.round(contentRight),
    bottomPx: Math.round(height - lowest),
    leftPx: Math.round(bar.x)
  }
}

/** 合成背景：左白 / 中灰 / 右黑三段，专门看浅色条与深色条的边界。 */
function createBackdrop(width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const sky = ctx.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, '#3c444e')
  sky.addColorStop(0.55, '#232a32')
  sky.addColorStop(1, '#14181d')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, width, height)

  const bands: Array<[number, number, string]> = [
    [0, 0.34, '#e8eaee'],
    [0.34, 0.67, '#2a3038'],
    [0.67, 1, '#101317']
  ]
  for (const [from, to, color] of bands) {
    ctx.fillStyle = color
    ctx.globalAlpha = 0.85
    ctx.fillRect(Math.round(width * from), 0, Math.round(width * (to - from)), height)
  }
  ctx.globalAlpha = 1
  return canvas
}

function canvasToPngBytes(canvas: OffscreenCanvas): Promise<Uint8Array> {
  return canvas.convertToBlob({ type: 'image/png' }).then(async (blob) => new Uint8Array(await blob.arrayBuffer()))
}

function directoryOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '')
}

export interface VisualCheckInput {
  reportPath: string
  fontIndex: FontRecord[]
  width?: number
  height?: number
}

export interface VisualCaseReport {
  presetId: PresetId
  presetName: string
  structure: string
  variant: Variant
  title: string
  subtitle: string
  metrics: CaseMetrics | null
  failures: string[]
  image?: string
}

export interface VisualCheckReport {
  generatedAt: string
  width: number
  height: number
  passed: boolean
  failures: number
  structures: number
  cases: VisualCaseReport[]
}

function buildSpec(
  fontIndex: FontRecord[],
  presetId: PresetId,
  text: SampleText,
  width: number,
  height: number
): Promise<RenderJobSpec> {
  const project = createDefaultProject(`visual-${presetId}`)
  project.resolution = { width, height }
  project.fps = FPS_30
  const clip = createClip({ startTime: 0, fps: FPS_30, presetId })
  clip.content = { ...text }
  clip.startTime = snapTimeToFrame(0, FPS_30)
  clip.endTime = snapTimeToFrame(3, FPS_30)
  project.clips = [clip]
  return buildRenderJob({ project, fontIndex, resolution: { width, height }, fps: FPS_30, scope: { kind: 'timeline' } })
}

export async function runVisualCheck(input: VisualCheckInput): Promise<VisualCheckReport> {
  const width = input.width ?? 1920
  const height = input.height ?? 1080
  const directory = directoryOf(input.reportPath)
  const backdrop = createBackdrop(width, height)
  const stage = new NativeStage(width, height)
  const cases: VisualCaseReport[] = []
  const frames: OffscreenCanvas[] = []

  for (const preset of PRESETS) {
    for (const variant of ['short', 'normal', 'long'] as const) {
      const text = SAMPLE_TEXTS[preset.id][variant]
      const spec = await buildSpec(input.fontIndex, preset.id, text, width, height)
      const clip = spec.clips[0]
      const boxes = clip?.boxes ?? []
      const metrics = measureCase(boxes, width, height)
      const prefix = `${preset.name}${VARIANT_LABEL[variant]}：`
      const failures: string[] = (metrics ? checkVisualSample(metrics) : ['没有可测量的条块/文字盒']).map(
        (item) => `${prefix}${item}`
      )
      const title = boxes.find((box) => box.role === 'title')
      const subtitle = boxes.find((box) => box.role === 'subtitle')
      const bar = boxes.find((box) => box.role === 'primaryBar')

      if (bar && title && subtitle) {
        const sideBySide = subtitle.x >= title.x + title.w + 1
        if (!sideBySide && subtitle.y < title.y) failures.push(`${prefix}副标题跑到了主标题上方（阅读顺序倒置）`)
        if (subtitle.x < bar.x - 1 || subtitle.x + subtitle.w > bar.x + bar.w + 1) {
          failures.push(`${prefix}副标题溢出条块左右边界`)
        }
        if (title.x < bar.x - 1 || title.x + title.w > bar.x + bar.w + 1) {
          failures.push(`${prefix}标题溢出条块左右边界`)
        }
      }

      // 渲染全帧（稳态帧：入场完成后再多两帧）
      const local = clip ? Math.min(spec.endFrame - spec.startFrame - 1, clip.animation.inFrames + 2) : 0
      stage.render(spec, spec.startFrame + local, {})
      const frame = new OffscreenCanvas(width, height)
      const ctx = frame.getContext('2d')
      if (ctx) {
        ctx.drawImage(backdrop, 0, 0)
        ctx.drawImage(stage.surface, 0, 0)
      }
      const imagePath = `${directory}/${preset.id}-${variant}.png`
      await window.focusnews.app.writeFileDev(imagePath, await canvasToPngBytes(frame))
      frames.push(frame)

      cases.push({
        presetId: preset.id,
        presetName: preset.name,
        structure: STRUCTURE[preset.id],
        variant,
        title: text.title,
        subtitle: text.subtitle,
        metrics,
        failures,
        image: imagePath
      })
    }
  }

  const sheet = await composeSheet(cases, frames, width, height)
  const failures = cases.reduce((sum, item) => sum + item.failures.length, 0)
  const report: VisualCheckReport = {
    generatedAt: new Date().toISOString(),
    width,
    height,
    passed: failures === 0,
    failures,
    structures: new Set(Object.values(STRUCTURE)).size,
    cases
  }
  await window.focusnews.app.writeFileDev(`${directory}/sheet.png`, sheet.bytes)
  await window.focusnews.app.writeFileDev(
    input.reportPath,
    new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`)
  )
  return report
}

/** 8 行 × 3 列总览；每格下方标注条宽、占比、对比度等关键读数。 */
function composeSheet(
  cases: VisualCaseReport[],
  frames: OffscreenCanvas[],
  frameWidth: number,
  frameHeight: number
): Promise<{ width: number; height: number; bytes: Uint8Array }> {
  const columns = 3
  const rows = Math.ceil(cases.length / columns)
  const tileW = 600
  const tileH = Math.round((tileW * frameHeight) / frameWidth)
  const labelH = 46
  const pad = 16
  const headerH = 86
  const sheetW = pad * 2 + columns * (tileW + pad)
  const sheetH = pad * 2 + headerH + rows * (tileH + labelH + pad)
  const canvas = new OffscreenCanvas(sheetW, sheetH)
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve({ width: sheetW, height: sheetH, bytes: new Uint8Array() })

  ctx.fillStyle = '#101317'
  ctx.fillRect(0, 0, sheetW, sheetH)
  ctx.fillStyle = '#f2f5f9'
  ctx.font = '600 28px "Noto Sans SC", system-ui, sans-serif'
  ctx.fillText('FocusNews 字幕条视觉检查 · 8 预设 × 短/常规/长文案', pad, pad + 30)
  ctx.fillStyle = '#9fb0c2'
  ctx.font = '400 18px "Noto Sans SC", system-ui, sans-serif'
  ctx.fillText(
    `${frameWidth}×${frameHeight} @30fps · 背景左白/中灰/右黑用于检查边界 · 通过=文字占比/右侧空白/条高/内边距/安全区/对比度全部达标`,
    pad,
    pad + 60
  )

  for (let index = 0; index < cases.length; index++) {
    const item = cases[index]
    if (!item) continue
    const row = Math.floor(index / columns)
    const col = index % columns
    const left = pad + col * (tileW + pad)
    const top = pad + headerH + row * (tileH + labelH + pad)

    const bitmap = frames[index]
    if (bitmap) ctx.drawImage(bitmap, left, top, tileW, tileH)
    else {
      ctx.fillStyle = '#1b2027'
      ctx.fillRect(left, top, tileW, tileH)
    }

    ctx.fillStyle = '#0b0e12'
    ctx.fillRect(left, top + tileH, tileW, labelH)
    ctx.fillStyle = item.failures.length === 0 ? '#b7ecc9' : '#ffbcc4'
    ctx.font = '600 17px "Noto Sans SC", system-ui, sans-serif'
    const m = item.metrics
    const summary = m
      ? `条 ${m.barWidth}×${m.barHeight} · 文字 ${(m.textRatio * 100).toFixed(0)}% · 底距 ${m.bottomPx}px · 对比 ${
          m.titleContrast === null ? '—' : m.titleContrast.toFixed(1)
        }`
      : '无度量'
    ctx.fillText(`${item.presetName} · ${VARIANT_LABEL[item.variant]} · ${item.failures.length === 0 ? 'PASS' : 'FAIL'}`, left + 8, top + tileH + 20)
    ctx.fillStyle = '#93a4b6'
    ctx.font = '400 14px "Noto Sans SC", system-ui, sans-serif'
    ctx.fillText(summary, left + 8, top + tileH + 40)
  }

  // 用 canvas 自己重采样成 sheet 后再编码（供人眼查看），同时把单例图路径写进报告
  return canvasToPngBytes(canvas).then((bytes) => ({ width: sheetW, height: sheetH, bytes }))
}
