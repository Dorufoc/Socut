import { DEFAULT_SEQUENCE_ID, DEFAULT_SEQUENCE_NAME, MAX_SEQUENCES } from './constants'
import { makeAudioTrack, makeMediaTrack, makeSubtitleTrack } from './tracks'
import type { Project, SequenceSnapshot } from './types'

/**
 * v4 多序列（一个工程多段剪辑）纯函数。
 *
 * 核心口径（见 `SequenceSnapshot` 注释）：**活动序列的内容就是 Project 的平铺字段**，
 * `Project.sequences` 只存非活动序列快照。因此：
 * - 预览/导出/CLI/测试等既有消费面读 `project.clips`/`mediaClips`/`mediaTracks` 时，
 *   拿到的永远是"当前正在编辑的那一条序列"，零改动；
 * - 切换序列 = 把平铺字段打包成快照 → 放回 `sequences` → 把目标快照摊回平铺字段。
 *
 * 三条纪律：
 * 1. **默认序列不落盘**：`activeSequenceId === DEFAULT_SEQUENCE_ID` 时删掉该键、
 *    `activeSequenceName === DEFAULT_SEQUENCE_NAME` 时删掉该键（工程 JSON 对单序列工程逐字节不变）；
 * 2. **任何切换都保持"活动序列不在 sequences 数组里"**（避免双份真相）；
 * 3. 纯函数：不改入参，返回新对象；id 生成走本模块内部（不 import projectSchema，避免循环依赖）。
 */

/** 序列名上限（与轨道名同口径，避免侧栏被超长名字撑开） */
export const SEQUENCE_NAME_MAX_LENGTH = 40

let sequenceIdSequence = 0

/** 新序列 id：前缀 + 时间戳 + 递增序号（与 projectSchema.createId 同风格，但不引入循环依赖）。 */
export function createSequenceId(): string {
  sequenceIdSequence = (sequenceIdSequence + 1) % 4096
  return `seq-${Date.now().toString(36)}-${sequenceIdSequence.toString(36)}`
}

/** 序列名归一：trim + 限长；空名回退到调用方给的缺省。 */
export function normalizeSequenceName(name: unknown, fallback: string): string {
  if (typeof name !== 'string') return fallback
  const trimmed = name.trim().slice(0, SEQUENCE_NAME_MAX_LENGTH).trim()
  return trimmed.length > 0 ? trimmed : fallback
}

export function activeSequenceId(project: Project): string {
  const id = project.activeSequenceId
  return typeof id === 'string' && id.length > 0 ? id : DEFAULT_SEQUENCE_ID
}

export function activeSequenceName(project: Project): string {
  const name = project.activeSequenceName
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : DEFAULT_SEQUENCE_NAME
}

/** 非活动序列快照（按工程里保存的顺序）。 */
export function inactiveSequences(project: Project): SequenceSnapshot[] {
  return Array.isArray(project.sequences) ? project.sequences : []
}

/** 把活动序列（平铺字段）打包成快照；不修改工程。 */
export function activeSequence(project: Project): SequenceSnapshot {
  return {
    id: activeSequenceId(project),
    name: activeSequenceName(project),
    clips: project.clips,
    mediaClips: project.mediaClips,
    mediaTracks: project.mediaTracks,
    audioTracks: project.audioTracks,
    subtitleTrack: project.subtitleTrack,
    ...(project.audioClips && project.audioClips.length > 0 ? { audioClips: project.audioClips } : {}),
    ...(project.textClips && project.textClips.length > 0 ? { textClips: project.textClips } : {}),
    ...(project.graphicsZ ? { graphicsZ: project.graphicsZ } : {})
  }
}

/** 全部序列（活动序列排第一）。UI 序列下拉与 CLI 列表都读它。 */
export function allSequences(project: Project): SequenceSnapshot[] {
  return [activeSequence(project), ...inactiveSequences(project)]
}

export function findSequence(project: Project, id: string): SequenceSnapshot | null {
  if (id === activeSequenceId(project)) return activeSequence(project)
  return inactiveSequences(project).find((sequence) => sequence.id === id) ?? null
}

/** 序列摘要（UI 下拉 / CLI 列表用；不参与渲染）。 */
export interface SequenceSummary {
  id: string
  name: string
  active: boolean
  clipCount: number
  mediaClipCount: number
  durationSec: number
}

export function sequenceSummaries(project: Project): SequenceSummary[] {
  return allSequences(project).map((sequence) => {
    const clipEnd = sequence.clips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
    const mediaEnd = sequence.mediaClips.reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
    const audioEnd = (sequence.audioClips ?? []).reduce((acc, clip) => Math.max(acc, clip.timelineEndSec), 0)
    return {
      id: sequence.id,
      name: sequence.name,
      active: sequence.id === activeSequenceId(project),
      clipCount: sequence.clips.length,
      mediaClipCount: sequence.mediaClips.length,
      durationSec: Math.max(clipEnd, mediaEnd, audioEnd)
    }
  })
}

/** 写回活动序列 id/名字：等于默认值时删键（单序列工程 JSON 不变）。 */
function withActiveMeta(project: Project, id: string, name: string): Project {
  const next: Project = { ...project }
  if (id === DEFAULT_SEQUENCE_ID) delete next.activeSequenceId
  else next.activeSequenceId = id
  if (name === DEFAULT_SEQUENCE_NAME) delete next.activeSequenceName
  else next.activeSequenceName = name
  return next
}

/** 把一份快照摊回平铺字段（活动序列内容），并维护"活动不在 sequences 里"的不变量。 */
function loadSequence(
  project: Project,
  snapshot: SequenceSnapshot,
  remaining: SequenceSnapshot[]
): Project {
  const next: Project = {
    ...project,
    clips: snapshot.clips,
    mediaClips: snapshot.mediaClips,
    mediaTracks: snapshot.mediaTracks,
    audioTracks: snapshot.audioTracks,
    subtitleTrack: snapshot.subtitleTrack
  }
  if (snapshot.audioClips && snapshot.audioClips.length > 0) next.audioClips = snapshot.audioClips
  else delete next.audioClips
  if (snapshot.textClips && snapshot.textClips.length > 0) next.textClips = snapshot.textClips
  else delete next.textClips
  if (snapshot.audioMastering) next.audioMastering = snapshot.audioMastering
  else delete next.audioMastering
  if (snapshot.graphicsZ) next.graphicsZ = snapshot.graphicsZ
  else delete next.graphicsZ
  const withMeta = withActiveMeta(next, snapshot.id, normalizeSequenceName(snapshot.name, DEFAULT_SEQUENCE_NAME))
  const sequences = remaining.filter((sequence) => sequence.id !== snapshot.id)
  if (sequences.length > 0) withMeta.sequences = sequences
  else delete withMeta.sequences
  return withMeta
}

/**
 * 切换序列。`targetId` 不存在或就是当前活动序列时返回 null / 原工程。
 * 返回 null 表示没有该序列；id 相同返回原对象（调用方可据此判断"无需变更"）。
 */
export function switchSequence(project: Project, targetId: string): Project | null {
  const currentId = activeSequenceId(project)
  if (targetId === currentId) return project
  const target = inactiveSequences(project).find((sequence) => sequence.id === targetId)
  if (!target) return null
  const current = activeSequence(project)
  const remaining = inactiveSequences(project).filter((sequence) => sequence.id !== targetId)
  return loadSequence(project, target, [...remaining, current])
}

/** 新建一条空序列（不切换）。达到 `MAX_SEQUENCES` 时返回 null。 */
export function addSequence(project: Project, name?: string): { project: Project; id: string } | null {
  const sequences = inactiveSequences(project)
  if (sequences.length + 1 >= MAX_SEQUENCES) return null
  const id = createSequenceId()
  const fallbackName = `序列 ${sequences.length + 2}`
  const snapshot: SequenceSnapshot = {
    id,
    name: normalizeSequenceName(name, fallbackName),
    clips: [],
    mediaClips: [],
    mediaTracks: [makeMediaTrack(0)],
    audioTracks: [makeAudioTrack(0)],
    subtitleTrack: makeSubtitleTrack()
  }
  const next: Project = { ...project, sequences: [...sequences, snapshot] }
  return { project: next, id }
}

/** 删除序列；只剩一条时拒绝（返回 null）。删的是活动序列时先切到第一条非活动序列。 */
export function removeSequence(project: Project, id: string): Project | null {
  const sequences = inactiveSequences(project)
  const currentId = activeSequenceId(project)
  if (id === currentId) {
    const fallback = sequences[0]
    if (!fallback) return null
    const switched = switchSequence(project, fallback.id)
    if (!switched) return null
    return removeSequenceSnapshot(switched, currentId)
  }
  if (!sequences.some((sequence) => sequence.id === id)) return null
  return removeSequenceSnapshot(project, id)
}

function removeSequenceSnapshot(project: Project, id: string): Project {
  const next: Project = { ...project }
  const sequences = inactiveSequences(project).filter((sequence) => sequence.id !== id)
  if (sequences.length > 0) next.sequences = sequences
  else delete next.sequences
  return next
}

/** 重命名：活动序列写 `activeSequenceName`，非活动序列改快照；空名忽略。 */
export function renameSequence(project: Project, id: string, name: string): Project {
  const normalized = normalizeSequenceName(name, '')
  if (normalized.length === 0) return project
  if (id === activeSequenceId(project)) {
    return withActiveMeta(project, activeSequenceId(project), normalized)
  }
  const sequences = inactiveSequences(project)
  if (!sequences.some((sequence) => sequence.id === id)) return project
  return {
    ...project,
    sequences: sequences.map((sequence) => (sequence.id === id ? { ...sequence, name: normalized } : sequence))
  }
}

/** 复制一份序列（缺省复制活动序列），副本一定落在非活动序列里；达到上限返回 null。 */
export function duplicateSequence(
  project: Project,
  sourceId?: string,
  name?: string
): { project: Project; id: string } | null {
  const sequences = inactiveSequences(project)
  if (sequences.length + 1 >= MAX_SEQUENCES) return null
  const source = sourceId ? findSequence(project, sourceId) : activeSequence(project)
  if (!source) return null
  const id = createSequenceId()
  const snapshot: SequenceSnapshot = {
    ...source,
    id,
    name: normalizeSequenceName(name, `${source.name} 副本`),
    // 深拷贝数组，避免副本与原序列共享引用（撤销快照也不该被后续编辑穿透）
    clips: [...source.clips],
    mediaClips: [...source.mediaClips],
    mediaTracks: [...source.mediaTracks],
    audioTracks: [...source.audioTracks],
    ...(source.audioClips ? { audioClips: [...source.audioClips] } : {}),
    ...(source.textClips ? { textClips: [...source.textClips] } : {})
  }
  return { project: { ...project, sequences: [...sequences, snapshot] }, id }
}
