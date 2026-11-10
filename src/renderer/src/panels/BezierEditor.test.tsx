import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DEFAULT_BEZIER } from '@shared/bezier'
import { TEXT } from '@shared/i18n'
import { BezierEditor, pointerToBezierPoint } from './BezierEditor'

/** M6-D：可视化贝塞尔曲线编辑器（SVG 拖拽两个控制点）。 */

// 与 SVG 的 132×132 画布一致（组件按 getBoundingClientRect 归一化指针）
const RECT = { left: 0, top: 0, width: 132, height: 132 }

/** 132×132 画布：内边距 14，跨度 104。 */
const size = 132
const pad = 14
const span = size - pad * 2
const toClient = (x: number, y: number): { clientX: number; clientY: number } => ({
  clientX: pad + span * x,
  clientY: size - pad - span * y
})

function setup(value = DEFAULT_BEZIER) {
  const onChange = vi.fn<(next: readonly number[]) => void>()
  const { container } = render(<BezierEditor value={value} onChange={onChange} />)
  const svg = container.querySelector('svg') as SVGSVGElement
  // jsdom 里没有布局：手动给一份盒模型（组件按它把指针换算成 0..1）
  svg.getBoundingClientRect = () => ({
    ...RECT,
    right: RECT.width,
    bottom: RECT.height,
    x: 0,
    y: 0,
    toJSON: () => RECT
  }) as DOMRect
  return { onChange, svg, container }
}

describe('pointerToBezierPoint', () => {
  it('归一化：左下角 = (0,0)、右上角 = (1,1)；夹到 [0,1]', () => {
    expect(pointerToBezierPoint(RECT, 0, 132)).toEqual({ x: 0, y: 0 })
    expect(pointerToBezierPoint(RECT, 132, 0)).toEqual({ x: 1, y: 1 })
    expect(pointerToBezierPoint(RECT, 66, 66)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointerToBezierPoint(RECT, -50, 500)).toEqual({ x: 0, y: 0 })
    expect(pointerToBezierPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBeNull()
  })
})

describe('BezierEditor', () => {
  it('渲染曲线、两个端点与两个控制点', () => {
    const { svg, container } = setup()
    expect(svg.getAttribute('aria-label')).toBe(TEXT.keyframes.bezierEditor)
    expect(container.querySelectorAll('.bezier-editor__control')).toHaveLength(2)
    expect(container.querySelectorAll('.bezier-editor__anchor')).toHaveLength(2)
    expect(container.querySelector('.bezier-editor__curve')?.getAttribute('d')).toContain('M')
    cleanup()
  })

  it('拖控制点 0：松手后按归一化坐标写回（x/y 都在 0..1）', () => {
    const { onChange, svg, container } = setup([0.25, 0.1, 0.25, 1])
    const handle = container.querySelector('[data-bezier-handle="0"]') as SVGCircleElement
    const from = toClient(0.25, 0.1)
    const to = toClient(0.7, 0.4)

    fireEvent.pointerDown(handle, { pointerId: 1, ...from })
    fireEvent.pointerMove(svg, { pointerId: 1, ...to })
    fireEvent.pointerUp(svg, { pointerId: 1, ...to })

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]![0] as unknown as [number, number, number, number]
    expect(next[0]).toBeCloseTo(0.7, 1)
    expect(next[1]).toBeCloseTo(0.4, 1)
    expect(next[2]).toBe(0.25)
    expect(next[3]).toBe(1)
    cleanup()
  })

  it('拖出画布：y 被夹到 [0,1]（不产生过冲）', () => {
    const { onChange, svg, container } = setup([0.25, 0.1, 0.25, 1])
    const handle = container.querySelector('[data-bezier-handle="0"]') as SVGCircleElement
    const from = toClient(0.25, 0.1)
    const outside = { clientX: pad + span * 0.5, clientY: -200 }

    fireEvent.pointerDown(handle, { pointerId: 2, ...from })
    fireEvent.pointerMove(svg, { pointerId: 2, ...outside })
    fireEvent.pointerUp(svg, { pointerId: 2, ...outside })

    const next = onChange.mock.calls[0]![0] as unknown as [number, number, number, number]
    expect(next[1]).toBe(1)
    expect(next[0]).toBeCloseTo(0.5, 1)
    cleanup()
  })

  it('拖控制点 1：只改后半段（p1 保持不变）', () => {
    const { onChange, svg, container } = setup([0.25, 0.1, 0.25, 1])
    const handle = container.querySelector('[data-bezier-handle="1"]') as SVGCircleElement
    const from = toClient(0.25, 1)
    const to = toClient(0.6, 0.7)

    fireEvent.pointerDown(handle, { pointerId: 4, ...from })
    fireEvent.pointerMove(svg, { pointerId: 4, ...to })
    fireEvent.pointerUp(svg, { pointerId: 4, ...to })

    const next = onChange.mock.calls[0]![0] as unknown as [number, number, number, number]
    expect(next[0]).toBe(0.25)
    expect(next[1]).toBe(0.1)
    expect(next[2]).toBeCloseTo(0.6, 1)
    expect(next[3]).toBeCloseTo(0.7, 1)
    cleanup()
  })
})
