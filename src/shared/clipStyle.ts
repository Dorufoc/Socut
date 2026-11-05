import { DEFAULT_FONT_ID } from './constants'
import { COLOR_TOKEN_KEYS, parseColor } from './colors'
import { durationSecToFrames, framesToDurationSec } from './fps'
import type { ColorTokenKey, ColorTokens, Fps, GradientSpec, Preset, StyleOverrides, SubtitleClip } from './types'

/**
 * 片段自定义覆盖（`styleOverrides`）的洁净度法则与预览可见性判定（纯函数，主/渲染/测试共用）。
 *
 * 为什么覆盖层必须「只装与预设不同的键」：
 * 覆盖是挂在片段上的，不随预设切换而失效。一旦把等于预设声明的值也写进覆盖
 * （旧版配色面板就是把合并后的整套令牌整体回写），切到别的预设时这些陈旧键
 * 会照样生效并压住新预设的声明色——表现就是「点了预设但预览没跟着变」。
 * 因此：写入时算差集，改回预设值就删键；切换预设则整层清空（见 projectStore.updateClip）。
 */

/** 颜色等价判断：#RGB / #RRGGBB / rgb() 都归一到 r/g/b/a 再比；解析失败一律视为不等（宁保守留覆盖）。 */
export function sameColor(a: string | undefined, b: string | undefined): boolean {
  // 两边都「没有值」就是同一个状态（都不覆盖）；只有一边缺值才算偏离
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  if (a === b) return true
  const left = parseColor(a)
  const right = parseColor(b)
  if (!left || !right) return false
  return (
    Math.round(left.r) === Math.round(right.r) &&
    Math.round(left.g) === Math.round(right.g) &&
    Math.round(left.b) === Math.round(right.b) &&
    Math.abs(left.a - right.a) < 0.004
  )
}

/** 字号缩放是否算自定义：与 1 相差不到 0.5%（低于滑杆 5% 粒度的一半）视为未设置。 */
const SCALE_EPSILON = 0.005

function isCustomScale(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && Math.abs(value - 1) >= SCALE_EPSILON
}

function isCustomGradient(gradient: GradientSpec | undefined): boolean {
  return gradient !== undefined && gradient.enabled === true
}

/**
 * 令牌差集：把「与预设相同」的键（含历史遗留的陈旧同值覆盖）从覆盖集合里删掉，
 * 只保留真正被用户改过的键。返回的就是要写回工程的新 `tokens`。
 */
export function tokensDelta(
  preset: Preset,
  previous: Partial<ColorTokens> | undefined,
  key: ColorTokenKey,
  value: string
): Partial<ColorTokens> {
  const next: Partial<ColorTokens> = {}
  for (const tokenKey of COLOR_TOKEN_KEYS) {
    const override = previous?.[tokenKey]
    if (override === undefined) continue
    if (sameColor(override, preset.tokens[tokenKey])) continue
    next[tokenKey] = override
  }
  if (sameColor(value, preset.tokens[key])) delete next[key]
  else next[key] = value
  return next
}

/** 字号缩放差集：等于 100% 的角色不留在覆盖里（否则切预设后它仍是一条"自定义"）。 */
export function fontScaleDelta(
  previous: StyleOverrides['fontScale'],
  role: 'title' | 'subtitle',
  value: number
): { title?: number; subtitle?: number } {
  const next: { title?: number; subtitle?: number } = {}
  if (isCustomScale(previous?.title)) next.title = previous?.title
  if (isCustomScale(previous?.subtitle)) next.subtitle = previous?.subtitle
  if (isCustomScale(value)) next[role] = value
  else delete next[role]
  return next
}

/** 覆盖集合是否还有内容（空集合应当整键删掉，不给工程 JSON 留噪声）。 */
export function hasKeys(record: object | undefined): boolean {
  return record !== undefined && Object.keys(record).length > 0
}

/**
 * 本片段相对预设还有多少项自定义：驱动「已自定义 N 项」提示、
 * 「恢复预设默认」按钮的显隐，以及重复点击当前预设时是否需要二次确认。
 */
export function styleOverrideCount(preset: Preset, overrides: StyleOverrides): number {
  let count = 0
  for (const key of COLOR_TOKEN_KEYS) {
    const override = overrides.tokens?.[key]
    if (override !== undefined && !sameColor(override, preset.tokens[key])) count += 1
  }
  if (overrides.barOpacity !== undefined && Math.abs(overrides.barOpacity - 1) >= 0.005) count += 1
  if (isCustomGradient(overrides.titleGradient)) count += 1
  if (isCustomGradient(overrides.subtitleGradient)) count += 1
  if (overrides.compact === true) count += 1
  if (isCustomScale(overrides.fontScale?.title)) count += 1
  if (isCustomScale(overrides.fontScale?.subtitle)) count += 1
  return count
}

/**
 * 回到该预设的默认配置：清空全部自定义参数（配色 / 透明度 / 渐变 / 字号缩放 / 紧凑），
 * 字体回到默认内置字体，动画回到预设声明的节奏。
 * 文字内容与入出点**不属于样式**，一律保持不动。
 */
export function clipWithPresetDefaults(clip: SubtitleClip, preset: Preset): SubtitleClip {
  return {
    ...clip,
    presetId: preset.id,
    fontId: DEFAULT_FONT_ID,
    animation: { ...preset.animation, displacement: { ...preset.animation.displacement } },
    styleOverrides: {}
  }
}

/**
 * 编辑后「让改动看得见」：给出应该落到的播放头秒数，返回 null 表示不用动。
 *
 * 规则（刻意保守，不与用户抢播放头）：
 * - 播放中不动：时钟自己在走，跳帧反而打断观感；
 * - 播放头已落在「入场完成 → 出场开始」这个能看清完整样式的窗口内不动；
 * - 否则落到入场完成后的第一帧（片段极短时退到末帧前一帧）。
 */
export function revealTargetSec(
  clip: SubtitleClip,
  fps: Fps,
  currentSec: number,
  playing: boolean
): number | null {
  if (playing) return null
  const frameSec = framesToDurationSec(1, fps)
  const inSec = framesToDurationSec(durationSecToFrames(clip.animation.inDuration, fps), fps)
  const outSec = framesToDurationSec(durationSecToFrames(clip.animation.outDuration, fps), fps)
  const visibleFrom = clip.startTime + inSec
  const visibleTo = Math.max(visibleFrom, clip.endTime - outSec)
  if (currentSec >= visibleFrom - 1e-9 && currentSec <= visibleTo + 1e-9) return null
  return Math.min(visibleFrom, Math.max(clip.startTime, clip.endTime - frameSec))
}
