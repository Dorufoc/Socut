import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_ANIMATION_IN_SEC, DEFAULT_ANIMATION_OUT_SEC, FPS_23_976, FPS_30, MAX_ANIMATION_SEC } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { durationSecToFrames, framesToDurationSec } from '@shared/fps'
import type { Fps, Project, SubtitleClip } from '@shared/types'
import { AnimationPanel } from './AnimationPanel'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 动画节奏面板契约：
 * 1) 输入以「秒」为准，帧数按当前帧率折算，写入时吸附到整帧边界；
 * 2) 新建片段默认入场/出场各 1s；非标准帧率（如 23.976）自动展开为 24 帧；
 * 3) 面板最大值随 MAX_ANIMATION_SEC（秒）伸缩，不再固定 30 帧硬顶。
 */

function seed(fps: Fps = FPS_30): { project: Project; clip: SubtitleClip } {
  const project = createDefaultProject('动画面板测试')
  project.fps = fps
  const clip = createClip({ startTime: 0, fps })
  project.clips = [clip]
  useProjectStore.setState({ project, selectedClipId: clip.id, fonts: [] })
  return { project, clip }
}

function animationOf(clipId: string): SubtitleClip['animation'] {
  return useProjectStore.getState().project.clips.find((c) => c.id === clipId)!.animation
}

function inputFor(label: string): HTMLInputElement {
  const field = (screen.getByText(label).closest('label') as HTMLLabelElement).querySelector('input')
  return field as HTMLInputElement
}

afterEach(() => {
  cleanup()
  useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
  useUiStore.setState({ notice: null })
})

describe('AnimationPanel（秒为准 · 帧吸附）', () => {
  it('新建片段入场/出场显示为 1s，@30fps 折算 30 帧', () => {
    const { clip } = seed(FPS_30)
    render(<AnimationPanel />)
    expect(inputFor(TEXT.inspector.inDuration).valueAsNumber).toBeCloseTo(DEFAULT_ANIMATION_IN_SEC, 4)
    expect(inputFor(TEXT.inspector.outDuration).valueAsNumber).toBeCloseTo(DEFAULT_ANIMATION_OUT_SEC, 4)
    expect(animationOf(clip.id).inDuration).toBeCloseTo(1, 6)
    expect(screen.getByText(/入场 30 帧 · 出场 30 帧/)).toBeTruthy()
  })

  it('非标准帧率 23.976：1s 展开为 24 帧，写入秒值恰好落在帧边界', () => {
    const { clip } = seed(FPS_23_976)
    render(<AnimationPanel />)
    const frameSec = framesToDurationSec(24, FPS_23_976)
    expect(animationOf(clip.id).inDuration).toBe(frameSec)
    expect(screen.getByText(/入场 24 帧/)).toBeTruthy()
  })

  it('用户输入 2s：写入工程 = 2s，@30fps 帧数变为 60（不再受旧 30 帧硬顶限制）', () => {
    const { clip } = seed(FPS_30)
    render(<AnimationPanel />)
    fireEvent.change(inputFor(TEXT.inspector.inDuration), { target: { value: '2' } })
    expect(animationOf(clip.id).inDuration).toBeCloseTo(2, 6)
    expect(durationSecToFrames(animationOf(clip.id).inDuration, FPS_30)).toBe(60)
  })

  it('超过 MAX_ANIMATION_SEC 会被夹到上限；不足 1 帧会被抬到 1 帧', () => {
    const { clip } = seed(FPS_30)
    render(<AnimationPanel />)
    fireEvent.change(inputFor(TEXT.inspector.inDuration), { target: { value: '99' } })
    expect(animationOf(clip.id).inDuration).toBeCloseTo(MAX_ANIMATION_SEC, 6)

    fireEvent.change(inputFor(TEXT.inspector.outDuration), { target: { value: '0.001' } })
    expect(durationSecToFrames(animationOf(clip.id).outDuration, FPS_30)).toBe(1)
    expect(animationOf(clip.id).outDuration).toBe(framesToDurationSec(1, FPS_30))
  })

  it('任意输入吸附到当前帧率的整帧，工程文件里不会出现 0.83333 帧这种半帧', () => {
    const { clip } = seed(FPS_30)
    render(<AnimationPanel />)
    fireEvent.change(inputFor(TEXT.inspector.inDuration), { target: { value: '1.234' } })
    const value = animationOf(clip.id).inDuration
    const frames = durationSecToFrames(value, FPS_30)
    expect(value).toBe(framesToDurationSec(frames, FPS_30))
    // 1.234s @ 30fps 四舍五入到 37 帧，而不是 37.02 帧
    expect(frames).toBe(37)
  })
})
