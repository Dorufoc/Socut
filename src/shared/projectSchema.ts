import {
  AUTOSAVE_FILE,
  DEFAULT_ANIMATION_IN_SEC,
  DEFAULT_ANIMATION_OUT_SEC,
  DEFAULT_CLIP_DURATION_SEC,
  DEFAULT_FPS,
  DEFAULT_FONT_ID,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  MIN_CLIP_DURATION_SEC,
  PROJECT_VERSION
} from './constants'
import { DEFAULT_PRESET_ID, PRESET_IDS } from './presets'
import { EASING_KEYS } from './easing'
import { COLOR_TOKEN_KEYS, isValidColor } from './colors'
import {
  clipEndFrame,
  clipStartFrame,
  durationSecToFrames,
  framesToDurationSec,
  snapTimeToFrame
} from './fps'
import type {
  AnimationSpec,
  ColorTokens,
  EasingKey,
  FontRecord,
  Fps,
  GradientSpec,
  MediaClip,
  MediaItem,
  PresetId,
  Project,
  Rational,
  RefVideo,
  Resolution,
  SizeToken,
  StyleOverrides,
  SubtitleClip,
  VideoMeta,
  WatermarkSettings
} from './types'

/**
 * 工程序列化 schema（纯函数，主/渲染/测试共用）：
 * - normalizeProject：把任意 JSON（自动存档 / 用户文件）安全归一为 Project；
 * - 版本迁移钩子 migrate()；
 * - createClip / duplicateClip：默认值集中，避免 UI 与主进程口径不一致。
 */

export const PROJECT_FILE_EXTENSION = 'focusnews.json'
export { AUTOSAVE_FILE }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeResolution(value: unknown): Resolution {
  if (!isRecord(value)) return { ...{ width: 1920, height: 1080 } }
  const width = Math.max(16, Math.round(numberOr(value['width'], 1920)))
  const height = Math.max(16, Math.round(numberOr(value['height'], 1080)))
  return { width, height }
}

function normalizeFps(value: unknown): Fps {
  if (isRecord(value)) {
    const num = Math.round(numberOr(value['num'], DEFAULT_FPS.num))
    const den = Math.round(numberOr(value['den'], DEFAULT_FPS.den))
    if (num > 0 && den > 0) return { num, den }
  }
  // 容错：老草稿可能写成浮点
  const asNumber = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  return asNumber === null ? { ...DEFAULT_FPS } : { num: Math.round(asNumber * 1000), den: 1000 }
}

function normalizeClip(value: unknown, fps: Fps): SubtitleClip | null {
  if (!isRecord(value)) return null
  const rawStart = numberOr(value['startTime'], 0)
  const rawEnd = numberOr(value['endTime'], 0)
  const startTime = snapTimeToFrame(Math.max(0, rawStart), fps)
  let endTime = snapTimeToFrame(Math.max(rawStart + MIN_CLIP_DURATION_SEC, rawEnd), fps)
  if (endTime - startTime < MIN_CLIP_DURATION_SEC) {
    endTime = snapTimeToFrame(startTime + DEFAULT_CLIP_DURATION_SEC, fps)
  }
  const animation = isRecord(value['animation']) ? value['animation'] : {}
  const content = isRecord(value['content']) ? value['content'] : {}
  const overrides = isRecord(value['styleOverrides']) ? value['styleOverrides'] : {}
  const presetId = isPresetId(value['presetId']) ? value['presetId'] : DEFAULT_PRESET_ID
  const id = typeof value['id'] === 'string' && value['id'].length > 0 ? value['id'] : createId('clip')
  const styleOverrides: StyleOverrides = {}
  const tokens = normalizeTokens(overrides['tokens'])
  if (tokens) styleOverrides.tokens = tokens
  if (typeof overrides['barOpacity'] === 'number') styleOverrides.barOpacity = overrides['barOpacity']
  const titleGradient = normalizeGradient(overrides['titleGradient'])
  if (titleGradient) styleOverrides.titleGradient = titleGradient
  const subtitleGradient = normalizeGradient(overrides['subtitleGradient'])
  if (subtitleGradient) styleOverrides.subtitleGradient = subtitleGradient
  if (typeof overrides['compact'] === 'boolean') styleOverrides.compact = overrides['compact']
  const fontScale = normalizeFontScale(overrides['fontScale'])
  if (fontScale) styleOverrides.fontScale = fontScale

  return {
    id,
    startTime,
    endTime,
    presetId,
    styleOverrides,
    content: {
      title: typeof content['title'] === 'string' ? content['title'] : '',
      subtitle: typeof content['subtitle'] === 'string' ? content['subtitle'] : ''
    },
    animation: {
      inDuration: numberOr(animation['inDuration'], DEFAULT_ANIMATION_IN_SEC),
      outDuration: numberOr(animation['outDuration'], DEFAULT_ANIMATION_OUT_SEC),
      easing: isEasingKey(animation['easing']) ? animation['easing'] : 'outCubic',
      textRevealFrames: Math.max(1, Math.round(numberOr(animation['textRevealFrames'], 3))),
      displacement: normalizeDisplacement(animation['displacement']),
      ...(typeof animation['ruleLeadInFrames'] === 'number'
        ? { ruleLeadInFrames: Math.round(animation['ruleLeadInFrames']) }
        : {})
    },
    fontId: typeof value['fontId'] === 'string' && value['fontId'].length > 0 ? value['fontId'] : DEFAULT_FONT_ID
  }
}

/**
 * 字号缩放：非数字丢弃，越界夹到上下限，与 1 相差不到 0.5%（低于滑杆粒度）视为未设置，
 * 避免一件“看似没改”的片段在工程 JSON 里留下无意义的 0.001 级噪声。
 */
function normalizeFontScale(value: unknown): { title?: number; subtitle?: number } | undefined {
  if (!isRecord(value)) return undefined
  const out: { title?: number; subtitle?: number } = {}
  for (const role of ['title', 'subtitle'] as const) {
    const raw = value[role]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, raw))
    const rounded = Math.round(clamped * 1000) / 1000
    if (Math.abs(rounded - 1) < 0.005) continue
    out[role] = rounded
  }
  return out.title === undefined && out.subtitle === undefined ? undefined : out
}

function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && (PRESET_IDS as string[]).includes(value)
}

function isEasingKey(value: unknown): value is EasingKey {
  return typeof value === 'string' && (EASING_KEYS as string[]).includes(value)
}

function normalizeTokens(value: unknown): Partial<ColorTokens> | undefined {
  if (!isRecord(value)) return undefined
  const out: Partial<ColorTokens> = {}
  let any = false
  for (const key of COLOR_TOKEN_KEYS) {
    const v = value[key]
    if (typeof v === 'string' && isValidColor(v)) {
      out[key] = v
      any = true
    }
  }
  return any ? out : undefined
}

function normalizeGradient(value: unknown): GradientSpec | undefined {
  if (!isRecord(value)) return undefined
  const from = typeof value['from'] === 'string' && isValidColor(value['from']) ? value['from'] : null
  const to = typeof value['to'] === 'string' && isValidColor(value['to']) ? value['to'] : null
  if (!from || !to) return undefined
  return {
    enabled: value['enabled'] !== false,
    from,
    to,
    angleDeg: numberOr(value['angleDeg'], 0)
  }
}

function normalizeDisplacement(value: unknown): { x: SizeToken; y: SizeToken } {
  if (!isRecord(value)) return { x: '-30px@1080p', y: '0' }
  const x = value['x']
  const y = value['y']
  return {
    x: typeof x === 'string' || typeof x === 'number' ? x : '-30px@1080p',
    y: typeof y === 'string' || typeof y === 'number' ? y : '0'
  }
}

function normalizeRational(value: unknown, fallback: Rational): Rational {
  if (isRecord(value)) {
    const num = Math.round(numberOr(value['num'], fallback.num))
    const den = Math.round(numberOr(value['den'], fallback.den))
    if (num > 0 && den > 0) return { num, den }
  }
  return fallback
}

function normalizeMeta(value: unknown): VideoMeta | null {
  if (!isRecord(value)) return null
  const width = Math.round(numberOr(value['width'], 0))
  const height = Math.round(numberOr(value['height'], 0))
  if (width <= 0 || height <= 0) return null
  const str = (key: string): string | null => (typeof value[key] === 'string' ? (value[key] as string) : null)
  return {
    path: str('path') ?? '',
    containerName: str('containerName') ?? 'unknown',
    width,
    height,
    sar: isRecord(value['sar']) ? normalizeRational(value['sar'], { num: 1, den: 1 }) : null,
    displayRatio: numberOr(value['displayRatio'], width / height),
    rFrameRate: normalizeRational(value['rFrameRate'], { num: 25, den: 1 }),
    avgFrameRate: normalizeRational(value['avgFrameRate'], { num: 25, den: 1 }),
    pixFmt: str('pixFmt') ?? 'unknown',
    colorPrimaries: str('colorPrimaries'),
    colorSpace: str('colorSpace'),
    colorTransfer: str('colorTransfer'),
    colorRange: str('colorRange'),
    videoCodec: str('videoCodec') ?? 'unknown',
    audioCodec: str('audioCodec'),
    audioChannels: typeof value['audioChannels'] === 'number' ? value['audioChannels'] : null,
    durationSec: numberOr(value['durationSec'], 0),
    nbFrames: typeof value['nbFrames'] === 'number' ? value['nbFrames'] : null,
    bitRateKbps: typeof value['bitRateKbps'] === 'number' ? value['bitRateKbps'] : null
  }
}

function normalizeRefVideo(value: unknown): RefVideo | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value['path'] !== 'string') return undefined
  const meta = normalizeMeta(value['meta'])
  if (!meta) return undefined
  const policy = value['vfrPolicy']
  const compactMode = value['compactMode']
  return {
    path: value['path'],
    ...(typeof value['sourcePath'] === 'string' ? { sourcePath: value['sourcePath'] } : {}),
    meta,
    non169Ack: value['non169Ack'] === true,
    hdrAck: value['hdrAck'] === true,
    vfrPolicy: policy === 'converted' || policy === 'raw' ? policy : 'none',
    compactMode:
      compactMode === 'compact' || compactMode === 'ultrawide' || compactMode === 'standard'
        ? compactMode
        : 'auto',
    importedAt: typeof value['importedAt'] === 'string' ? value['importedAt'] : new Date(0).toISOString()
  }
}

/** v2：一枚参考视频的归一化。无 path/meta 时返回 null 以免向时间轴里注入坏卡。 */
function normalizeMediaItem(value: unknown): MediaItem | null {
  if (!isRecord(value)) return null
  if (typeof value['path'] !== 'string' || value['path'].length === 0) return null
  const meta = normalizeMeta(value['meta'])
  if (!meta) return null
  const id = typeof value['id'] === 'string' && value['id'].length > 0 ? value['id'] : createId('media')
  const name = typeof value['name'] === 'string' && value['name'].length > 0
    ? value['name']
    : (value['path'] as string).split(/[\\/]/).pop() ?? (value['path'] as string)
  const policy = value['vfrPolicy']
  const compactMode = value['compactMode']
  return {
    id,
    path: value['path'],
    ...(typeof value['sourcePath'] === 'string' ? { sourcePath: value['sourcePath'] } : {}),
    name,
    meta,
    non169Ack: value['non169Ack'] === true,
    hdrAck: value['hdrAck'] === true,
    vfrPolicy: policy === 'converted' || policy === 'raw' ? policy : 'none',
    compactMode:
      compactMode === 'compact' || compactMode === 'ultrawide' || compactMode === 'standard'
        ? compactMode
        : 'auto',
    thumbnailUrl: typeof value['thumbnailUrl'] === 'string' ? value['thumbnailUrl'] : '',
    importedAt: typeof value['importedAt'] === 'string' ? value['importedAt'] : new Date(0).toISOString()
  }
}

/** v2：时间轴上一段媒体。入出点写入前吸附帧边界，时长不足最短时拒收。 */
function normalizeMediaClip(value: unknown, fps: Fps, mediaIds: Set<string>): MediaClip | null {
  if (!isRecord(value)) return null
  if (typeof value['mediaId'] !== 'string' || !mediaIds.has(value['mediaId'])) return null
  const id = typeof value['id'] === 'string' && value['id'].length > 0 ? value['id'] : createId('mclip')
  const tStart = snapTimeToFrame(Math.max(0, numberOr(value['timelineStartSec'], 0)), fps)
  const tEndRaw = numberOr(value['timelineEndSec'], tStart)
  let tEnd = snapTimeToFrame(Math.max(tStart, tEndRaw), fps)
  if (tEnd - tStart < MIN_CLIP_DURATION_SEC) tEnd = snapTimeToFrame(tStart + MIN_CLIP_DURATION_SEC, fps)
  const duration = tEnd - tStart
  const sIn = snapTimeToFrame(Math.max(0, numberOr(value['sourceInSec'], 0)), fps)
  // 时长强制对齐：任何一份手工改写的 JSON 也要保证 `sourceOutSec - sourceInSec === timelineEndSec - timelineStartSec`
  let sOut = snapTimeToFrame(sIn + duration, fps)
  if (sOut <= sIn) sOut = snapTimeToFrame(sIn + duration, fps)
  return {
    id,
    mediaId: value['mediaId'],
    timelineStartSec: tStart,
    timelineEndSec: tEnd,
    sourceInSec: sIn,
    sourceOutSec: sOut
  }
}

/**
 * 水印设置归一化：无 path / 尺寸不可用时返回 undefined（等于没导入），
 * 不让一张已失效的图片把整个工程带坏。
 */
function normalizeWatermark(value: unknown): WatermarkSettings | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value['path'] !== 'string' || value['path'].length === 0) return undefined
  const sourceWidth = Math.round(numberOr(value['sourceWidth'], 0))
  const sourceHeight = Math.round(numberOr(value['sourceHeight'], 0))
  if (sourceWidth <= 0 || sourceHeight <= 0) return undefined
  const name = typeof value['name'] === 'string' && value['name'].length > 0
    ? value['name']
    : (value['path'] as string).split(/[\\/]/).pop() ?? (value['path'] as string)
  return {
    // 缺省视为启用：用户导入了就是要用（旧工程无此字段时保持 undefined，行为不变）
    enabled: value['enabled'] !== false,
    path: value['path'],
    name,
    sourceWidth,
    sourceHeight,
    importedAt: typeof value['importedAt'] === 'string' ? value['importedAt'] : new Date(0).toISOString()
  }
}

function normalizeFontRecord(value: unknown): FontRecord | null {
  if (!isRecord(value) || typeof value['fontId'] !== 'string' || typeof value['fileName'] !== 'string') return null
  return {
    fontId: value['fontId'],
    family: typeof value['family'] === 'string' ? value['family'] : value['fontId'],
    displayName: typeof value['displayName'] === 'string' ? value['displayName'] : value['fontId'],
    weight: Math.round(numberOr(value['weight'], 400)),
    style: value['style'] === 'italic' ? 'italic' : 'normal',
    bytes: Math.max(0, Math.round(numberOr(value['bytes'], 0))),
    sha1: typeof value['sha1'] === 'string' ? value['sha1'] : '',
    fileName: value['fileName'],
    source: value['source'] === 'user' ? 'user' : 'builtin',
    importedAt: typeof value['importedAt'] === 'string' ? value['importedAt'] : new Date(0).toISOString()
  }
}

/** 把未知 JSON 归一为 Project；结构完全不可用时返回 null。 */
export function normalizeProject(raw: unknown): Project | null {
  if (!isRecord(raw)) return null
  const version = Math.round(numberOr(raw['version'], 0))
  const migrated = version < PROJECT_VERSION ? migrate(raw, version) : raw
  if (!isRecord(migrated)) return null
  const resolution = normalizeResolution(migrated['resolution'])
  const fps = normalizeFps(migrated['fps'])
  const clipsRaw = Array.isArray(migrated['clips']) ? migrated['clips'] : []
  const clips = clipsRaw
    .map((clip) => normalizeClip(clip, fps))
    .filter((clip): clip is SubtitleClip => clip !== null)
    .sort((a, b) => a.startTime - b.startTime)
  const fonts = Array.isArray(migrated['fonts'])
    ? migrated['fonts']
        .map((font) => normalizeFontRecord(font))
        .filter((font): font is FontRecord => font !== null)
    : []
  // 旧工程：migrate() 已将 refVideo 写入 media[0] + 覆盖整段的 mediaClip；新工程直接读 media/mediaClips
  const mediaRaw = Array.isArray(migrated['media']) ? migrated['media'] : []
  const media = mediaRaw
    .map((item) => normalizeMediaItem(item))
    .filter((item): item is MediaItem => item !== null)
  const mediaIds = new Set(media.map((item) => item.id))
  const mediaClipsRaw = Array.isArray(migrated['mediaClips']) ? migrated['mediaClips'] : []
  const mediaClips = mediaClipsRaw
    .map((item) => normalizeMediaClip(item, fps, mediaIds))
    .filter((item): item is MediaClip => item !== null)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const ui = isRecord(migrated['ui']) ? (migrated['ui'] as Project['ui']) : undefined
  const watermark = normalizeWatermark(migrated['watermark'])
  return {
    version: PROJECT_VERSION,
    name: typeof migrated['name'] === 'string' && migrated['name'].length > 0 ? migrated['name'] : '未命名工程',
    resolution,
    fps,
    clips,
    fonts,
    media,
    mediaClips,
    ...(watermark ? { watermark } : {}),
    ...(ui ? { ui } : {})
  }
}

/**
 * 版本迁移钩子：
 * - v0（无 version）：字段名与 v1 一致，直接补版本号；
 * - v1 → v2：把 `refVideo` 拆为 `media[0] + mediaClip 覆盖整段`，无 refVideo 时 media/mediaClips 保持缺省。
 */
function migrate(raw: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  if (fromVersion >= PROJECT_VERSION) return raw
  const intermediate: Record<string, unknown> = { ...raw, version: PROJECT_VERSION }
  if (fromVersion < 2) {
    const legacyRef = normalizeRefVideo(raw['refVideo'])
    if (legacyRef) {
      const itemId = createId('media')
      const clipId = createId('mclip')
      const fps = normalizeFps(raw['fps'])
      const duration = Math.max(0, legacyRef.meta.durationSec)
      const timelineEnd = snapTimeToFrame(duration, fps)
      const sourceOut = snapTimeToFrame(duration, fps)
      intermediate['media'] = [
        {
          id: itemId,
          path: legacyRef.path,
          ...(legacyRef.sourcePath ? { sourcePath: legacyRef.sourcePath } : {}),
          name: legacyRef.path.split(/[\\/]/).pop() ?? legacyRef.path,
          meta: legacyRef.meta,
          non169Ack: legacyRef.non169Ack,
          hdrAck: legacyRef.hdrAck,
          vfrPolicy: legacyRef.vfrPolicy,
          compactMode: legacyRef.compactMode,
          thumbnailUrl: '',
          importedAt: legacyRef.importedAt
        }
      ]
      intermediate['mediaClips'] = [
        {
          id: clipId,
          mediaId: itemId,
          timelineStartSec: 0,
          timelineEndSec: timelineEnd,
          sourceInSec: 0,
          sourceOutSec: sourceOut
        }
      ]
      // 旧字段删除：normalizeProject 不再读 refVideo，避免重复写入时旧新共存
      delete intermediate['refVideo']
    } else {
      intermediate['media'] = []
      intermediate['mediaClips'] = []
    }
  }
  return intermediate
}

export function createDefaultProject(name = '未命名工程'): Project {
  return {
    version: PROJECT_VERSION,
    name,
    resolution: { width: 1920, height: 1080 },
    fps: { ...DEFAULT_FPS },
    clips: [],
    fonts: [],
    media: [],
    mediaClips: []
  }
}

/** 随机 id：时间戳 + 递增序列，避免同一毫秒冲突。 */
let idSequence = 0
export function createId(prefix: string): string {
  idSequence = (idSequence + 1) % 4096
  return `${prefix}-${Date.now().toString(36)}-${idSequence.toString(36)}`
}

export interface NewClipInput {
  startTime?: number
  fps: Fps
  presetId?: SubtitleClip['presetId']
  fontId?: string
  title?: string
  subtitle?: string
}

export function createClip(input: NewClipInput): SubtitleClip {
  const start = snapTimeToFrame(Math.max(0, input.startTime ?? 0), input.fps)
  const end = snapTimeToFrame(start + DEFAULT_CLIP_DURATION_SEC, input.fps)
  // 默认入场/出场各 1 秒：先按当前帧率取整帧再回写秒，保证非标准帧率（23.976/29.97/59.94）
  // 也能落在帧边界上，面板显示的帧数与时长保持同一口径。
  const inDuration = framesToDurationSec(durationSecToFrames(DEFAULT_ANIMATION_IN_SEC, input.fps), input.fps)
  const outDuration = framesToDurationSec(durationSecToFrames(DEFAULT_ANIMATION_OUT_SEC, input.fps), input.fps)
  return {
    id: createId('clip'),
    startTime: start,
    endTime: end,
    presetId: input.presetId ?? DEFAULT_PRESET_ID,
    styleOverrides: {},
    content: { title: input.title ?? '', subtitle: input.subtitle ?? '' },
    animation: {
      inDuration,
      outDuration,
      easing: 'outCubic',
      textRevealFrames: 3,
      displacement: { x: '-30px@1080p', y: '0' }
    },
    fontId: input.fontId ?? DEFAULT_FONT_ID
  }
}

/** 样式覆盖的深拷贝（含令牌与渐变）：UI 的「应用到全部」与复制片段都靠它隔离引用。 */
export function cloneStyleOverrides(source: StyleOverrides): StyleOverrides {
  return {
    ...(source.tokens ? { tokens: { ...source.tokens } } : {}),
    ...(source.barOpacity !== undefined ? { barOpacity: source.barOpacity } : {}),
    ...(source.titleGradient ? { titleGradient: { ...source.titleGradient } } : {}),
    ...(source.subtitleGradient ? { subtitleGradient: { ...source.subtitleGradient } } : {}),
    ...(source.compact !== undefined ? { compact: source.compact } : {}),
    ...(source.fontScale ? { fontScale: { ...source.fontScale } } : {})
  }
}

export function cloneAnimation(source: AnimationSpec): AnimationSpec {
  return { ...source, displacement: { ...source.displacement } }
}

/**
 * 把源片段的**样式**（预设 / 配色 / 不透明度 / 渐变 / 字号缩放 / 字体 / 动画）
 * 复制到工程内其余片段，**保留每段自己的文字内容与入出点**（用户明确要求：除文字外全部应用）。
 * 纯函数：返回新 project 与真正被改写的片段数（不含源片段自身）。
 */
export function applyClipStyleToAll(project: Project, sourceId: string): { project: Project; count: number } {
  const source = project.clips.find((clip) => clip.id === sourceId)
  if (!source) return { project, count: 0 }
  let count = 0
  const clips = project.clips.map((clip) => {
    if (clip.id === source.id) return clip
    count += 1
    return {
      ...clip,
      presetId: source.presetId,
      styleOverrides: cloneStyleOverrides(source.styleOverrides),
      animation: cloneAnimation(source.animation),
      fontId: source.fontId
    }
  })
  return count === 0 ? { project, count } : { project: { ...project, clips }, count }
}

export function duplicateClip(clip: SubtitleClip, fps: Fps): SubtitleClip {
  const durationSec = clip.endTime - clip.startTime
  const start = snapTimeToFrame(clip.endTime, fps)
  return {
    ...clip,
    id: createId('clip'),
    startTime: start,
    endTime: snapTimeToFrame(start + durationSec, fps),
    styleOverrides: cloneStyleOverrides(clip.styleOverrides),
    content: { ...clip.content },
    animation: cloneAnimation(clip.animation)
  }
}

/** 片段是否落在给定帧区间内（导出 span 过滤用）。 */
export function clipFrames(clip: SubtitleClip, fps: Fps): { startFrame: number; endFrame: number } {
  return {
    startFrame: clipStartFrame(clip.startTime, fps),
    endFrame: clipEndFrame(clip.endTime, fps)
  }
}

/** 校验时间轴合法性（入点 < 出点、时长下限）。 */
export function validateClips(clips: SubtitleClip[], fps: Fps): string[] {
  const issues: string[] = []
  for (const clip of clips) {
    const { startFrame, endFrame } = clipFrames(clip, fps)
    if (endFrame <= startFrame) {
      issues.push(`片段 ${clip.id} 的入出点在同一帧或倒序（${clip.startTime} → ${clip.endTime}）`)
    }
    if (clip.startTime < 0) issues.push(`片段 ${clip.id} 入点为负`)
  }
  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as SubtitleClip
    const cur = sorted[i] as SubtitleClip
    if (cur.startTime < prev.endTime) {
      issues.push(`片段 ${cur.id} 与 ${prev.id} 时间重叠（MVP 不做多字幕条同时叠加）`)
    }
  }
  return issues
}
