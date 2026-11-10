import { normalizeProject } from '@shared/projectSchema'
import {
  CliCommandError,
  CLI_ERROR_CODES,
  optionalBoolean,
  optionalEnum,
  optionalNumber,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requireBoolean,
  requireNumber,
  requireRecord,
  requireString,
  requireStringArray,
  toCliErrorInfo,
  type CliCommandRequest,
  type CliResponse
} from '@shared/cliProtocol'
import type {
  ClipAudio,
  ClipSpeed,
  ExportCanvasSelection,
  MediaClipTransition,
  MediaClipVideo,
  MediaClipStab,
  PresetId,
  SubtitleClip,
  WatermarkSettings
} from '@shared/types'
import { runCoverExport } from '../render/coverRunner'
import { runExport, GateError } from '../render/exportRunner'
import { buildRenderJob, renderJobToPngBlob } from '../render/jobBuilder'
import { bytesToBase64 } from '@shared/base64'
import { frameTimeSec, timeToFrameFloor } from '@shared/fps'
import { importMediaWithPolicy } from '../hooks/useVideoImport'
import { sequenceSummaries } from '@shared/sequence'
import { parseCaptionRows } from '@shared/captionBatch'
import { cuesFromClips, formatAss, formatSrt } from '@shared/subtitleFormats'
import { TEXT_PRESETS, isTextPresetId } from '@shared/textPresets'
import { inferMatteKind } from '@shared/ffmpegArgs'
import { useHistoryStore } from '../state/projectHistory'
import { waitForResult } from '../state/jobEvents'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 渲染侧 CLI 命令路由。
 *
 * 所有命令都直接调用现有 zustand action / 导出 runner，不复制业务逻辑；
 * `project.apply` 用完整工程 JSON 覆盖，作为离散命令覆盖不到时的通用逃生口。
 */

function basename(target: string): string {
  return target.split(/[\\/]/).pop() ?? target
}

function mediaProbeFailure(path: string): CliCommandError {
  return new CliCommandError(CLI_ERROR_CODES.MEDIA_PROBE_FAILED, `无法探测媒体文件：${path}`)
}

function gateCancelled(): CliCommandError {
  return new CliCommandError(
    CLI_ERROR_CODES.GATE_BLOCKED,
    '导入被门禁拒绝：非 16:9 / HDR / VFR 需要显式确认参数'
  )
}

function selectById(kind: 'subtitle' | 'media' | 'audio', id: string): void {
  const store = useProjectStore.getState()
  if (kind === 'subtitle') store.selectClip(id)
  else if (kind === 'media') store.selectMediaClip(id)
  else store.selectAudioClip(id)
}

function ensureMediaClip(id: string): void {
  if (!useProjectStore.getState().project.mediaClips.some((clip) => clip.id === id)) {
    throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `媒体段不存在：${id}`)
  }
}

function ensureAudioClip(id: string): void {
  if (!(useProjectStore.getState().project.audioClips ?? []).some((clip) => clip.id === id)) {
    throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `音频段不存在：${id}`)
  }
}

function ensureSubtitleClip(id: string): void {
  if (!useProjectStore.getState().project.clips.some((clip) => clip.id === id)) {
    throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `字幕条不存在：${id}`)
  }
}

function handleProjectCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'project.load': {
      const raw = requireRecord(params, 'project')
      const project = normalizeProject(raw)
      if (!project) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '工程结构不可用')
      const path = optionalString(params, 'path')
      const entryId = optionalString(params, 'entryId')
      store.loadProject(project, path, entryId)
      useUiStore.getState().setView('editor')
      return { path: path ?? null, entryId: entryId ?? null, name: project.name }
    }
    case 'project.apply': {
      const project = normalizeProject(requireRecord(params, 'project'))
      if (!project) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '工程结构不可用')
      const current = useProjectStore.getState()
      current.loadProject(project, current.currentPath ?? undefined, current.currentEntryId)
      useUiStore.getState().setView('editor')
      return { name: project.name, clips: project.clips.length, media: project.media.length }
    }
    case 'project.get':
      return {
        project: store.project,
        currentPath: store.currentPath,
        currentEntryId: store.currentEntryId,
        revision: store.revision,
        isDirty: store.isDirty,
        selectedClipId: store.selectedClipId,
        selectedMediaClipId: store.selectedMediaClipId,
        selectedAudioClipId: store.selectedAudioClipId,
        selectedTrackId: store.selectedTrackId,
        selectionKind: store.selectionKind
      }
    case 'project.save': {
      const target = optionalString(params, 'path') ?? store.currentPath
      if (!target) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '缺少保存路径：path')
      return window.socut.project.writeToPath(target, store.project).then((saved) => {
        useProjectStore.getState().adoptSavedEntry(saved.path, saved.entryId)
        return saved
      })
    }
    case 'project.rename': {
      const name = requireString(params, 'name').trim()
      if (!name) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '工程名不能为空')
      store.setName(name)
      return { name }
    }
    case 'project.resolution':
      store.setResolution(requireNumber(params, 'width'), requireNumber(params, 'height'))
      return { resolution: useProjectStore.getState().project.resolution }
    case 'project.fps': {
      const fps = { num: requireNumber(params, 'num'), den: requireNumber(params, 'den') }
      store.setFps(fps)
      return { fps }
    }
    case 'project.audioMastering': {
      const mode = optionalEnum(params, 'mastering', ['social', 'broadcast'] as const)
      store.setAudioMastering(mode)
      return { mastering: mode ?? 'off' }
    }
    case 'project.graphicsZ': {
      const value = requireEnumValue(params, 'value', ['aboveMedia', 'belowMedia'] as const)
      store.setGraphicsZ(value === 'belowMedia' ? 'belowMedia' : undefined)
      return { graphicsZ: value }
    }
    case 'project.undo': {
      useHistoryStore.getState().undo()
      return { undone: true }
    }
    case 'project.redo': {
      useHistoryStore.getState().redo()
      return { redone: true }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知工程命令：${command}`)
  }
}

async function handleMediaCommand(request: CliCommandRequest): Promise<unknown> {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'media.import': {
      const path = requireString(params, 'path')
      const probe = await window.socut.video.probe(path)
      if (!probe) throw mediaProbeFailure(path)
      const vfr = optionalEnum(params, 'vfr', ['none', 'raw', 'convert', 'reject'] as const) ?? 'reject'
      const outcome = await importMediaWithPolicy(
        { path, probe },
        {
          non169: optionalBoolean(params, 'ackNon169') === true ? 'accept' : 'reject',
          hdr: optionalBoolean(params, 'ackHdr') === true ? 'accept' : 'reject',
          vfr
        }
      )
      if (outcome.cancelled || !outcome.mediaId) throw gateCancelled()
      const mediaId = outcome.mediaId
      const name = optionalString(params, 'name')
      if (name) useProjectStore.getState().renameMedia(mediaId, name)
      const tags = optionalStringArray(params, 'tags')
      if (tags) useProjectStore.getState().setMediaTags(mediaId, tags)
      const binId = optionalString(params, 'binId')
      if (binId) useProjectStore.getState().assignMediaBin(mediaId, binId)
      return outcome
    }
    case 'media.list':
      return {
        media: store.project.media,
        bins: store.project.mediaBins ?? [],
        mediaTracks: store.project.mediaTracks,
        mediaClips: store.project.mediaClips
      }
    case 'media.remove': {
      const id = requireString(params, 'id')
      const removeClips = optionalBoolean(params, 'removeClips') !== false
      store.removeMedia(id, { removeClips })
      void window.socut.media.removeThumb(id).catch(() => undefined)
      void window.socut.media.removeProxy(id).catch(() => undefined)
      return { id, removeClips }
    }
    case 'media.relocate': {
      const id = requireString(params, 'id')
      const path = requireString(params, 'path')
      const probe = await window.socut.video.probe(path)
      if (!probe) throw mediaProbeFailure(path)
      store.relocateMedia(id, { path, meta: probe.meta })
      return { id, path, meta: probe.meta }
    }
    case 'media.rename':
      store.renameMedia(requireString(params, 'id'), requireString(params, 'name'))
      return { id: requireString(params, 'id') }
    case 'media.tags': {
      const id = requireString(params, 'id')
      const tags = requireStringArray(params, 'tags')
      store.setMediaTags(id, tags)
      return { id, tags }
    }
    case 'media.compactMode': {
      const id = requireString(params, 'id')
      const mode = requireEnumValue(params, 'mode', ['auto', 'compact', 'ultrawide', 'standard'] as const)
      store.setMediaCompactMode(id, mode)
      return { id, mode }
    }
    case 'media.vfrPolicy': {
      const id = requireString(params, 'id')
      const policy = requireEnumValue(params, 'policy', ['none', 'converted', 'raw'] as const)
      store.setMediaVfrPolicy(id, policy)
      return { id, policy }
    }
    case 'media.ackNon169': {
      const id = requireString(params, 'id')
      const value = requireBoolean(params, 'value')
      store.ackMediaNon169(id, value)
      return { id, value }
    }
    case 'media.ackHdr': {
      const id = requireString(params, 'id')
      const value = requireBoolean(params, 'value')
      store.ackMediaHdr(id, value)
      return { id, value }
    }
    case 'media.bin.add': {
      const id = store.addMediaBin(requireString(params, 'name'))
      if (!id) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '分组名为空或已达上限')
      return { id }
    }
    case 'media.bin.rename':
      store.renameMediaBin(requireString(params, 'id'), requireString(params, 'name'))
      return { id: requireString(params, 'id') }
    case 'media.bin.remove':
      store.removeMediaBin(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'media.bin.assign': {
      const id = requireString(params, 'id')
      const binId = params['binId'] === null ? null : optionalString(params, 'binId') ?? null
      store.assignMediaBin(id, binId)
      return { id, binId }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知素材命令：${command}`)
  }
}

function requireEnumValue<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T {
  const value = optionalString(params, key)
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `参数 ${key} 非法（可选：${allowed.join(' / ')}）`)
  }
  return value as T
}

async function handleSubtitleCommand(request: CliCommandRequest): Promise<unknown> {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'clip.add': {
      const at = optionalNumber(params, 'at')
      const id = store.addClip(at)
      const patch: Partial<Pick<SubtitleClip, 'content' | 'presetId' | 'fontId' | 'animation' | 'styleOverrides'>> = {}
      const content = optionalRecord(params, 'content')
      if (content) patch.content = content as unknown as SubtitleClip['content']
      const presetId = optionalString(params, 'presetId')
      if (presetId) patch.presetId = presetId as SubtitleClip['presetId']
      const fontId = optionalString(params, 'fontId')
      if (fontId) patch.fontId = fontId
      const animation = optionalRecord(params, 'animation')
      if (animation) patch.animation = animation as unknown as SubtitleClip['animation']
      const styleOverrides = optionalRecord(params, 'styleOverrides')
      if (styleOverrides) patch.styleOverrides = styleOverrides as unknown as SubtitleClip['styleOverrides']
      if (Object.keys(patch).length > 0) useProjectStore.getState().updateClip(id, patch)
      const duration = optionalNumber(params, 'duration')
      if (duration !== undefined) {
        const clip = useProjectStore.getState().project.clips.find((item) => item.id === id)
        if (clip) useProjectStore.getState().setClipTimes(id, clip.startTime, clip.startTime + duration)
      }
      return { id }
    }
    case 'clip.update': {
      const id = requireString(params, 'id')
      ensureSubtitleClip(id)
      useProjectStore
        .getState()
        .updateClip(id, requireRecord(params, 'patch') as unknown as Parameters<typeof store.updateClip>[1])
      return { id }
    }
    case 'clip.remove':
      store.removeClip(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'clip.duplicate': {
      const id = store.duplicateClipAction(requireString(params, 'id'))
      if (!id) throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, '源字幕条不存在')
      return { id }
    }
    case 'clip.select':
      store.selectClip(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'clip.split': {
      const id = optionalString(params, 'id')
      if (id) {
        ensureSubtitleClip(id)
        selectById('subtitle', id)
      }
      return { id: store.splitTargetAt(requireNumber(params, 'at')) }
    }
    case 'clip.applyStyleToAll': {
      const count = store.applyStyleToAll(requireString(params, 'id'))
      return { changed: count }
    }
    case 'clip.resetStyle':
      store.resetClipStyle(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'clip.setTimes':
      store.setClipTimes(
        requireString(params, 'id'),
        requireNumber(params, 'startTime'),
        requireNumber(params, 'endTime')
      )
      return { id: requireString(params, 'id') }
    case 'clip.keyframes': {
      const id = requireString(params, 'id')
      const raw = params['keyframes']
      if (raw !== null && !Array.isArray(raw)) {
        throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, 'keyframes 必须是数组或 null')
      }
      const tracks = raw === null ? undefined : (raw as never)
      // M6-E：媒体段与字幕条共用同一个命令（id 空间不重叠，先查媒体段）
      const media = useProjectStore.getState().project.mediaClips.find((item) => item.id === id)
      if (media) {
        useProjectStore.getState().setMediaClipKeyframes(id, tracks)
        const updated = useProjectStore.getState().project.mediaClips.find((item) => item.id === id)
        return { kind: 'media', id, keyframes: updated?.keyframes ?? null }
      }
      useProjectStore.getState().setClipKeyframes(id, tracks)
      const clip = useProjectStore.getState().project.clips.find((item) => item.id === id)
      if (!clip) throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `片段不存在：${id}`)
      return { kind: 'subtitle', id, keyframes: clip.keyframes ?? null }
    }
    case 'clip.key': {
      const id = requireString(params, 'id')
      const raw = params['key']
      useProjectStore.getState().setClipKey(id, raw === null ? undefined : (raw as never))
      const clip = useProjectStore.getState().project.mediaClips.find((item) => item.id === id)
      if (!clip) throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `媒体段不存在：${id}`)
      return { id, key: clip.key ?? null }
    }
    case 'clip.mask': {
      const id = requireString(params, 'id')
      const raw = params['mask']
      if (raw !== null && typeof raw !== 'object') {
        throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, 'mask 必须是对象或 null')
      }
      useProjectStore.getState().setMediaClipMask(id, raw === null ? undefined : (raw as never))
      const clip = useProjectStore.getState().project.mediaClips.find((item) => item.id === id)
      if (!clip) throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `媒体段不存在：${id}`)
      return { id, mask: clip.mask ?? null }
    }
    case 'clip.matte': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      const rawPath = params['path'] ?? null
      if (rawPath !== null && typeof rawPath !== 'string') {
        throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, 'path 必须是字符串或 null')
      }
      const target = typeof rawPath === 'string' ? rawPath.trim() : ''
      if (target.length === 0) {
        useProjectStore.getState().setMediaClipMatte(id, undefined)
      } else {
        // matte 只能引用绝对路径（与素材同一惯例）；主进程导出前还会再校验存在性
        if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(target)) {
          throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, 'matte path 必须是绝对路径')
        }
        const alive = await window.socut.video.exists(target)
        if (!alive) {
          throw new CliCommandError(CLI_ERROR_CODES.MEDIA_PROBE_FAILED, `matte 文件不可用：${target}`)
        }
        const explicitKind = params['kind']
        if (explicitKind !== undefined && explicitKind !== 'image' && explicitKind !== 'video') {
          throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, 'kind 只能是 "image" 或 "video"')
        }
        const kind = explicitKind ?? inferMatteKind(target)
        if (!kind) {
          throw new CliCommandError(
            CLI_ERROR_CODES.BAD_PARAMS,
            '无法根据扩展名判断 matte 类型，请显式传 kind: "image" | "video"'
          )
        }
        useProjectStore.getState().setMediaClipMatte(id, { path: target, kind })
      }
      const clip = useProjectStore.getState().project.mediaClips.find((item) => item.id === id)
      return { id, mattePath: clip?.mattePath ?? null, matteKind: clip?.matteKind ?? null }
    }
    case 'clip.keyframes.reset': {
      const id = requireString(params, 'id')
      const media = useProjectStore.getState().project.mediaClips.find((item) => item.id === id)
      if (media) useProjectStore.getState().setMediaClipKeyframes(id, undefined)
      else useProjectStore.getState().setClipKeyframes(id, undefined)
      return { kind: media ? 'media' : 'subtitle', id, keyframes: null }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知字幕命令：${command}`)
  }
}

async function handleTimelineMediaCommand(request: CliCommandRequest): Promise<unknown> {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'timeline.media.insert': {
      const clip = store.insertMediaClip({
        mediaId: requireString(params, 'mediaId'),
        timelineStartSec: requireNumber(params, 'at'),
        ...(optionalNumber(params, 'duration') !== undefined
          ? { durationSec: optionalNumber(params, 'duration') }
          : {}),
        ...(optionalNumber(params, 'sourceIn') !== undefined ? { sourceInSec: optionalNumber(params, 'sourceIn') } : {}),
        ...(optionalString(params, 'trackId') ? { trackId: optionalString(params, 'trackId') } : {})
      })
      if (!clip) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '插入失败：素材不存在/轨道锁定/落点不可用')
      return { clip }
    }
    case 'timeline.media.move': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      store.moveMediaClip(id, requireNumber(params, 'at'), optionalString(params, 'trackId'))
      return { id }
    }
    case 'timeline.media.trim': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      store.trimMediaClip(id, {
        ...(optionalNumber(params, 'start') !== undefined ? { timelineStartSec: optionalNumber(params, 'start') } : {}),
        ...(optionalNumber(params, 'end') !== undefined ? { timelineEndSec: optionalNumber(params, 'end') } : {})
      })
      return { id }
    }
    case 'timeline.media.remove':
      store.removeMediaClip(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'timeline.media.split': {
      const id = optionalString(params, 'id')
      if (id) {
        ensureMediaClip(id)
        selectById('media', id)
      }
      return { id: store.splitTargetAt(requireNumber(params, 'at')) }
    }
    case 'timeline.media.select':
      store.selectMediaClip(params['id'] === null ? null : optionalString(params, 'id') ?? null)
      return { id: params['id'] ?? null }
    case 'timeline.media.removeSelected':
      return { removed: store.removeSelected() }
    case 'timeline.media.removeAt':
      return { removed: store.removeTargetAt(requireNumber(params, 'at')) }
    case 'timeline.compact':
      store.compactTimeline()
      return { mediaClips: useProjectStore.getState().project.mediaClips }
    case 'timeline.media.rippleDelete': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      if (!store.rippleDeleteMediaClip(id)) {
        throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '波纹删除失败：片段不存在或所属轨道已锁定')
      }
      return { removed: id, mediaClips: useProjectStore.getState().project.mediaClips }
    }
    case 'timeline.media.mergeNext': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      if (!store.mergeMediaClipWithNext(id)) {
        throw new CliCommandError(
          CLI_ERROR_CODES.BAD_PARAMS,
          '合并失败：需要同轨相邻片段、同一素材、源区间连续且画面/音频参数一致'
        )
      }
      return { id, mediaClips: useProjectStore.getState().project.mediaClips }
    }
    case 'timeline.media.freeze': {
      const at = requireNumber(params, 'at')
      const id = optionalString(params, 'id')
      const duration = optionalNumber(params, 'duration')
      const freezeId = await store.freezeFrameAt(at, {
        ...(id ? { clipId: id } : {}),
        ...(duration !== undefined ? { durationSec: duration } : {})
      })
      if (!freezeId) {
        throw new CliCommandError(
          CLI_ERROR_CODES.BAD_PARAMS,
          '冻结帧失败：切点不在媒体段内 / 轨道已锁定 / 源文件不可读或 FFmpeg 不可用'
        )
      }
      return { id: freezeId, mediaClips: useProjectStore.getState().project.mediaClips }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知时间轴命令：${command}`)
  }
}

function handleClipEffectCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'clip.video': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      store.updateMediaClipVideo(id, requireRecord(params, 'patch') as unknown as Partial<MediaClipVideo>)
      return { id }
    }
    case 'clip.video.reset':
      store.resetMediaClipVideo(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'clip.stab': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      store.updateMediaClipStab(id, requireRecord(params, 'patch') as unknown as Partial<MediaClipStab>)
      return { id }
    }
    case 'clip.audio': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      store.updateMediaClipAudio(id, requireRecord(params, 'patch') as unknown as Partial<ClipAudio>)
      return { id }
    }
    case 'clip.speed': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      store.updateMediaClipSpeed(id, requireRecord(params, 'patch') as unknown as Partial<ClipSpeed>)
      return { id }
    }
    case 'clip.transition': {
      const id = requireString(params, 'id')
      ensureMediaClip(id)
      const transition = params['transition']
      store.setMediaClipTransition(
        id,
        transition === null ? null : (transition as MediaClipTransition | undefined) ?? null
      )
      return { id }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知片段效果命令：${command}`)
  }
}

function handleTimelineAudioCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'timeline.audio.insert': {
      const clip = store.insertAudioClip({
        mediaId: requireString(params, 'mediaId'),
        timelineStartSec: requireNumber(params, 'at'),
        ...(optionalNumber(params, 'duration') !== undefined
          ? { durationSec: optionalNumber(params, 'duration') }
          : {}),
        ...(optionalNumber(params, 'sourceIn') !== undefined ? { sourceInSec: optionalNumber(params, 'sourceIn') } : {}),
        ...(optionalString(params, 'trackId') ? { trackId: optionalString(params, 'trackId') } : {})
      })
      if (!clip) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '插入失败：素材不存在/轨道锁定/落点不可用')
      return { clip }
    }
    case 'timeline.audio.move': {
      const id = requireString(params, 'id')
      ensureAudioClip(id)
      store.moveAudioClip(id, requireNumber(params, 'at'), optionalString(params, 'trackId'))
      return { id }
    }
    case 'timeline.audio.trim': {
      const id = requireString(params, 'id')
      ensureAudioClip(id)
      store.trimAudioClip(id, {
        ...(optionalNumber(params, 'start') !== undefined ? { timelineStartSec: optionalNumber(params, 'start') } : {}),
        ...(optionalNumber(params, 'end') !== undefined ? { timelineEndSec: optionalNumber(params, 'end') } : {})
      })
      return { id }
    }
    case 'timeline.audio.remove':
      store.removeAudioClip(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'timeline.audio.split': {
      const id = optionalString(params, 'id')
      if (id) {
        ensureAudioClip(id)
        selectById('audio', id)
      }
      return { id: store.splitTargetAt(requireNumber(params, 'at')) }
    }
    case 'timeline.audio.select':
      store.selectAudioClip(params['id'] === null ? null : optionalString(params, 'id') ?? null)
      return { id: params['id'] ?? null }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知音频时间轴命令：${command}`)
  }
}

function handleAudioEffectCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()
  const id = requireString(params, 'id')

  switch (command) {
    case 'audio.fx':
      ensureAudioClip(id)
      store.updateAudioClipAudio(id, requireRecord(params, 'patch') as unknown as Partial<ClipAudio>)
      return { id }
    case 'audio.speed':
      ensureAudioClip(id)
      store.updateAudioClipSpeed(id, requireRecord(params, 'patch') as unknown as Partial<ClipSpeed>)
      return { id }
    case 'audio.role':
      ensureAudioClip(id)
      store.updateAudioClipRole(id, requireEnumValue(params, 'role', ['voice', 'bgm'] as const))
      return { id }
    case 'audio.ducking': {
      ensureAudioClip(id)
      const level = optionalEnum(params, 'level', ['light', 'standard', 'strong'] as const)
      store.updateAudioClipDucking(id, level)
      return { id, level: level ?? null }
    }
    case 'audio.reset':
      store.resetAudioClipFx(id)
      return { id }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知音频效果命令：${command}`)
  }
}

function handleTrackCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'track.addMedia': {
      const id = store.addMediaTrack()
      if (!id) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '媒体轨已达上限')
      return { id }
    }
    case 'track.addAudio': {
      const id = store.addAudioTrack()
      if (!id) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '音频轨已达上限')
      return { id }
    }
    case 'track.removeMedia':
      store.removeMediaTrack(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'track.removeAudio':
      store.removeAudioTrack(requireString(params, 'id'))
      return { id: requireString(params, 'id') }
    case 'track.moveMedia':
      store.moveMediaTrack(requireString(params, 'id'), requireNumber(params, 'toIndex'))
      return { id: requireString(params, 'id') }
    case 'track.moveAudio':
      store.moveAudioTrack(requireString(params, 'id'), requireNumber(params, 'toIndex'))
      return { id: requireString(params, 'id') }
    case 'track.rename':
      store.renameTrack(requireString(params, 'id'), requireString(params, 'name'))
      return { id: requireString(params, 'id') }
    case 'track.mute':
      store.setTrackMuted(requireString(params, 'id'), requireBoolean(params, 'muted'))
      return { id: requireString(params, 'id') }
    case 'track.hidden':
      store.setTrackHidden(requireString(params, 'id'), requireBoolean(params, 'hidden'))
      return { id: requireString(params, 'id') }
    case 'track.locked':
      store.setTrackLocked(requireString(params, 'id'), requireBoolean(params, 'locked'))
      return { id: requireString(params, 'id') }
    case 'track.select':
      store.selectTrack(params['id'] === null ? null : optionalString(params, 'id') ?? null)
      return { id: params['id'] ?? null }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知轨道命令：${command}`)
  }
}

async function handleWatermarkCommand(request: CliCommandRequest): Promise<unknown> {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'watermark.set': {
      const path = requireString(params, 'path')
      const size =
        optionalNumber(params, 'sourceWidth') !== undefined && optionalNumber(params, 'sourceHeight') !== undefined
          ? {
              width: optionalNumber(params, 'sourceWidth') as number,
              height: optionalNumber(params, 'sourceHeight') as number
            }
          : await window.socut.watermark.probe(path)
      const settings: WatermarkSettings = {
        enabled: optionalBoolean(params, 'enabled') !== false,
        path,
        name: basename(path),
        sourceWidth: size.width,
        sourceHeight: size.height,
        importedAt: new Date().toISOString()
      }
      store.setWatermark(settings)
      return settings
    }
    case 'watermark.enable':
      store.setWatermarkEnabled(requireBoolean(params, 'enabled'))
      return { enabled: requireBoolean(params, 'enabled') }
    case 'watermark.remove':
      store.setWatermark(null)
      return { removed: true }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知水印命令：${command}`)
  }
}

async function handleExportCommand(request: CliCommandRequest): Promise<unknown> {
  const { command, params } = request

  switch (command) {
    case 'export.start': {
      const kind = requireEnumValue(params, 'kind', ['overlayMp4', 'transparentMov', 'pngSequence'] as const)
      const result = await runExport(
        {
          kind,
          outputDir: requireString(params, 'outputDir'),
          fileName: requireString(params, 'fileName'),
          ...(optionalEnum(params, 'pipeTransport', ['raw', 'png'] as const)
            ? { pipeTransport: optionalEnum(params, 'pipeTransport', ['raw', 'png'] as const) }
            : {}),
          ...(optionalEnum(params, 'codec', ['prores4444', 'qtrle'] as const)
            ? { codec: optionalEnum(params, 'codec', ['prores4444', 'qtrle'] as const) }
            : {}),
          ...(optionalRecord(params, 'canvas')
            ? { canvas: optionalRecord(params, 'canvas') as unknown as ExportCanvasSelection }
            : {}),
          ...(optionalEnum(params, 'quality', ['high', 'standard', 'small'] as const)
            ? { quality: optionalEnum(params, 'quality', ['high', 'standard', 'small'] as const) }
            : {}),
          // M9：编码交付参数（缺省不落键）
          ...(optionalEnum(params, 'videoCodec', ['avc', 'hevc', 'av1'] as const)
            ? { videoCodec: optionalEnum(params, 'videoCodec', ['avc', 'hevc', 'av1'] as const) }
            : {}),
          ...(optionalNumber(params, 'crf') !== undefined ? { crf: optionalNumber(params, 'crf') } : {}),
          ...(optionalString(params, 'encoderPreset') ? { encoderPreset: optionalString(params, 'encoderPreset') } : {}),
          ...(optionalNumber(params, 'bitDepth') !== undefined
            ? { bitDepth: optionalNumber(params, 'bitDepth') === 10 ? (10 as const) : (8 as const) }
            : {}),
          ...(optionalEnum(params, 'colorRange', ['limited', 'full'] as const)
            ? { colorRange: optionalEnum(params, 'colorRange', ['limited', 'full'] as const) }
            : {})
        },
        { autoConfirm: true }
      )
      return result
    }
    case 'export.cover': {
      const selection =
        (optionalRecord(params, 'canvas') as unknown as ExportCanvasSelection | undefined) ?? {
          kind: 'landscape' as const
        }
      const atSec = optionalNumber(params, 'atSec')
      return runCoverExport({
        outputDir: requireString(params, 'outputDir'),
        selection,
        ...(atSec !== undefined ? { atSec } : {})
      })
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知导出命令：${command}`)
  }
}

/**
 * M10：渲染一帧 PNG（base64）给 Agent 看。
 * 走生产同一条 `buildRenderJob → renderJobToPngBlob`（字幕条 + 文本元素 + 关键帧都在里面），
 * 不落盘、不触发导出队列；大图（4K）由调用方自己限制 `maxWidth` 后再缩放。
 */
async function handlePreviewCommand(request: CliCommandRequest): Promise<unknown> {
  const { params } = request
  const state = useProjectStore.getState()
  const atSec = optionalNumber(params, 'at') ?? useUiStore.getState().displayTimeSec
  const spec = await buildRenderJob({
    project: state.project,
    fontIndex: state.fonts,
    scope: { kind: 'timeline' }
  })
  const lastFrame = Math.max(spec.startFrame, spec.endFrame - 1)
  const frame = Math.min(Math.max(spec.startFrame, timeToFrameFloor(atSec, spec.fps)), lastFrame)
  const blob = await renderJobToPngBlob(spec, frame)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return {
    pngBase64: bytesToBase64(bytes),
    width: spec.width,
    height: spec.height,
    frame,
    atSec: frameTimeSec(frame, spec.fps),
    bytes: bytes.length
  }
}

function handleCaptionCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'caption.import': {
      const raw = params['cues']
      if (!Array.isArray(raw)) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, 'cues 必须是数组')
      const cues = raw.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return []
        const record = item as Record<string, unknown>
        if (typeof record['text'] !== 'string') return []
        const startSec = Number(record['startSec'])
        const endSec = Number(record['endSec'])
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return []
        return [{ startSec, endSec, text: record['text'] }]
      })
      const presetId = optionalString(params, 'presetId')
      const replace = params['replace'] === true
      const added = store.addCaptionsFromCues(cues, {
        ...(replace ? { replace: true } : {}),
        ...(presetId ? { presetId: presetId as PresetId } : {})
      })
      return { added, replace, skipped: raw.length - cues.length }
    }
    case 'caption.batch': {
      const text = requireString(params, 'text')
      const format = optionalEnum(params, 'format', ['csv', 'json', 'lines', 'auto'] as const) ?? 'auto'
      const report = parseCaptionRows(text, format)
      const startSec = optionalNumber(params, 'startSec')
      const defaultDuration = optionalNumber(params, 'defaultDuration')
      const gap = optionalNumber(params, 'gap')
      const presetId = optionalString(params, 'presetId')
      const added = store.addCaptionBatch(report.rows, {
        ...(startSec !== undefined ? { startSec } : {}),
        ...(defaultDuration !== undefined ? { defaultDurationSec: defaultDuration } : {}),
        ...(gap !== undefined ? { gapSec: gap } : {}),
        ...(presetId ? { presetId: presetId as PresetId } : {})
      })
      return { added, dropped: report.dropped, parsed: report.rows.length }
    }
    case 'caption.export': {
      const format = requireEnumValue(params, 'format', ['srt', 'ass'] as const)
      const clips = useProjectStore.getState().project.clips
      const cues = cuesFromClips(clips)
      return {
        format,
        count: cues.length,
        text: format === 'ass' ? formatAss(cues, { title: useProjectStore.getState().project.name }) : formatSrt(cues)
      }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知字幕命令：${command}`)
  }
}

function handleTextCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'text.presets':
      return {
        presets: TEXT_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, sampleText: preset.sampleText }))
      }
    case 'text.list':
      return { textClips: useProjectStore.getState().project.textClips ?? [] }
    case 'text.add': {
      const presetId = optionalString(params, 'presetId')
      if (presetId !== undefined && !isTextPresetId(presetId)) {
        throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, `未知文本预设：${presetId}`)
      }
      const at = optionalNumber(params, 'at')
      const duration = optionalNumber(params, 'duration')
      const text = optionalString(params, 'text')
      const clip = store.addTextClip({
        ...(at !== undefined ? { at } : {}),
        ...(duration !== undefined ? { durationSec: duration } : {}),
        ...(presetId !== undefined && isTextPresetId(presetId) ? { presetId } : {}),
        ...(text !== undefined ? { text } : {})
      })
      if (!clip) throw new CliCommandError(CLI_ERROR_CODES.INTERNAL, '新增文本元素失败')
      return { clip }
    }
    case 'text.update': {
      const id = requireString(params, 'id')
      const patch = requireRecord(params, 'patch')
      useProjectStore.getState().updateTextClip(id, patch as never)
      const clip = (useProjectStore.getState().project.textClips ?? []).find((item) => item.id === id)
      if (!clip) throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `文本元素不存在：${id}`)
      return { clip }
    }
    case 'text.remove': {
      const id = requireString(params, 'id')
      useProjectStore.getState().removeTextClip(id)
      return { id }
    }
    case 'text.select': {
      const id = params['id'] === null ? null : (optionalString(params, 'id') ?? null)
      useProjectStore.getState().selectTextClip(id)
      return { id }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知文本命令：${command}`)
  }
}

function handleSequenceCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const store = useProjectStore.getState()

  switch (command) {
    case 'sequence.list':
      return { sequences: sequenceSummaries(useProjectStore.getState().project) }
    case 'sequence.add': {
      const id = store.addSequence(optionalString(params, 'name'))
      if (!id) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '新建序列失败：已达序列数量上限')
      return { id, sequences: sequenceSummaries(useProjectStore.getState().project) }
    }
    case 'sequence.select': {
      const id = requireString(params, 'id')
      if (!store.selectSequence(id)) {
        throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `序列不存在或已是当前序列：${id}`)
      }
      return { id, sequences: sequenceSummaries(useProjectStore.getState().project) }
    }
    case 'sequence.rename': {
      const id = requireString(params, 'id')
      if (!store.renameSequence(id, requireString(params, 'name'))) {
        throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '重命名失败：序列不存在或名字为空')
      }
      return { id, sequences: sequenceSummaries(useProjectStore.getState().project) }
    }
    case 'sequence.remove': {
      const id = requireString(params, 'id')
      if (!store.removeSequence(id)) {
        throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '删除失败：序列不存在或只剩一条序列')
      }
      return { id, sequences: sequenceSummaries(useProjectStore.getState().project) }
    }
    case 'sequence.duplicate': {
      const id = store.duplicateSequence(optionalString(params, 'id'), optionalString(params, 'name'))
      if (!id) throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, '复制序列失败：源序列不存在或已达数量上限')
      return { id, sequences: sequenceSummaries(useProjectStore.getState().project) }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知序列命令：${command}`)
  }
}

function handleUiCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const ui = useUiStore.getState()

  switch (command) {
    case 'ui.set': {
      const view = optionalEnum(params, 'view', ['launcher', 'editor', 'settings'] as const)
      if (view) ui.setView(view)
      const leftTab = optionalEnum(params, 'leftTab', ['media', 'transition', 'wrap', 'export', 'progress'] as const)
      if (leftTab) ui.setLeftTab(leftTab)
      const scope = optionalEnum(params, 'exportScope', ['timeline', 'selected'] as const)
      if (scope) ui.setExportScope(scope)
      return { view: view ?? ui.view, leftTab: leftTab ?? ui.leftTab, exportScope: scope ?? ui.exportScope }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知 UI 命令：${command}`)
  }
}

/** M8-P1：AI 人像抠像（生成 matte 并挂到媒体段；进度/结果走 job 事件，本命令等到结束）。 */
async function handleAiMatteCommand(request: CliCommandRequest): Promise<unknown> {
  const { command, params } = request
  if (command === 'ai.matte.status') return window.socut.aiMatte.status()
  if (command !== 'ai.matte') {
    throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知 AI 命令：${command}`)
  }
  const id = requireString(params, 'id')
  ensureMediaClip(id)
  const project = useProjectStore.getState().project
  const clip = project.mediaClips.find((item) => item.id === id)!
  const media = project.media.find((item) => item.id === clip.mediaId)
  if (!media) throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `素材不存在：${clip.mediaId}`)
  if (Math.abs((clip.speed?.speed ?? 1) - 1) > 1e-9) {
    throw new CliCommandError(CLI_ERROR_CODES.BAD_PARAMS, 'AI 抠像暂不支持变速片段')
  }
  const queued = await window.socut.aiMatte.generate({
    clipId: id,
    sourcePath: media.path,
    sourceInSec: clip.sourceInSec,
    sourceOutSec: clip.sourceOutSec,
    fps: project.fps,
    sourceWidth: media.meta.width,
    sourceHeight: media.meta.height
  })
  let mattePath = queued.path
  if (queued.status !== 'cached' || !mattePath) {
    const result = await waitForResult(queued.jobId)
    if (!result.ok || !result.outputPath) {
      throw new CliCommandError(CLI_ERROR_CODES.INTERNAL, result.error?.message ?? 'AI 抠像失败')
    }
    mattePath = result.outputPath
  }
  useProjectStore.getState().setMediaClipMatte(id, { path: mattePath, kind: 'video' })
  return { id, jobId: queued.jobId, mattePath, cached: queued.status === 'cached' }
}

export async function handleCliCommand(request: CliCommandRequest): Promise<unknown> {  if (request.command === 'app.info' || request.command === 'app.health' || request.command === 'app.commands') {
    // app.* 正常由主进程直接处理；走到这里说明主机分派缺失，给出可诊断错误
    throw new CliCommandError(CLI_ERROR_CODES.INTERNAL, 'app.* 应由主进程处理')
  }
  if (request.command.startsWith('project.')) return handleProjectCommand(request)
  if (request.command.startsWith('media.')) return handleMediaCommand(request)
  if (request.command.startsWith('watermark.')) return handleWatermarkCommand(request)
  if (request.command.startsWith('clip.')) {
    // clip.video / clip.stab / clip.audio / clip.speed / clip.transition 属于媒体段效果
    if (
      request.command === 'clip.video' ||
      request.command === 'clip.video.reset' ||
      request.command === 'clip.stab' ||
      request.command === 'clip.audio' ||
      request.command === 'clip.speed' ||
      request.command === 'clip.transition'
    ) {
      return handleClipEffectCommand(request)
    }
    return handleSubtitleCommand(request)
  }
  if (request.command.startsWith('ai.')) return handleAiMatteCommand(request)
  if (request.command.startsWith('timeline.media.')) return handleTimelineMediaCommand(request)
  if (request.command.startsWith('timeline.audio.')) return handleTimelineAudioCommand(request)
  if (request.command === 'timeline.compact') return handleTimelineMediaCommand(request)
  if (request.command.startsWith('audio.')) return handleAudioEffectCommand(request)
  if (request.command.startsWith('track.')) return handleTrackCommand(request)
  if (request.command.startsWith('caption.')) return handleCaptionCommand(request)
  if (request.command.startsWith('text.')) return handleTextCommand(request)
  if (request.command.startsWith('sequence.')) return handleSequenceCommand(request)
  if (request.command.startsWith('export.')) return handleExportCommand(request)
  if (request.command === 'preview.frame') return handlePreviewCommand(request)
  if (request.command.startsWith('ui.')) return handleUiCommand(request)
  throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知命令：${request.command}`)
}

/** main.tsx 挂载：注册路由并回放 preload 期间排队的命令。 */
export function installCliCommandRouter(): () => void {
  return window.socut.cli.onCommand((request) => {
    void handleCliCommand(request)
      .then((result) => {
        const response: CliResponse = { ok: true, result }
        window.socut.cli.respond(request.id, response)
      })
      .catch((error: unknown) => {
        const info =
          error instanceof GateError
            ? { code: CLI_ERROR_CODES.GATE_BLOCKED, message: error.message }
            : toCliErrorInfo(error)
        window.socut.cli.respond(request.id, { ok: false, error: info })
      })
  })
}
