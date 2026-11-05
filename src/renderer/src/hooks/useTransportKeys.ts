import { useEffect, useRef } from 'react'
import { useUiStore } from '../state/uiStore'

/**
 * 播放键盘（Transport 快捷键）：
 * - `空格`：播放 / 暂停；
 * - `←` / `→`：上一帧 / 下一帧，按住不放先等一拍，之后连续跳（长按连跳）。
 *
 * 三条让位规则：
 * 1. 焦点在文本类控件（输入框 / 多行文本 / 下拉 / contentEditable）时一律放行——
 *    空格要在框里打字符、下拉要用方向键换选项，抢走就是 bug；
 * 2. 门禁弹窗排队中不生效——不能拿空格绕过「必须确认」的阻断（规格 §6）；
 * 3. 带修饰键的组合（Ctrl/Cmd/Alt）与已被别处 preventDefault 的按键不接手。
 *
 * 连跳节奏由本模块自己计时，不认系统按键重复（`event.repeat` 一律忽略）：
 * 否则节奏跟着操作系统的重复率设置走，既可能慢到看不清，也可能快得跳过目标帧。
 */

/** 长按起跳的等待时长（毫秒）：太短会把「单帧确认」误判成连跳 */
export const FRAME_HOLD_DELAY_MS = 320
/** 连跳节奏（毫秒/帧）：慢到看得清每一帧，又不至于按一次跑到别处 */
export const FRAME_REPEAT_INTERVAL_MS = 60

/**
 * 焦点是否落在文本类控件里（`App.tsx` 的 Ctrl+B / Delete 用同一条判据）。
 * 按钮不算：空格按下时由本模块统一 preventDefault，避免「焦点按钮被再点一次 = 切换两下」。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  const tag = element?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element?.isContentEditable === true
}

/** 方向键 → 帧步长；其余键返回 0。 */
export function stepDeltaOf(key: string): number {
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  return 0
}

/** 空格键（`Spacebar` 是旧 Chromium 的键名，一并认）。 */
function isSpace(key: string): boolean {
  return key === ' ' || key === 'Spacebar'
}

export interface TransportKeys {
  /** 空格：切换播放 / 暂停 */
  togglePlay: () => void
  /** ←/→：按帧数跳转（-1 上一帧 / +1 下一帧），长按连跳时会被反复调用 */
  stepFrame: (deltaFrames: number) => void
}

export function useTransportKeys(keys: TransportKeys): void {
  // 处理器进 ref：回调换身份（预览规格重建是常态）不必重挂监听
  const keysRef = useRef(keys)
  keysRef.current = keys

  useEffect(() => {
    let holdKey: string | null = null
    let armTimer: number | null = null
    let repeatTimer: number | null = null

    const stopHold = (): void => {
      if (armTimer !== null) window.clearTimeout(armTimer)
      if (repeatTimer !== null) window.clearInterval(repeatTimer)
      armTimer = null
      repeatTimer = null
      holdKey = null
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      if (useUiStore.getState().dialogQueue.length > 0) return
      // 带修饰键的组合归别的快捷键管（Ctrl+B 拆分……），方向键也留给文本光标
      if (event.ctrlKey || event.metaKey || event.altKey) return
      // 已被别处消费掉的按键不再接手：分隔线（role=separator）的方向键自己 preventDefault 过，
      // 冒泡到 window 后再跳帧就会变成「调布局同时把播放头乱推」
      if (event.defaultPrevented) return

      if (isSpace(event.key)) {
        // 按住空格会连发 keydown：一次按下只切换一次
        if (event.repeat) return
        // 拦下默认行为：否则空格会滚动预览区，或激活当前聚焦的按钮
        event.preventDefault()
        keysRef.current.togglePlay()
        return
      }

      const delta = stepDeltaOf(event.key)
      if (delta === 0) return
      event.preventDefault()
      // 系统重复的 keydown 与「同一键已在连跳中」都不再起头，否则会叠出两个定时器
      if (event.repeat || holdKey === event.key) return
      // 换方向：先把上一个键的连跳断开，否则左右两边会同时推着播放头抖
      stopHold()
      holdKey = event.key
      keysRef.current.stepFrame(delta)
      const stepDelta = delta
      armTimer = window.setTimeout(() => {
        armTimer = null
        repeatTimer = window.setInterval(() => {
          // 焦点中途进了输入框也要停：不能背着用户继续推进播放头
          if (isEditableTarget(document.activeElement)) {
            stopHold()
            return
          }
          keysRef.current.stepFrame(stepDelta)
        }, FRAME_REPEAT_INTERVAL_MS)
      }, FRAME_HOLD_DELAY_MS)
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      if (stepDeltaOf(event.key) !== 0 && event.key === holdKey) stopHold()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    // 窗口失焦后 keyup 不会送达：不在此断掉就等于「按住方向键出门」连跳到回来
    window.addEventListener('blur', stopHold)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', stopHold)
      stopHold()
    }
  }, [])
}
