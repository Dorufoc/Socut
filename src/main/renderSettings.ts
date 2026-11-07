import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_RENDER_SETTINGS, normalizeRenderSettings } from '../shared/gpu'
import type { GpuPreference, RenderSettings } from '../shared/gpu'

/**
 * 渲染设置的持久化（userData/render-settings.json）。
 *
 * 关键纪律：
 * - 这里**刻意**不在模块顶层读文件：index.ts 会先调用 applyDevUserDataOverride()
 *   把 userData 换到隔离目录（冒烟/取证），顶层求值会读到错误的 profile。
 *   所有读写都发生在导出函数内部，按调用时刻解析路径。
 * - 读失败（缺失/损坏/权限）一律回落到默认值，绝不因为配置问题拒绝启动。
 * - 写盘先落 .tmp 再 rename，避免半截文件把下次启动的偏好吞掉。
 */

const FILE_NAME = 'render-settings.json'

/** 已解析的设置（null = 尚未读取）。 */
let cache: RenderSettings | null = null

/** 本次进程启动时实际应用的偏好（用于计算 restartRequired）。 */
let startupPreference: GpuPreference | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** 同步读取设置；任何异常都返回默认值。可在 app.whenReady() 之前调用。 */
export function readRenderSettingsSync(): RenderSettings {
  if (cache) return cache
  let loaded: RenderSettings
  try {
    loaded = normalizeRenderSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')))
  } catch {
    loaded = { ...DEFAULT_RENDER_SETTINGS }
  }
  cache = loaded
  return loaded
}

/** 缓存过的设置读取（首次调用会触发一次同步读盘）。 */
export function getRenderSettings(): RenderSettings {
  return cache ?? readRenderSettingsSync()
}

/** 归一化后原子写盘，更新缓存并返回落盘的值。 */
export function saveRenderSettings(next: RenderSettings): RenderSettings {
  const normalized = normalizeRenderSettings(next)
  const target = settingsPath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp`
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), 'utf8')
  fs.renameSync(temp, target)
  cache = normalized
  return normalized
}

/** 记录本次进程启动时追加的 Chromium 开关对应的偏好。 */
export function markStartupPreference(preference: GpuPreference): void {
  startupPreference = preference
}

/** 启动时实际应用的偏好；从未标记时回落到默认值的偏好。 */
export function getStartupPreference(): GpuPreference {
  return startupPreference ?? DEFAULT_RENDER_SETTINGS.gpuPreference
}
