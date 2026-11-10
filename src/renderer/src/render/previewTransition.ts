import type { CSSProperties } from 'react'
import { applyEasing } from '@shared/easing'
import {
  TRANSITION_MAP,
  previousMediaClipOnTrack,
  resolveTransitionDuration,
  transitionMediaMetaOf,
  transitionProgressAt,
  transitionWindow
} from '@shared/transitions'
import type { Fps, MediaClip, Project, TransitionType } from '@shared/types'

/**
 * 转场预览近似（v10 Task 6）：纯函数，不碰 DOM。
 *
 * 预览与导出的**同一时相**：窗口居中跨切点 `[cut - T/2, cut + T/2]`，
 * 进度 0 / 0.5 / 1 对应窗口起点 / 切点 / 窗口终点。导出侧（Task 7）以 `xfade`
 * 为唯一真值；这里只保证「哪种效果、哪个方向、多长、切点在哪」与导出一致。
 *
 * 音频仍是硬切：预览层按 `cutSec` 只让一侧发声（见 MediaPreviewLayer）。
 */

export interface PreviewTransitionState {
  leftClipId: string
  rightClipId: string
  type: TransitionType
  cutSec: number
  startSec: number
  endSec: number
  durationSec: number
  /** 0..1，切点为 0.5 */
  progress: number
}

export interface PreviewTransitionInput {
  /** 同一条媒体轨上可见的片段（隐藏轨由调用方剔除） */
  clips: MediaClip[]
  atSec: number
  project: Project
  fps: Fps
  trackId: string
}

const EPS = 1e-9

/**
 * 找出该轨道上此刻生效的入场转场；无转场 / 窗口外 / 数据不合法返回 null。
 *
 * `transitionIn` 落在切点右侧片段上；左侧用 `previousMediaClipOnTrack` 取。
 * 时长走 `resolveTransitionDuration`（与检查器/导出计划同一口径，包含手柄夹取）。
 * 同一轨道理论上不该出现两个重叠窗口；出现脏数据时按时间顺序返回第一个有效项。
 */
export function previewTransitionForTrack(input: PreviewTransitionInput): PreviewTransitionState | null {
  const trackClips = input.clips
    .filter((clip) => clip.trackId === input.trackId)
    .sort((a, b) => a.timelineStartSec - b.timelineStartSec)

  for (const clip of trackClips) {
    if (!clip.transitionIn) continue
    const prev = previousMediaClipOnTrack(trackClips, clip)
    if (!prev) continue

    const resolution = resolveTransitionDuration({
      prev,
      clip,
      prevMeta: transitionMediaMetaOf(input.project, prev),
      clipMeta: transitionMediaMetaOf(input.project, clip),
      requestedSec: clip.transitionIn.durationSec,
      fps: input.fps
    })
    if (!resolution.ok) continue

    const window = transitionWindow(prev, clip, resolution.durationSec)
    if (input.atSec < window.startSec - EPS || input.atSec > window.endSec + EPS) continue

    return {
      leftClipId: prev.id,
      rightClipId: clip.id,
      type: clip.transitionIn.type,
      cutSec: window.cutSec,
      startSec: window.startSec,
      endSec: window.endSec,
      durationSec: resolution.durationSec,
      progress: transitionProgressAt(input.atSec, window.cutSec, resolution.durationSec)
    }
  }

  return null
}

export interface PreviewTransitionStyles {
  left: CSSProperties
  right: CSSProperties
  flash?: { color: string; opacity: number }
  /** 近似模糊半径（px，1080p 基座）；上限见 `PREVIEW_TRANSITION_MAX_BLUR_PX` */
  blurPx: number
  /** 平移方向单位（-1..1）：左/上 = -1，右/下 = +1 */
  dx: number
  dy: number
}

/** 风感/模糊/推拉的最大近似模糊半径（px）。预览只求观感，不追求与 xfade 逐像素一致。 */
export const PREVIEW_TRANSITION_MAX_BLUR_PX = 12

/** 运镜推近的轻微模糊上限（px）。 */
export const PREVIEW_TRANSITION_ZOOM_BLUR_PX = 4

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value)

const round2 = (value: number): number => Math.round(value * 100) / 100

function directionUnit(type: TransitionType): { dx: number; dy: number } {
  switch (TRANSITION_MAP[type].direction) {
    case 'left':
      return { dx: -1, dy: 0 }
    case 'right':
      return { dx: 1, dy: 0 }
    case 'up':
      return { dx: 0, dy: -1 }
    case 'down':
      return { dx: 0, dy: 1 }
    default:
      return { dx: 0, dy: 0 }
  }
}

function translateStyle(xPercent: number, yPercent: number): CSSProperties {
  const x = round2(xPercent)
  const y = round2(yPercent)
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6) return {}
  return { transform: `translate(${x}%, ${y}%)` }
}

function withBlur(style: CSSProperties, blurPx: number): CSSProperties {
  if (blurPx <= 1e-6) return style
  return { ...style, filter: `blur(${round2(blurPx)}px)` }
}

/**
 * 按效果族生成两层的近似样式。
 *
 * 语义（与导出 `xfade` 同名动作对齐）：
 * - `push*`（cover）：新画面从**反方向**进入并盖住旧画面。例如 `pushLeft` = 画面整体向左推，
 *   新画面从右侧（+100% x）进来 → 0；`pushRight` 从左侧（-100% x）进来；上下同理。
 * - `pull*`（reveal）：旧画面朝所选方向被拉走，新画面原地露出。例如 `pullLeft` = 旧画面
 *   0 → -100% x。
 * - `wind*`：旧画面朝所选方向移出，新画面从反方向移入，两侧都带运动模糊。
 * - `zoomIn`：新画面从 1.16 缩到 1.0 并淡入，旧画面淡出。
 *
 * `left/right` 里的 transform/filter 是**转场增量**，MediaPreviewLayer 会把它接在
 * 片段的基座 transform/filter 之后（`基座 转场增量`），退出转场时再还原成基座样式。
 */
export function transitionStyles(type: TransitionType, progress: number): PreviewTransitionStyles {
  const p = clamp01(progress)
  const family = TRANSITION_MAP[type].family
  const { dx, dy } = directionUnit(type)
  const mid = Math.sin(Math.PI * p)

  if (family === 'basic') {
    if (type === 'fadeBlack' || type === 'fadeWhite') {
      const leftOpacity = clamp01(1 - 2 * p)
      const rightOpacity = clamp01(2 * p - 1)
      return {
        left: { opacity: leftOpacity },
        right: { opacity: rightOpacity },
        flash: {
          color: type === 'fadeBlack' ? '#000' : '#fff',
          opacity: 1 - Math.abs(2 * p - 1)
        },
        blurPx: 0,
        dx,
        dy
      }
    }

    if (type === 'lightFlash') {
      return {
        left: { opacity: 1 - p },
        right: { opacity: p },
        flash: { color: '#808080', opacity: 0.55 * mid },
        blurPx: 0,
        dx,
        dy
      }
    }

    // dissolve：纯透明度交叉淡化
    return {
      left: { opacity: 1 - p },
      right: { opacity: p },
      blurPx: 0,
      dx,
      dy
    }
  }

  if (family === 'blur') {
    const blurPx = PREVIEW_TRANSITION_MAX_BLUR_PX * mid
    return {
      left: withBlur({ opacity: 1 - p }, blurPx),
      right: withBlur({ opacity: p }, blurPx),
      blurPx,
      dx,
      dy
    }
  }

  const eased = applyEasing('outCubic', p)

  if (family === 'wind') {
    const blurPx = PREVIEW_TRANSITION_MAX_BLUR_PX * mid
    return {
      left: withBlur(
        { opacity: 1, ...translateStyle(dx * eased * 100, dy * eased * 100) },
        blurPx
      ),
      right: withBlur(
        {
          opacity: 1,
          zIndex: 2,
          ...translateStyle(-dx * (1 - eased) * 100, -dy * (1 - eased) * 100)
        },
        blurPx
      ),
      blurPx,
      dx,
      dy
    }
  }

  if (family === 'push') {
    const blurPx = PREVIEW_TRANSITION_MAX_BLUR_PX * mid
    return {
      left: { opacity: 1, zIndex: 1 },
      right: withBlur(
        {
          opacity: 1,
          zIndex: 2,
          ...translateStyle(-dx * (1 - eased) * 100, -dy * (1 - eased) * 100)
        },
        blurPx
      ),
      blurPx,
      dx,
      dy
    }
  }

  if (family === 'pull') {
    const blurPx = PREVIEW_TRANSITION_MAX_BLUR_PX * mid
    return {
      left: withBlur(
        { opacity: 1, zIndex: 2, ...translateStyle(dx * eased * 100, dy * eased * 100) },
        blurPx
      ),
      right: { opacity: 1, zIndex: 1 },
      blurPx,
      dx,
      dy
    }
  }

  // M7-E：滑动（slide*）= 两层同向平移，新画面从反方向顶进来
  if (family === 'slide') {
    return {
      left: { opacity: 1, zIndex: 1, ...translateStyle(-dx * eased * 100, -dy * eased * 100) },
      right: { opacity: 1, zIndex: 2, ...translateStyle(dx * (1 - eased) * 100, dy * (1 - eased) * 100) },
      blurPx: 0,
      dx,
      dy
    }
  }

  // M7-E：擦除（wipe*）= 用 clip-path 揭示新画面；对角线/切片类方向为 none，做纵向开合近似
  if (family === 'wipe') {
    const reveal = 1 - eased
    let clipPath: string
    if (dx < 0) clipPath = `inset(0 ${round2(reveal * 100)}% 0 0)`
    else if (dx > 0) clipPath = `inset(0 0 0 ${round2(reveal * 100)}%)`
    else if (dy < 0) clipPath = `inset(0 0 ${round2(reveal * 100)}% 0)`
    else if (dy > 0) clipPath = `inset(${round2(reveal * 100)}% 0 0 0)`
    else clipPath = `inset(${round2(reveal * 50)}% 0 ${round2(reveal * 50)}% 0)`
    return {
      left: { opacity: 1 },
      right: { opacity: 1, zIndex: 2, clipPath },
      blurPx: 0,
      dx,
      dy
    }
  }

  // M7-E：形状（circle*/vert*/horz*/radial/distance/crop）= 圆形/矩形剪裁展开
  if (family === 'shape') {
    const open = 75 * eased
    if (type === 'vertOpen' || type === 'vertClose') {
      const inset = round2((type === 'vertOpen' ? 50 * (1 - eased) : 50 * eased))
      return {
        left: { opacity: 1 },
        right: { opacity: 1, zIndex: 2, clipPath: `inset(${inset}% 0 ${inset}% 0)` },
        blurPx: 0,
        dx,
        dy
      }
    }
    if (type === 'horzOpen' || type === 'horzClose') {
      const inset = round2((type === 'horzOpen' ? 50 * (1 - eased) : 50 * eased))
      return {
        left: { opacity: 1 },
        right: { opacity: 1, zIndex: 2, clipPath: `inset(0 ${inset}% 0 ${inset}%)` },
        blurPx: 0,
        dx,
        dy
      }
    }
    if (type === 'rectCrop') {
      const inset = round2(50 * (1 - eased))
      return {
        left: { opacity: 1 },
        right: { opacity: 1, zIndex: 2, clipPath: `inset(${inset}% 0 ${inset}% 0)` },
        blurPx: 0,
        dx,
        dy
      }
    }
    return {
      left: { opacity: 1 },
      right: { opacity: 1, zIndex: 2, clipPath: `circle(${round2(open)}% at 50% 50%)` },
      blurPx: 0,
      dx,
      dy
    }
  }

  // M7-E：特效（pixelize / squeezeH / squeezeV）
  if (family === 'effect') {
    if (type === 'pixelize') {
      const blurPx = 8 * mid
      return {
        left: withBlur({ opacity: 1 - p }, blurPx),
        right: withBlur({ opacity: p, zIndex: 2 }, blurPx),
        blurPx,
        dx,
        dy
      }
    }
    const horizontal = type === 'squeezeH'
    const shrink = 1 - 0.9 * eased
    const grow = 0.1 + 0.9 * eased
    const size = (value: number): CSSProperties =>
      horizontal ? { transform: `scaleX(${round2(value)})` } : { transform: `scaleY(${round2(value)})` }
    return {
      left: { opacity: 1, zIndex: 1, ...size(shrink) },
      right: { opacity: 1, zIndex: 2, ...size(grow) },
      blurPx: 0,
      dx,
      dy
    }
  }

  // camera：zoomin = 新画面推近入场
  const blurPx = PREVIEW_TRANSITION_ZOOM_BLUR_PX * mid
  const scale = 1.16 - 0.16 * p
  return {
    left: withBlur({ opacity: 1 - p }, blurPx),
    right: withBlur({ opacity: p, zIndex: 2, transform: `scale(${round2(scale)})` }, blurPx),
    blurPx,
    dx: 0,
    dy: 0
  }
}
