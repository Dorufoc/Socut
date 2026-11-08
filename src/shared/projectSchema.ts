import {
  AUTOSAVE_FILE,
  DEFAULT_ANIMATION_IN_SEC,
  DEFAULT_ANIMATION_OUT_SEC,
  DEFAULT_CLIP_DURATION_SEC,
  DEFAULT_FPS,
  DEFAULT_FONT_ID,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  MAX_AUDIO_TRACKS,
  MAX_MEDIA_TRACKS,
  MEDIA_BIN_ID_MAX_LENGTH,
  MEDIA_BIN_MAX_COUNT,
  MEDIA_BIN_NAME_MAX_LENGTH,
  MEDIA_TAG_MAX_COUNT,
  MEDIA_TAG_MAX_LENGTH,
  MIN_CLIP_DURATION_SEC,
  PROJECT_VERSION,
  TRANSITION_DURATION
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
import { normalizeMediaVideo } from './mediaClipVideo'
import { normalizeMediaStab } from './mediaStab'
import { normalizeClipAudio, normalizeClipSpeed, speedValueOf } from './mediaClipAudio'
import { MIN_AUDIO_CLIP_SEC, normalizeLayer } from './audioClips'
import {
  AUDIO_TRACK_ID_PREFIX,
  MEDIA_TRACK_ID_PREFIX,
  makeAudioTrack,
  makeMediaTrack,
  makeSubtitleTrack
} from './tracks'
import type {
  AnimationSpec,
  AudioClip,
  AudioDuckingLevel,
  AudioMastering,
  AudioTrack,
  ColorTokens,
  EasingKey,
  FontRecord,
  Fps,
  GradientSpec,
  LeftTabValue,
  MediaBin,
  MediaClip,
  MediaClipTransition,
  MediaItem,
  MediaTrack,
  PresetId,
  Project,
  Rational,
  RefVideo,
  Resolution,
  SizeToken,
  StyleOverrides,
  SubtitleClip,
  SubtitleTrack,
  Track,
  TransitionType,
  VideoMeta,
  WatermarkSettings
} from './types'

/**
 * 工程序列化 schema（纯函数，主/渲染/测试共用）：
 * - normalizeProject：把任意 JSON（自动存档 / 用户文件）安全归一为 Project；
 * - 版本迁移钩子 migrate()；
 * - createClip / duplicateClip：默认值集中，避免 UI 与主进程口径不一致。
 */

export const PROJECT_FILE_EXTENSION = 'socut.json'
export { AUTOSAVE_FILE }

/**
 * 左侧栏 Tab 清单（P6）：素材库 / 包装 / 导出 / 进度。
 * 「包装」把原来的字幕与水印两栏合并，旧工程里的 'captions' / 'watermark'
 * 在读入时一律迁到 'wrap'（见 normalizeLeftTab）。
 */
export const LEFT_TABS = ['media', 'wrap', 'export', 'progress'] as const

/** 旧版 Tab 值 → 现在的位置；只为兼容旧工程，写新值时不要再产出它们。 */
const LEGACY_LEFT_TABS: Record<string, LeftTabValue> = { captions: 'wrap', watermark: 'wrap' }

/**
 * 把任意读到的 leftTab 归一成当前认识的值：
 * 旧值迁到新位置，不认识的值返回 undefined（由调用方退回默认），
 * 防止旧工程把一个界面已经不存在的 Tab 恢复出来变成空面板。
 */
export function normalizeLeftTab(value: unknown): LeftTabValue | undefined {
  if (typeof value !== 'string') return undefined
  const legacy = LEGACY_LEFT_TABS[value]
  if (legacy) return legacy
  return (LEFT_TABS as readonly string[]).includes(value) ? (value as LeftTabValue) : undefined
}

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
  // v7：音频素材没有画面（width/height = 0），不能当「坏视频」丢掉；
  // 只拒绝负数/非有限值，0 的形态由 kind 区分。
  if (!(width >= 0) || !(height >= 0)) return null
  const fallbackRatio = width > 0 && height > 0 ? width / height : 16 / 9
  const str = (key: string): string | null => (typeof value[key] === 'string' ? (value[key] as string) : null)
  return {
    path: str('path') ?? '',
    containerName: str('containerName') ?? 'unknown',
    width,
    height,
    sar: isRecord(value['sar']) ? normalizeRational(value['sar'], { num: 1, den: 1 }) : null,
    displayRatio: numberOr(value['displayRatio'], fallbackRatio),
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

/**
 * v10：素材分组的归一化。
 * id/name 都做 trim 与限长；id 去重；空分组定义直接丢弃；上限 64 组。
 * 没有任何合法分组时返回 undefined（工程 JSON 不凭空多出 mediaBins 键）。
 */
function normalizeMediaBins(raw: unknown): MediaBin[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const bins: MediaBin[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (bins.length >= MEDIA_BIN_MAX_COUNT) break
    if (!isRecord(item)) continue
    const id = typeof item['id'] === 'string' ? item['id'].trim().slice(0, MEDIA_BIN_ID_MAX_LENGTH) : ''
    if (id.length === 0 || seen.has(id)) continue
    const name = typeof item['name'] === 'string' ? item['name'].trim().slice(0, MEDIA_BIN_NAME_MAX_LENGTH) : ''
    if (name.length === 0) continue
    seen.add(id)
    bins.push({ id, name })
  }
  return bins.length > 0 ? bins : undefined
}

/** v10：标签归一化：trim、丢空、按原值去重、单条限长、上限 12 个；为空返回 undefined。 */
export function normalizeMediaTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const tags: string[] = []
  for (const item of raw) {
    if (tags.length >= MEDIA_TAG_MAX_COUNT) break
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MEDIA_TAG_MAX_LENGTH).trim()
    if (tag.length === 0 || tags.includes(tag)) continue
    tags.push(tag)
  }
  return tags.length > 0 ? tags : undefined
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
  // v7：素材类型。旧工程无此字段：有画面就是视频，没画面（width=0）就是音频
  const kindRaw = value['kind']
  const kind =
    kindRaw === 'audio' || kindRaw === 'image' || kindRaw === 'video'
      ? kindRaw
      : meta.width > 0
        ? 'video'
        : 'audio'
  // v10：分组与标签；缺省一律不写键（旧工程 JSON 逐字节不变）
  const binId = typeof value['binId'] === 'string' ? value['binId'].trim().slice(0, MEDIA_BIN_ID_MAX_LENGTH) : ''
  const tags = normalizeMediaTags(value['tags'])
  return {
    id,
    path: value['path'],
    ...(typeof value['sourcePath'] === 'string' ? { sourcePath: value['sourcePath'] } : {}),
    // 视频是缺省类型，不落盘（旧工程 JSON 保持逐字节不变）
    ...(kind !== 'video' ? { kind } : {}),
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
    importedAt: typeof value['importedAt'] === 'string' ? value['importedAt'] : new Date(0).toISOString(),
    ...(binId.length > 0 ? { binId } : {}),
    ...(tags ? { tags } : {})
  }
}

/**
 * v3：轨道归一化。
 *
 * 三条兜底：
 * - 至少一条媒体轨 / 音频轨（新素材要有地方落）；
 * - id 去重、数量夹到上限；
 * - 片段引用了不存在的轨道（手改 JSON / 旧工程）时，按 `layer` 换算或退回第一条。
 */
function normalizeTrackName(value: Record<string, unknown>, fallback: string): string {
  const name = typeof value['name'] === 'string' ? value['name'].trim() : ''
  return name.length > 0 ? name.slice(0, 40) : fallback
}

function trackFlags(value: Record<string, unknown>): { muted: boolean; hidden: boolean; locked: boolean } {
  return {
    muted: value['muted'] === true,
    hidden: value['hidden'] === true,
    locked: value['locked'] === true
  }
}

/** 片段里出现过的 trackId（顺序保留），用于给「缺轨道定义」的工程补轨。 */
function collectTrackIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const ids: string[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = item['trackId']
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function normalizeMediaTracks(value: unknown, referenced: readonly string[]): MediaTrack[] {
  const tracks: MediaTrack[] = []
  const seen = new Set<string>()
  const push = (track: MediaTrack): void => {
    if (tracks.length >= MAX_MEDIA_TRACKS || seen.has(track.id)) return
    seen.add(track.id)
    tracks.push(track)
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!isRecord(item)) return
      const id = typeof item['id'] === 'string' && item['id'].length > 0 ? item['id'] : `${MEDIA_TRACK_ID_PREFIX}${index}`
      push({ id, kind: 'media', name: normalizeTrackName(item, `媒体 ${index + 1}`), ...trackFlags(item) })
    })
  }
  for (const id of referenced) {
    if (tracks.length >= MAX_MEDIA_TRACKS) break
    push({ id, kind: 'media', name: `媒体 ${tracks.length + 1}`, muted: false, hidden: false, locked: false })
  }
  if (tracks.length === 0) tracks.push(makeMediaTrack(0))
  return tracks
}

function normalizeAudioTracks(value: unknown, referenced: readonly string[]): AudioTrack[] {
  const tracks: AudioTrack[] = []
  const seen = new Set<string>()
  const push = (track: AudioTrack): void => {
    if (tracks.length >= MAX_AUDIO_TRACKS || seen.has(track.id)) return
    seen.add(track.id)
    tracks.push(track)
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (!isRecord(item)) return
      const id = typeof item['id'] === 'string' && item['id'].length > 0 ? item['id'] : `${AUDIO_TRACK_ID_PREFIX}${index}`
      push({ id, kind: 'audio', name: normalizeTrackName(item, `音频 ${index + 1}`), ...trackFlags(item) })
    })
  }
  for (const id of referenced) {
    if (tracks.length >= MAX_AUDIO_TRACKS) break
    push({ id, kind: 'audio', name: `音频 ${tracks.length + 1}`, muted: false, hidden: false, locked: false })
  }
  if (tracks.length === 0) tracks.push(makeAudioTrack(0))
  return tracks
}

/** 字幕轨永远只有一条、id 固定；只保留名字与三个开关。 */
function normalizeSubtitleTrack(value: unknown): SubtitleTrack {
  const rec = isRecord(value) ? value : {}
  return makeSubtitleTrack({ name: normalizeTrackName(rec, '字幕'), ...trackFlags(rec) })
}

/**
 * 片段 → 轨道 id。
 * 合法的 `trackId` 直接用；否则把旧 `layer` 投影成迁移后的 deterministic id；
 * 仍然不存在时退回第一条同类轨道（宁可叠在一起，也不让片段凭空消失）。
 */
function resolveTrackId(
  rawTrackId: unknown,
  rawLayer: unknown,
  tracks: readonly Track[],
  legacyPrefix: string
): string {
  if (typeof rawTrackId === 'string' && rawTrackId.length > 0 && tracks.some((track) => track.id === rawTrackId)) {
    return rawTrackId
  }
  const legacyId = `${legacyPrefix}${normalizeLayer(rawLayer)}`
  if (tracks.some((track) => track.id === legacyId)) return legacyId
  return tracks[0]!.id
}

/** v10：19 种成片转场（schema 只认类型，可用性判定留给 Task 5 的 transitions.ts）。 */
const TRANSITION_TYPES: readonly TransitionType[] = [
  'dissolve',
  'fadeBlack',
  'fadeWhite',
  'lightFlash',
  'blurH',
  'blurV',
  'windLeft',
  'windRight',
  'windUp',
  'windDown',
  'pushLeft',
  'pushRight',
  'pushUp',
  'pushDown',
  'pullLeft',
  'pullRight',
  'pullUp',
  'pullDown',
  'zoomIn'
]

/**
 * v10：转场归一化（只做类型/时长/帧率合法性，不判断手柄与相邻关系）。
 * 时长先夹到 0.2–1.5s，再吸附帧边界并夹回合法帧数；不足 2 帧视为无效，整键丢弃。
 */
export function normalizeTransition(raw: unknown, fps: Fps): MediaClipTransition | undefined {
  if (!isRecord(raw)) return undefined
  const type = raw['type']
  if (typeof type !== 'string' || !(TRANSITION_TYPES as readonly string[]).includes(type)) return undefined
  const rawDuration = raw['durationSec']
  if (typeof rawDuration !== 'number' || !Number.isFinite(rawDuration)) return undefined
  const clamped = Math.min(TRANSITION_DURATION.max, Math.max(TRANSITION_DURATION.min, rawDuration))
  const snappedSec = snapTimeToFrame(clamped, fps)
  const snappedFrames = durationSecToFrames(snappedSec, fps, 0)
  if (snappedFrames < TRANSITION_DURATION.minFrames) return undefined
  // 非整数帧率下向上吸附可能略超 1.5s，按最大帧数再夹一次，保证时长上限成立
  const maxFrames = Math.floor((TRANSITION_DURATION.max * fps.num) / fps.den + 1e-9)
  const frames = Math.min(snappedFrames, maxFrames)
  if (frames < TRANSITION_DURATION.minFrames) return undefined
  return { type: type as TransitionType, durationSec: framesToDurationSec(frames, fps) }
}

/** v2：时间轴上一段媒体。入出点写入前吸附帧边界，时长不足最短时拒收。 */
function normalizeMediaClip(
  value: unknown,
  fps: Fps,
  mediaIds: Set<string>,
  tracks: readonly MediaTrack[]
): MediaClip | null {
  if (!isRecord(value)) return null
  if (typeof value['mediaId'] !== 'string' || !mediaIds.has(value['mediaId'])) return null
  const id = typeof value['id'] === 'string' && value['id'].length > 0 ? value['id'] : createId('mclip')
  const tStart = snapTimeToFrame(Math.max(0, numberOr(value['timelineStartSec'], 0)), fps)
  const tEndRaw = numberOr(value['timelineEndSec'], tStart)
  let tEnd = snapTimeToFrame(Math.max(tStart, tEndRaw), fps)
  if (tEnd - tStart < MIN_CLIP_DURATION_SEC) tEnd = snapTimeToFrame(tStart + MIN_CLIP_DURATION_SEC, fps)
  const duration = tEnd - tStart
  const sIn = snapTimeToFrame(Math.max(0, numberOr(value['sourceInSec'], 0)), fps)
  const video = normalizeMediaVideo(value['video'])
  const stab = normalizeMediaStab(value['stab'])
  // v3：轨道归属（旧工程的 layer 在此投影成迁移后的 deterministic trackId）
  const trackId = resolveTrackId(value['trackId'], value['layer'], tracks, MEDIA_TRACK_ID_PREFIX)
  // v9：音频与变速（全默认 → undefined → 整键不落盘）
  const audio = normalizeClipAudio(value['audio'])
  const speed = normalizeClipSpeed(value['speed'])
  // v10：入场转场（无效时整键丢弃）
  const transitionIn = normalizeTransition(value['transitionIn'], fps)
  // 时长强制对齐：任何一份手工改写的 JSON 也要保证
  // `sourceOutSec - sourceInSec === (timelineEndSec - timelineStartSec) × 倍速`（1x 时即旧恒等式）
  const sOut = snapTimeToFrame(sIn + duration * speedValueOf(speed), fps)
  return {
    id,
    mediaId: value['mediaId'],
    timelineStartSec: tStart,
    timelineEndSec: tEnd,
    sourceInSec: sIn,
    sourceOutSec: sOut,
    trackId,
    // v6：画面变换与调色；全部默认时 normalizeMediaVideo 返回 undefined，整键不落盘
    ...(video ? { video } : {}),
    // v8：防抖；关闭且无自定义选择时 normalizeMediaStab 返回 undefined，整键不落盘
    ...(stab ? { stab } : {}),
    // v9：音频参数 / 变速；同上，全默认时整键不存在
    ...(audio ? { audio } : {}),
    ...(speed ? { speed } : {}),
    // v10：转场；无效/缺省时整键不存在
    ...(transitionIn ? { transitionIn } : {})
  }
}

function isDuckingLevel(value: unknown): value is AudioDuckingLevel {
  return value === 'light' || value === 'standard' || value === 'strong'
}

/** v7：音频段。与媒体段同一套时间轴口径，但只贡献声音、不参与画面合成。 */
function normalizeAudioClip(
  value: unknown,
  fps: Fps,
  mediaIds: Set<string>,
  tracks: readonly AudioTrack[]
): AudioClip | null {
  if (!isRecord(value)) return null
  if (typeof value['mediaId'] !== 'string' || !mediaIds.has(value['mediaId'])) return null
  const id = typeof value['id'] === 'string' && value['id'].length > 0 ? value['id'] : createId('aclip')
  const tStart = snapTimeToFrame(Math.max(0, numberOr(value['timelineStartSec'], 0)), fps)
  let tEnd = snapTimeToFrame(Math.max(tStart, numberOr(value['timelineEndSec'], tStart)), fps)
  if (tEnd - tStart < MIN_AUDIO_CLIP_SEC) tEnd = snapTimeToFrame(tStart + MIN_AUDIO_CLIP_SEC, fps)
  const sIn = snapTimeToFrame(Math.max(0, numberOr(value['sourceInSec'], 0)), fps)
  const trackId = resolveTrackId(value['trackId'], value['layer'], tracks, AUDIO_TRACK_ID_PREFIX)
  const audio = normalizeClipAudio(value['audio'])
  const speed = normalizeClipSpeed(value['speed'])
  // v10：voice 是默认角色，不落盘；无效 role 同样丢弃
  const role = value['role'] === 'bgm' ? 'bgm' : undefined
  const ducking = isDuckingLevel(value['ducking']) ? value['ducking'] : undefined
  return {
    id,
    mediaId: value['mediaId'],
    timelineStartSec: tStart,
    timelineEndSec: tEnd,
    sourceInSec: sIn,
    sourceOutSec: snapTimeToFrame(sIn + (tEnd - tStart) * speedValueOf(speed), fps),
    trackId,
    // v9：与媒体段同一套音频/变速口径
    ...(audio ? { audio } : {}),
    ...(speed ? { speed } : {}),
    ...(role ? { role } : {}),
    ...(ducking ? { ducking } : {})
  }
}

/** v10：响度标准化档位；off/未知一律不落盘。 */
function normalizeAudioMastering(value: unknown): AudioMastering | undefined {
  return value === 'social' || value === 'broadcast' ? value : undefined
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

/**
 * 归一 ui 快照（P6）：只校验 leftTab，其余键（面板比例等）原样带走。
 * 没有 leftTab 就不补——冷启动默认由 uiStore 决定，这里不该替它拍板。
 */
function normalizeUi(raw: Record<string, unknown>): NonNullable<Project['ui']> {
  const { leftTab: rawLeftTab, ...rest } = raw
  const leftTab = normalizeLeftTab(rawLeftTab)
  return leftTab ? { ...rest, leftTab } : rest
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
  const mediaBins = normalizeMediaBins(migrated['mediaBins'])
  const mediaRaw = Array.isArray(migrated['media']) ? migrated['media'] : []
  let media = mediaRaw
    .map((item) => normalizeMediaItem(item))
    .filter((item): item is MediaItem => item !== null)
  // v10：binId 必须指向存在且通过归一的 mediaBins；否则退回未分组（键删除）
  if (media.some((item) => item.binId !== undefined)) {
    const binIds = new Set((mediaBins ?? []).map((bin) => bin.id))
    media = media.map((item) => {
      if (item.binId === undefined || binIds.has(item.binId)) return item
      const next: MediaItem = { ...item }
      delete next.binId
      return next
    })
  }
  const mediaIds = new Set(media.map((item) => item.id))
  const mediaClipsRaw = Array.isArray(migrated['mediaClips']) ? migrated['mediaClips'] : []
  const audioClipsRaw = Array.isArray(migrated['audioClips']) ? migrated['audioClips'] : []
  // v3：先归一轨道，再把片段挂上去（缺 trackId 的片段按 legacy layer 投影）
  const mediaTracks = normalizeMediaTracks(migrated['mediaTracks'], collectTrackIds(mediaClipsRaw))
  const audioTracks = normalizeAudioTracks(migrated['audioTracks'], collectTrackIds(audioClipsRaw))
  const subtitleTrack = normalizeSubtitleTrack(migrated['subtitleTrack'])
  const mediaClips = mediaClipsRaw
    .map((item) => normalizeMediaClip(item, fps, mediaIds, mediaTracks))
    .filter((item): item is MediaClip => item !== null)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const audioClips = audioClipsRaw
    .map((item) => normalizeAudioClip(item, fps, mediaIds, audioTracks))
    .filter((item): item is AudioClip => item !== null)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)
  const ui = isRecord(migrated['ui']) ? normalizeUi(migrated['ui']) : undefined
  const watermark = normalizeWatermark(migrated['watermark'])
  const audioMastering = normalizeAudioMastering(migrated['audioMastering'])
  return {
    version: PROJECT_VERSION,
    name: typeof migrated['name'] === 'string' && migrated['name'].length > 0 ? migrated['name'] : '未命名工程',
    resolution,
    fps,
    clips,
    fonts,
    media,
    mediaClips,
    mediaTracks,
    audioTracks,
    subtitleTrack,
    // v7：没有音频段的工程不写这个键（旧工程 JSON 不变）
    ...(audioClips.length > 0 ? { audioClips } : {}),
    ...(watermark ? { watermark } : {}),
    // v10：off/空分组不落盘（旧工程 JSON 不变）
    ...(audioMastering ? { audioMastering } : {}),
    ...(mediaBins ? { mediaBins } : {}),
    ...(ui ? { ui } : {})
  }
}

/** 旧工程历史层号 → 轨道条数（连续 0..max；没有任何片段时也给一条空轨）。 */
function legacyTrackCount(clipsRaw: unknown, max: number): number {
  let maxLayer = -1
  if (Array.isArray(clipsRaw)) {
    for (const clip of clipsRaw) {
      if (!isRecord(clip)) continue
      maxLayer = Math.max(maxLayer, normalizeLayer(clip['layer']))
    }
  }
  return Math.min(max, Math.max(1, maxLayer + 1))
}

/** 旧片段：把 layer 投影成 deterministic trackId 并删掉旧字段。 */
function assignTrackIds(clipsRaw: unknown, prefix: string): unknown {
  if (!Array.isArray(clipsRaw)) return clipsRaw
  return clipsRaw.map((clip) => {
    if (!isRecord(clip)) return clip
    const next: Record<string, unknown> = { ...clip }
    if (typeof next['trackId'] !== 'string' || next['trackId'].length === 0) {
      next['trackId'] = `${prefix}${normalizeLayer(next['layer'])}`
    }
    delete next['layer']
    return next
  })
}

/**
 * v2 → v3：给旧工程补轨道数组。
 *
 * 每个历史上用到的层号一条轨道（0..max 连续），id 固定为 `track-media-N` / `track-audio-N`：
 * 同一份旧工程每次迁移结果一致（自动存档 / 历史快照读回不会漂移）。
 * 字幕轨固定一条 `track-subtitle`；旧工程没有字幕分层概念。
 */
function applyTrackMigration(project: Record<string, unknown>): void {
  const mediaClipsRaw = project['mediaClips']
  const audioClipsRaw = project['audioClips']
  project['mediaTracks'] = Array.from(
    { length: legacyTrackCount(mediaClipsRaw, MAX_MEDIA_TRACKS) },
    (_, index) => makeMediaTrack(index)
  )
  project['audioTracks'] = Array.from(
    { length: legacyTrackCount(audioClipsRaw, MAX_AUDIO_TRACKS) },
    (_, index) => makeAudioTrack(index)
  )
  project['subtitleTrack'] = makeSubtitleTrack()
  if (Array.isArray(mediaClipsRaw)) project['mediaClips'] = assignTrackIds(mediaClipsRaw, MEDIA_TRACK_ID_PREFIX)
  if (Array.isArray(audioClipsRaw)) project['audioClips'] = assignTrackIds(audioClipsRaw, AUDIO_TRACK_ID_PREFIX)
}

/**
 * 版本迁移钩子：
 * - v0（无 version）：字段名与 v1 一致，直接补版本号；
 * - v1 → v2：把 `refVideo` 拆为 `media[0] + mediaClip 覆盖整段`，无 refVideo 时 media/mediaClips 保持缺省；
 * - v2 → v3：补 `mediaTracks` / `audioTracks` / `subtitleTrack`，并把片段的 `layer` 投影成 `trackId`。
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
  if (fromVersion < 3) applyTrackMigration(intermediate)
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
    mediaClips: [],
    mediaTracks: [makeMediaTrack(0)],
    audioTracks: [makeAudioTrack(0)],
    subtitleTrack: makeSubtitleTrack()
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

export interface SubtitleSplitResult {
  /** 左半段：入点不变，出点落在切分帧 */
  left: SubtitleClip
  /** 右半段：入点从切分帧起，出点沿用原段 */
  right: SubtitleClip
}

/**
 * 在 `atSec`（自动吸附帧边界）处把一条字幕条切成两段（P3：工具栏拆分对字幕条也生效）。
 *
 * 拆分只改时间：文字、预设、自定义样式、字体、动画全部原样带到两半，
 * 而且都是**独立副本**——否则改右半边的标题会连着改左半边。
 * 切点不在本条区间内，或任一半不足最短时长 → null（与媒体段同一套判据）。
 */
export function splitSubtitleClipAt(
  clip: SubtitleClip,
  atSec: number,
  fps: Fps,
  newId: (source: SubtitleClip) => string
): SubtitleSplitResult | null {
  const cut = snapTimeToFrame(atSec, fps)
  if (cut <= clip.startTime + MIN_CLIP_DURATION_SEC - 1e-9) return null
  if (cut >= clip.endTime - MIN_CLIP_DURATION_SEC + 1e-9) return null
  const left: SubtitleClip = {
    ...clip,
    endTime: cut,
    styleOverrides: cloneStyleOverrides(clip.styleOverrides),
    content: { ...clip.content },
    animation: cloneAnimation(clip.animation)
  }
  const right: SubtitleClip = {
    ...clip,
    id: newId(clip),
    startTime: cut,
    styleOverrides: cloneStyleOverrides(clip.styleOverrides),
    content: { ...clip.content },
    animation: cloneAnimation(clip.animation)
  }
  return { left, right }
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
