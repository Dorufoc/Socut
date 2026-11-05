import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PRESETS, getPreset } from '@shared/presets'
import { DEFAULT_FONT_ID, FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { PresetPicker } from './PresetPicker'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

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
    expect(screen.getByText(TEXT.inspector.noneSelected)).toBeTruthy()
    // 禁用状态下即使触发 click 也不应改写任何片段
    const before = JSON.stringify(useProjectStore.getState().project)
    fireEvent.click(screen.getAllByRole('button')[1]!)
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(before)
  })
})

/**
 * 切预设的两条用户要求：
 * 1. 点**别的**预设 → 即时应用，不弹确认；本条自定义参数全部回到该预设默认；
 * 2. 重复点**当前**预设且已有自定义 → 先二次确认（破坏性操作），确认后才清空。
 */
describe('PresetPicker：切预设即时应用并还原默认', () => {
  const cardOf = (presetId: string): HTMLButtonElement =>
    screen.getByText(getPreset(presetId as never).name).closest('button') as HTMLButtonElement
  const clipOf = (id: string) => useProjectStore.getState().project.clips.find((clip) => clip.id === id)!

  /** 先把当前预设调成「带自定义」的状态 */
  const customize = (clipId: string): void => {
    const store = useProjectStore.getState()
    store.updateClip(clipId, { presetId: 'breakingRed' })
    store.updateClip(clipId, { styleOverrides: { tokens: { primary: '#101010' }, barOpacity: 0.6 }, fontId: 'builtin-notosanssc-900' })
  }

  it('点其他预设：无确认弹窗，即时应用并把自定义还原到该预设默认', () => {
    const clipId = seedClip(PRESETS[0]!.id)
    customize(clipId)
    render(<PresetPicker />)

    fireEvent.click(cardOf('calmEditorial'))

    expect(useUiStore.getState().dialogQueue).toHaveLength(0)
    const after = clipOf(clipId)
    expect(after.presetId).toBe('calmEditorial')
    expect(after.styleOverrides).toEqual({})
    expect(after.fontId).toBe(DEFAULT_FONT_ID)
  })

  it('重复点当前预设：先弹二次确认，确认前一个字段都不改', async () => {
    const clipId = seedClip(PRESETS[0]!.id)
    customize(clipId)
    render(<PresetPicker />)
    const snapshot = JSON.stringify(clipOf(clipId))

    fireEvent.click(cardOf('breakingRed'))
    const prompt = useUiStore.getState().dialogQueue[0]
    expect(prompt?.dialog.kind).toBe('confirm')
    expect(JSON.stringify(clipOf(clipId))).toBe(snapshot)

    await act(async () => {
      prompt?.resolve('ok')
      useUiStore.getState().shiftPrompt()
    })

    const after = clipOf(clipId)
    expect(after.styleOverrides).toEqual({})
    expect(after.presetId).toBe('breakingRed')
    expect(useUiStore.getState().notice).toBe(TEXT.inspector.resetAllCustomDone)
  })

  it('取消确认时保留全部自定义参数', async () => {
    const clipId = seedClip(PRESETS[0]!.id)
    customize(clipId)
    render(<PresetPicker />)
    const snapshot = JSON.stringify(clipOf(clipId))

    fireEvent.click(cardOf('breakingRed'))
    const prompt = useUiStore.getState().dialogQueue[0]
    await act(async () => {
      prompt?.resolve('cancel')
      useUiStore.getState().shiftPrompt()
    })

    expect(JSON.stringify(clipOf(clipId))).toBe(snapshot)
  })

  it('没有自定义时不弹确认，也不显示「已自定义」角标', () => {
    seedClip(PRESETS[0]!.id)
    render(<PresetPicker />)

    fireEvent.click(cardOf('breakingRed'))
    expect(useUiStore.getState().dialogQueue).toHaveLength(0)
    expect(clipOf(useProjectStore.getState().selectedClipId!).presetId).toBe('breakingRed')
    expect(screen.queryByText(/已自定义/)).toBeNull()
  })

  it('带自定义时只留一个「已自定义 N 项」角标（不再堆说明句）', () => {
    const clipId = seedClip(PRESETS[0]!.id)
    customize(clipId)
    const { container } = render(<PresetPicker />)

    expect(screen.getByText(/已自定义 2 项/)).toBeTruthy()
    // 面板正文不再有任何解释性段落：只剩分组标题 + 卡片 + 一个角标
    expect(container.querySelectorAll('p.hint')).toHaveLength(0)
    // 预设说明仍可通过 hover 读到
    expect(screen.getByText(PRESETS[0]!.name).closest('button')?.getAttribute('title')).toBe(PRESETS[0]!.description)
  })
})
