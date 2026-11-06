import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FPS_30 } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import type { MediaItem, VideoMeta } from '@shared/types'
import { useProjectStore } from './projectStore'
import { attachProjectHistory, HISTORY_LIMIT, useHistoryStore } from './projectHistory'

/**
 * P1：项目级撤销/重做（**本次启动轮次内**、最多 100 步，不落盘）。
 *
 * 记账是「订阅式全量快照」，所以这里的每一步都必须由真实 store 动作驱动——
 * 测试不直接往栈里塞东西，否则锁不住真正的记账规则。
 * 时间用假计时器推进：合并窗口（500ms）是这套设计的核心判据之一。
 */

function baseMeta(over: Partial<VideoMeta> = {}): VideoMeta {
  return {
    path: 'C:/media/a.mp4',
    containerName: 'mov,mp4,m4a,3gp,2b2,gif,webm',
    width: 1920,
    height: 1080,
    sar: null,
    displayRatio: 1920 / 1080,
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 },
    pixFmt: 'yuv420p',
    colorPrimaries: null,
    colorSpace: null,
    colorTransfer: null,
    colorRange: null,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioChannels: 2,
    durationSec: 10,
    nbFrames: null,
    bitRateKbps: null,
    ...over
  }
}

function seedItem(over: Partial<MediaItem> = {}): Omit<MediaItem, 'id'> {
  return {
    path: over.path ?? 'C:/media/a.mp4',
    name: over.name ?? 'a.mp4',
    meta: over.meta ?? baseMeta(),
    non169Ack: false,
    hdrAck: false,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
}

function freshProject(): void {
  useProjectStore.setState({
    project: createDefaultProject('撤销测试'),
    selectedClipId: null,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 0,
    currentPath: null
  })
}

let detach: (() => void) | null = null

const depth = (): { undo: number; redo: number } => ({
  undo: useHistoryStore.getState().past.length,
  redo: useHistoryStore.getState().future.length
})

const clips = () => useProjectStore.getState().project.clips

beforeEach(() => {
  vi.useFakeTimers()
  detach?.()
  detach = null
  freshProject()
  detach = attachProjectHistory()
})

afterEach(() => {
  detach?.()
  detach = null
  vi.useRealTimers()
})

describe('projectHistory（项目级撤销/重做）', () => {
  it('挂载后的第一次工程改动产生一步撤销，undo 回到改动前', () => {
    useProjectStore.getState().addClip(0)

    expect(depth().undo).toBe(1)
    expect(clips()).toHaveLength(1)

    useHistoryStore.getState().undo()

    expect(clips()).toHaveLength(0)
    expect(depth().undo).toBe(0)
    expect(depth().redo).toBe(1)
  })

  it('同一条字幕上的连续输入合并为一步（窗口内），窗口过后才开新步', () => {
    const id = useProjectStore.getState().addClip(0)
    vi.advanceTimersByTime(600)

    useProjectStore.getState().updateClip(id, { content: { title: '长三角', subtitle: '' } })
    vi.advanceTimersByTime(80)
    useProjectStore.getState().updateClip(id, { content: { title: '长三角一体化', subtitle: '' } })

    // 新建一步 + 这次连续输入一步
    expect(depth().undo).toBe(2)

    useHistoryStore.getState().undo()
    expect(clips()[0]?.content.title).toBe('')
    expect(clips()).toHaveLength(1)
  })

  it('紧跟在增删段之后的第一次改动单独成步，即使还处在合并窗口内', () => {
    const id = useProjectStore.getState().addClip(0)
    vi.advanceTimersByTime(50)
    useProjectStore.getState().updateClip(id, { content: { title: '汛期防御启动', subtitle: '' } })

    expect(depth().undo).toBe(2)

    // 撤销这次输入：片段还在，只是文字回到空
    useHistoryStore.getState().undo()
    expect(clips()).toHaveLength(1)
    expect(clips()[0]?.content.title).toBe('')
  })

  it('点选另一条之后立即改参数，也是新的一步（撤销不跨过选中）', () => {
    const first = useProjectStore.getState().addClip(0)
    vi.advanceTimersByTime(600)
    useProjectStore.getState().addClip(6)
    vi.advanceTimersByTime(50)

    useProjectStore.getState().selectClip(first)
    vi.advanceTimersByTime(50)
    useProjectStore.getState().updateClip(first, { content: { title: '回到第一条', subtitle: '' } })

    useHistoryStore.getState().undo()

    expect(useProjectStore.getState().project.clips.find((clip) => clip.id === first)?.content.title).toBe('')
    // 撤销回来的那一步带着「当时选中的是哪条」，右侧检查器不会指向别的段
    expect(useProjectStore.getState().selectedClipId).toBe(first)
  })

  it('撤销连带恢复选中项', () => {
    const first = useProjectStore.getState().addClip(0)
    vi.advanceTimersByTime(600)
    const second = useProjectStore.getState().addClip(6)
    expect(useProjectStore.getState().selectedClipId).toBe(second)

    useHistoryStore.getState().undo()

    expect(clips()).toHaveLength(1)
    expect(useProjectStore.getState().selectedClipId).toBe(first)
  })

  it('撤销后 redo 回到撤销前；撤销后再编辑则清空 redo', () => {
    useProjectStore.getState().addClip(0)
    useHistoryStore.getState().undo()
    expect(clips()).toHaveLength(0)

    useHistoryStore.getState().redo()
    expect(clips()).toHaveLength(1)
    expect(depth().redo).toBe(0)

    // 重做的结果再被新编辑覆盖时，redo 链必须断掉
    useHistoryStore.getState().undo()
    vi.advanceTimersByTime(600)
    useProjectStore.getState().setName('改名工程')
    expect(depth().redo).toBe(0)
  })

  it('空栈时 undo / redo 都是 no-op', () => {
    useHistoryStore.getState().undo()
    useHistoryStore.getState().redo()

    expect(clips()).toHaveLength(0)
    expect(depth()).toEqual({ undo: 0, redo: 0 })
  })

  it(`历史上限 ${HISTORY_LIMIT} 步：超出丢最旧`, () => {
    for (let i = 0; i <= HISTORY_LIMIT; i += 1) {
      useProjectStore.getState().addClip(i)
      vi.advanceTimersByTime(5)
    }
    expect(clips()).toHaveLength(HISTORY_LIMIT + 1)
    expect(depth().undo).toBe(HISTORY_LIMIT)

    for (let i = 0; i < HISTORY_LIMIT; i += 1) useHistoryStore.getState().undo()

    // 最旧的一步已被丢弃，所以还能剩下 1 条而不是回到空工程
    expect(clips()).toHaveLength(1)
    expect(depth().undo).toBe(0)
  })

  it('只写 project.ui（切左侧 Tab）不进历史，撤销也不把 Tab 刷回去', () => {
    const writeTab = (tab: 'export' | 'wrap'): void => {
      useProjectStore.setState((state) => ({
        project: { ...state.project, ui: { ...(state.project.ui ?? {}), leftTab: tab } },
        revision: state.revision + 1
      }))
    }
    writeTab('export')
    expect(depth().undo).toBe(0)

    useProjectStore.getState().addClip(0)
    writeTab('wrap')
    expect(depth().undo).toBe(1)

    useHistoryStore.getState().undo()

    expect(clips()).toHaveLength(0)
    expect(useProjectStore.getState().project.ui?.leftTab).toBe('wrap')
  })

  it('缩略图写回不进历史，撤销后仍保留活态缩略图', () => {
    const mediaId = useProjectStore.getState().addMedia(seedItem())
    expect(depth().undo).toBe(1)

    useProjectStore.getState().setMediaThumb(mediaId, 'data:image/jpeg;base64,AAA')
    expect(depth().undo).toBe(1)

    vi.advanceTimersByTime(600)
    useProjectStore.getState().addClip(0)
    useHistoryStore.getState().undo()

    expect(clips()).toHaveLength(0)
    expect(useProjectStore.getState().project.media[0]?.thumbnailUrl).toBe('data:image/jpeg;base64,AAA')
  })

  it('loadProject 换工程时清空历史：跨工程的撤销没有意义', () => {
    useProjectStore.getState().addClip(0)
    expect(depth().undo).toBe(1)

    const next = createDefaultProject('另一个工程')
    next.fps = FPS_30
    useProjectStore.getState().loadProject(next, 'C:/projects/next.fnproj')

    expect(depth()).toEqual({ undo: 0, redo: 0 })

    // 旧工程的步骤不能再被撤销回来
    useHistoryStore.getState().undo()
    expect(useProjectStore.getState().project.name).toBe('另一个工程')
  })

  it('卸载记账后不再产生步骤', () => {
    detach?.()
    detach = null

    useProjectStore.getState().addClip(0)

    expect(clips()).toHaveLength(1)
    expect(depth().undo).toBe(0)
  })

  it('重复 attach 只保留一条订阅，不会把同一次改动记成两步', () => {
    detach?.()
    detach = attachProjectHistory()
    detach = attachProjectHistory()

    useProjectStore.getState().addClip(0)

    expect(depth().undo).toBe(1)
  })
})
