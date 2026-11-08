import { useCallback, useEffect, useRef, useState } from 'react'
import { cssFamilyFor } from '@shared/constants'
import type { FontRecord } from '@shared/types'
import { useUiStore } from '../state/uiStore'

/**
 * 字体注册（规格 §4.5）。
 * 内置字体在 resources/fonts/、用户导入在 userData/fonts/，字节由主进程读取后经 IPC 传来，
 * 在渲染进程用 FontFace 注册；Canvas 只有在 FontFace 加载完成后才会真正使用该字体。
 */

const registered = new Map<string, Promise<void>>()
const failed = new Set<string>()

export async function ensureFontRegistered(record: FontRecord): Promise<void> {
  const existing = registered.get(record.fontId)
  if (existing) return existing
  const task = (async () => {
    const beginFontLoad = useUiStore.getState().beginFontLoad
    const endFontLoad = useUiStore.getState().endFontLoad
    beginFontLoad()
    const startedAt = performance.now()
    try {
      const buffer = await window.socut.fonts.readBytes(record.fontId)
      const family = cssFamilyFor(record.fontId)
      const face = new FontFace(family, buffer, {
        weight: String(record.weight),
        style: record.style
      })
      await face.load()
      document.fonts.add(face)
      await document.fonts.ready
      const elapsed = performance.now() - startedAt
      if (elapsed > 300) {
        // 大字体加载已明显耗时：加载期间导出按钮已被禁用（见 FontLoadingOverlay）
        await window.socut.app.writeLog('info', `字体加载 ${record.displayName} 用时 ${Math.round(elapsed)}ms`)
      }
    } catch (error) {
      failed.add(record.fontId)
      registered.delete(record.fontId)
      throw error
    } finally {
      endFontLoad()
    }
  })()
  registered.set(record.fontId, task)
  return task
}

export function isFontFailed(fontId: string): boolean {
  return failed.has(fontId)
}

/** 确保一组字体就绪；返回是否全部完成（用于渲染前先加载，避免回落默认字体）。 */
export function useEnsureFonts(records: FontRecord[]): {
  ready: boolean
  error: string | null
  retry: () => void
} {
  const [ready, setReady] = useState(records.length === 0)
  const [error, setError] = useState<string | null>(null)
  const key = records.map((r) => r.fontId).join(',')
  const keyRef = useRef(key)

  useEffect(() => {
    if (keyRef.current === key && ready) return
    keyRef.current = key
    let cancelled = false
    if (records.length === 0) {
      setReady(true)
      return
    }
    setReady(false)
    void Promise.all(records.map((record) => ensureFontRegistered(record).catch((e: unknown) => e)))
      .then((results) => {
        if (cancelled) return
        const firstError = results.find((r) => r instanceof Error) as Error | undefined
        setError(firstError ? firstError.message : null)
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [key, records, ready])

  const retry = useCallback(() => {
    setReady(false)
    void Promise.all(records.map((record) => ensureFontRegistered(record))).then(() => setReady(true))
  }, [records])

  return { ready, error: error ? `${error}（可点击重试）` : null, retry }
}
