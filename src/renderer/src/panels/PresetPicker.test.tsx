import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PRESETS } from '@shared/presets'
import { FPS_30 } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { PresetPicker } from './PresetPicker'
import { useProjectStore } from '../state/projectStore'

/**
 * 预设面板（计划 M2-4）。
 * 这一层测的是「点击 → 工程状态」的真实链路：面板只改 store，
 * 预览/导出由 store 派生，因此这里的状态正确就能保证三处一致。
 */

function seedClip(presetId?: string): string {
  const project = createDefaultProject('预设面板测试')
  const clip = createClip({ startTime: 0, fps: FPS_30 })
  project.clips = [presetId ? { ...clip, presetId: presetId as typeof clip.presetId } : clip]
  useProjectStore.setState({ project, selectedClipId: clip.id, fonts: [] })
  return clip.id
}

function clipOf(clipId: string): { presetId: string } | undefined {
  return useProjectStore.getState().project.clips.find((clip) => clip.id === clipId)
}

afterEach(() => {
  cleanup()
  useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
})

describe('PresetPicker（8 套预设）', () => {
  it('渲染全部 8 套预设，且当前预设高亮', () => {
    seedClip(PRESETS[2]!.id)
    render(<PresetPicker />)
    const cards = screen.getAllByRole('button')
    expect(cards).toHaveLength(PRESETS.length)
    for (const preset of PRESETS) {
      expect(screen.getByText(preset.name)).toBeTruthy()
    }
    const active = cards.filter((card) => card.className.includes('preset-card--active'))
    expect(active).toHaveLength(1)
    expect(active[0]!.textContent).toContain(PRESETS[2]!.name)
  })

  it('点击切换预设：工程里该片段的 presetId 被改写，高亮随之移动', () => {
    const clipId = seedClip(PRESETS[0]!.id)
    render(<PresetPicker />)
    const target = PRESETS[5]!
    fireEvent.click(screen.getByText(target.name).closest('button')!)
    expect(clipOf(clipId)?.presetId).toBe(target.id)
    const active = screen
      .getAllByRole('button')
      .filter((card) => card.className.includes('preset-card--active'))
    expect(active).toHaveLength(1)
    expect(active[0]!.textContent).toContain(target.name)
  })

  it('没有选中片段时按钮全部禁用并给出提示（不会写坏工程）', () => {
    const project = createDefaultProject('无选中')
    const clip = createClip({ startTime: 0, fps: FPS_30 })
    project.clips = [clip]
    useProjectStore.setState({ project, selectedClipId: null, fonts: [] })
    render(<PresetPicker />)
    for (const card of screen.getAllByRole('button')) {
      expect((card as HTMLButtonElement).disabled).toBe(true)
    }
    expect(screen.getByText('请先在时间轴选择一个片段。')).toBeTruthy()
    // 禁用状态下即使触发 click 也不应改写任何片段
    const before = JSON.stringify(useProjectStore.getState().project)
    fireEvent.click(screen.getAllByRole('button')[1]!)
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(before)
  })
})
