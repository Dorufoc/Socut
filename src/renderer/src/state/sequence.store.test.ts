import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SEQUENCE_ID } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import { inactiveSequences, sequenceSummaries } from '@shared/sequence'
import { useProjectStore } from './projectStore'

/** v4 多序列 store 接线：新增 / 切换 / 重命名 / 删除 / 复制，以及切换时的选中态清理。 */

function freshProject(): void {
  useProjectStore.setState({
    project: createDefaultProject('多序列 store'),
    selectedClipId: null,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectedTrackId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0,
    currentPath: null
  })
}

beforeEach(() => {
  freshProject()
})

describe('projectStore 多序列', () => {
  it('addSequence：新增非活动序列，活动序列与选中态不动，revision +1', () => {
    const current = useProjectStore.getState()
    current.addClip()
    const revision = useProjectStore.getState().revision
    const id = useProjectStore.getState().addSequence('第二段')

    expect(id).not.toBeNull()
    expect(useProjectStore.getState().project.activeSequenceId).toBeUndefined()
    expect(inactiveSequences(useProjectStore.getState().project)).toHaveLength(1)
    expect(useProjectStore.getState().revision).toBe(revision + 1)
    // 活动序列内容不受影响
    expect(useProjectStore.getState().project.clips).toHaveLength(1)
  })

  it('selectSequence：切换后清空选中态，切回来片段完好', () => {
    useProjectStore.getState().addClip()
    const activeClipId = useProjectStore.getState().project.clips[0]!.id
    useProjectStore.getState().selectClip(activeClipId)
    const id = useProjectStore.getState().addSequence('第二段')!

    const ok = useProjectStore.getState().selectSequence(id)

    expect(ok).toBe(true)
    const switched = useProjectStore.getState()
    expect(switched.project.activeSequenceId).toBe(id)
    expect(switched.project.activeSequenceName).toBe('第二段')
    expect(switched.project.clips).toHaveLength(0)
    expect(switched.selectedClipId).toBeNull()
    expect(switched.selectionKind).toBe('subtitle')

    expect(useProjectStore.getState().selectSequence(DEFAULT_SEQUENCE_ID)).toBe(true)
    expect(useProjectStore.getState().project.clips).toHaveLength(1)
  })

  it('selectSequence：不存在的 id / 当前活动 id 返回 false 且不改工程', () => {
    const before = useProjectStore.getState().project
    expect(useProjectStore.getState().selectSequence('seq-missing')).toBe(false)
    expect(useProjectStore.getState().selectSequence(DEFAULT_SEQUENCE_ID)).toBe(false)
    expect(useProjectStore.getState().project).toBe(before)
  })

  it('renameSequence：活动序列与非活动序列都能改名，空名返回 false', () => {
    const id = useProjectStore.getState().addSequence('旧名')!
    expect(useProjectStore.getState().renameSequence(id, '新名')).toBe(true)
    const summary = sequenceSummaries(useProjectStore.getState().project).find((item) => item.id === id)!
    expect(summary.name).toBe('新名')

    expect(useProjectStore.getState().renameSequence(DEFAULT_SEQUENCE_ID, '主剪辑')).toBe(true)
    expect(useProjectStore.getState().project.activeSequenceName).toBe('主剪辑')

    expect(useProjectStore.getState().renameSequence(id, '   ')).toBe(false)
  })

  it('removeSequence：删活动序列会先切到剩余序列并清空选中态；只剩一条时拒绝', () => {
    useProjectStore.getState().addClip()
    const id = useProjectStore.getState().addSequence('第二段')!
    useProjectStore.getState().selectSequence(id)
    useProjectStore.getState().addClip()
    const clipId = useProjectStore.getState().project.clips[0]!.id
    useProjectStore.getState().selectClip(clipId)

    expect(useProjectStore.getState().removeSequence(id)).toBe(true)
    const after = useProjectStore.getState()
    expect(after.project.activeSequenceId).toBeUndefined()
    expect(after.project.clips).toHaveLength(1)
    expect(after.selectedClipId).toBeNull()
    expect(inactiveSequences(after.project)).toHaveLength(0)

    // 只剩一条活动序列时拒绝
    expect(useProjectStore.getState().removeSequence(DEFAULT_SEQUENCE_ID)).toBe(false)
  })

  it('duplicateSequence：副本留在非活动序列，活动序列不变', () => {
    useProjectStore.getState().addClip()
    const duplicated = useProjectStore.getState().duplicateSequence(undefined, '副本')!
    const state = useProjectStore.getState()
    expect(state.project.activeSequenceId).toBeUndefined()
    const copy = sequenceSummaries(state.project).find((item) => item.id === duplicated)!
    expect(copy).toMatchObject({ name: '副本', active: false, clipCount: 1 })
    expect(state.project.clips).toHaveLength(1)
  })
})
