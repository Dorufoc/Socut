import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DEFAULT_MEDIA_TRACK_ID } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createDefaultProject } from '@shared/projectSchema'
import type { MaskStroke, MediaClip, MediaClipMask } from '@shared/types'
import { MASK_POINT_MIN_DISTANCE, MaskPaintLayer } from './MaskPaintLayer'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * M8：预览画笔层。
 *
 * 锁四件事：
 * 1. pointerdown/move/up 生成一笔并提交 store，**一次 pointerup = 一次 revision**；
 * 2. client 坐标按画面矩形归一化（含边界夹取）与按距离抽稀；
 * 3. 拖动期间有半透明实时预览（黑=抹掉 / 白=擦回），单点是圆点；
 * 4. Esc/卸载/取消不提交（退出画笔后不再写工程）。
 */

const FRAME = { width: 800, height: 450 }
const POINTER = { pointerId: 1, button: 0 }

function seedClip(mask?: MediaClipMask): string {
  const project = createDefaultProject('画笔层')
  const clip: MediaClip = {
    id: 'mclip-1',
    mediaId: 'media-1',
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: 0,
    timelineEndSec: 8,
    sourceInSec: 0,
    sourceOutSec: 8,
    ...(mask ? { mask } : {})
  }
  project.mediaClips = [clip]
  useProjectStore.setState({
    project,
    selectedMediaClipId: clip.id,
    selectedClipId: null,
    selectionKind: 'media',
    revision: 1
  })
  return clip.id
}

function maskOf(id: string): MediaClipMask | undefined {
  return useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)?.mask
}

function paintLayer(props: Partial<{ mode: MaskStroke['mode']; radiusPct: number; onExit: () => void }> = {}) {
  const view = render(
    <MaskPaintLayer
      clipId="mclip-1"
      mode={props.mode ?? 'hide'}
      radiusPct={props.radiusPct ?? 4}
      width={FRAME.width}
      height={FRAME.height}
      {...(props.onExit ? { onExit: props.onExit } : {})}
    />
  )
  const layer = view.container.querySelector('.stage__mask-paint') as HTMLDivElement
  return { ...view, layer }
}

afterEach(() => {
  cleanup()
  useProjectStore.setState({
    project: createDefaultProject('空'),
    selectedMediaClipId: null,
    selectedClipId: null,
    selectionKind: 'subtitle',
    revision: 0
  })
  // 键盘快捷键会写 uiStore：复位，避免影响下一个用例
  useUiStore.setState({ maskPaint: { clipId: null, mode: 'hide', radiusPct: 4 } })
})

describe('画笔层 · 提交', () => {
  it('down→move→up：按画面矩形归一化后 append 一笔，一次 pointerup 只推一次 revision', () => {
    const id = seedClip()
    const { layer } = paintLayer()
    const before = useProjectStore.getState().revision

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    fireEvent.pointerMove(layer, { ...POINTER, clientX: 600, clientY: 225 })
    fireEvent.pointerUp(layer, { ...POINTER, clientX: 600, clientY: 225 })

    const mask = maskOf(id)!
    expect(mask.strokes).toHaveLength(1)
    expect(mask.strokes[0]!.mode).toBe('hide')
    expect(mask.strokes[0]!.radiusPct).toBe(4)
    // 800×450 的画面：中心 = (0.5, 0.5)，右移到 600px = 0.75
    expect(mask.strokes[0]!.points).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 0.75, y: 0.5 }
    ])
    expect(useProjectStore.getState().revision).toBe(before + 1)
  })

  it('两次落笔 = 两笔、两个 revision，且按落笔顺序 append', () => {
    const id = seedClip({ strokes: [{ mode: 'hide', radiusPct: 2, points: [{ x: 0.1, y: 0.1 }] }] })
    const { layer } = paintLayer()
    const before = useProjectStore.getState().revision

    for (const x of [200, 600]) {
      fireEvent.pointerDown(layer, { ...POINTER, clientX: x, clientY: 225 })
      fireEvent.pointerUp(layer, { ...POINTER, clientX: x, clientY: 225 })
    }

    const strokes = maskOf(id)!.strokes
    expect(strokes).toHaveLength(3)
    expect(strokes[0]!.points).toEqual([{ x: 0.1, y: 0.1 }])
    expect(strokes[1]!.points).toEqual([{ x: 0.25, y: 0.5 }])
    expect(strokes[2]!.points).toEqual([{ x: 0.75, y: 0.5 }])
    expect(useProjectStore.getState().revision).toBe(before + 2)
  })

  it('坐标越界夹到 0..1（画面外起笔/松手也不会写坏数据）', () => {
    const id = seedClip()
    const { layer } = paintLayer()

    fireEvent.pointerDown(layer, { ...POINTER, clientX: -200, clientY: -100 })
    fireEvent.pointerMove(layer, { ...POINTER, clientX: 2000, clientY: 900 })
    fireEvent.pointerUp(layer, { ...POINTER, clientX: 2000, clientY: 900 })

    expect(maskOf(id)!.strokes[0]!.points).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 1 }
    ])
  })

  it('移动间距小于阈值只采一个点（一笔不会画出成百上千个重复点）', () => {
    const id = seedClip()
    const { layer } = paintLayer()

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    // 0.8px / 800px = 0.001 < 阈值，丢弃
    fireEvent.pointerMove(layer, { ...POINTER, clientX: 400.8, clientY: 225 })
    // 超过阈值才采点
    fireEvent.pointerMove(layer, { ...POINTER, clientX: 400 + MASK_POINT_MIN_DISTANCE * FRAME.width + 2, clientY: 225 })
    fireEvent.pointerUp(layer, { ...POINTER, clientX: 410, clientY: 225 })

    expect(maskOf(id)!.strokes[0]!.points).toHaveLength(2)
  })

  it('restore 模式写成 restore 笔画（擦回）', () => {
    const id = seedClip()
    const { layer } = paintLayer({ mode: 'restore', radiusPct: 6 })

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    fireEvent.pointerUp(layer, { ...POINTER, clientX: 400, clientY: 225 })

    const stroke = maskOf(id)!.strokes[0]!
    expect(stroke.mode).toBe('restore')
    expect(stroke.radiusPct).toBe(6)
  })

  it('非左键起笔不采集（右键/中键不误画）', () => {
    const id = seedClip()
    const { layer } = paintLayer()

    fireEvent.pointerDown(layer, { pointerId: 2, button: 2, clientX: 400, clientY: 225 })
    fireEvent.pointerUp(layer, { pointerId: 2, button: 2, clientX: 400, clientY: 225 })

    expect(maskOf(id)).toBeUndefined()
  })
})

describe('画笔层 · 实时预览与退出', () => {
  it('拖动期间显示半透明预览：单点是圆点（半径 = lineWidth/2），两点以上是圆头折线', () => {
    seedClip()
    const { layer, container } = paintLayer()

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    // 800 宽、半径 4% → 直径 64、半径 32
    const circle = container.querySelector('circle')!
    expect(circle.getAttribute('cx')).toBe('400')
    expect(circle.getAttribute('cy')).toBe('225')
    expect(circle.getAttribute('r')).toBe('32')
    expect(circle.getAttribute('fill')).toBe('rgba(0, 0, 0, 0.45)')

    fireEvent.pointerMove(layer, { ...POINTER, clientX: 600, clientY: 225 })
    expect(container.querySelector('circle')).toBeNull()
    const polyline = container.querySelector('polyline')!
    expect(polyline.getAttribute('stroke-width')).toBe('64')
    expect(polyline.getAttribute('stroke')).toBe('rgba(0, 0, 0, 0.45)')
    expect(polyline.getAttribute('stroke-linecap')).toBe('round')

    fireEvent.pointerUp(layer, { ...POINTER, clientX: 600, clientY: 225 })
    expect(container.querySelector('polyline')).toBeNull()
  })

  it('擦回模式的预览是半透明白', () => {
    seedClip()
    const { layer, container } = paintLayer({ mode: 'restore' })

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    expect(container.querySelector('circle')!.getAttribute('fill')).toBe('rgba(255, 255, 255, 0.62)')
  })

  it('Esc：退出回调被调用，且这一笔不再提交', () => {
    const id = seedClip()
    const onExit = vi.fn()
    const { layer } = paintLayer({ onExit })

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(layer, { ...POINTER, clientX: 400, clientY: 225 })

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(maskOf(id)).toBeUndefined()
  })

  it('指针取消（pointercancel）：丢弃这一笔，不写工程', () => {
    const id = seedClip()
    const { layer } = paintLayer()

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    fireEvent.pointerMove(layer, { ...POINTER, clientX: 600, clientY: 225 })
    fireEvent.pointerCancel(layer, POINTER)
    fireEvent.pointerUp(layer, { ...POINTER, clientX: 600, clientY: 225 })

    expect(maskOf(id)).toBeUndefined()
  })

  it('只渲染提示文案与 SVG（无 mask 场景不需要额外 DOM 样式）', () => {
    seedClip()
    const { layer } = paintLayer()
    expect(layer.textContent).toContain(TEXT.mask.paintHint)
  })

  it('新笔画继承该段已有的羽化/反向（画第二笔不会把反向遮罩悄悄丢回白底）', () => {
    const id = seedClip({
      strokes: [{ mode: 'hide', radiusPct: 3, points: [{ x: 0.1, y: 0.1 }] }],
      featherPct: 4,
      invert: true
    })
    const { layer } = paintLayer()

    fireEvent.pointerDown(layer, { ...POINTER, clientX: 400, clientY: 225 })
    fireEvent.pointerUp(layer, { ...POINTER, clientX: 400, clientY: 225 })

    const mask = maskOf(id)!
    expect(mask.strokes).toHaveLength(2)
    expect(mask.featherPct).toBe(4)
    expect(mask.invert).toBe(true)
  })
})

describe('画笔层 · 快捷键', () => {
  it('[ / ] 调笔刷大小：步进 1%，clamp 到 0.5..20，不写工程', () => {
    const id = seedClip()
    useUiStore.setState({ maskPaint: { clipId: id, mode: 'hide', radiusPct: 4 } })
    paintLayer()

    fireEvent.keyDown(window, { key: ']' })
    expect(useUiStore.getState().maskPaint.radiusPct).toBe(5)
    fireEvent.keyDown(window, { key: '[' })
    fireEvent.keyDown(window, { key: '[' })
    expect(useUiStore.getState().maskPaint.radiusPct).toBe(3)

    // 下界/上界都夹住（与检查器滑杆同一个 MASK_BRUSH_RANGE）
    useUiStore.setState({ maskPaint: { clipId: id, mode: 'hide', radiusPct: 0.5 } })
    fireEvent.keyDown(window, { key: '[' })
    expect(useUiStore.getState().maskPaint.radiusPct).toBe(0.5)
    useUiStore.setState({ maskPaint: { clipId: id, mode: 'hide', radiusPct: 20 } })
    fireEvent.keyDown(window, { key: ']' })
    expect(useUiStore.getState().maskPaint.radiusPct).toBe(20)

    expect(maskOf(id)).toBeUndefined()
  })

  it('其它按键不触发笔刷变化（避免误吞输入框快捷键）', () => {
    const id = seedClip()
    useUiStore.setState({ maskPaint: { clipId: id, mode: 'hide', radiusPct: 7 } })
    paintLayer()

    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: '=' })
    expect(useUiStore.getState().maskPaint.radiusPct).toBe(7)
  })
})
