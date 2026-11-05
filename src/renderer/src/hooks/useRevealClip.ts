import { useCallback } from 'react'
import { revealTargetSec } from '@shared/clipStyle'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 「改了就该看得见」。
 *
 * 样式面板写完参数后调用它：若播放头此刻不在所选片段「样式已完整呈现」的窗口里
 * （最常见：片段 10s 才入，而播放头停在 0s），就把播放头落到入场完成后的第一帧，
 * 于是配色 / 字体 / 字号 / 动画的改动立即反映在预览区。
 *
 * 保守规则（不与用户抢播放头）：播放中不动、已经看得见不动——判定在
 * `shared/clipStyle.revealTargetSec` 里，是纯函数，可单测。
 */
export function useRevealClip(): (clipId: string) => void {
  return useCallback((clipId: string): void => {
    const project = useProjectStore.getState().project
    const clip = project.clips.find((item) => item.id === clipId)
    if (!clip) return
    const ui = useUiStore.getState()
    const target = revealTargetSec(clip, project.fps, ui.displayTimeSec, ui.playing)
    if (target === null) return
    ui.seekHandler?.(target)
  }, [])
}
