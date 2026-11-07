import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { defaultMediaVideo, mediaVideoCorners } from '@shared/mediaClipVideo'
import { DEFAULT_MEDIA_TRACK_ID } from '@shared/constants'
import type { MediaClip, MediaClipVideo } from '@shared/types'
import { StageTransformOverlay } from './StageTransformOverlay'
import { useProjectStore } from '../state/projectStore'
import { createDefaultProject } from '@shared/projectSchema'

/**
 * 预览画面的变换交互层（v6.1）。
 *
 * 锁四件事：
 * 1. 四个缩放圆点 + 一个旋转圆点 + 平移抓手都在，且都带可读标签；
 * 2. 拖角缩放 = 以画面中心为基准（指针到中心距离翻倍 → 缩放翻倍），并写回同一条媒体段；
 * 3. 画面内拖拽 = 改位移百分比，靠近中线/边线时吸附并画出辅助线；
 * 4. 拖旋转圆点 = 改角度（0..360），与面板滑杆是同一字段。
 */

const FRAME = { width: 800, height: 450 }

function seedClip(video?: MediaClipVideo): string {
  const project = createDefaultProject('交互层')
  const clip: MediaClip = {
    id: 'mclip-1',
    mediaId: 'media-1',
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: 0,
    timelineEndSec: 8,
    sourceInSec: 0,
    sourceOutSec: 8,
    ...(video ? { video } : {})
  }
  project.mediaClips = [clip]
  useProjectStore.setState({ project, selectedMediaClipId: clip.id, selectedClipId: null, selectionKind: 'media', revision: 1 })
  return clip.id
}

const videoOf = (id: string) =>
  useProjectStore.getState().project.mediaClips.find((item) => item.id === id)!.video as MediaClipVideo

/** jsdom 没有布局：把 SVG 的盒子伪造成帧尺寸，client 坐标就能直接当帧坐标用 */
function stubRect(svg: SVGSVGElement): void {
  svg.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: FRAME.width, height: FRAME.height, right: FRAME.width, bottom: FRAME.height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
}

afterEach(() => {
  cleanup()
  act(() => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedMediaClipId: null, selectionKind: 'subtitle' })
  })
})

describe('交互层的形状', () => {
  it('四个缩放圆点 + 旋转圆点 + 平移抓手，标签齐全', () => {
    const id = seedClip()
    const { container } = render(
      <StageTransformOverlay clip={useProjectStore.getState().project.mediaClips[0]!} video={defaultMediaVideo()} frame={FRAME} />
    )
    expect(id).toBe('mclip-1')
    expect(container.querySelectorAll('.stage-interact__handle')).toHaveLength(4)
    expect(container.querySelectorAll('.stage-interact__rotate')).toHaveLength(1)
    expect(container.querySelector('.stage-interact__surface')).toBeTruthy()
    expect(screen.getByRole('button', { name: /缩放 3/ })).toBeTruthy()
  })

  it('缩放后四角跟着变（手柄用的是同一套几何函数）', () => {
    const video = { ...defaultMediaVideo(), scalePercent: 50 }
    seedClip(video)
    const { container } = render(<StageTransformOverlay clip={useProjectStore.getState().project.mediaClips[0]!} video={video} frame={FRAME} />)
    const handles = Array.from(container.querySelectorAll('.stage-interact__handle'))
    const expected = mediaVideoCorners(video, FRAME)
    handles.forEach((handle, index) => {
      expect(Number(handle.getAttribute('cx'))).toBeCloseTo(expected[index]!.x, 6)
      expect(Number(handle.getAttribute('cy'))).toBeCloseTo(expected[index]!.y, 6)
    })
  })
})

describe('拖拽缩放', () => {
  it('拖右下角：指针到中心距离翻倍 → 缩放 200%，并写回同一条片段', () => {
    const id = seedClip()
    const { container } = render(
      <StageTransformOverlay clip={useProjectStore.getState().project.mediaClips[0]!} video={defaultMediaVideo()} frame={FRAME} />
    )
    const svg = container.querySelector('.stage-interact') as SVGSVGElement
    stubRect(svg)

    const corner = screen.getByRole('button', { name: /缩放 3/ })
    // 右下角在 (800, 450)，中心在 (400, 225)
    fireEvent.pointerDown(corner, { pointerId: 1, clientX: 800, clientY: 450 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 1200, clientY: 675 })

    expect(videoOf(id).scalePercent).toBe(200)
    // 拖拽时给出读数
    expect(container.querySelector('.stage-interact__hud')?.textContent).toBe('200%')

    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 1200, clientY: 675 })
    expect(container.querySelector('.stage-interact__hud')).toBeNull()
  })
})

describe('拖拽平移与辅助线', () => {
  it('拖动画面改位移百分比（不吸附时不出辅助线）', () => {
    const id = seedClip()
    const { container } = render(
      <StageTransformOverlay clip={useProjectStore.getState().project.mediaClips[0]!} video={defaultMediaVideo()} frame={FRAME} />
    )
    const svg = container.querySelector('.stage-interact') as SVGSVGElement
    stubRect(svg)

    const surface = container.querySelector('.stage-interact__surface')!
    fireEvent.pointerDown(surface, { pointerId: 2, clientX: 400, clientY: 225 })
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 440, clientY: 225 })

    // 40px / 800px = 5%
    expect(videoOf(id).offsetXPercent).toBe(5)
    expect(videoOf(id).offsetYPercent).toBe(0)
    // 水平方向没到吸附线，但垂直仍在正中 → 只出一条水平居中导引线
    const guides = container.querySelectorAll('.stage-interact__guide')
    expect(guides).toHaveLength(1)
    expect(Number(guides[0]!.getAttribute('y1'))).toBe(FRAME.height / 2)
  })

  it('靠近中线时吸附到 0 并画出居中辅助线', () => {
    seedClip()
    const { container } = render(
      <StageTransformOverlay clip={useProjectStore.getState().project.mediaClips[0]!} video={defaultMediaVideo()} frame={FRAME} />
    )
    const svg = container.querySelector('.stage-interact') as SVGSVGElement
    stubRect(svg)

    const surface = container.querySelector('.stage-interact__surface')!
    fireEvent.pointerDown(surface, { pointerId: 3, clientX: 400, clientY: 225 })
    // 只偏 3px（0.375%）→ 落在 1.5% 容差内，吸附回中心 = 回到默认位置（整键删除）
    fireEvent.pointerMove(svg, { pointerId: 3, clientX: 403, clientY: 225 })

    expect(useProjectStore.getState().project.mediaClips[0]!.video).toBeUndefined()
    // 两个轴都回到正中 → 竖/横两条居中导引线
    const guides = Array.from(container.querySelectorAll('.stage-interact__guide'))
    expect(guides).toHaveLength(2)
    const vertical = guides.find((line) => line.getAttribute('x1') === line.getAttribute('x2'))!
    expect(Number(vertical.getAttribute('x1'))).toBe(FRAME.width / 2)
  })
})

describe('拖拽旋转', () => {
  it('从正上方拖到正右方 → 旋转 90°', () => {
    const id = seedClip()
    const { container } = render(
      <StageTransformOverlay clip={useProjectStore.getState().project.mediaClips[0]!} video={defaultMediaVideo()} frame={FRAME} />
    )
    const svg = container.querySelector('.stage-interact') as SVGSVGElement
    stubRect(svg)

    const rotate = container.querySelector('.stage-interact__rotate')!
    // 以中心 (400,225) 为基准：起点正上方、终点正右方
    fireEvent.pointerDown(rotate, { pointerId: 4, clientX: 400, clientY: 25 })
    fireEvent.pointerMove(svg, { pointerId: 4, clientX: 600, clientY: 225 })

    expect(videoOf(id).rotationDeg).toBe(90)
    expect(container.querySelector('.stage-interact__hud')?.textContent).toBe('90°')
  })

  it('转过 360° 会归一到 0..360，不出现负角度或超大角度', () => {
    const id = seedClip({ ...defaultMediaVideo(), rotationDeg: 350 })
    const { container } = render(
      <StageTransformOverlay clip={useProjectStore.getState().project.mediaClips[0]!} video={{ ...defaultMediaVideo(), rotationDeg: 350 }} frame={FRAME} />
    )
    const svg = container.querySelector('.stage-interact') as SVGSVGElement
    stubRect(svg)

    const rotate = container.querySelector('.stage-interact__rotate')!
    fireEvent.pointerDown(rotate, { pointerId: 5, clientX: 400, clientY: 25 })
    fireEvent.pointerMove(svg, { pointerId: 5, clientX: 600, clientY: 225 })

    const degrees = videoOf(id).rotationDeg
    expect(degrees).toBeGreaterThanOrEqual(0)
    expect(degrees).toBeLessThan(360)
    expect(degrees).toBeCloseTo(80, 6) // 350 + 90 = 440 → 80
  })
})
