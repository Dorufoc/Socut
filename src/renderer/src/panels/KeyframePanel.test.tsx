import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { SubtitleClip } from '@shared/types'
import { KeyframePanel } from './KeyframePanel'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/** M6：关键帧面板交互（打点 / 改值 / 切自定义缓动 / 删点 / 清空）。 */

function seed(): SubtitleClip {
  const project = createDefaultProject('关键帧面板')
  const clip = createClip({ startTime: 0, fps: project.fps })
  clip.startTime = 0
  clip.endTime = 4
  project.clips = [clip]
  useProjectStore.setState({ project, selectedClipId: clip.id, fonts: [] })
  useUiStore.setState({ displayTimeSec: 0, seekHandler: null })
  return clip
}

const clipOf = (id: string): SubtitleClip => useProjectStore.getState().project.clips.find((clip) => clip.id === id)!

beforeEach(() => {
  seed()
})

afterEach(() => {
  cleanup()
})

function renderPanel(): SubtitleClip {
  // 与生产一致：面板的 clip 由父组件从 store 取，store 一变就重渲染
  function Harness(): ReactElement | null {
    const clip = useProjectStore((state) =>
      state.project.clips.find((item) => item.id === state.selectedClipId) ?? null
    )
    return clip ? <KeyframePanel clip={clip} /> : null
  }
  render(<Harness />)
  return useProjectStore.getState().project.clips[0]!
}

describe('KeyframePanel', () => {
  it('默认 5 个参数、0 个关键点；播放头进度显示为百分比', () => {
    const clip = renderPanel()
    expect(screen.getByText(TEXT.keyframes.hint)).toBeTruthy()
    expect(screen.getByText(TEXT.keyframes.playhead(0))).toBeTruthy()
    expect(screen.getAllByText(TEXT.keyframes.empty)).toHaveLength(5)
    expect(clip.keyframes).toBeUndefined()
  })

  it('在播放头打点：写入 0% 的关键点，值取参数默认值', () => {
    const clip = renderPanel()
    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.addPoint)[0]!))

    const keyframes = clipOf(clip.id).keyframes!
    expect(keyframes).toHaveLength(1)
    expect(keyframes[0]!.param).toBe('opacity')
    expect(keyframes[0]!.points).toEqual([{ t: 0, value: 1, easing: 'linear' }])
    expect(screen.getByText(TEXT.keyframes.points(1))).toBeTruthy()
  })

  it('播放头到 50% 再打点：同一参数两个关键点，t 分别为 0% 与 50%', () => {
    const clip = renderPanel()
    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.addPoint)[0]!))
    act(() => useUiStore.setState({ displayTimeSec: 2 }))
    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.addPoint)[0]!))

    const track = clipOf(clip.id).keyframes![0]!
    expect(track.points.map((point) => Math.round(point.t * 100))).toEqual([0, 50])
  })

  it('改点上的值：写回 store（归一后仍是合法数字）', () => {
    const clip = renderPanel()
    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.addPoint)[0]!))
    const input = screen.getByLabelText(`${TEXT.keyframes.labels.opacity} ${TEXT.keyframes.value} 1`) as HTMLInputElement
    act(() => fireEvent.change(input, { target: { value: '0.4' } }))
    expect(clipOf(clip.id).keyframes![0]!.points[0]!.value).toBe(0.4)
  })

  it('切自定义贝塞尔：出现 4 个分量输入；非法值被夹到 [0,1]', () => {
    const clip = renderPanel()
    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.addPoint)[0]!))
    const easing = screen.getByLabelText(`${TEXT.keyframes.labels.opacity} ${TEXT.keyframes.easing} 1`) as HTMLSelectElement
    act(() => fireEvent.change(easing, { target: { value: 'custom' } }))

    const components = [1, 2, 3, 4].map(
      (index) =>
        screen.getByLabelText(`${TEXT.keyframes.labels.opacity} bezier ${index}`) as HTMLInputElement
    )
    expect(components).toHaveLength(4)
    act(() => fireEvent.change(components[0]!, { target: { value: '1.8' } }))
    const point = clipOf(clip.id).keyframes![0]!.points[0]!
    expect(point.easing).toBe('custom')
    expect(point.bezier![0]).toBe(1)
  })

  it('删点：最后一个点删掉后整条轨道消失；清空按钮同理', () => {
    const clip = renderPanel()
    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.addPoint)[0]!))
    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.deletePoint)[0]!))
    expect('keyframes' in clipOf(clip.id)).toBe(false)

    act(() => fireEvent.click(screen.getAllByTitle(TEXT.keyframes.addPoint)[0]!))
    expect(clipOf(clip.id).keyframes).toHaveLength(1)
    act(() => fireEvent.click(screen.getByTitle(TEXT.keyframes.clearTrack)))
    expect('keyframes' in clipOf(clip.id)).toBe(false)
  })
})
