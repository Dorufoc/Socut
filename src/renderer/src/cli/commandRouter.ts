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
  SubtitleClip,
  WatermarkSettings
} from '@shared/types'
import { runCoverExport } from '../render/coverRunner'
import { runExport, GateError } from '../render/exportRunner'
import { importMediaWithPolicy } from '../hooks/useVideoImport'
import { useHistoryStore } from '../state/projectHistory'
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
      return window.focusnews.project.writeToPath(target, store.project).then((saved) => {
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
      const probe = await window.focusnews.video.probe(path)
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
      void window.focusnews.media.removeThumb(id).catch(() => undefined)
      void window.focusnews.media.removeProxy(id).catch(() => undefined)
      return { id, removeClips }
    }
    case 'media.relocate': {
      const id = requireString(params, 'id')
      const path = requireString(params, 'path')
      const probe = await window.focusnews.video.probe(path)
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

function handleSubtitleCommand(request: CliCommandRequest): unknown {
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
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知字幕命令：${command}`)
  }
}

function handleTimelineMediaCommand(request: CliCommandRequest): unknown {
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
          : await window.focusnews.watermark.probe(path)
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
          ...(optionalEnum(params, 'frameDelivery', ['pipe', 'pngSequence'] as const)
            ? { frameDelivery: optionalEnum(params, 'frameDelivery', ['pipe', 'pngSequence'] as const) }
            : {}),
          ...(optionalEnum(params, 'pipeTransport', ['raw', 'png'] as const)
            ? { pipeTransport: optionalEnum(params, 'pipeTransport', ['raw', 'png'] as const) }
            : {}),
          ...(optionalEnum(params, 'codec', ['prores4444', 'qtrle'] as const)
            ? { codec: optionalEnum(params, 'codec', ['prores4444', 'qtrle'] as const) }
            : {}),
          ...(optionalBoolean(params, 'directPipe') !== undefined
            ? { directPipe: optionalBoolean(params, 'directPipe') }
            : {}),
          ...(optionalRecord(params, 'canvas')
            ? { canvas: optionalRecord(params, 'canvas') as unknown as ExportCanvasSelection }
            : {}),
          ...(optionalEnum(params, 'quality', ['high', 'standard', 'small'] as const)
            ? { quality: optionalEnum(params, 'quality', ['high', 'standard', 'small'] as const) }
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

function handleUiCommand(request: CliCommandRequest): unknown {
  const { command, params } = request
  const ui = useUiStore.getState()

  switch (command) {
    case 'ui.set': {
      const view = optionalEnum(params, 'view', ['launcher', 'editor', 'settings'] as const)
      if (view) ui.setView(view)
      const leftTab = optionalEnum(params, 'leftTab', ['media', 'wrap', 'export', 'progress'] as const)
      if (leftTab) ui.setLeftTab(leftTab)
      const scope = optionalEnum(params, 'exportScope', ['timeline', 'selected'] as const)
      if (scope) ui.setExportScope(scope)
      return { view: view ?? ui.view, leftTab: leftTab ?? ui.leftTab, exportScope: scope ?? ui.exportScope }
    }
    default:
      throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知 UI 命令：${command}`)
  }
}

export async function handleCliCommand(request: CliCommandRequest): Promise<unknown> {
  if (request.command === 'app.info' || request.command === 'app.health' || request.command === 'app.commands') {
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
  if (request.command.startsWith('timeline.media.')) return handleTimelineMediaCommand(request)
  if (request.command.startsWith('timeline.audio.')) return handleTimelineAudioCommand(request)
  if (request.command === 'timeline.compact') return handleTimelineMediaCommand(request)
  if (request.command.startsWith('audio.')) return handleAudioEffectCommand(request)
  if (request.command.startsWith('track.')) return handleTrackCommand(request)
  if (request.command.startsWith('export.')) return handleExportCommand(request)
  if (request.command.startsWith('ui.')) return handleUiCommand(request)
  throw new CliCommandError(CLI_ERROR_CODES.NOT_FOUND, `未知命令：${request.command}`)
}

/** main.tsx 挂载：注册路由并回放 preload 期间排队的命令。 */
export function installCliCommandRouter(): () => void {
  return window.focusnews.cli.onCommand((request) => {
    void handleCliCommand(request)
      .then((result) => {
        const response: CliResponse = { ok: true, result }
        window.focusnews.cli.respond(request.id, response)
      })
      .catch((error: unknown) => {
        const info =
          error instanceof GateError
            ? { code: CLI_ERROR_CODES.GATE_BLOCKED, message: error.message }
            : toCliErrorInfo(error)
        window.focusnews.cli.respond(request.id, { ok: false, error: info })
      })
  })
}
