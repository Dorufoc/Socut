import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import { useProjectStore } from './projectStore'

/** M11：字幕条导入 / 批量名单落库（store 层：帧对齐、追加/替换、选择）。 */

function fresh(): void {
  useProjectStore.setState({
    project: createDefaultProject('字幕导入'),
    selectedClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0
  })
}

beforeEach(() => {
  fresh()
  useProjectStore.getState().project.fps = FPS_30
})

afterEach(() => {
  fresh()
})

describe('addCaptionsFromCues', () => {
  it('cue → 字幕条：标题=文本、副标题空、时间吸附帧边界、选中第一条', () => {
    const added = useProjectStore.getState().addCaptionsFromCues([
      { startSec: 1.017, endSec: 3.02, text: '今日头条' },
      { startSec: 4, endSec: 6, text: '第二条' }
    ])
    const clips = useProjectStore.getState().project.clips
    expect(added).toBe(2)
    expect(clips).toHaveLength(2)
    // 1.017s → 31 帧（最接近的帧边界）
    expect(clips[0]!.startTime).toBeCloseTo(31 / 30, 6)
    expect(clips[0]!.endTime).toBeCloseTo(3.033333, 4)
    expect(clips[0]!.content).toEqual({ title: '今日头条', subtitle: '' })
    expect(useProjectStore.getState().selectedClipId).toBe(clips[0]!.id)
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
  })

  it('replace=true 先清空现有字幕条；缺省追加', () => {
    useProjectStore.getState().addCaptionsFromCues([{ startSec: 0, endSec: 2, text: '旧' }])
    useProjectStore.getState().addCaptionsFromCues([{ startSec: 5, endSec: 7, text: '新' }])
    expect(useProjectStore.getState().project.clips).toHaveLength(2)

    useProjectStore.getState().addCaptionsFromCues([{ startSec: 0, endSec: 2, text: '替换' }], { replace: true })
    const clips = useProjectStore.getState().project.clips
    expect(clips).toHaveLength(1)
    expect(clips[0]!.content.title).toBe('替换')
  })

  it('零时长 cue 被夹到工程最短时长（不丢条目）；正常 cue 原样落位', () => {
    const added = useProjectStore.getState().addCaptionsFromCues([
      { startSec: 5, endSec: 5, text: '零时长' },
      { startSec: 8, endSec: 9, text: '正常' }
    ])
    const clips = useProjectStore.getState().project.clips
    expect(added).toBe(2)
    expect(clips[0]!.endTime - clips[0]!.startTime).toBeGreaterThanOrEqual(0.2 - 1e-9)
    expect(clips[1]!.startTime).toBe(8)
    expect(clips[1]!.endTime).toBe(9)
  })
})

describe('addCaptionBatch', () => {
  it('缺省接在现有字幕末尾，首尾相接', () => {
    useProjectStore.getState().addCaptionsFromCues([{ startSec: 0, endSec: 3, text: '已有' }])
    const added = useProjectStore.getState().addCaptionBatch(
      [
        { title: '张伟', subtitle: '主任' },
        { title: '李娜', subtitle: '记者' }
      ],
      { defaultDurationSec: 2 }
    )
    const clips = useProjectStore.getState().project.clips
    expect(added).toBe(2)
    expect(clips).toHaveLength(3)
    expect(clips[1]!.startTime).toBe(3)
    expect(clips[1]!.endTime).toBe(5)
    expect(clips[2]!.startTime).toBe(5)
    expect(clips[2]!.endTime).toBe(7)
    expect(clips[2]!.content).toEqual({ title: '李娜', subtitle: '记者' })
  })

  it('显式 startSec / gap / 行内 duration 生效', () => {
    useProjectStore.getState().addCaptionBatch(
      [
        { title: 'A', subtitle: '', durationSec: 4 },
        { title: 'B', subtitle: '' }
      ],
      { startSec: 10, gapSec: 1, defaultDurationSec: 2 }
    )
    const clips = useProjectStore.getState().project.clips
    expect(clips[0]!.startTime).toBe(10)
    expect(clips[0]!.endTime).toBe(14)
    expect(clips[1]!.startTime).toBe(15)
    expect(clips[1]!.endTime).toBe(17)
  })

  it('空行列表不产生任何字幕条', () => {
    expect(useProjectStore.getState().addCaptionBatch([], {})).toBe(0)
    expect(useProjectStore.getState().project.clips).toHaveLength(0)
  })
})
