import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { PANE_PREFS_KEY, readPaneRatios, writePaneRatios } from './panePrefs'
import { usePaneLayout } from './usePaneLayout'
import { Splitter } from '../components/ui/Splitter'

/**
 * 伸缩布局控制器的三条行为契约（用 DOM 事实来证明，而不是内部变量）：
 * 1. 冷启动默认 == 历史固定尺寸；有存档则按存档比例恢复；
 * 2. 拖拽中**不重渲染外层界面**（只命令式写 CSS 变量），抬手才提交状态并持久化；
 * 3. 窗口尺寸变化时按保持比例重新解算，三栏与两区始终恰好填满容器。
 */

const SHELL = { width: 1440, height: 700 }
let resizeCallback: (() => void) | null = null
let harnessRenders = 0

beforeAll(() => {
  Element.prototype.setPointerCapture = () => undefined
  Element.prototype.releasePointerCapture = () => undefined
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.getBoundingClientRect = function getRect(this: Element): DOMRect {
    const width = this.classList.contains('shell') ? SHELL.width : 0
    const height = this.classList.contains('shell') ? SHELL.height : 0
    return {
      width,
      height,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect
  }
  class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = () => callback([], this as unknown as ResizeObserver)
    }
    observe(): void {
      // 真实 ResizeObserver 首次 observe 也会回报一次，桩保持一致
      resizeCallback?.()
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
})

beforeEach(() => {
  globalThis.localStorage.clear()
  SHELL.width = 1440
  SHELL.height = 700
  harnessRenders = 0
})

afterEach(() => {
  cleanup()
  resizeCallback = null
})

function Harness(): ReactElement {
  harnessRenders += 1
  const layout = usePaneLayout()
  return (
    <div
      className="shell"
      ref={layout.shellRef}
      style={layout.shellStyle}
      data-left={layout.sizes.left}
      data-center={layout.sizes.center}
      data-right={layout.sizes.right}
      data-stage={layout.sizes.stage}
      data-timeline={layout.sizes.timeline}
    >
      <div className="body">
        <aside className="rail" />
        <Splitter {...layout.splitterProps('left')} />
        <main className="stage" />
        <Splitter {...layout.splitterProps('right')} />
        <aside className="inspector-dock" />
      </div>
      <Splitter {...layout.splitterProps('timeline')} />
      <footer className="timeline-dock" />
      <button type="button" onClick={layout.resetLayout}>
        reset
      </button>
    </div>
  )
}

interface Scene {
  shell: HTMLElement
  sizeOf: (key: 'left' | 'center' | 'right' | 'stage' | 'timeline') => number
  /** CSS 变量当前生效值：拖拽中的实时尺寸就长在这里 */
  varOf: (name: '--pane-left' | '--pane-right' | '--pane-timeline') => string
  splitter: (edge: string) => HTMLElement
}

/**
 * 真实启动路径的缩影：应用先落在「最近项目」页（没有 `.shell`），
 * 新建/打开工程后编辑器骨架才挂载。测量必须跟着后挂载的 `.shell` 重建。
 */
function DeferredHarness(): ReactElement {
  const layout = usePaneLayout()
  const [mounted, setMounted] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setMounted(true)}>
        open-editor
      </button>
      {mounted ? (
        <div
          className="shell"
          ref={layout.shellRef}
          style={layout.shellStyle}
          data-left={layout.sizes.left}
          data-center={layout.sizes.center}
          data-right={layout.sizes.right}
          data-stage={layout.sizes.stage}
          data-timeline={layout.sizes.timeline}
        >
          <div className="body">
            <aside className="rail" />
            <Splitter {...layout.splitterProps('left')} />
            <main className="stage" />
            <Splitter {...layout.splitterProps('right')} />
            <aside className="inspector-dock" />
          </div>
          <Splitter {...layout.splitterProps('timeline')} />
          <footer className="timeline-dock" />
        </div>
      ) : null}
    </div>
  )
}

function mount(): Scene {
  const { container } = render(<Harness />)
  const shell = container.querySelector('.shell') as HTMLElement
  return {
    shell,
    sizeOf: (key) => Number(shell.dataset[key]),
    varOf: (name) => shell.style.getPropertyValue(name),
    splitter: (edge) => container.querySelector(`.splitter[data-edge="${edge}"]`) as HTMLElement
  }
}

function pointer(clientX: number, clientY: number): PointerEventInit {
  return { clientX, clientY, button: 0, pointerId: 11, bubbles: true, cancelable: true }
}

/** 模拟窗口缩放：改容器实测尺寸并回报一次 ResizeObserver（React 状态更新要在 act 里发生） */
function resizeTo(width: number, height = 700): void {
  SHELL.width = width
  SHELL.height = height
  act(() => {
    resizeCallback?.()
  })
}

describe('usePaneLayout 测量生命周期', () => {
  it('编辑器骨架后挂载（最近项目页 → 新建工程）仍能测得尺寸，拖拽不会把区域写成 0', () => {
    const { container } = render(<DeferredHarness />)
    expect(container.querySelector('.shell')).toBeNull()

    fireEvent.click(container.querySelector('button') as HTMLElement)
    const shell = container.querySelector('.shell') as HTMLElement
    // 后挂载也要立刻拿到真实容器尺寸，而不是停在 0
    expect(Number(shell.dataset.left)).toBe(300)
    expect(Number(shell.dataset.right)).toBe(344)
    expect(Number(shell.dataset.timeline)).toBe(232)

    const splitter = container.querySelector('.splitter[data-edge="left"]') as HTMLElement
    fireEvent.pointerDown(splitter, pointer(300, 120))
    fireEvent.pointerMove(splitter, pointer(360, 120))

    // 其余两区保持原尺寸，任何一个都不能被写成 0
    expect(shell.style.getPropertyValue('--pane-left')).toBe('360px')
    expect(shell.style.getPropertyValue('--pane-right')).toBe('344px')
    expect(shell.style.getPropertyValue('--pane-timeline')).toBe('232px')

    fireEvent.pointerUp(splitter, pointer(360, 120))
    expect(Number(shell.dataset.left)).toBe(360)
    expect(Number(shell.dataset.center)).toBe(1440 - 14 - 360 - 344)
    expect(readPaneRatios()).toEqual({ left: 0.25, right: 0.2389, timeline: 0.3314 })
  })

  it('容器尺寸还没测到时拖拽完全无效：不写 0px，也不落盘零比例', () => {
    SHELL.width = 0
    SHELL.height = 0
    const scene = mount()
    const splitter = scene.splitter('left')

    fireEvent.pointerDown(splitter, pointer(0, 0))
    fireEvent.pointerMove(splitter, pointer(240, 0))
    fireEvent.pointerUp(splitter, pointer(240, 0))

    expect(scene.varOf('--pane-left')).toBe('')
    expect(scene.varOf('--pane-right')).toBe('')
    expect(scene.varOf('--pane-timeline')).toBe('')
    expect(readPaneRatios()).toBeNull()
  })
})

describe('usePaneLayout 冷启动与恢复', () => {
  it('无存档时就是历史固定布局：左 300 / 右 344 / 时间轴 232', () => {
    const scene = mount()
    expect(scene.sizeOf('left')).toBe(300)
    expect(scene.sizeOf('right')).toBe(344)
    expect(scene.sizeOf('timeline')).toBe(232)
    expect(scene.sizeOf('center')).toBe(1440 - 14 - 300 - 344)
    expect(scene.sizeOf('stage')).toBe(700 - 7 - 232)
    // 首帧就把变量写进 DOM，React 渲染与命令式路径同源
    expect(scene.varOf('--pane-left')).toBe('300px')
    expect(scene.varOf('--pane-timeline')).toBe('232px')
  })

  it('有存档时按比例恢复，而不是回到默认', () => {
    writePaneRatios({ left: 0.3, right: 0.2, timeline: 0.4 })
    const scene = mount()
    expect(scene.sizeOf('left')).toBe(432)
    expect(scene.sizeOf('right')).toBe(288)
    expect(scene.sizeOf('timeline')).toBe(280)
  })

  it('存档坏了一个字节也不影响开机：落回默认布局', () => {
    globalThis.localStorage.setItem(PANE_PREFS_KEY, '{oops')
    const scene = mount()
    expect(scene.sizeOf('left')).toBe(300)
  })
})

describe('usePaneLayout 拖拽', () => {
  it('拖动左栏：过程中外层界面一次都不重渲染，只写 CSS 变量；抬手才提交并落盘', () => {
    const scene = mount()
    const splitter = scene.splitter('left')
    const rendersAtRest = harnessRenders

    fireEvent.pointerDown(splitter, pointer(300, 120))
    fireEvent.pointerMove(splitter, pointer(340, 120))

    expect(scene.varOf('--pane-left')).toBe('340px')
    fireEvent.pointerMove(splitter, pointer(360, 120))
    expect(scene.varOf('--pane-left')).toBe('360px')
    expect(harnessRenders).toBe(rendersAtRest)
    expect(scene.sizeOf('left')).toBe(300)
    expect(readPaneRatios()).toBeNull()

    fireEvent.pointerUp(splitter, pointer(360, 120))

    expect(scene.sizeOf('left')).toBe(360)
    expect(scene.sizeOf('center')).toBe(1440 - 14 - 360 - 344)
    expect(harnessRenders).toBeGreaterThan(rendersAtRest)
    expect(readPaneRatios()).toEqual({ left: 0.25, right: 0.2389, timeline: 0.3314 })
  })

  it('拖动时间轴上边缘：同一次拖拽同时改写预览区与时间轴的高度', () => {
    const scene = mount()
    const splitter = scene.splitter('timeline')

    fireEvent.pointerDown(splitter, pointer(500, 600))
    fireEvent.pointerMove(splitter, pointer(500, 560))
    expect(scene.varOf('--pane-timeline')).toBe('272px')
    fireEvent.pointerUp(splitter, pointer(500, 560))

    expect(scene.sizeOf('timeline')).toBe(272)
    expect(scene.sizeOf('stage')).toBe(700 - 7 - 272)
    expect(scene.sizeOf('stage') + scene.sizeOf('timeline') + 7).toBe(700)
  })

  it('拖动右栏：加宽的是字幕编辑，收窄的是预览', () => {
    const scene = mount()
    const splitter = scene.splitter('right')

    fireEvent.pointerDown(splitter, pointer(1100, 120))
    fireEvent.pointerMove(splitter, pointer(1040, 120))
    fireEvent.pointerUp(splitter, pointer(1040, 120))

    expect(scene.sizeOf('right')).toBe(404)
    expect(scene.sizeOf('center')).toBe(1440 - 14 - 300 - 404)
    expect(scene.sizeOf('left')).toBe(300)
  })

  it('想拖过保底也拖不过去：左栏最大受中栏保底宽与自身上限约束', () => {
    const scene = mount()
    const splitter = scene.splitter('left')

    fireEvent.pointerDown(splitter, pointer(300, 120))
    fireEvent.pointerMove(splitter, pointer(1440, 120))
    fireEvent.pointerUp(splitter, pointer(1440, 120))

    // 中栏保底 360 时左栏最多 1440-14-360-344 = 722，但自身上限 520 先生效
    expect(scene.sizeOf('left')).toBe(520)
    expect(scene.sizeOf('center')).toBeGreaterThanOrEqual(360)
    expect(scene.sizeOf('left') + scene.sizeOf('center') + scene.sizeOf('right') + 14).toBe(1440)
  })

  it('窗口尺寸变化：没偏好时守默认像素，拖过一次后按记住的比例缩放', () => {
    const scene = mount()
    expect(scene.sizeOf('left')).toBe(300)

    // 无存档 = 从未表达过习惯：缩放窗口仍守默认像素，不跟着放大
    resizeTo(1920)
    expect(scene.sizeOf('left')).toBe(300)
    resizeTo(1440)

    // 拖一次就成了习惯：比例落盘，后续缩放都按这条比例走
    const splitter = scene.splitter('left')
    fireEvent.pointerDown(splitter, pointer(300, 120))
    fireEvent.pointerUp(splitter, pointer(360, 120))
    expect(scene.sizeOf('left')).toBe(360)
    expect(readPaneRatios()?.left).toBeCloseTo(0.25, 4)

    resizeTo(1920)
    expect(scene.sizeOf('left')).toBe(480)
    expect(scene.sizeOf('left') + scene.sizeOf('center') + scene.sizeOf('right') + 14).toBe(1920)
  })

  it('恢复默认布局：清掉本机存档并回到初始三条尺寸', () => {
    const scene = mount()
    const splitter = scene.splitter('left')
    fireEvent.pointerDown(splitter, pointer(300, 120))
    fireEvent.pointerUp(splitter, pointer(430, 120))
    expect(readPaneRatios()).not.toBeNull()

    fireEvent.click(scene.shell.querySelector('button') as HTMLElement)

    expect(globalThis.localStorage.getItem(PANE_PREFS_KEY)).toBeNull()
    expect(scene.sizeOf('left')).toBe(300)
    expect(scene.sizeOf('right')).toBe(344)
    expect(scene.sizeOf('timeline')).toBe(232)
  })
})
