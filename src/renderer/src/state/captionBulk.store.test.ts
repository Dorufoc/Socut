import { describe, expect, it } from 'vitest'
import { FPS_30, MIN_CLIP_DURATION_SEC } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { PresetId, SubtitleClip } from '@shared/types'
import { attachProjectHistory, useHistoryStore } from './projectHistory'
import { useProjectStore } from './projectStore'

/**
 * M11-I：字幕列表多选的批量写入口（store 层）。
 *
 * 锁四件事：
 * 1. 每个批量动作只推一次 revision（= 项目级历史一步撤销，不是循环 N 次）；
 * 2. 同值 / 未知 id / 非法参数不推 revision（不触发自动存档、不产生空撤销步）；
 * 3. 统一时长从各自入点顺延、帧吸附、撞到邻居贴住；
 * 4. 批量删除不留指向已删片段的选中 id。
 */

/** 固定时长的字幕条：入出点直接给死，避免受 createClip 默认 5s 影响 */
function clipAt(start: number, end: number, title: string): SubtitleClip {
  const clip = createClip({ startTime: start, fps: FPS_30 })
  clip.startTime = start
  clip.endTime = end
  clip.content = { title, subtitle: '副标题' }
  return clip
}

function fresh(): void {
  const project = createDefaultProject('批量编辑')
  project.fps = FPS_30
  project.clips = [clipAt(0, 2, '第一'), clipAt(4, 6, '第二'), clipAt(8, 10, '第三')]
  useProjectStore.setState({
    project,
    selectedClipId: project.clips[0]!.id,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectedTransitionClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0
  })
}

function clipsOf(): SubtitleClip[] {
  return useProjectStore.getState().project.clips
}

function revisionOf(): number {
  return useProjectStore.getState().revision
}

function idOf(index: number): string {
  return clipsOf()[index]!.id
}

describe('applyPresetToClips', () => {
  it('批量改预设：文字与入出点不动，返回实际改写条数，未知 id 忽略', () => {
    fresh()
    const [a, b, c] = clipsOf()
    const before = revisionOf()

    const changed = useProjectStore.getState().applyPresetToClips([a!.id, b!.id, 'missing'], 'breakingRed')

    expect(changed).toBe(2)
    expect(revisionOf()).toBe(before + 1)
    const after = clipsOf()
    expect(after.map((clip) => clip.presetId)).toEqual(['breakingRed', 'breakingRed', c!.presetId])
    // 切预设 = 恢复该预设默认（自定义清空），但文字与入出点属于内容，必须保留
    expect(after[0]!.styleOverrides).toEqual({})
    expect(after[0]!.content).toEqual({ title: '第一', subtitle: '副标题' })
    expect(after[0]!.startTime).toBe(0)
    expect(after[0]!.endTime).toBe(2)
  })

  it('同值不推 revision：对已是该预设的条目再应用一次什么都不写', () => {
    fresh()
    useProjectStore.getState().applyPresetToClips([idOf(0)], 'breakingRed')
    const before = revisionOf()

    const changed = useProjectStore.getState().applyPresetToClips([idOf(0)], 'breakingRed')

    expect(changed).toBe(0)
    expect(revisionOf()).toBe(before)
  })

  it('未知预设 id 被拒收：不写坏工程、不推 revision', () => {
    fresh()
    const before = revisionOf()
    const presetId = clipsOf()[0]!.presetId

    const changed = useProjectStore.getState().applyPresetToClips([idOf(0)], '不存在的预设' as PresetId)

    expect(changed).toBe(0)
    expect(revisionOf()).toBe(before)
    expect(clipsOf()[0]!.presetId).toBe(presetId)
  })
})

describe('setClipsDuration', () => {
  it('各自入点顺延到统一时长，出点吸附帧边界', () => {
    fresh()
    const before = revisionOf()

    // 30fps 下 2.017s 吸附到 61 帧 = 2.033333…
    const changed = useProjectStore.getState().setClipsDuration([idOf(0), idOf(1)], 2.017)

    expect(changed).toBe(2)
    expect(revisionOf()).toBe(before + 1)
    const [a, b] = clipsOf()
    expect(a!.startTime).toBe(0)
    expect(a!.endTime - a!.startTime).toBeCloseTo(61 / 30, 6)
    expect(b!.startTime).toBe(4)
    expect(b!.endTime - b!.startTime).toBeCloseTo(61 / 30, 6)
  })

  it('撞到右侧邻居就贴住：不制造重叠，贴住后同值的那条不算改动', () => {
    fresh()
    const project = useProjectStore.getState().project
    project.clips = [clipAt(0, 2, 'A'), clipAt(2, 4, 'B'), clipAt(8, 10, 'C')]
    useProjectStore.setState({ project, revision: 0 })

    const changed = useProjectStore.getState().setClipsDuration([idOf(0), idOf(1)], 5)

    const [a, b] = clipsOf()
    // A 想长到 5s，但 B 的入点在 2s → A 贴住（正好等于原值，不算改动）
    expect(a!.endTime).toBe(2)
    // B 的右侧是 8s 的 C，5s 放得下 → B 变成 2→7
    expect(b!.startTime).toBe(2)
    expect(b!.endTime).toBe(7)
    expect(changed).toBe(1)
  })

  it('非法值不动：0 / NaN / 吸附后不足最短时长都拒收', () => {
    fresh()
    const before = revisionOf()
    const store = useProjectStore.getState()

    expect(store.setClipsDuration([idOf(0)], 0)).toBe(0)
    expect(store.setClipsDuration([idOf(0)], Number.NaN)).toBe(0)
    expect(store.setClipsDuration([idOf(0)], MIN_CLIP_DURATION_SEC / 2)).toBe(0)
    expect(revisionOf()).toBe(before)
    expect(clipsOf()[0]!.endTime).toBe(2)
  })

  it('同值不推 revision', () => {
    fresh()
    const before = revisionOf()

    const changed = useProjectStore.getState().setClipsDuration([idOf(0), idOf(1), idOf(2)], 2)

    expect(changed).toBe(0)
    expect(revisionOf()).toBe(before)
  })
})

describe('removeClips', () => {
  it('批量删除并清掉指向已删片段的选中 id；未知 id 忽略', () => {
    fresh()
    useProjectStore.setState({ selectedClipId: idOf(0) })
    const before = revisionOf()

    const removed = useProjectStore.getState().removeClips([idOf(0), 'missing'])

    expect(removed).toBe(1)
    expect(revisionOf()).toBe(before + 1)
    expect(clipsOf().map((clip) => clip.content.title)).toEqual(['第二', '第三'])
    // 选中态挪到剩余第一条，绝不停在一个已经不存在的 id 上
    expect(useProjectStore.getState().selectedClipId).toBe(clipsOf()[0]!.id)
  })

  it('空数组 / 全部未知 id 不推 revision', () => {
    fresh()
    const before = revisionOf()
    const store = useProjectStore.getState()

    expect(store.removeClips([])).toBe(0)
    expect(store.removeClips(['missing-1', 'missing-2'])).toBe(0)
    expect(revisionOf()).toBe(before)
    expect(clipsOf()).toHaveLength(3)
  })
})

describe('setClipsCompact', () => {
  it('开 = 写 compact:true；关 = 删键；同值不推 revision', () => {
    fresh()
    const store = useProjectStore.getState()

    expect(store.setClipsCompact([idOf(0), idOf(1)], true)).toBe(2)
    expect(clipsOf()[0]!.styleOverrides.compact).toBe(true)
    expect(clipsOf()[1]!.styleOverrides.compact).toBe(true)
    // 没选中的第三条不受影响
    expect(clipsOf()[2]!.styleOverrides.compact).toBeUndefined()

    const before = revisionOf()
    expect(store.setClipsCompact([idOf(0)], true)).toBe(0)
    expect(revisionOf()).toBe(before)

    expect(store.setClipsCompact([idOf(0)], false)).toBe(1)
    // 关掉不留下「看似自定义」的 false
    expect('compact' in clipsOf()[0]!.styleOverrides).toBe(false)
  })
})

describe('setClipsGradientEnabled', () => {
  it('开：主/副标题渐变都启用，缺省用统一双色；关：只翻 enabled，颜色保留', () => {
    fresh()
    const store = useProjectStore.getState()

    expect(store.setClipsGradientEnabled([idOf(0)], true)).toBe(1)
    const opened = clipsOf()[0]!.styleOverrides
    expect(opened.titleGradient).toMatchObject({ enabled: true, from: '#ffffff', to: '#9ec7ff', angleDeg: 90 })
    expect(opened.subtitleGradient).toMatchObject({ enabled: true })

    expect(store.setClipsGradientEnabled([idOf(0)], false)).toBe(1)
    const closed = clipsOf()[0]!.styleOverrides
    expect(closed.titleGradient?.enabled).toBe(false)
    // 颜色不丢：下次再开不用重配
    expect(closed.titleGradient?.from).toBe('#ffffff')

    const before = revisionOf()
    expect(store.setClipsGradientEnabled([idOf(0)], false)).toBe(0)
    expect(revisionOf()).toBe(before)
  })

  it('开渐变沿用条目已有颜色，不覆盖用户配过的双色', () => {
    fresh()
    const project = useProjectStore.getState().project
    project.clips[1] = {
      ...project.clips[1]!,
      styleOverrides: {
        ...project.clips[1]!.styleOverrides,
        titleGradient: { enabled: false, from: '#ff0000', to: '#00ff00', angleDeg: 45 }
      }
    }
    useProjectStore.setState({ project })

    useProjectStore.getState().setClipsGradientEnabled([idOf(1)], true)

    expect(clipsOf()[1]!.styleOverrides.titleGradient).toEqual({
      enabled: true,
      from: '#ff0000',
      to: '#00ff00',
      angleDeg: 45
    })
  })
})

describe('一次批量动作 = 一步撤销', () => {
  it('一次批量改预设只产生一个撤销步，撤销后整批回滚', () => {
    fresh()
    const detach = attachProjectHistory()
    try {
      useHistoryStore.setState({ past: [], future: [] })
      const ids = clipsOf().map((clip) => clip.id)

      useProjectStore.getState().applyPresetToClips(ids, 'breakingRed')

      // 3 条一起改，历史里也只有一步（不是循环 3 次 set）
      expect(useHistoryStore.getState().past).toHaveLength(1)
      expect(clipsOf().map((clip) => clip.presetId)).toEqual(['breakingRed', 'breakingRed', 'breakingRed'])

      useHistoryStore.getState().undo()

      expect(clipsOf().map((clip) => clip.presetId)).toEqual(['stackedNews', 'stackedNews', 'stackedNews'])
      expect(useHistoryStore.getState().past).toHaveLength(0)
    } finally {
      detach()
    }
  })
})
