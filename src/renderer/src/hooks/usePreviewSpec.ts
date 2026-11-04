import { useEffect, useState } from 'react'
import { DEFAULT_FONT_ID } from '@shared/constants'
import { getPreset } from '@shared/presets'
import type { FontRecord, RenderJobSpec } from '@shared/types'
import { buildRenderJob } from '../render/jobBuilder'
import { ensureFontRegistered } from './useFontLoader'
import { useProjectStore } from '../state/projectStore'

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
  const [spec, setSpec] = useState<RenderJobSpec | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const run = async (): Promise<void> => {
      const localGeneration = ++specGeneration
      const wanted = wantedFontIds(fonts, project.clips)
      let failure: string | null = null
      for (const record of wanted) {
        try {
          await ensureFontRegistered(record)
        } catch (fontError: unknown) {
          failure = fontError instanceof Error ? fontError.message : String(fontError)
        }
      }
      // 字体必须先注册完成，否则 Canvas 会回落默认字形（预览与导出就会不一致）
      const built = await buildRenderJob({
        project,
        fontIndex: fonts,
        scope: { kind: 'timeline' }
      })
      if (localGeneration !== specGeneration) return
      setSpec(built)
      setError(failure)
      setReady(true)
    }
    void run()
  }, [project, revision, fonts])

  return { spec, ready, error }
}
