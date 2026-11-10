import { detectCompat } from '@shared/probe'
import { activeMediaClipSpans } from '@shared/mediaClips'
import { audibleAudioTracks, clipsOnMediaTrack, mediaTrackOrder, visibleMediaTracks } from '@shared/tracks'
import { mediaKindOf } from '@shared/audioClips'
import { speedValueOf } from '@shared/mediaClipAudio'
import { createId } from '@shared/projectSchema'
import { frameTimeSec, rationalToNumber } from '@shared/fps'
import { DEFAULT_AUDIO_BITRATE_KBPS, nearestFps } from '@shared/constants'
import { resolveExportCanvas, type ResolvedExportCanvas } from '@shared/exportPresets'
import { TEXT } from '@shared/i18n'
import { formatBytes } from '@shared/sizeEstimate'
import type {
  AudioMixClipRequest,
  ExportCanvasSelection,
  ExportKind,
  ExportQuality,
  ExportRequest,
  FrameSpec,
  Fps,
  MediaClipMask,
  MediaItem,
  OverlaySegment,
  Project,
  TransparentCodec,
  VideoCodec,
  VideoMeta
} from '@shared/types'
import { askHugeExport, askVfrSecondConfirm } from '../dialog/ask'
import type { DialogAnswer } from '../state/uiStore'
import { gateBlocked } from '../state/uiStore'
import { buildRenderJob } from './jobBuilder'
import { frameSpecOf, registerExportJob } from './frameSource'
import { rasterizeMask } from './maskRaster'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 非交互导出编排（渲染侧）：
 * - 应用内导出面板与 CLI 共用同一段规格构建/门禁/预估逻辑；
 * - `autoConfirm` 只跳过“人类确认弹窗”，**不跳过磁盘硬预检**；
 * - 返回 jobId 后由调用方决定是等 job 事件（应用内）还是轮询主进程（CLI）。
 */

export interface StartExportInput {
  kind: ExportKind
  outputDir: string
  fileName: string
  /** 管道内帧形式：raw（默认，无 PNG 压缩开销）或 png */
  pipeTransport?: 'raw' | 'png'
  codec?: TransparentCodec
  /** v10：目标画布（缺省 = 现有行为：叠加跟随首个底层素材的横屏） */
  canvas?: ExportCanvasSelection
  /** v10：画质档（缺省 = high，CRF 18 与旧版一致） */
  quality?: ExportQuality
  /** 视频编码格式（缺省 = AVC/H.264） */
  videoCodec?: VideoCodec
  /** 视频码率（kbps）；有值时走码率模式 */
  videoBitrateKbps?: number
  /** 音频码率（kbps）；有值时强制 AAC 重编码 */
  audioBitrateKbps?: number
  /** M9：CRF 直给（0–51）；缺省按画质档 */
  crf?: number
  /** M9：软件编码 preset（x264/x265 名称；AV1 内部映射 SVT 档位） */
  encoderPreset?: string
  /** M9：输出位深（10 走 yuv420p10le；H.264 不支持，UI 侧禁用） */
  bitDepth?: 8 | 10
  /** M9：色彩范围标签（full → -color_range pc） */
  colorRange?: 'limited' | 'full'
}

export interface RunExportOptions {
  /** CLI：跳过确认框；磁盘不足仍然直接失败 */
  autoConfirm?: boolean
}

export interface StartExportResult {
  jobId: string
  frames: number
  width: number
  height: number
  fps: Fps
  estimateBytes: number
}

export class GateError extends Error {}

/**
 * 门禁校验（规格 §6：未确认不得导入或导出）。
 * v2：确认位在枚级——逐枚检查素材池，任一未确认即阻断（gateBlocked 同一实现）。
 */
export function assertGate(): void {
  const project = useProjectStore.getState().project
  if (project.media.length === 0 && project.refVideo) {
    // v1 兼容：冒烟取证直接写 refVideo，没有素材池时沿用旧口径
    const legacy = gateBlocked([
      {
        id: 'legacy-ref',
        path: project.refVideo.path,
        name: project.refVideo.path.split(/[\\/]/).pop() ?? project.refVideo.path,
        meta: project.refVideo.meta,
        non169Ack: project.refVideo.non169Ack,
        hdrAck: project.refVideo.hdrAck,
        vfrPolicy: project.refVideo.vfrPolicy,
        compactMode: project.refVideo.compactMode,
        thumbnailUrl: '',
        importedAt: project.refVideo.importedAt
      }
    ])
    if (legacy.blocked) throw new GateError(legacy.reason ?? '门禁未通过')
    return
  }
  const gate = gateBlocked(project.media)
  if (gate.blocked) throw new GateError(gate.reason ?? '门禁未通过')
}

/** 导出基座的媒体时间轴（v2）：mediaClips → 按时间轴升序的 trim 段列表。 */
export interface OverlayBase {
  segments: OverlaySegment[]
  /**
   * 与 `segments` 一一对应的片段 id。
   * M8：`OverlaySegment` 本身没有 id，但遮罩 PNG 的 `{ clipId, png }` 契约需要它
   * （文件名/错误信息要有可读的归属），所以这里另带一份平行数组。
   */
  clipIds: string[]
  /** 段数 > 1 或存在空隙/非零源入点时，主进程改走多输入 trim+concat */
  multi: boolean
  /** 首段元数据（分辨率/帧率跟随基准，规格 §2.3） */
  primaryMeta: VideoMeta
  /** 参与拼接的源里是否存在无音轨段（有则不能逐段 copy） */
  anyNoAudio: boolean
  /** 任一段的源仍是未转换 VFR */
  anyVfrRaw: boolean
  audioTranscodeNeeded: boolean
}

export function buildOverlayBase(project: Project): OverlayBase | null {
  const pool = new Map<string, MediaItem>(project.media.map((item) => [item.id, item]))
  // v3 多轨：不再把轨道压成一条。按「底层→顶层」逐轨输出段，导出层按 trackIndex 分层合成。
  // 隐藏轨不导出；静音轨仍出画面，但 hasAudio=false（导出层补静音，且不混它的原声）。
  const order = mediaTrackOrder(project.mediaTracks)
  let clips: (OverlaySegment & { meta: VideoMeta | null; vfrRaw: boolean; clipId: string })[] = []
  for (const track of visibleMediaTracks(project.mediaTracks)) {
    const trackIndex = order.get(track.id) ?? 0
    for (const clip of clipsOnMediaTrack(project.mediaClips, track.id)) {
      const item = pool.get(clip.mediaId)
      clips.push({
        // M8：片段 id 只用于遮罩归属，不参与任何 argv/画面计算
        clipId: clip.id,
        refVideoPath: item?.path ?? '',
        timelineStartSec: clip.timelineStartSec,
        timelineEndSec: clip.timelineEndSec,
        sourceInSec: clip.sourceInSec,
        sourceOutSec: clip.sourceOutSec,
        trackIndex,
        hasAudio: !track.muted && item?.meta.audioCodec != null && mediaKindOf(item) !== 'image',
        ...(track.muted ? { muted: true } : {}),
        // v8：只把「开着防抖」的段带进导出请求；缺键 = 主进程行为与现状逐字节一致
        ...(clip.stab?.enabled === true ? { stab: clip.stab } : {}),
        // v9：音量/渐变/变速同样只在「动过」时带键（全默认时 argv 与旧版逐字节一致）
        ...(clip.audio ? { audio: clip.audio } : {}),
        ...(clip.speed ? { speed: clip.speed } : {}),
        // v6：调色/变换参数原样透传，不能在多轨改造里丢掉（导出暂未烧录，见验收文档）
        ...(clip.video ? { video: clip.video } : {}),
        // M6-E：媒体段关键帧（缺键 = 静态几何，导出 argv 与旧版逐字节一致）
        ...(clip.keyframes ? { keyframes: clip.keyframes } : {}),
        // M8：手绘遮罩（缺键 = 不遮罩，请求体与旧版逐字节一致）
        ...(clip.mask ? { mask: clip.mask } : {}),
        // M8-P0：外部 matte（绝对路径 + 可选类型；缺键 = 不接 matte）
        ...(clip.mattePath ? { mattePath: clip.mattePath } : {}),
        ...(clip.matteKind ? { matteKind: clip.matteKind } : {}),
        // v10：转场只在定义时带键（无转场时请求体与旧版逐字节一致）
        ...(clip.transitionIn ? { transitionIn: clip.transitionIn } : {}),
        ...(item ? { sourceDurationSec: item.meta.durationSec } : {}),
        isImage: item ? mediaKindOf(item) === 'image' : false,
        meta: item?.meta ?? null,
        vfrRaw: item?.vfrPolicy === 'raw'
      })
    }
  }
  if (project.mediaClips.length === 0 && project.media[0]) {
    // v2 过渡：有素材但尚未排轨 → 按旧习惯把第一枚素材整段作为基座
    const item = project.media[0]
    clips = [
      {
        clipId: `media-${item.id}`,
        refVideoPath: item.path,
        timelineStartSec: 0,
        timelineEndSec: item.meta.durationSec,
        sourceInSec: 0,
        sourceOutSec: item.meta.durationSec,
        trackIndex: 0,
        hasAudio: mediaKindOf(item) !== 'image' && item.meta.audioCodec != null,
        sourceDurationSec: item.meta.durationSec,
        isImage: mediaKindOf(item) === 'image',
        meta: item.meta,
        vfrRaw: item.vfrPolicy === 'raw'
      }
    ]
  } else if (project.mediaClips.length === 0 && project.refVideo) {
    // v1 兼容路径
    const ref = project.refVideo
    clips = [
      {
        clipId: 'legacy-ref',
        refVideoPath: ref.path,
        timelineStartSec: 0,
        timelineEndSec: ref.meta.durationSec,
        sourceInSec: 0,
        sourceOutSec: ref.meta.durationSec,
        trackIndex: 0,
        hasAudio: ref.meta.audioCodec != null,
        sourceDurationSec: ref.meta.durationSec,
        isImage: false,
        meta: ref.meta,
        vfrRaw: ref.vfrPolicy === 'raw'
      }
    ]
  }
  if (clips.length === 0) return null
  // 底层轨道优先：primaryMeta（导出分辨率/帧率基准）必须来自最底层有内容的媒体轨，
  // 不能因为上层片段开始得更早就让整片尺寸跟着上层素材跑。
  clips.sort((a, b) => (a.trackIndex ?? 0) - (b.trackIndex ?? 0) || a.timelineStartSec - b.timelineStartSec)
  const first = clips[0]
  const primaryMeta = first?.meta ?? null
  if (!primaryMeta) return null
  let cursor = first?.timelineStartSec ?? 0
  let hasGap = false
  for (const clip of clips) {
    if (clip.timelineStartSec > cursor + 1e-6) hasGap = true
    cursor = Math.max(cursor, clip.timelineEndSec)
  }
  const multi =
    clips.length > 1 ||
    hasGap ||
    (first?.sourceInSec ?? 0) > 1e-6 ||
    (first?.timelineStartSec ?? 0) > 1e-6 ||
    // 图像段要求多输入路径（单输入 builder 不支持 `-loop 1`）
    clips.some((clip) => clip.isImage) ||
    // v3：上层轨道必须分层合成；静音轨必须走 trim 链补静音
    clips.some((clip) => (clip.trackIndex ?? 0) > 0) ||
    clips.some((clip) => clip.muted === true) ||
    // M8：有遮罩就必须走多输入路径（旧单输入 builder 没有逐段 alphamerge 插入点）
    clips.some((clip) => clip.mask !== undefined) ||
    // M8-P0：外部 matte 同理（需要独立输入 + 逐段 alpha 相乘）
    clips.some((clip) => typeof clip.mattePath === 'string' && clip.mattePath.length > 0)
  return {
    segments: clips.map(({ meta, vfrRaw, clipId, ...seg }) => {
      void meta
      void vfrRaw
      void clipId
      return seg
    }),
    // M8：与 segments 同序的片段 id（遮罩的 clipId/png 契约靠它归属）
    clipIds: clips.map((clip) => clip.clipId),
    multi,
    primaryMeta,
    anyNoAudio: clips.some((clip) => clip.hasAudio === false),
    anyVfrRaw: clips.some((clip) => clip.vfrRaw),
    audioTranscodeNeeded: clips.some((clip) => (clip.meta ? detectCompat(clip.meta).audioTranscodeNeeded : false))
  }
}

/**
 * M8：把「本次导出里带手绘遮罩的段」逐段光栅化成 PNG，供主进程接 alphamerge。
 *
 * 尺寸用**导出目标画布**（spec.width/height），与主进程 `frameSize`、预览画笔同一坐标系。
 * 顺序即 `base.segments` 里带 `mask` 的段顺序——主进程按同一顺序接 `maskPath`
 * （OverlaySegment 没有 clipId，数量/顺序必须由这条唯一构造路径保证）。
 * 无遮罩时返回空数组（请求体不落 `mediaMasks` 键，旧导出逐字节一致）。
 *
 * `rasterize` 可注入（jsdom 里没有 2D Canvas，测试用假光栅化验证归属与顺序）。
 */
export type MaskRasterizer = (
  mask: MediaClipMask,
  width: number,
  height: number
) => Promise<Uint8Array>

export async function rasterizeExportMasks(
  base: Pick<OverlayBase, 'segments' | 'clipIds'>,
  width: number,
  height: number,
  rasterize: MaskRasterizer = rasterizeMask
): Promise<Array<{ clipId: string; png: Uint8Array }>> {
  const out: Array<{ clipId: string; png: Uint8Array }> = []
  for (const [index, seg] of base.segments.entries()) {
    if (!seg.mask) continue
    const clipId = base.clipIds[index] ?? `mask-${index}`
    out.push({ clipId, png: await rasterize(seg.mask, width, height) })
  }
  return out
}

/**
 * 导出/封面共用的目标画布解析：landscape 跟随首个可见底层素材，
 * portrait/square 用固定档位；帧率沿用首个素材（无素材时工程帧率）。
 */
export function overlayCanvasFor(
  project: Project,
  selection: ExportCanvasSelection
): { canvas: ResolvedExportCanvas; fps: Fps } | null {
  const base = buildOverlayBase(project)
  if (!base) return null
  const primaryMeta = base.primaryMeta
  const canvas = resolveExportCanvas({
    selection,
    primaryMeta: { width: primaryMeta.width, height: primaryMeta.height },
    projectResolution: project.resolution
  })
  const fps = nearestFps(
    rationalToNumber(primaryMeta.avgFrameRate) ?? primaryMeta.rFrameRate.num / primaryMeta.rFrameRate.den
  )
  return { canvas, fps }
}

async function confirmHugeExport(
  width: number,
  height: number,
  frames: number,
  fps: Fps,
  outputDir: string,
  kind: ExportKind,
  videoBitrateKbps?: number,
  audioBitrateKbps?: number
): Promise<{ choice: DialogAnswer; estimateBytes: number; freeBytes?: number }> {
  const estimate = await window.socut.export.estimate({
    width,
    height,
    fps,
    frames,
    outputDir,
    kind,
    ...(videoBitrateKbps !== undefined ? { videoBitrateKbps } : {}),
    ...(audioBitrateKbps !== undefined ? { audioBitrateKbps } : {})
  })
  // PNG 出口本身就是产物，叠加出口的产物是小体积 H.264：两者都不该弹「改用 PNG / 空间不足」
  if (kind === 'pngSequence' || kind === 'overlayMp4') {
    return { choice: 'ok', estimateBytes: estimate.bytes, freeBytes: estimate.freeBytes }
  }
  if (estimate.sufficientDisk && !estimate.recommendPng) {
    return { choice: 'ok', estimateBytes: estimate.bytes, freeBytes: estimate.freeBytes }
  }
  // 规格 §2.3：4K60 透明 MOV 导出前须显示预估文件大小，并提供 PNG 序列替代出口
  const label =
    `${TEXT.modalHugeExport.bodyPrefix} ${formatBytes(estimate.bytes)}，` +
    (estimate.sufficientDisk
      ? TEXT.modalHugeExport.bodySuffix
      : `目标磁盘可用 ${formatBytes(estimate.freeBytes ?? 0)}，不足以安全写入。`)
  const choice = await askHugeExport(label, `${width}x${height} · ${frames} 帧`, {
    allowPng: kind === 'transparentMov',
    diskShort: !estimate.sufficientDisk
  })
  return { choice, estimateBytes: estimate.bytes, freeBytes: estimate.freeBytes }
}

/** CLI 路径：不弹体积确认，但磁盘不足必须硬失败（不能把“自动确认”当成“忽略预检”）。 */
async function autoConfirmHugeExport(
  width: number,
  height: number,
  frames: number,
  fps: Fps,
  outputDir: string,
  kind: ExportKind,
  videoBitrateKbps?: number,
  audioBitrateKbps?: number
): Promise<{ choice: DialogAnswer; estimateBytes: number; freeBytes?: number }> {
  const estimate = await window.socut.export.estimate({
    width,
    height,
    fps,
    frames,
    outputDir,
    kind,
    ...(videoBitrateKbps !== undefined ? { videoBitrateKbps } : {}),
    ...(audioBitrateKbps !== undefined ? { audioBitrateKbps } : {})
  })
  // 叠加出口全程流式、产物是 H.264，ProRes 口径的「空间不足」在这里不成立
  if (kind !== 'overlayMp4' && !estimate.sufficientDisk) {
    throw new GateError(
      `目标磁盘空间不足：预计 ${formatBytes(estimate.bytes)}，可用 ${formatBytes(estimate.freeBytes ?? 0)}`
    )
  }
  return { choice: 'ok', estimateBytes: estimate.bytes, freeBytes: estimate.freeBytes }
}

async function confirmVfrRaw(): Promise<boolean> {
  return askVfrSecondConfirm(TEXT.modalVfr.secondConfirmBody)
}

export async function runExport(
  input: StartExportInput,
  options: RunExportOptions = {}
): Promise<StartExportResult> {
  const autoConfirm = options.autoConfirm === true
  assertGate()

  const project = useProjectStore.getState().project
  const fonts = useProjectStore.getState().fonts
  const selectedClipId = useProjectStore.getState().selectedClipId
  const exportScope = useUiStore.getState().exportScope

  /**
   * 水印走同一条「文件不可用就提前说」纪律（规格 §8 的素材完整性口径）：
   * 否则要到 FFmpeg 打开输入时才失败，用户只能看到一串 stderr。
   * 透明字幕条出口不烧录水印，所以只在叠加出口前检查。
   */
  const watermark = project.watermark
  if (input.kind === 'overlayMp4' && watermark?.enabled) {
    const alive = await window.socut.video.exists(watermark.path)
    if (!alive) throw new GateError(`水印图片已不可用：${watermark.name}（请在水印页重新导入，或先关掉开关）`)
  }

  const isOverlay = input.kind === 'overlayMp4'
  const base = isOverlay ? buildOverlayBase(project) : null
  if (isOverlay && !base) throw new GateError('叠加导出需要先把素材放入媒体轨（或至少导入一枚素材）')

  /** 跟随基准（规格 §2.3）：v2 取媒体轨首段的源元数据；无媒体轨时退回首枚素材/旧 refVideo（buildOverlayBase 已拉平） */
  const primaryMeta = base?.primaryMeta ?? null

  /**
   * 音频一律重编码为 AAC：多视频混音后各源码率不一致，不存在可继承的“原始码率”，
   * 统一按本次配置的码率压制（缺省 192 kbps）。
   */
  const audioBitrateKbps = input.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS

  /**
   * v10：可选目标画布。未选时保持旧行为；只有叠加出口吃画布，
   * 透明 MOV / PNG 序列仍只按工程分辨率。
   */
  const resolvedCanvas =
    isOverlay && input.canvas
      ? resolveExportCanvas({
          selection: input.canvas,
          primaryMeta: primaryMeta ? { width: primaryMeta.width, height: primaryMeta.height } : null,
          projectResolution: project.resolution
        })
      : null
  /**
   * 只把「会改变画面几何」的画布下传给主进程：横屏 + contain 且跟随素材与旧行为等价，
   * 传下去只会凭空多一圈 scale，违背「默认导出 argv 逐字节不变」。
   * 但横屏选了具体分辨率档位时必须下传，否则主进程不会缩放。
   */
  const canvasForRequest =
    resolvedCanvas &&
    (resolvedCanvas.kind !== 'landscape' ||
      resolvedCanvas.fit !== 'contain' ||
      (input.canvas?.resolution !== undefined && input.canvas.resolution !== 'source'))
      ? { width: resolvedCanvas.width, height: resolvedCanvas.height, fit: resolvedCanvas.fit }
      : null

  // 叠加合成强制跟随参考视频参数（规格 §2.3 / §11）；显式画布优先
  const resolution = resolvedCanvas
    ? { width: resolvedCanvas.width, height: resolvedCanvas.height }
    : isOverlay && primaryMeta
      ? { width: primaryMeta.width, height: primaryMeta.height }
      : project.resolution
  const fps =
    isOverlay && primaryMeta
      ? nearestFps(
          rationalToNumber(primaryMeta.avgFrameRate) ?? primaryMeta.rFrameRate.num / primaryMeta.rFrameRate.den
        )
      : project.fps

  const scope: Parameters<typeof buildRenderJob>[0]['scope'] =
    exportScope === 'timeline' ? { kind: 'timeline' } : { kind: 'clips', clipIds: selectedClipId ? [selectedClipId] : [] }

  /**
   * 帧形式必须跟着“帧到底交给谁”：
   * 计划 C17 把管道主路径改成未压缩 rawvideo（PNG 压缩是吐吐量瓶颈）；
   * PNG 序列出口落的就是文件名带 .png 的**产物**，拿到 raw 字节会产出“921600B 的假 PNG”（应用内实捕）。
   * v11 起导出流程内部不再有 PNG 中间帧：透明/叠加出口一律 raw 直送编码器。
   */
  const framesToDisk = input.kind === 'pngSequence'

  const spec = await buildRenderJob({
    project,
    fontIndex: fonts,
    resolution,
    fps,
    // v10：竖屏/方图必须强制对应字幕条分支（不能被枚级 compactMode 覆盖）
    mode: resolvedCanvas?.mode,
    scope,
    frameFormat: framesToDisk ? 'png' : input.pipeTransport ?? 'raw',
    // 计划 C7：叠加出口只渲染首个入点→末个出点，开头的全透明间隙不进管线
    restrictToActiveSpan: isOverlay
  })
  const frames = Math.max(0, spec.endFrame - spec.startFrame)
  if (frames === 0) throw new GateError('没有可导出的片段（时间轴为空）')

  const frameSpec: FrameSpec = frameSpecOf(spec)
  const estimate = autoConfirm
    ? await autoConfirmHugeExport(
        spec.width,
        spec.height,
        frames,
        fps,
        input.outputDir,
        input.kind,
        input.videoBitrateKbps,
        audioBitrateKbps
      )
    : await confirmHugeExport(
        spec.width,
        spec.height,
        frames,
        fps,
        input.outputDir,
        input.kind,
        input.videoBitrateKbps,
        audioBitrateKbps
      )
  if (estimate.choice === 'cancel') throw new GateError('已取消导出')
  let kind: ExportKind = input.kind
  if (estimate.choice === 'png') {
    // 「改用 PNG 序列」只对透明 MOV 开放：帧序列本身就是产物，不需要再编码回容器
    kind = 'pngSequence'
  }

  let fpsMode: 'cfr' | 'vfr' = 'cfr'
  if (isOverlay && base?.anyVfrRaw) {
    const ok = autoConfirm ? true : await confirmVfrRaw()
    if (!ok) throw new GateError('已取消导出')
    fpsMode = 'vfr'
  }

  const jobId = createId('job')
  registerExportJob(jobId, spec)

  /**
   * 音频策略：一律 AAC 重编码（码率见上），不再有 copy 分支。
   */
  const audioMode: 'copy' | 'aac' = 'aac'

  /**
   * v7：音频轨 → 导出输入。
   *
   * 四点口径：
   * 1. 只保留与本次 span 有重叠的段；
   * 2. 被 span 切开的段要把 sourceInSec 同步平移（否则会从头开始放，与预览对不上），
   *    平移量乘上倍速（v9：时间轴 1s 吃掉 speed 秒源）；
   * 3. 带 sourceOutSec / audio / speed（只在动过时）；
   * 4. PNG 序列出口不写音频（帧序列没有容器可承载），其余两种出口都带。
   */
  const spanStart = frameTimeSec(spec.startFrame, fps)
  const spanEnd = frameTimeSec(spec.endFrame, fps)
  // v3：静音音频轨上的片段必须从混音里剔除（否则静音开关只影响画面不影响声音）。
  const externalAudio =
    kind === 'pngSequence'
      ? []
      : (() => {
          const audibleAudioIds = new Set(audibleAudioTracks(project.audioTracks).map((track) => track.id))
          return (project.audioClips ?? [])
            .filter((clip) => audibleAudioIds.has(clip.trackId))
            .map((clip) => {
              const item = project.media.find((m) => m.id === clip.mediaId)
              if (!item) return null
              const start = Math.max(clip.timelineStartSec, spanStart)
              const end = Math.min(clip.timelineEndSec, spanEnd)
              if (end - start <= 1e-3) return null
              const speed = speedValueOf(clip.speed)
              const sourceIn = clip.sourceInSec + (start - clip.timelineStartSec) * speed
              return {
                path: item.path,
                timelineStartSec: start,
                timelineEndSec: end,
                sourceInSec: sourceIn,
                sourceOutSec: sourceIn + (end - start) * speed,
                ...(clip.audio ? { audio: clip.audio } : {}),
                ...(clip.speed ? { speed: clip.speed } : {}),
                // v10：角色与 ducking 只对音频段有意义（BGM 段参与自动压低）
                ...(clip.role === 'bgm' ? { role: clip.role } : {}),
                ...(clip.ducking ? { ducking: clip.ducking } : {})
              }
            })
            .filter((clip): clip is NonNullable<typeof clip> => clip !== null)
        })()

  /**
   * v3 多轨内嵌原声：按「当前时刻最上层、可见且未静音」的片段压平。
   * 单轨工程不走这里（旧 trim+concat 链已经在段内混过原声，再混会双声）。
   */
  const multiTrack = isOverlay && (base?.segments.some((seg) => (seg.trackIndex ?? 0) > 0) ?? false)
  const embeddedAudio: AudioMixClipRequest[] =
    multiTrack && kind !== 'pngSequence'
      ? (() => {
          const order = mediaTrackOrder(project.mediaTracks)
          const audibleTrackIds = new Set(
            visibleMediaTracks(project.mediaTracks)
              .filter((track) => !track.muted)
              .map((track) => track.id)
          )
          const audibleClips = project.mediaClips.filter((clip) => audibleTrackIds.has(clip.trackId))
          return activeMediaClipSpans(audibleClips, order, spanStart, spanEnd).flatMap((span) => {
            const item = project.media.find((media) => media.id === span.clip.mediaId)
            if (!item || item.meta.audioCodec == null || mediaKindOf(item) === 'image') return []
            return [
              {
                path: item.path,
                timelineStartSec: span.timelineStartSec,
                timelineEndSec: span.timelineEndSec,
                sourceInSec: span.sourceInSec,
                sourceOutSec: span.sourceOutSec,
                ...(span.clip.audio ? { audio: span.clip.audio } : {}),
                ...(span.clip.speed ? { speed: span.clip.speed } : {})
              }
            ]
          })
        })()
      : []
  const audioMix = [...externalAudio, ...embeddedAudio]

  /**
   * M8：手绘遮罩 → PNG 字节（尺寸 = 导出目标画布 spec.width/height）。
   * 只服务叠加出口；没有遮罩时返回空数组、请求体不落 `mediaMasks` 键
   * （旧工程导出请求与现在逐字节一致）。
   */
  const mediaMasks = isOverlay && base ? await rasterizeExportMasks(base, spec.width, spec.height) : []

  const request: ExportRequest = {
    jobId,
    target: { kind, outputDir: input.outputDir, fileName: input.fileName },
    frameSpec,
    codec: input.codec ?? 'prores4444',
    // M8：手绘遮罩 PNG（缺省不落键）；主进程写盘后接 maskPath 并走 alphamerge
    ...(mediaMasks.length > 0 ? { mediaMasks } : {}),
    // v10：响度标准化；off/缺省不落键（argv 与旧版逐字节一致）
    ...(project.audioMastering === 'social' || project.audioMastering === 'broadcast'
      ? { audioMastering: project.audioMastering }
      : {}),
    ...(audioMix.length > 0 ? { audioClips: audioMix } : {}),
    ...(isOverlay && base && primaryMeta
      ? {
          overlay: {
            segments: base.segments,
            /** v1 兼容字段：首段即旧单输入路径的参考视频 */
            refVideoPath: base.segments[0]?.refVideoPath ?? '',
            // M7-E：图形层 z 档（缺省 aboveMedia 不落键 → argv 与旧版逐字节一致）
            ...(project.graphicsZ ? { graphicsZ: project.graphicsZ } : {}),
            refMeta: primaryMeta,
            audioMode,
            fpsMode,
            spanStartSec: frameTimeSec(spec.startFrame, fps),
            spanEndSec: frameTimeSec(spec.endFrame, fps),
            // 水印：主进程按本次输出尺寸等比换算后作为最后一层 overlay
            ...(watermark?.enabled
              ? {
                  watermark: {
                    path: watermark.path,
                    sourceWidth: watermark.sourceWidth,
                    sourceHeight: watermark.sourceHeight
                  }
                }
              : {}),
            // v10：目标画布与画质档（缺省时不落键，argv 与旧版逐字节一致）
            ...(canvasForRequest ? { canvas: canvasForRequest } : {}),
            ...(input.quality ? { quality: input.quality } : {}),
            ...(input.videoCodec ? { videoCodec: input.videoCodec } : {}),
            ...(input.videoBitrateKbps !== undefined ? { videoBitrateKbps: input.videoBitrateKbps } : {}),
            // M9：CRF / preset / 位深 / 色彩范围（缺省不落键 → argv 与旧版逐字节一致）
            ...(input.crf !== undefined ? { crf: input.crf } : {}),
            ...(input.encoderPreset ? { encoderPreset: input.encoderPreset } : {}),
            ...(input.bitDepth === 10 ? { bitDepth: 10 as const } : {}),
            ...(input.colorRange ? { colorRange: input.colorRange } : {}),
            audioBitrateKbps
          }
        }
      : {})
  }

  await window.socut.export.start(request)
  return {
    jobId,
    frames,
    width: spec.width,
    height: spec.height,
    fps,
    estimateBytes: estimate.estimateBytes
  }
}
