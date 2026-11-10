import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SEQUENCE_ID } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import { useProjectStore } from './projectStore'

/** M7：文本元素的 store 接线（新增 / 更新 / 删除 / 选中 / 多序列携带）。 */

function freshProject(): void {
  useProjectStore.setState({
    project: createDefaultProject('文本元素 store'),
    selectedClipId: null,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectedTextClipId: null,
    selectedTrackId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0,
    currentPath: null
  })
}

const textClips = () => useProjectStore.getState().project.textClips ?? []

beforeEach(() => {
  freshProject()
})

describe('projectStore 文本元素', () => {
  it('addTextClip：写入文本轨、选中并切到文本检查器，revision +1', () => {
    const revision = useProjectStore.getState().revision
    const clip = useProjectStore.getState().addTextClip({ at: 1, text: '今日头条' })!

    expect(clip.trackId).toBe('track-text')
    expect(textClips()).toHaveLength(1)
    expect(useProjectStore.getState().selectedTextClipId).toBe(clip.id)
    expect(useProjectStore.getState().selectionKind).toBe('text')
    expect(useProjectStore.getState().revision).toBe(revision + 1)
    expect(textClips()[0]!.startTime).toBe(1)
  })

  it('updateTextClip：文字/覆盖/入出点都能改；空文案被归一拒绝（不产生撤销步）', () => {
    const clip = useProjectStore.getState().addTextClip()!
    useProjectStore.getState().updateTextClip(clip.id, { text: '改后的标题', startTime: 2, endTime: 6 })
    expect(textClips()[0]!.text).toBe('改后的标题')
    expect(textClips()[0]!.startTime).toBe(2)
    expect(textClips()[0]!.endTime).toBe(6)

    const revision = useProjectStore.getState().revision
    useProjectStore.getState().updateTextClip(clip.id, { text: '   ' })
    expect(useProjectStore.getState().revision).toBe(revision)
    expect(textClips()[0]!.text).toBe('改后的标题')
  })

  it('同一份数据重复写入不产生撤销步', () => {
    const clip = useProjectStore.getState().addTextClip()!
    const revision = useProjectStore.getState().revision
    useProjectStore.getState().updateTextClip(clip.id, { text: textClips()[0]!.text })
    expect(useProjectStore.getState().revision).toBe(revision)
  })

  it('removeTextClip：删掉后键消失；Delete 走 removeSelected 也能删', () => {
    const first = useProjectStore.getState().addTextClip()!
    const second = useProjectStore.getState().addTextClip({ at: 6 })!
    expect(textClips()).toHaveLength(2)

    useProjectStore.getState().removeTextClip(first.id)
    expect(textClips()).toHaveLength(1)

    useProjectStore.getState().selectTextClip(second.id)
    expect(useProjectStore.getState().removeSelected()).toBe(true)
    expect(useProjectStore.getState().project.textClips).toBeUndefined()
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
    expect(useProjectStore.getState().selectedTextClipId).toBeNull()
  })

  it('多序列：切换序列后文本元素隔离，切回来完好', () => {
    useProjectStore.getState().addTextClip({ text: '主序列文本' })
    const sequenceId = useProjectStore.getState().addSequence('第二段')!
    expect(useProjectStore.getState().selectSequence(sequenceId)).toBe(true)
    expect(textClips()).toHaveLength(0)

    expect(useProjectStore.getState().selectSequence(DEFAULT_SEQUENCE_ID)).toBe(true)
    expect(textClips()).toHaveLength(1)
    expect(textClips()[0]!.text).toBe('主序列文本')
  })
})
