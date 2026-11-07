import { describe, expect, it } from 'vitest'
import { DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { compactMediaClips } from '@shared/mediaClips'
import {
  TIMELINE_SNAP_PX,
  collectSnapEdges,
  nearestEdge,
  snapEdge,
  snapMove,
  snapWindowSec
} from '@shared/timelineSnap'
import type { MediaClip } from '@shared/types'

/**
 * 时间轴工具栏（v6.2）的两个纯逻辑：
 *
 * 1. **自动吸附**：像素窗口 → 秒的换算、候选边缘收集（排除自己）、单边/整段吸附；
 * 2. **主轨对齐**：按时间顺序紧贴排列，间隙恒为 0，时长不变（字幕轨不受影响）。
 *
 * 这两条都在 shared 里，所以「拖到哪停在哪」与「一定没有空隙」都能在无 UI 的情况下锁死。
 */

const clip = (id: string, start: number, end: number): MediaClip => ({
  id,
  mediaId: 'media-1',
  trackId: DEFAULT_MEDIA_TRACK_ID,
  timelineStartSec: start,
  timelineEndSec: end,
  sourceInSec: 1,
  sourceOutSec: 1 + (end - start)
})

describe('吸附窗口换算', () => {
  it('像素阈值按「轨道宽度 / 总时长」折算成秒', () => {
    // 1000px 显示 10s → 10px = 0.1s
    expect(snapWindowSec(1000, 10)).toBeCloseTo(TIMELINE_SNAP_PX / 1000 * 10, 9)
    expect(snapWindowSec(1000, 10)).toBeCloseTo(0.1, 9)
    // 同样的 10px 在更短的总时长里代表更少的秒
    expect(snapWindowSec(1000, 5)).toBeCloseTo(0.05, 9)
  })

  it('参数非法时不吸附（宽度/时长/像素任一为 0 都返回 0）', () => {
    expect(snapWindowSec(0, 10)).toBe(0)
    expect(snapWindowSec(1000, 0)).toBe(0)
    expect(snapWindowSec(1000, 10, 0)).toBe(0)
  })
})

describe('候选边缘', () => {
  it('收集两轨片段的首尾 + 0 点，并排除被拖的那条', () => {
    const sources = [
      { id: 'a', start: 1, end: 3 },
      { id: 'b', start: 3, end: 6 }
    ]
    expect(collectSnapEdges(sources)).toEqual([0, 1, 3, 6])
    // 排除 b 之后，6 不再出现（b 的尾巴不能把 b 自己吸住）
    expect(collectSnapEdges(sources, 'b')).toEqual([0, 1, 3])
  })

  it('nearEdge：只认窗口内的最近边缘', () => {
    expect(nearestEdge(2.9, [0, 3, 6], 0.2)).toBe(3)
    expect(nearestEdge(2.5, [0, 3, 6], 0.2)).toBeNull()
    expect(nearestEdge(2.9, [0, 3, 6], 0)).toBeNull()
  })
})

describe('单边吸附（拖入点 / 拖出点）', () => {
  it('命中就贴到边缘并回传目标位置（画高亮线用）', () => {
    expect(snapEdge(2.95, [0, 3, 6], 0.1)).toEqual({ value: 3, guideSec: 3 })
  })

  it('没命中就原样返回，且没有导引线', () => {
    expect(snapEdge(2.5, [0, 3, 6], 0.1)).toEqual({ value: 2.5, guideSec: null })
  })
})

describe('整段平移吸附', () => {
  const edges = [0, 3, 6]

  it('尾部靠近邻居开头 → 贴住，形成无缝衔接（首尾相接）', () => {
    // 片段长 2s，起点 1.05 → 尾巴 3.05，离 3 只差 0.05
    const result = snapMove(1.05, 2, edges, 0.1, 10)
    expect(result.value).toBeCloseTo(1, 9)
    expect(result.guideSec).toBe(3)
  })

  it('头部靠近邻居结尾 → 贴住（从右边接上去）', () => {
    const result = snapMove(3.05, 2, edges, 0.1, 10)
    expect(result.value).toBeCloseTo(3, 9)
    expect(result.guideSec).toBe(3)
  })

  it('首尾都能吸时取位移更小的那个', () => {
    // 起点 2.92（离 3 差 0.08）、尾巴 5.1（离 6 差 0.9）→ 选起点
    const result = snapMove(2.92, 2.2, edges, 0.1, 10)
    expect(result.value).toBeCloseTo(3, 9)
    expect(result.guideSec).toBe(3)
  })

  it('都不在窗口里就不动', () => {
    expect(snapMove(1.2, 2, edges, 0.1, 10)).toEqual({ value: 1.2, guideSec: null })
  })

  it('吸附后仍夹在轨道内（不会把片段推出末尾或负轴）', () => {
    expect(snapMove(-0.05, 2, [0], 0.1, 10).value).toBe(0)
    const pushed = snapMove(9.95, 2, [9], 0.1, 10)
    expect(pushed.value).toBeLessThanOrEqual(8)
  })
})

describe('主轨对齐（compactMediaClips）', () => {
  it('按顺序紧贴排列：间隙恒为 0，时长不变', () => {
    const compacted = compactMediaClips([clip('b', 4, 6), clip('a', 1, 3)], FPS_30)
    expect(compacted.map((item) => [item.id, item.timelineStartSec, item.timelineEndSec])).toEqual([
      ['a', 0, 2],
      ['b', 2, 4]
    ])
    // 源出点跟着时长走（时长恒等式不能被破坏）
    for (const item of compacted) {
      expect(item.sourceOutSec - item.sourceInSec).toBeCloseTo(item.timelineEndSec - item.timelineStartSec, 6)
    }
  })

  it('单条片段也会被拉到 0（前面不留空隙）', () => {
    expect(compactMediaClips([clip('a', 5, 7)], FPS_30)[0]!.timelineStartSec).toBe(0)
  })

  it('已经紧贴时是幂等的（重复点不会让片段漂移）', () => {
    const first = compactMediaClips([clip('a', 0, 2), clip('b', 2, 4)], FPS_30)
    const second = compactMediaClips(first, FPS_30)
    expect(second.map((item) => item.timelineStartSec)).toEqual([0, 2])
  })

  it('空轨道返回空数组', () => {
    expect(compactMediaClips([], FPS_30)).toEqual([])
  })
})
