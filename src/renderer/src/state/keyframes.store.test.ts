import { beforeEach, describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import type { KeyframeTrack } from '@shared/keyframes'
import { useProjectStore } from './projectStore'

/** M6：字幕条关键帧的 store 接线（归一、去重、清空、拆分不继承）。 */

const tracks: KeyframeTrack[] = [
  {
    param: 'opacity',
    points: [
      { t: 0, value: 1, easing: 'linear' },
      { t: 1, value: 0, easing: 'outCubic' }
    ]
  }
]

function freshProject(): string {
  useProjectStore.setState({
    project: createDefaultProject('关键帧 store'),
    selectedClipId: null,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectedTrackId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0,
    currentPath: null
  })
  useProjectStore.getState().addClip()
  return useProjectStore.getState().project.clips[0]!.id
}

const clipOf = (id: string) => useProjectStore.getState().project.clips.find((clip) => clip.id === id)!

describe('projectStore.setClipKeyframes', () => {
  let clipId = ''
  beforeEach(() => {
    clipId = freshProject()
  })

  it('写入后归一落盘；revision +1', () => {
    const revision = useProjectStore.getState().revision
    useProjectStore.getState().setClipKeyframes(clipId, tracks)
    expect(clipOf(clipId).keyframes).toEqual(tracks)
    expect(useProjectStore.getState().revision).toBe(revision + 1)
  })

  it('写同样的关键帧不产生新撤销步（归一后逐字节比较）', () => {
    useProjectStore.getState().setClipKeyframes(clipId, tracks)
    const revision = useProjectStore.getState().revision
    // 同一份数据再写一次（点顺序不同）→ 归一后相同，不应推高 revision
    useProjectStore.getState().setClipKeyframes(clipId, [
      { param: 'opacity', points: [...tracks[0]!.points].reverse() }
    ])
    expect(useProjectStore.getState().revision).toBe(revision)
  })

  it('传入空数组/undefined/全非法数据 → 删除 keyframes 键', () => {
    useProjectStore.getState().setClipKeyframes(clipId, tracks)
    useProjectStore.getState().setClipKeyframes(clipId, undefined)
    expect('keyframes' in clipOf(clipId)).toBe(false)

    useProjectStore.getState().setClipKeyframes(clipId, tracks)
    useProjectStore.getState().setClipKeyframes(clipId, [{ param: 'nope', points: [] } as never])
    expect('keyframes' in clipOf(clipId)).toBe(false)
  })

  it('视频片段 id 不存在时静默忽略（不抛错、不动工程）', () => {
    const before = useProjectStore.getState().revision
    useProjectStore.getState().setClipKeyframes('clip-missing', tracks)
    expect(useProjectStore.getState().revision).toBe(before)
  })

  it('拆分：左半段保留关键帧，右半段不继承（内部切点）', () => {
    useProjectStore.getState().setClipKeyframes(clipId, tracks)
    useProjectStore.getState().selectClip(clipId)
    const rightId = useProjectStore.getState().splitTargetAt(2)!

    const left = clipOf(clipId)
    const right = clipOf(rightId)
    expect(left.keyframes).toEqual(tracks)
    expect('keyframes' in right).toBe(false)
  })

  it('时间轴只在 30fps 片段边界内工作：关键帧不影响入出点与时长', () => {
    const before = clipOf(clipId)
    useProjectStore.getState().setClipKeyframes(clipId, tracks)
    const after = clipOf(clipId)
    expect(after.startTime).toBe(before.startTime)
    expect(after.endTime).toBe(before.endTime)
    expect(useProjectStore.getState().project.fps).toEqual(FPS_30)
  })
})
