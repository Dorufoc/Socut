import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SPLITTER_KEY_STEP_PX, type PaneEdge } from '@shared/paneLayout'
import { Splitter, type SplitterProps } from './Splitter'

/**
 * 分隔线交互契约：
 * 1) 按下进入拖拽态（捕获指针 + 显示实时读数），抬起提交并收尾；
 * 2) 拖拽中只走 onLiveResize（父级命令式写 CSS 变量），抬手才 onCommit；
 * 3) 方向系数与钳制：越界一律停在合法区间，绝不把相邻区域拖成负尺寸；
 * 4) 键盘微调与双击复位（无障碍与快速恢复）。
 */

const captured: number[] = []

beforeAll(() => {
  Element.prototype.setPointerCapture = function setCapture(pointerId: number): void {
    captured.push(pointerId)
  }
  Element.prototype.releasePointerCapture = function releaseCapture(pointerId: number): void {
    const index = captured.indexOf(pointerId)
    if (index >= 0) captured.splice(index, 1)
  }
  Element.prototype.hasPointerCapture = (pointerId: number): boolean => captured.includes(pointerId)
})

afterEach(() => {
  cleanup()
  captured.length = 0
})

function makeProps(overrides: Partial<SplitterProps> = {}): SplitterProps {
  return {
    edge: 'left' as PaneEdge,
    orientation: 'vertical',
    label: '拖动调整素材栏与预览的宽度',
    value: 300,
    min: 232,
    max: 722,
    defaultValue: 300,
    invert: false,
    onLiveResize: vi.fn(),
    onCommit: vi.fn(),
    hudText: (px: number) => `素材栏 ${px}px`,
    ...overrides
  }
}

function renderSplitter(props: SplitterProps): HTMLElement {
  const { container } = render(<Splitter {...props} />)
  return container.firstElementChild as HTMLElement
}

function pointer(clientX: number, clientY: number, button = 0): PointerEventInit {
  return { clientX, clientY, button, pointerId: 7, bubbles: true, cancelable: true }
}

describe('Splitter 拖拽', () => {
  it('按下进入拖拽态：捕获指针、标记 active、读数落在当前尺寸', () => {
    const el = renderSplitter(makeProps())

    fireEvent.pointerDown(el, pointer(300, 120))

    expect(el.className).toContain('splitter--active')
    expect(captured).toContain(7)
    expect((el.querySelector('.splitter__hud') as HTMLElement).textContent).toBe('素材栏 300px')
    expect(el.querySelector('.splitter__shield')).toBeTruthy()
  })

  it('拖动实时回报目标像素并刷新读数，抬手才提交一次', () => {
    const props = makeProps()
    const el = renderSplitter(props)

    fireEvent.pointerDown(el, pointer(300, 120))
    fireEvent.pointerMove(el, pointer(360, 120))
    expect(props.onLiveResize).toHaveBeenLastCalledWith(360)
    expect((el.querySelector('.splitter__hud') as HTMLElement).textContent).toBe('素材栏 360px')

    fireEvent.pointerMove(el, pointer(320, 120))
    expect(props.onLiveResize).toHaveBeenLastCalledWith(320)
    expect(props.onCommit).not.toHaveBeenCalled()

    fireEvent.pointerUp(el, pointer(320, 120))
    expect(props.onCommit).toHaveBeenCalledTimes(1)
    expect(props.onCommit).toHaveBeenLastCalledWith(320)
    expect(el.className).not.toContain('splitter--active')
    expect(captured).not.toContain(7)
    expect(el.querySelector('.splitter__shield')).toBeNull()
  })

  it('抬起之后的移动不再跟随（一次拖拽只服务一条线）', () => {
    const props = makeProps()
    const live = props.onLiveResize as ReturnType<typeof vi.fn>
    const el = renderSplitter(props)

    fireEvent.pointerDown(el, pointer(300, 120))
    fireEvent.pointerMove(el, pointer(340, 120))
    expect(live).toHaveBeenCalledTimes(1)

    fireEvent.pointerUp(el, pointer(340, 120))
    fireEvent.pointerMove(el, pointer(700, 120))
    expect(live).toHaveBeenCalledTimes(1)
    expect(props.onCommit).toHaveBeenCalledTimes(1)
  })

  it('钳制到合法区间：不会越过自身下限，也不许把邻居挤到保底以下', () => {
    const props = makeProps()
    const el = renderSplitter(props)

    fireEvent.pointerDown(el, pointer(300, 120))
    fireEvent.pointerMove(el, pointer(40, 120))
    expect(props.onLiveResize).toHaveBeenLastCalledWith(232)
    fireEvent.pointerMove(el, pointer(1400, 120))
    expect(props.onLiveResize).toHaveBeenLastCalledWith(722)
  })

  it('右栏与时间轴反向：指针向正方向移动挤压的是被治理区域自己', () => {
    const right = makeProps({ edge: 'right', value: 344, min: 268, max: 722, invert: true, hudText: (px) => `字幕编辑 ${px}px` })
    const rightEl = renderSplitter(right)
    fireEvent.pointerDown(rightEl, pointer(1100, 120))
    fireEvent.pointerMove(rightEl, pointer(1160, 120))
    expect(right.onLiveResize).toHaveBeenLastCalledWith(284)
    cleanup()

    const timeline = makeProps({
      edge: 'timeline',
      orientation: 'horizontal',
      value: 232,
      min: 180,
      max: 473,
      invert: true
    })
    const timelineEl = renderSplitter(timeline)
    expect(timelineEl.className).toContain('splitter--horizontal')
    fireEvent.pointerDown(timelineEl, pointer(500, 600))
    // 上移 40px：时间轴加高 40px，预览区等高减 40px
    fireEvent.pointerMove(timelineEl, pointer(500, 560))
    expect(timeline.onLiveResize).toHaveBeenLastCalledWith(272)
  })

  it('非主键按下不接管指针（不抢系统滚动与中键行为）', () => {
    const props = makeProps()
    const el = renderSplitter(props)

    fireEvent.pointerDown(el, pointer(300, 120, 1))
    expect(el.className).not.toContain('splitter--active')
    fireEvent.pointerMove(el, pointer(400, 120))
    expect(props.onLiveResize).not.toHaveBeenCalled()
  })
})

describe('Splitter 键盘与复位', () => {
  it('方向键按步长微调并直接提交，Shift 放大 4 倍', () => {
    const props = makeProps()
    const el = renderSplitter(props)

    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(props.onCommit).toHaveBeenLastCalledWith(300 + SPLITTER_KEY_STEP_PX)
    fireEvent.keyDown(el, { key: 'ArrowLeft' })
    expect(props.onCommit).toHaveBeenLastCalledWith(300 - SPLITTER_KEY_STEP_PX)
    fireEvent.keyDown(el, { key: 'ArrowRight', shiftKey: true })
    expect(props.onCommit).toHaveBeenLastCalledWith(300 + SPLITTER_KEY_STEP_PX * 4)
  })

  it('反向区域的键盘方向同样按指针方向理解（右栏 ArrowRight 是变窄）', () => {
    const props = makeProps({ edge: 'right', value: 344, min: 268, max: 722, invert: true })
    const el = renderSplitter(props)

    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(props.onCommit).toHaveBeenLastCalledWith(344 - SPLITTER_KEY_STEP_PX)
    fireEvent.keyDown(el, { key: 'ArrowLeft' })
    expect(props.onCommit).toHaveBeenLastCalledWith(344 + SPLITTER_KEY_STEP_PX)
  })

  it('横向分隔线只认上下键，双击回到默认尺寸', () => {
    const props = makeProps({
      edge: 'timeline',
      orientation: 'horizontal',
      value: 232,
      min: 180,
      max: 473,
      defaultValue: 232,
      invert: true
    })
    const el = renderSplitter(props)

    fireEvent.keyDown(el, { key: 'ArrowRight' })
    expect(props.onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(el, { key: 'ArrowUp' })
    expect(props.onCommit).toHaveBeenLastCalledWith(232 + SPLITTER_KEY_STEP_PX)

    fireEvent.doubleClick(el, { pointerId: 7 })
    expect(props.onCommit).toHaveBeenLastCalledWith(232)
  })
})

describe('Splitter 无障碍语义', () => {
  it('role=separator 暴露方向、当前值与区间，读数同步', () => {
    const el = renderSplitter(makeProps({ value: 420 }))

    expect(el.getAttribute('role')).toBe('separator')
    expect(el.getAttribute('aria-orientation')).toBe('vertical')
    expect(el.getAttribute('aria-valuemin')).toBe('232')
    expect(el.getAttribute('aria-valuemax')).toBe('722')
    expect(el.getAttribute('aria-valuenow')).toBe('420')
    expect(el.getAttribute('aria-valuetext')).toBe('素材栏 420px')
    expect(el.getAttribute('tabindex')).toBe('0')
  })

  it('静止值越界时读数取合法端点，不把坏值念给用户', () => {
    const el = renderSplitter(makeProps({ value: 900, max: 722 }))
    expect(el.getAttribute('aria-valuenow')).toBe('722')

    const inverted = renderSplitter(makeProps({ value: 10, min: 232 }))
    expect(inverted.getAttribute('aria-valuenow')).toBe('232')
  })
})
