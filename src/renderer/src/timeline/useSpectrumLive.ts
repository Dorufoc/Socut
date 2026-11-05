import { useEffect, type RefObject } from 'react'
import { readPreviewLevel } from '../audio/previewLevel'
import { useUiStore } from '../state/uiStore'

/**
 * 频谱条的实时调制（v9）。
 *
 * 只有**正在发声的那一条**卡片会跑这个循环：预览侧把电平读者登记到
 * `audio/previewLevel`，这里每帧读一次写成 CSS 变量 `--spectrum-live`（命令式，
 * 一次 React 渲染都不触发）。拿不到读者（未播放 / 没有 WebAudio 图）时
 * 变量保持缺省 = 1，柱子退回「提取到的静态幅度」，不会塌成一条线。
 */

/** 起伏区间：0.82 ~ 1.17 倍柱高（静音时略收、响时略涨，读数刻度不变形）。 */
const LIVE_MIN = 0.82
const LIVE_SPAN = 0.35

export function useSpectrumLive(target: RefObject<HTMLElement | null>, clipId: string, ready: boolean): void {
  const isLive = useUiStore((state) => state.liveClipId === clipId)

  useEffect(() => {
    const element = ready ? target.current : null
    if (!isLive || !element) return
    let frame = 0
    let last = -1
    const tick = (): void => {
      const next = Math.round((LIVE_MIN + LIVE_SPAN * readPreviewLevel()) * 100) / 100
      if (next !== last) {
        last = next
        element.style.setProperty('--spectrum-live', String(next))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      element.style.removeProperty('--spectrum-live')
    }
  }, [isLive, ready, target])
}
