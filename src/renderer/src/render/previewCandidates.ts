import { sourceTimeAt, speedValueOf } from '@shared/mediaClipAudio'
import { MEDIA_GRADE_FILTER_ID } from '@shared/mediaClipVideo'
import { stabProxyTimeOf } from '@shared/mediaStab'
import type { MediaClip } from '@shared/types'

/**
 * 预览候选池（v10）：切段不再卸载/重载单个 `<video>`。
 *
 * 旧实现只有一个 `<video>`，源路径一变就 `setVideoUrl(null)` 卸载元素，等 IPC 拿到新地址
 * 再重新挂载、等元数据、seek、等解码——这段空窗期 Canvas 画的是棋盘格，用户看到的就是
 * 「切段时黑一下」。现在改成按时间轴预选一组候选段，各自提前挂载、预 seek、预卷，
 * 切点只做 **opacity 翻转**，画面永远不会回到空元素。
 *
 * 本文件只放纯函数：候选选择、源坐标换算、预卷目标。DOM 与 IPC 全部留在
 * `components/MediaPreviewLayer.tsx`，这样边界条件可以直接用单测钉住。
 */

/** 前瞻窗口：切点前多久开始挂载下一段（秒）。 */
export const PREVIEW_LOOKAHEAD_SEC = 2

/** 保留窗口：段结束后仍留多久，用于切点瞬间的「上一帧兜底」（秒）。 */
export const PREVIEW_HOLD_SEC = 0.5

/** 同时存活的候选上限（含当前所有图层）。视频解码器很贵，不能无限挂。 */
export const PREVIEW_MAX_CANDIDATES = 4

/** 预卷时长（时间轴秒）：切点前多久开始静音播放，抵消解码器起播延迟。 */
export const PREVIEW_PREROLL_SEC = 0.35

/** 播放中允许的漂移（秒）；超过才 seek，避免每帧 seek 卡顿。 */
export const PREVIEW_DRIFT_SEC = 0.25

/** 转场窗口内必须同时存活的一对片段（左 = 前段，右 = 后段）。 */
export interface PreviewTransitionIds {
  leftId: string
  rightId: string
}

const EPS = 1e-9

/** 候选段的完整播放信息（路径已按防抖代理新鲜度解析过）。 */
export interface PreviewCandidate {
  clip: MediaClip
  kind: 'video' | 'image'
  hasAudio: boolean
  /** 实际要挂到 `focusnews-media://` 的文件（原片或防抖代理） */
  sourcePath: string
  /** `sourcePath` 是否为防抖代理：源坐标要换成代理坐标 */
  useStabProxy: boolean
}

/** 半开区间 `[timelineStartSec, timelineEndSec)`，与 `topActiveMediaClip` 同口径。 */
export function isClipActiveAt(
  clip: Pick<MediaClip, 'timelineStartSec' | 'timelineEndSec'>,
  atSec: number
): boolean {
  return atSec >= clip.timelineStartSec - EPS && atSec < clip.timelineEndSec - EPS
}

function normalizeTransitionIds(
  input:
    | PreviewTransitionIds
    | readonly PreviewTransitionIds[]
    | undefined
): PreviewTransitionIds[] {
  if (!input) return []
  return Array.isArray(input) ? [...input] : [input as PreviewTransitionIds]
}

/**
 * 选出当前需要存活的候选段，顺序即 DOM 顺序：
 * 1. **所有当前图层**（按轨道序号升序：底层先画、上层后画）；
 * 2. **刚结束仍在 hold 窗口内的段**（最近结束的优先，用于接缝兜底）；
 * 3. **前瞻窗口内即将开始的段**（按开始时间升序）；
 * 4. 传入 `transitionIds` 时，转场左右两侧**强制保留**（优先于 2/3 的限流填充）。
 *
 * `trackOrder` = 媒体轨 id → 数组索引（0 = 最底层），由 `tracks.ts / mediaTrackOrder` 生成；
 * 隐藏轨的片段应在调用前剔除。总数不超过 `PREVIEW_MAX_CANDIDATES`，但当前图层永远全部保留——
 * 多轨重叠时少挂一层会直接改变画面内容，不能为了限流牺牲正确性。
 */
export function selectPreviewCandidates(
  tracks: MediaClip[],
  atSec: number,
  trackOrder: ReadonlyMap<string, number>,
  transitionIds?:
    | PreviewTransitionIds
    | readonly PreviewTransitionIds[]
): MediaClip[] {
  const rankOf = (clip: MediaClip): number => trackOrder.get(clip.trackId) ?? -1
  const active = tracks
    .filter((clip) => isClipActiveAt(clip, atSec))
    .sort((a, b) => rankOf(a) - rankOf(b) || a.timelineStartSec - b.timelineStartSec)

  const activeIds = new Set(active.map((clip) => clip.id))
  const forcedIds = new Set<string>()
  for (const pair of normalizeTransitionIds(transitionIds)) {
    forcedIds.add(pair.leftId)
    forcedIds.add(pair.rightId)
  }
  // 转场左右两侧必须在窗口内同时挂载：即使一侧还没进入前瞻窗口 / 已超出 hold 窗口
  // （转场最长 1.5s，半窗 0.75s > hold 0.5s），也不能让画面在切点附近掉回单层。
  const forced = tracks.filter((clip) => forcedIds.has(clip.id))

  const held = tracks
    .filter(
      (clip) =>
        !activeIds.has(clip.id) &&
        clip.timelineEndSec <= atSec + EPS &&
        atSec - clip.timelineEndSec <= PREVIEW_HOLD_SEC + EPS
    )
    .sort((a, b) => b.timelineEndSec - a.timelineEndSec)

  const upcoming = tracks
    .filter(
      (clip) =>
        !activeIds.has(clip.id) &&
        clip.timelineStartSec > atSec + EPS &&
        clip.timelineStartSec <= atSec + PREVIEW_LOOKAHEAD_SEC + EPS
    )
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)

  const out = [...active]
  // 当前图层永远全部保留；转场对优先于 hold/前瞻的限流填充。
  for (const clip of forced) {
    if (!out.some((item) => item.id === clip.id)) out.push(clip)
  }
  for (const clip of [...held, ...upcoming]) {
    if (out.length >= PREVIEW_MAX_CANDIDATES) break
    if (!out.some((item) => item.id === clip.id)) out.push(clip)
  }
  return out
}

/**
 * 时间轴秒 → 这一候选段要 seek 的源秒（播代理时换成代理坐标）。
 * 与 `sourceTimeAt` / `stabProxyTimeOf` 同一口径，只在这里组合一次。
 */
export function previewSourceTimeAt(clip: MediaClip, timelineSec: number, useStabProxy: boolean): number {
  const sourceSec = sourceTimeAt(clip, timelineSec)
  if (!useStabProxy || !clip.stab?.enabled) return Math.max(0, sourceSec)
  return stabProxyTimeOf(sourceSec, clip.sourceInSec, clip.sourceOutSec)
}

/**
 * 转场预览专用的源坐标：允许 `atSec` 落在片段**时间轴起点之前**（后段头部手柄）或
 * 终点之后（前段尾部手柄），此时按负/超出的本地时间乘倍速继续读数。
 *
 * 与 `sourceTimeAt` 的区别：后者先 `Math.max(0, local)`，会把头部手柄钳回 `sourceIn`，
 * 转场窗口前半段就会看到后段的第一帧而不是手柄内容。这里只钳最终源秒 >= 0。
 * 防抖代理只覆盖片段原源区间，转场窗口不用代理（调用方传 `useStabProxy=false`）。
 */
export function previewTransitionSourceTime(clip: MediaClip, atSec: number): number {
  const localSec = atSec - clip.timelineStartSec
  return Math.max(0, clip.sourceInSec + localSec * speedValueOf(clip.speed))
}

/** 片段入点对应的源秒（代理坐标从 0 开始）。 */
export function previewClipStartSourceTime(clip: MediaClip, useStabProxy: boolean): number {
  if (useStabProxy && clip.stab?.enabled) {
    return stabProxyTimeOf(clip.sourceInSec, clip.sourceInSec, clip.sourceOutSec)
  }
  return Math.max(0, clip.sourceInSec)
}

/**
 * 预卷目标：切点前 `remaining` 秒开始，从 `start - remaining × speed` 静音播放，
 * 到切点时 `currentTime` 正好等于入点。
 *
 * 返回 `null` 表示**不该预卷**：
 * - 还没进入预卷窗口（remaining > PREVIEW_PREROLL_SEC）；
 * - 已经过了切点；
 * - 源入点太靠前（`start < remaining × speed`），从 0 起播到切点仍会超前，
 *   不如停在入点，等切点那一帧直接 play。
 */
export function previewPrerollTarget(
  clip: MediaClip,
  atSec: number,
  useStabProxy: boolean
): number | null {
  const remaining = clip.timelineStartSec - atSec
  if (remaining <= EPS || remaining > PREVIEW_PREROLL_SEC + EPS) return null
  const lead = remaining * speedValueOf(clip.speed)
  const start = previewClipStartSourceTime(clip, useStabProxy)
  if (start < lead - EPS) return null
  return start - lead
}

/**
 * 每个候选段自己的 SVG 曲线表 id。
 *
 * 同一时刻候选池里可能同时挂着几段调色不同的素材；如果都引用全局的
 * `MEDIA_GRADE_FILTER_ID`，切点后的一小段时间里新画面会沿用上一段的查找表。
 * clipId 只做保守清洗，保证能安全嵌进 `url(#...)`。
 */
export function previewGradeFilterId(clipId: string): string {
  return `${MEDIA_GRADE_FILTER_ID}-${clipId.replace(/[^\w-]/g, '_')}`
}
