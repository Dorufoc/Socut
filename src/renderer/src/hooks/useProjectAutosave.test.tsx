/**
 * 自动保存钩子测试（规格 §4.6 + 「每完成一次操作都持久化」）：
 * - 一次操作完成（revision 停止变化）后按 debounce 落盘，拖拽连续改值合并成一次写入；
 * - beforeunload / visibilitychange 把未到期的 debounce 立即刷成写入；
 * - 同一 revision 不重复写（主进程写盘失败才重试）。
 * 另测启动自动恢复的进度判据 hasRestoreProgress。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { AUTOSAVE_DEBOUNCE_MS, DEFAULT_AUDIO_TRACK_ID, DEFAULT_MEDIA_TRACK_ID } from '@shared/constants'
import { createDefaultProject, createClip } from '@shared/projectSchema'
import type { Project, WatermarkSettings } from '@shared/types'
import { useProjectAutosave } from './useProjectAutosave'
import { hasRestoreProgress } from '../App'
import { useProjectStore } from '../state/projectStore'

const autosaveWrite = vi.fn(async (_project: Project): Promise<void> => undefined)
const writeLog = vi.fn(async (): Promise<void> => undefined)

beforeEach(() => {
  vi.useFakeTimers()
  autosaveWrite.mockReset()
  writeLog.mockReset()
  useProjectStore.setState({ project: createDefaultProject('自动保存'), revision: 0 })
  ;(window as unknown as { focusnews: unknown }).focusnews = {
    project: { autosaveWrite },
    app: { writeLog }
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useProjectAutosave', () => {
  it('一次操作完成后按 debounce 落盘，拖拽连续改值合并成一次写入', async () => {
    renderHook(() => useProjectAutosave())
    const state = useProjectStore.getState()
    // 模拟一段拖拽：同一手势里 revision 连涨 3 次
    act(() => {
      useProjectStore.setState({ revision: state.revision + 1 })
      useProjectStore.setState({ revision: state.revision + 2 })
      useProjectStore.setState({ revision: state.revision + 3 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1)
    })
    expect(autosaveWrite).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    // 整段手势只写一次，且写的是最终状态
    expect(autosaveWrite).toHaveBeenCalledTimes(1)
    expect(autosaveWrite.mock.calls[0]?.[0]).toBe(useProjectStore.getState().project)
  })

  it('关窗（beforeunload）把未到期的 debounce 立即刷成写入', async () => {
    renderHook(() => useProjectAutosave())
    act(() => {
      useProjectStore.setState({ revision: useProjectStore.getState().revision + 1 })
    })
    // 还没到 debounce 就关窗：不能等定时器，必须马上发出
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    expect(autosaveWrite).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    })
    // 已落盘的 revision 不再被定时器重复写
    expect(autosaveWrite).toHaveBeenCalledTimes(1)
  })

  it('页签切走（visibilitychange）同样立即刷新进度', () => {
    renderHook(() => useProjectAutosave())
    act(() => {
      useProjectStore.setState({ revision: useProjectStore.getState().revision + 1 })
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(autosaveWrite).toHaveBeenCalledTimes(1)
  })

  it('写盘失败后下一次操作会重新发出，同一 revision 不重复写', async () => {
    autosaveWrite.mockRejectedValueOnce(new Error('disk full'))
    renderHook(() => useProjectAutosave())
    act(() => {
      useProjectStore.setState({ revision: useProjectStore.getState().revision + 1 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1)
    })
    expect(autosaveWrite).toHaveBeenCalledTimes(1)
    expect(writeLog).toHaveBeenCalled()
    // 新一次操作 → 新 revision → 重新落盘
    act(() => {
      useProjectStore.setState({ revision: useProjectStore.getState().revision + 1 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 1)
    })
    expect(autosaveWrite).toHaveBeenCalledTimes(2)
  })

  it('revision 为 0（冷启动默认工程）不写盘', async () => {
    renderHook(() => useProjectAutosave())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)
    })
    expect(autosaveWrite).not.toHaveBeenCalled()
  })
})

describe('hasRestoreProgress（启动自动恢复判据）', () => {
  it('空工程 / 纯参数改动不恢复', () => {
    expect(hasRestoreProgress(createDefaultProject('空'))).toBe(false)
  })

  it('字幕轨有内容就恢复', () => {
    const project = createDefaultProject('有字幕')
    project.clips.push(createClip({ startTime: 0, fps: project.fps }))
    expect(hasRestoreProgress(project)).toBe(true)
  })

  it('媒体轨 / 音频轨 / 启用的水印各自都算编辑进度', () => {
    const base = createDefaultProject('轨道判据')
    const watermark: WatermarkSettings = {
      enabled: true,
      path: 'C:/x/wm.png',
      name: 'wm.png',
      sourceWidth: 200,
      sourceHeight: 80,
      importedAt: '2026-01-01T00:00:00.000Z'
    }
    const withMedia: Project = {
      ...base,
      mediaClips: [
        {
          id: 'mclip-1',
          mediaId: 'media-1',
          trackId: DEFAULT_MEDIA_TRACK_ID,
          timelineStartSec: 0,
          timelineEndSec: 4,
          sourceInSec: 0,
          sourceOutSec: 4
        }
      ]
    }
    expect(hasRestoreProgress(withMedia)).toBe(true)
    const withAudio: Project = {
      ...base,
      audioClips: [
        {
          id: 'aclip-1',
          mediaId: 'media-1',
          trackId: DEFAULT_AUDIO_TRACK_ID,
          timelineStartSec: 0,
          timelineEndSec: 4,
          sourceInSec: 0,
          sourceOutSec: 4
        }
      ]
    }
    expect(hasRestoreProgress(withAudio)).toBe(true)
    const withWatermark: Project = { ...base, watermark }
    expect(hasRestoreProgress(withWatermark)).toBe(true)
    const withDisabledWatermark: Project = { ...base, watermark: { ...watermark, enabled: false } }
    expect(hasRestoreProgress(withDisabledWatermark)).toBe(false)
  })
})
