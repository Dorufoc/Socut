import { useEffect, useState } from 'react'
import { DEFAULT_FONT_ID } from '@shared/constants'
import { getPreset } from '@shared/presets'
import { resolveExportCanvas } from '@shared/exportPresets'
import type { AspectMode, ExportCanvasKind, ExportFit, FontRecord, Project, RenderJobSpec } from '@shared/types'
import { buildRenderJob } from '../render/jobBuilder'
import { ensureFontRegistered } from './useFontLoader'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/** 预览覆盖画布（v10）：null = 工程画布；横屏跟随工程分辨率，竖屏/方图按 1080 档固定。 */
export function previewTargetCanvas(
  project: Project,
  kind: ExportCanvasKind | null,
  fit: ExportFit
): { width: number; height: number; mode: AspectMode } | null {
  if (kind === null) return null
  const canvas = resolveExportCanvas({
    selection: { kind, tier: '1080', fit },
    projectResolution: project.resolution
  })
  return { width: canvas.width, height: canvas.height, mode: canvas.mode }
}

/**
 * 预览规格：工程/字体/分辨率/帧率变化后重建一次。
 * 布局在渲染层算（Yoga 在渲染进程），主进程只收帧像素与 FrameSpec（规格 §4.2）。
 * 只有被片段与预设真正引用的字体才注册，避免一次性加载全部内置字体。
 */

function wantedFontIds(records: FontRecord[], clips: { presetId: string; fontId: string }[]): FontRecord[] {
  const byId = new Map(records.map((record) => [record.fontId, record]))
  const ids = new Set<string>([DEFAULT_FONT_ID])
  for (const clip of clips) {
    ids.add(clip.fontId)
    const preset = getPreset(clip.presetId as never)
    for (const role of ['title', 'subtitle'] as const) {
      const declared = preset.fonts[role]
      if (declared.builtinKey !== 'auto') ids.add(declared.builtinKey)
      ids.add(declared.fallbackBuiltinKey)
    }
  }
  // 过滤掉磁盘上并不存在的字体（未执行 fetch:fonts 时不阻塞其它字体）
  return [...ids].map((id) => byId.get(id)).filter((record): record is FontRecord => record !== undefined)
}

/** 模块级代数计数：只有最后一次重建的结果可以上屏（快速连续修改时丢弃旧结果）。 */
let specGeneration = 0

export function usePreviewSpec(): { spec: RenderJobSpec | null; ready: boolean; error: string | null } {
  const project = useProjectStore((state) => state.project)
  const revision = useProjectStore((state) => state.revision)
  const fonts = useProjectStore((state) => state.fonts)
  const previewCanvasKind = useUiStore((state) => state.previewCanvasKind)
  const previewFit = useUiStore((state) => state.previewFit)
  const [spec, setSpec] = useState<RenderJobSpec | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let cancelSchedule: () => void = () => undefined

    const run = async (): Promise<void> => {
      if (cancelled) return
      // 真正开始构建时才从 store 取最新值：同一帧里连续改参数只会留下最后一份工程，
      // 前面几份根本不会进入字体注册与 Yoga 布局（旧的 result 仍由 specGeneration 兜底丢弃）。
      const latest = useProjectStore.getState()
      const ui = useUiStore.getState()
      const localGeneration = ++specGeneration
      const wanted = wantedFontIds(latest.fonts, latest.project.clips)
      let failure: string | null = null
      for (const record of wanted) {
        try {
          await ensureFontRegistered(record)
        } catch (fontError: unknown) {
          failure = fontError instanceof Error ? fontError.message : String(fontError)
        }
      }
      // 字体必须先注册完成，否则 Canvas 会回落默认字形（预览与导出就会不一致）
      const target = previewTargetCanvas(latest.project, ui.previewCanvasKind, ui.previewFit)
      const built = await buildRenderJob({
        project: latest.project,
        fontIndex: latest.fonts,
        scope: { kind: 'timeline' },
        ...(target
          ? {
              resolution: { width: target.width, height: target.height },
              mode: target.mode
            }
          : {})
      })
      if (cancelled || localGeneration !== specGeneration) return
      setSpec(built)
      setError(failure)
      setReady(true)
    }

    // 用一个「下一帧/下一宏任务」调度：effect 重跑时先取消上一份，
    // 同一帧内的多次 revision 因此只剩最后一次真正开始构建（异步合并）。
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(() => {
        void run()
      })
      cancelSchedule = () => cancelAnimationFrame(id)
    } else {
      const id = setTimeout(() => {
        void run()
      }, 0)
      cancelSchedule = () => clearTimeout(id)
    }

    return () => {
      cancelled = true
      cancelSchedule()
    }
  }, [project, revision, fonts, previewCanvasKind, previewFit])

  return { spec, ready, error }
}
