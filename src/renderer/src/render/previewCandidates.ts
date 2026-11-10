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

/**
 * 预卷时长（时间轴秒）：切点前多久开始静音播放，抵消解码器起播延迟。
 * 不能太短：`play()` 真正出帧往往晚于 seek 落地，窗口内还要留出二次纠偏的余量，
 * 否则这点延迟会原样留到切点（观感就是「新段第一帧卡一下」）。
 */
export const PREVIEW_PREROLL_SEC = 0.5

/**
 * 预卷停手时间（时间轴秒）：切点前这段时间只播不 seek。
 * 跨在切点上的 seek 会让解码器停止出帧，正好把「新段第一帧」冻住。
 */
export const PREVIEW_PREROLL_LOCK_SEC = 0.1

/**
 * 预卷纠偏容差（时间轴秒）。
 *
 * 必须比「切点漂移容差」松：预卷期的 seek 虽然不可见，但每次 seek 都会清解码队列，
 * 按半帧容差纠偏会在窗口内反复 seek，既抢可见段的解码带宽，也会在切点留下抖动。
 * 0.1s 足够吸收 play() 起播延迟，同时保证切点落点仍在 `PREVIEW_DRIFT_SEC` 以内。
 */
export const PREVIEW_PREROLL_STEER_SEC = 0.1

/**
 * 播放中允许的漂移（秒）；超过才 seek，避免每帧 seek 卡顿。
 * 阈值不能太松：0.25s 在 30fps 下相当于画面与播放头差 7 帧以上，
 * 切点后的第一帧就已经能看出「画面慢半拍」。0.12s（约 3–4 帧）是观感与 seek 次数的折中。
 */
export const PREVIEW_DRIFT_SEC = 0.12

/**
 * 起播窗口（时间轴秒）：切点前多久才真的开始播放。
 *
 * 预卷窗口（`PREVIEW_PREROLL_SEC`）负责「挂载 + 对齐 + 出好首帧」，但整段都播的话，
 * 切点前 0.5s 里有两路视频同时解码、同时上屏，可见那一路会被抢解码/合成资源，
 * 观感就是切点附近帧率一抖。真正需要提前播的只有「起播延迟」那一小段：
 * 0.2s 足够吸收从暂停态起播的 1～2 帧延迟，又把双路解码的重叠压到最短。
 */
export const PREVIEW_ROLL_IN_SEC = 0.2

/**
 * 切点允许继承的起播偏差（秒）。
 *
 * 预卷在切点前开始播放，`play()` 真正出帧可能晚几十毫秒；这点落后如果按
 * `PREVIEW_DRIFT_SEC` 在切点那一帧补 seek，解码器会冻在 `seeked` 之前 ——
 * 又变回「新段第一帧卡一下」。所以切点接管这一帧不 seek，而是把这个偏差登记成
 * 本段的合法起点，之后只在**相对偏差**超过 `PREVIEW_DRIFT_SEC` 时才重新对齐。
 * 上限 0.25s（30fps 下约 7 帧）：再大就不是起播延迟，而是真的跑偏了，必须 seek。
 */
export const PREVIEW_CUT_DRIFT_SEC = 0.25

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
  /** 实际要挂到 `socut-media://` 的文件（原片或防抖代理） */
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

export interface PreviewCandidateOptions {
  /**
   * 时间轴循环总时长（秒）。播放到末尾会回绕到 0，提供该值时在末尾前瞻窗口内
   * 把「回绕后即将开始」的首部片段也纳入候选，回绕瞬间无需重新挂载/等元数据。
   */
  loopDurationSec?: number
}

/** 即将开始的候选：`effectiveStart` 用于排序（回绕候选 = loopDurationSec + 起点）。 */
interface UpcomingEntry {
  clip: MediaClip
  effectiveStart: number
}

/**
 * 选出当前需要存活的候选段，顺序即 DOM 顺序：
 * 1. **所有当前图层**（按轨道序号升序：底层先画、上层后画）；
 * 2. 传入 `transitionIds` 时，转场左右两侧**强制保留**（永不裁剪）；
 * 3. **即将开始的段**（含回绕前瞻，按有效开始时间升序）；
 * 4. **刚结束仍在 hold 窗口内的段**（结束时间由近到远，用于接缝兜底）。
 *
 * `trackOrder` = 媒体轨 id → 数组索引（0 = 最底层），由 `tracks.ts / mediaTrackOrder` 生成；
 * 隐藏轨的片段应在调用前剔除。总数不超过 `PREVIEW_MAX_CANDIDATES`，但当前图层与转场对
 * 永远全部保留——多轨重叠时少挂一层会直接改变画面内容，不能为了限流牺牲正确性。
 *
 * 顺序上「即将开始」排在 hold 之前：多轨 + 多 hold 时，限流只应丢兜底段，
 * 不能让真正要切的下一段被挤出候选池（否则切点处目标 `<video>` 根本没挂载，
 * 预览会一直停在上一段最后一帧）。
 */
export function selectPreviewCandidates(
  tracks: MediaClip[],
  atSec: number,
  trackOrder: ReadonlyMap<string, number>,
  transitionIds?: PreviewTransitionIds | readonly PreviewTransitionIds[],
  options?: PreviewCandidateOptions
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

  const upcoming: UpcomingEntry[] = tracks
    .filter(
      (clip) =>
        !activeIds.has(clip.id) &&
        clip.timelineStartSec > atSec + EPS &&
        clip.timelineStartSec <= atSec + PREVIEW_LOOKAHEAD_SEC + EPS
    )
    .map((clip) => ({ clip, effectiveStart: clip.timelineStartSec }))

  // 回绕前瞻：临近时间轴末尾时，头部片段要到回绕后才会开始。
  // 距回绕点 d = loopDurationSec - atSec，起点 s 满足 d + s <= 前瞻窗口 即纳入；
  // 排序按有效起点 loopDurationSec + s，所以它们总排在本轮末尾即将开始的段之后。
  const loopDurationSec = options?.loopDurationSec ?? 0
  if (loopDurationSec > 0 && atSec >= loopDurationSec - PREVIEW_LOOKAHEAD_SEC - EPS) {
    const remaining = loopDurationSec - atSec
    const seen = new Set(upcoming.map((entry) => entry.clip.id))
    for (const clip of tracks) {
      if (activeIds.has(clip.id) || seen.has(clip.id)) continue
      if (remaining + clip.timelineStartSec > PREVIEW_LOOKAHEAD_SEC + EPS) continue
      seen.add(clip.id)
      upcoming.push({ clip, effectiveStart: loopDurationSec + clip.timelineStartSec })
    }
  }
  upcoming.sort((a, b) => a.effectiveStart - b.effectiveStart)

  const out = [...active]
  // 当前图层永远全部保留；转场对优先于 upcoming/held 的限流填充。
  for (const clip of forced) {
    if (!out.some((item) => item.id === clip.id)) out.push(clip)
  }
  // 先填 upcoming（越近越优先），再填 held：上限只裁剪「更远的 upcoming」与兜底段。
  for (const entry of upcoming) {
    if (out.length >= PREVIEW_MAX_CANDIDATES) break
    if (!out.some((item) => item.id === entry.clip.id)) out.push(entry.clip)
  }
  for (const clip of held) {
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
 * 最近一个已经结束的片段（终点 <= atSec）。
 * 「最后一帧兜底」只能由它来做：更早结束的段即便还在候选池的 hold 窗口里，
 * 也不能在更晚的段结束之后重新冒出来。
 */
export function latestEndedClip(clips: readonly MediaClip[], atSec: number): MediaClip | null {
  let latest: MediaClip | null = null
  for (const clip of clips) {
    if (clip.timelineEndSec > atSec + EPS) continue
    if (latest === null || clip.timelineEndSec > latest.timelineEndSec) latest = clip
  }
  return latest
}

/**
 * 该片段终点处是否紧贴着同轨的下一段（剪辑缝口）。
 *
 * 只有这种缝口才允许拿上一段最后一帧顶住画面、等下一段就绪；轨道真正结束
 * （末端 / 段后空隙）时必须立即隐藏，否则上层轨道的最后一帧会多压住下层半秒，
 * 看起来像「叠加层结束后还赖着不走」。
 */
export function hasSeamSuccessor(clip: MediaClip, clips: readonly MediaClip[]): boolean {
  return clips.some(
    (other) => other.id !== clip.id && Math.abs(other.timelineStartSec - clip.timelineEndSec) < 1e-6
  )
}

/** 预卷规划（见 `previewPrerollPlan`）。 */
export interface PreviewPrerollPlan {
  /** 元素此刻应当处于的源坐标（已钳到 0）：起播窗口内按它持续纠偏 */
  target: number
  /**
   * 起播前应当**停**在的源坐标：起播窗口（`PREVIEW_ROLL_IN_SEC`）之前元素保持暂停，
   * 只摆到这个位置。窗口内 `target` 一直在往前走，暂停态跟着它走会反复 seek。
   */
  park: number
  /** true = 只是热身起播：入点太靠前、无法倒退预卷，不能再按 target 往回纠偏 */
  warmup: boolean
}

/**
 * 预卷规划：切点前该把元素摆到源上的哪个坐标。
 *
 * - 常规情形（`入点 >= 剩余时长 × 倍速`）：切点前 `PREVIEW_PREROLL_SEC` 就进窗口，
 *   先把元素**暂停**摆到 `park`（起播位置），到 `PREVIEW_ROLL_IN_SEC` 才静音起播，
 *   切点时 `currentTime` 正好落在入点，切点只做 opacity 翻转；
 * - 入点太靠前（典型：`sourceInSec = 0`）时无法倒退预卷，这时只在切点前
 *   `warmupSec` 秒内**原地热身起播**，让解码器提前进入播放态。切点处至多超前
 *   `warmupSec`（时间轴口径，调用方按 1~2 帧传入），交给漂移容差吸收，
 *   换来切点不再等解码器冷启动。
 *
 * 返回 `null` 表示这一帧不该动：还没进入预卷窗口 / 热身窗口，或已经过了切点。
 */
export function previewPrerollPlan(
  clip: MediaClip,
  atSec: number,
  useStabProxy: boolean,
  warmupSec = 0
): PreviewPrerollPlan | null {
  const remaining = clip.timelineStartSec - atSec
  if (remaining <= EPS || remaining > PREVIEW_PREROLL_SEC + EPS) return null
  const speed = speedValueOf(clip.speed)
  const start = previewClipStartSourceTime(clip, useStabProxy)
  const lead = remaining * speed
  /** 起播那一刻该在的位置：此时 remaining 恰好等于 PREVIEW_ROLL_IN_SEC */
  const park = Math.max(0, start - PREVIEW_ROLL_IN_SEC * speed)
  if (start >= lead - EPS) return { target: Math.max(0, start - lead), park, warmup: false }
  if (warmupSec <= EPS || remaining > warmupSec + EPS) return null
  return { target: Math.max(0, start - lead), park, warmup: true }
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
