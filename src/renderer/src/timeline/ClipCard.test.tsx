import { describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import type { KeyframeTrack } from '@shared/keyframes'
import type { SubtitleClip } from '@shared/types'
import { ClipCard } from './ClipCard'

/** M6：字幕条上的关键帧菱形（多参数同一 t 只画一个；位置按片段进度映射）。 */

function makeClip(keyframes?: KeyframeTrack[]): SubtitleClip {
  return {
    id: 'clip-1',
    startTime: 1,
    endTime: 3,
    presetId: 'stackedNews',
    styleOverrides: {},
    content: { title: '测试标题', subtitle: '' },
    animation: {
      inDuration: 12,
      outDuration: 9,
      easing: 'outCubic',
      textRevealFrames: 3,
      displacement: { x: 0, y: 0 }
    },
    fontId: 'noto-sans-sc-bold',
    ...(keyframes ? { keyframes } : {})
  }
}

const props = {
  durationSec: 10,
  widthPx: 1000,
  fps: FPS_30,
  selected: false,
  playheadSec: 0,
  onSelect: () => undefined,
  onChangeTimes: () => undefined,
  onSeekKeyframe: undefined as ((atSec: number) => void) | undefined
}

describe('ClipCard 关键帧菱形', () => {
  it('无关键帧：不渲染菱形', () => {
    const { container } = render(<ClipCard clip={makeClip()} {...props} />)
    expect(container.querySelectorAll('.clip-card__keyframe')).toHaveLength(0)
    cleanup()
  })

  it('多参数同一 t 去重；位置 = 条内进度 × 条宽', () => {
    const keyframes: KeyframeTrack[] = [
      { param: 'opacity', points: [{ t: 0.25, value: 0.5, easing: 'linear' }] },
      { param: 'scalePct', points: [{ t: 0.25, value: 120, easing: 'linear' }, { t: 0.75, value: 100, easing: 'linear' }] }
    ]
    const { container } = render(<ClipCard clip={makeClip(keyframes)} {...props} />)
    const markers = [...container.querySelectorAll('.clip-card__keyframe')] as HTMLElement[]
    expect(markers).toHaveLength(2)
    expect(markers.map((marker) => marker.dataset.keyframeT)).toEqual(['0.25', '0.75'])
    // 菱形相对卡片定位：条宽 200px，t=0.25 → 50px，t=0.75 → 150px
    expect(markers[0]!.style.left).toBe('50px')
    expect(markers[1]!.style.left).toBe('150px')
    expect(markers[0]!.title).toContain('25%')
    cleanup()
  })

  it('t=0 / t=1 的菱形被夹在条内（不溢出到相邻片段）', () => {
    const keyframes: KeyframeTrack[] = [
      {
        param: 'rotationDeg',
        points: [
          { t: 0, value: 0, easing: 'linear' },
          { t: 1, value: 10, easing: 'linear' }
        ]
      }
    ]
    const { container } = render(<ClipCard clip={makeClip(keyframes)} {...props} />)
    const markers = [...container.querySelectorAll('.clip-card__keyframe')] as HTMLElement[]
    expect(markers.map((marker) => marker.style.left)).toEqual(['2px', '198px'])
    cleanup()
  })
})
describe('M6-D：点菱形跳帧', () => {
  it('点击关键帧菱形 → 回调时间轴位置（入点 + t × 时长）且不触发拖拽', () => {
    const seeks: number[] = []
    const keyframes: KeyframeTrack[] = [
      { param: 'opacity', points: [{ t: 0.5, value: 0.5, easing: 'linear' }] }
    ]
    const { container } = render(
      <ClipCard clip={makeClip(keyframes)} {...props} onSeekKeyframe={(atSec) => seeks.push(atSec)} />
    )
    const marker = container.querySelector('.clip-card__keyframe') as HTMLElement
    fireEvent.pointerDown(marker, { pointerId: 9, clientX: 20, clientY: 5, bubbles: true })
    fireEvent.click(marker)
    expect(seeks).toEqual([1 + 0.5 * 2])
    cleanup()
  })
})