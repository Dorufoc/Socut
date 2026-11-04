import { PRESETS } from '@shared/presets'
import { FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { snapTimeToFrame } from '@shared/fps'
import type { FontRecord, PresetId, RenderJobSpec } from '@shared/types'
import { buildRenderJob } from '../render/jobBuilder'
import { NativeStage } from '../render/stage'

/**
 * 逐帧动画评审表（计划 M4-7 的可自动化部分：8 预设 × 入场/出场关键帧）。
 * 全部走**生产同一套**像素生产者：buildRenderJob → computeClipBoxes → renderFrame(NativeStage)，
 * 因此这张表就是导出画面本身，不是第二套近似实现。
 * 只在开发环境由 FOCUSNEWS_REVIEW_SHEET 触发，写盘经主进程限定在仓库 spikes/ 下。
 */

const CLIP_SEC = 3
const TILE_W = 512
const TILE_H = 288
const LABEL_H = 30
const PAD = 12
const HEADER_H = 54

/** 每套预设的评审文案（只用通用新闻语汇，不含任何品牌名称）。 */
const SAMPLE_TEXT: Record<PresetId, { title: string; subtitle: string }> = {
  policyAuthority: { title: '长三角一体化新规发布', subtitle: '省发展改革委负责人解读' },
  stackedNews: { title: '全省夏粮收购全面启动', subtitle: '已收小麦 1240 万吨 · 同比增 3.2%' },
  calmEditorial: { title: '城市更新中的老房子去留', subtitle: '深度报道 · 第三篇' },
  financeData: { title: '上证指数 3 241.66', subtitle: '+0.86% · 成交额 3 812 亿元' },
  globalSimple: { title: '国际能源署发布季节性展望', subtitle: '二季度需求预期下调' },
  localWarm: { title: '老城区早餐街改造完工', subtitle: '居民：早上买豆浆不用绕路了' },
  breakingRed: { title: '突发：地铁 4 号线临时限速', subtitle: '运营方正在调整运行图' },
  personProfile: { title: '王志远', subtitle: '国家杰出青年基金获得者 · 结构生物学' }
}

interface Sample {
  local: number
  phase: string
}

/** 入场起/中/末 + 静止 + 出场前/中/末，共 7 格；全部按当前 fps 取整帧。 */
function sampleFrames(input: {
  totalFrames: number
  inFrames: number
  outFrames: number
}): { samples: Sample[]; inFrames: number; outFrames: number } {
  const { totalFrames, inFrames, outFrames } = input
  const clamp = (frame: number): number => Math.min(totalFrames - 1, Math.max(0, frame))
  const raw: Sample[] = [
    { local: clamp(0), phase: '入场 起' },
    { local: clamp(Math.floor(inFrames / 2)), phase: '入场 中' },
    { local: clamp(inFrames - 1), phase: '入场 末' },
    { local: clamp(Math.floor(totalFrames / 2)), phase: '静止' },
    { local: clamp(totalFrames - outFrames - 1), phase: '出场 前' },
    { local: clamp(totalFrames - Math.floor(outFrames / 2) - 1), phase: '出场 中' },
    { local: clamp(totalFrames - 1), phase: '出场 末' }
  ]
  return { samples: raw, inFrames, outFrames }
}

async function decodeBackdrop(bytes: ArrayBuffer | null): Promise<ImageBitmap | null> {
  if (!bytes) return null
  try {
    return await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  } catch {
    return null
  }
}

export interface ReviewSheetInput {
  outputPath: string
  fontIndex: FontRecord[]
  /** 1080p 背景帧（PNG 字节）；为空时用中性灰底，仅用于观察边缘与对比度 */
  backdropBytes?: ArrayBuffer | null
  width?: number
  height?: number
}

export interface ReviewSheetSummary {
  presets: number
  columns: number
  bytesWritten: number
  sheetWidth: number
  sheetHeight: number
}

export async function renderReviewSheet(input: ReviewSheetInput): Promise<ReviewSheetSummary> {
  const width = input.width ?? 1920
  const height = input.height ?? 1080
  const fps = FPS_30
  const backdrop = await decodeBackdrop(input.backdropBytes ?? null)

  interface Row {
    presetId: PresetId
    name: string
    samples: Sample[]
    spec: RenderJobSpec
    inFrames: number
    outFrames: number
  }
  const rows: Row[] = []

  const makeRow = async (
    preset: (typeof PRESETS)[number],
    content: { title: string; subtitle: string },
    label: string
  ): Promise<Row> => {
    const project = createDefaultProject(`review-${preset.id}-${label}`)
    project.resolution = { width, height }
    project.fps = fps
    // 片段只存 fontId（规格 §4.5）；预设内部的字重/角色由 presetResolver 映射
    const clip = createClip({ startTime: 0, fps, presetId: preset.id })
    clip.content = { ...content }
    clip.startTime = snapTimeToFrame(0, fps)
    clip.endTime = snapTimeToFrame(CLIP_SEC, fps)
    clip.animation = { ...preset.animation }
    project.clips = [clip]

    const spec = await buildRenderJob({
      project,
      fontIndex: input.fontIndex,
      resolution: { width, height },
      fps,
      scope: { kind: 'timeline' }
    })
    const totalFrames = spec.endFrame - spec.startFrame
    const inFrames = Math.max(1, Math.round((preset.animation.inDuration * fps.num) / fps.den))
    const outFrames = Math.max(1, Math.round((preset.animation.outDuration * fps.num) / fps.den))
    const { samples } = sampleFrames({ totalFrames, inFrames, outFrames })
    return { presetId: preset.id, name: `${preset.name}${label}`, samples, spec, inFrames, outFrames }
  }

  for (const preset of PRESETS) {
    rows.push(await makeRow(preset, SAMPLE_TEXT[preset.id], ''))
  }
  // 末行：长文案 —— 直接看「主条满宽减等边距 → 超过就换行 → 条高随行数长高」
  // （主条现在很宽，样本必须够长：22 字在 1080p 满宽下放得下，不会换行）
  rows.push(
    await makeRow(
      PRESETS[0]!,
      {
        title: '长三角一体化发展新规今日正式对外发布并即日起施行'.repeat(2),
        subtitle: '省发展改革委负责人表示新规将覆盖交通能源与数据要素三大领域'.repeat(2)
      },
      ' · 长文案换行'
    )
  )

  const columns = rows[0]?.samples.length ?? 7
  const sheetWidth = PAD * 2 + columns * (TILE_W + PAD)
  const sheetHeight = PAD * 2 + HEADER_H + rows.length * (TILE_H + LABEL_H + PAD)
  const sheet = new OffscreenCanvas(sheetWidth, sheetHeight)
  const ctx = sheet.getContext('2d')
  if (!ctx) throw new Error('无法创建评审表 2D 上下文')

  ctx.fillStyle = '#0f1216'
  ctx.fillRect(0, 0, sheetWidth, sheetHeight)
  ctx.fillStyle = '#e7edf5'
  ctx.font = '600 26px "Noto Sans SC", system-ui, sans-serif'
  ctx.fillText(
    `逐帧动画评审表 · ${width}×${height} @${fps.num}/${fps.den} · 片段 ${CLIP_SEC}s · ${rows.length} 行 × ${columns} 关键帧`,
    PAD,
    PAD + 24
  )
  ctx.font = '400 18px "Noto Sans SC", system-ui, sans-serif'
  ctx.fillStyle = '#8fa0b4'
  ctx.fillText(
    `动画统一为「整体从左到右擦除」；条宽随文字自适应（末行为长文案换行）；${
      backdrop ? '背景为 1080p 合成测试画面帧' : '背景为中性灰（未提供背景帧）'
    } · 入场/出场帧数见每行首格标注`,
    PAD,
    PAD + 46
  )

  const stage = new NativeStage(width, height)
  let bytesWritten = 0

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]
    if (!row) continue
    const top = PAD + HEADER_H + rowIndex * (TILE_H + LABEL_H + PAD)
    for (let col = 0; col < row.samples.length; col++) {
      const sample = row.samples[col]
      if (!sample) continue
      const left = PAD + col * (TILE_W + PAD)

      if (backdrop) {
        ctx.drawImage(backdrop, left, top, TILE_W, TILE_H)
      } else {
        ctx.fillStyle = '#2b2f36'
        ctx.fillRect(left, top, TILE_W, TILE_H)
      }
      // 生产路径：原生分辨率渲染后等比缩进格子（这里的重采样只发生在评审表排版，不参与坐标计算）
      stage.render(row.spec, row.spec.startFrame + sample.local, {})
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(stage.surface, left, top, TILE_W, TILE_H)

      ctx.fillStyle = '#0f1216'
      ctx.fillRect(left, top + TILE_H, TILE_W, LABEL_H)
      ctx.fillStyle = '#cfd8e3'
      ctx.font = '500 17px "Noto Sans SC", system-ui, sans-serif'
      const inOut =
        col === 0 ? `入场 ${row.inFrames} 帧 / 出场 ${row.outFrames} 帧` : `f${sample.local} · ${sample.phase}`
      ctx.fillText(`${row.name} · ${inOut}`, left + 8, top + TILE_H + 20)
    }
  }

  const blob = await sheet.convertToBlob({ type: 'image/png' })
  const buffer = await blob.arrayBuffer()
  bytesWritten = await window.focusnews.app.writeFileDev(input.outputPath, new Uint8Array(buffer))

  return {
    presets: rows.length,
    columns,
    bytesWritten,
    sheetWidth,
    sheetHeight
  }
}
