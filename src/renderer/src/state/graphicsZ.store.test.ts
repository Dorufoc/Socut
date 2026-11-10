import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultProject } from '@shared/projectSchema'
import { normalizeProject } from '@shared/projectSchema'
import { activeSequence } from '@shared/sequence'
import { useProjectStore } from './projectStore'

/** M7-E：图形层 z 档（store / 序列快照 / schema 持久化）。 */

function fresh(): void {
  useProjectStore.setState({
    project: createDefaultProject('图形层'),
    selectedClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0
  })
}

beforeEach(() => fresh())
afterEach(() => fresh())

describe('setGraphicsZ', () => {
  it('belowMedia 落盘并推进 revision；aboveMedia（undefined）删键', () => {
    const before = useProjectStore.getState().revision
    useProjectStore.getState().setGraphicsZ('belowMedia')
    expect(useProjectStore.getState().project.graphicsZ).toBe('belowMedia')
    expect(useProjectStore.getState().revision).toBe(before + 1)

    useProjectStore.getState().setGraphicsZ(undefined)
    expect(useProjectStore.getState().project.graphicsZ).toBeUndefined()
    expect('graphicsZ' in useProjectStore.getState().project).toBe(false)
  })

  it('schema 往返：belowMedia 保留、缺省不出现在 JSON', () => {
    useProjectStore.getState().setGraphicsZ('belowMedia')
    const normalized = normalizeProject(
      JSON.parse(JSON.stringify(useProjectStore.getState().project))
    )
    expect(normalized?.graphicsZ).toBe('belowMedia')

    fresh()
    const plain = normalizeProject(JSON.parse(JSON.stringify(useProjectStore.getState().project)))
    expect(plain?.graphicsZ).toBeUndefined()
    expect(JSON.stringify(plain)).not.toContain('graphicsZ')
  })
})

describe('序列快照', () => {
  it('活动序列快照携带 graphicsZ；切到新序列后不残留、切回恢复', () => {
    useProjectStore.getState().setGraphicsZ('belowMedia')
    const mainId = activeSequence(useProjectStore.getState().project).id
    expect(activeSequence(useProjectStore.getState().project).graphicsZ).toBe('belowMedia')

    const otherId = useProjectStore.getState().addSequence('另一条')
    expect(otherId).not.toBeNull()
    expect(useProjectStore.getState().selectSequence(otherId!)).toBe(true)
    expect(useProjectStore.getState().project.graphicsZ).toBeUndefined()

    expect(useProjectStore.getState().selectSequence(mainId)).toBe(true)
    expect(useProjectStore.getState().project.graphicsZ).toBe('belowMedia')
  })
})
