import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FONT_ID, FPS_29_97, FPS_30, MIN_CLIP_DURATION_SEC, MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { getPreset } from '@shared/presets'
import { snapTimeToFrame } from '@shared/fps'
import { MEDIA_TRACK_ID_PREFIX, makeMediaTrack } from '@shared/tracks'
import type { MediaItem, Project, VideoMeta } from '@shared/types'
import { useProjectStore, timelineDurationSec } from './projectStore'

/**
 * v2 素材池与媒体轨动作（阶段 3 单测）：
 * 导入/移出、时长恒等式、仅重叠才右移、拆分、枚级确认位、leftTab。
 * 全部断言走 store 动作本身，不依赖窗口 IPC。
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

function freshProject(project?: Project): void {
  useProjectStore.setState({
    project: project ?? createDefaultProject('媒体轨测试'),
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

describe('素材池动作', () => {
  it('addMedia 入池并返回 id；同路径重复导入复用旧条目不产生第二枚', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    expect(useProjectStore.getState().project.media).toHaveLength(1)
    const again = useProjectStore.getState().addMedia(seedItem({ name: 'renamed' }))
    expect(again).toBe(id)
    expect(useProjectStore.getState().project.media).toHaveLength(1)
    expect(useProjectStore.getState().project.media[0]?.name).toBe('renamed')
  })

  it('removeMedia 默认连带删除引用片段；removeClips=false 保轨（重新定位用）', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    store.insertMediaClip({ mediaId: id, timelineStartSec: 0 })
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(1)
    useProjectStore.getState().removeMedia(id, { removeClips: false })
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(1)
    expect(useProjectStore.getState().project.media).toHaveLength(0)
    // 孤儿片段仍留在轨上（卡片显示「素材已移出」），再删一次带片段
    const id2 = useProjectStore.getState().addMedia(seedItem({ path: 'C:/media/b.mp4' }))
    useProjectStore.getState().insertMediaClip({ mediaId: id2, timelineStartSec: 20 })
    useProjectStore.getState().removeMedia(id2)
    const clips = useProjectStore.getState().project.mediaClips
    expect(clips.every((c) => c.mediaId === id)).toBe(true)
  })

  it('renameMedia / ackMedia* / setMediaVfrPolicy 只动目标枚', () => {
    const store = useProjectStore.getState()
    const a = store.addMedia(seedItem({ path: 'C:/media/a.mp4' }))
    const b = store.addMedia(seedItem({ path: 'C:/media/b.mp4' }))
    useProjectStore.getState().renameMedia(a, '  新闻A  ')
    useProjectStore.getState().ackMediaHdr(b, true)
    useProjectStore.getState().setMediaVfrPolicy(a, 'converted')
    const pool = useProjectStore.getState().project.media
    expect(pool.find((m) => m.id === a)?.name).toBe('新闻A')
    expect(pool.find((m) => m.id === a)?.vfrPolicy).toBe('converted')
    expect(pool.find((m) => m.id === b)?.hdrAck).toBe(true)
    expect(pool.find((m) => m.id === b)?.vfrPolicy).toBe('none')
  })

  it('relocateMedia 换源不换轨：路径/元数据更新，片段引用保持', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 0 })
    store.relocateMedia(id, { path: 'C:/media/new.mp4', meta: baseMeta({ path: 'C:/media/new.mp4', durationSec: 8 }) })
    const after = useProjectStore.getState()
    expect(after.project.media.find((m) => m.id === id)?.path).toBe('C:/media/new.mp4')
    expect(after.project.mediaClips.map((c) => c.mediaId)).toContain(id)
    expect(after.project.mediaClips[0]?.id).toBe(clip?.id)
  })
})

describe('媒体轨动作', () => {
  it('insertMediaClip：默认整段，时长恒等式 timeline == source 区间', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 2 })
    expect(clip).not.toBeNull()
    expect(clip!.timelineStartSec).toBe(2)
    expect(clip!.sourceInSec).toBe(0)
    expect(clip!.timelineEndSec - clip!.timelineStartSec).toBeCloseTo(clip!.sourceOutSec - clip!.sourceInSec, 6)
    expect(clip!.timelineEndSec).toBeCloseTo(12, 6)
  })

  it('insertMediaClip：落点剩余不足最短时长时向内收；素材不存在拒收', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 0, durationSec: 10, sourceInSec: 9.95 })
    // 只剩 0.05s 源料（< MIN_MEDIA_CLIP_SEC 0.2）→ 拒收
    expect(clip).toBeNull()
    expect(useProjectStore.getState().insertMediaClip({ mediaId: 'nope', timelineStartSec: 0 })).toBeNull()
  })

  it('moveMediaClip：只能在空档里滑动，撞到邻居就贴住，绝不推动它', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const a = store.insertMediaClip({ mediaId: id, timelineStartSec: 0, durationSec: 4 })!
    const b = store.insertMediaClip({ mediaId: id, timelineStartSec: 5, durationSec: 3 })!
    // 把 a 拖到 4s：a 与 b（5–8）之间的空档只容得下 [0,5]，所以 a 停在 1s 贴住 b 的左缘
    useProjectStore.getState().moveMediaClip(a.id, 4)
    const after = useProjectStore.getState().project.mediaClips
    const movedA = after.find((c) => c.id === a.id)!
    const movedB = after.find((c) => c.id === b.id)!
    expect(movedA.timelineStartSec).toBe(1)
    expect(movedA.timelineEndSec).toBe(5)
    // b 一动不动（时长与源坐标也不变）
    expect(movedB.timelineStartSec).toBe(5)
    expect(movedB.timelineEndSec).toBe(8)
    expect(movedB.timelineEndSec - movedB.timelineStartSec).toBeCloseTo(3, 6)
    expect(movedB.sourceInSec).toBe(b.sourceInSec)
    expect(movedB.sourceOutSec).toBe(b.sourceOutSec)
  })

  it('moveMediaClip：拖到后半段时，起点更早但**不重叠**的片段原地不动', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem({ meta: baseMeta({ durationSec: 10 }) }))
    // 前段 C[0,1]，被拖的 A[3,7]
    const c = store.insertMediaClip({ mediaId: id, timelineStartSec: 0, durationSec: 1 })!
    const a = store.insertMediaClip({ mediaId: id, timelineStartSec: 3, durationSec: 4 })!
    // A 拖到 2s（[2,6]）：与 C 完全不相交，C 必须留在 0
    useProjectStore.getState().moveMediaClip(a.id, 2)
    const after = useProjectStore.getState().project.mediaClips
    expect(after.find((clip) => clip.id === a.id)!.timelineStartSec).toBe(2)
    expect(after.find((clip) => clip.id === c.id)!.timelineStartSec).toBe(0)
    expect(after.find((clip) => clip.id === c.id)!.timelineEndSec).toBe(1)
  })

  it('moveMediaClip：不同轨道的片段互不推挤', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem({ meta: baseMeta({ durationSec: 10 }) }))
    const a = useProjectStore.getState().insertMediaClip({ mediaId: id, timelineStartSec: 3, durationSec: 4 })!
    const trackId = useProjectStore.getState().addMediaTrack()!
    const b = useProjectStore
      .getState()
      .insertMediaClip({ mediaId: id, timelineStartSec: 8, durationSec: 1, trackId })!
    // B 从 8s 拖到 4s：与底层轨道 0 的 A[3,7] 重叠，但 B 在上层轨道，不能把 A 顶走
    useProjectStore.getState().moveMediaClip(b.id, 4)
    const after = useProjectStore.getState().project.mediaClips
    expect(after.find((clip) => clip.id === b.id)!.timelineStartSec).toBe(4)
    expect(after.find((clip) => clip.id === a.id)!.timelineStartSec).toBe(3)
    expect(after.find((clip) => clip.id === a.id)!.timelineEndSec).toBe(7)
  })

  it('moveMediaClip：压住多段时也只贴住最近的那段，不推动任何邻居', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem({ meta: baseMeta({ durationSec: 10 }) }))
    const a = store.insertMediaClip({ mediaId: id, timelineStartSec: 0, durationSec: 4 })!
    const b = store.insertMediaClip({ mediaId: id, timelineStartSec: 5, durationSec: 1 })!
    const c = store.insertMediaClip({ mediaId: id, timelineStartSec: 6.5, durationSec: 0.5 })!
    // A 想拖到 5s：空档 [0,5] 只放得下 4s，A 停在 1s，B/C 原地不动
    useProjectStore.getState().moveMediaClip(a.id, 5)
    const after = useProjectStore.getState().project.mediaClips
    const movedA = after.find((clip) => clip.id === a.id)!
    const movedB = after.find((clip) => clip.id === b.id)!
    const movedC = after.find((clip) => clip.id === c.id)!
    expect(movedA.timelineStartSec).toBe(1)
    expect(movedA.timelineEndSec).toBe(5)
    expect(movedB.timelineStartSec).toBe(5)
    expect(movedC.timelineStartSec).toBe(6.5)
  })


  it('trimMediaClip：入/出点与源坐标同幅度平移，恒等式不破坏', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 2, durationSec: 6, sourceInSec: 1 })!
    useProjectStore.getState().trimMediaClip(clip.id, { timelineStartSec: 3 })
    let after = useProjectStore.getState().project.mediaClips.find((c) => c.id === clip.id)!
    expect(after.sourceInSec).toBeCloseTo(2, 6)
    expect(after.timelineEndSec - after.timelineStartSec).toBeCloseTo(after.sourceOutSec - after.sourceInSec, 6)
    useProjectStore.getState().trimMediaClip(clip.id, { timelineEndSec: after.timelineStartSec + 4 })
    after = useProjectStore.getState().project.mediaClips.find((c) => c.id === clip.id)!
    expect(after.timelineEndSec - after.timelineStartSec).toBeCloseTo(4, 6)
    expect(after.sourceOutSec - after.sourceInSec).toBeCloseTo(4, 6)
  })

  it('trimMediaClip：出点超出源尾时按源尾截断（时长恒等式仍成立）', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem({ meta: baseMeta({ durationSec: 5 }) }))
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 0 })!
    useProjectStore.getState().trimMediaClip(clip.id, { timelineEndSec: 9 })
    const after = useProjectStore.getState().project.mediaClips.find((c) => c.id === clip.id)!
    // 源只有 5s：出点最多推到 sourceOut=5 → 时长 5
    expect(after.sourceOutSec).toBeCloseTo(5, 6)
    expect(after.timelineEndSec - after.timelineStartSec).toBeCloseTo(after.sourceOutSec - after.sourceInSec, 6)
  })

  it('splitTargetAt（未选中退到媒体轨）：拆出的两段首尾相接、右段入选中；切点无效返回 null', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 0, durationSec: 6, sourceInSec: 2 })!
    const rightId = useProjectStore.getState().splitTargetAt(2)
    expect(rightId).not.toBeNull()
    const after = useProjectStore.getState()
    expect(after.selectedMediaClipId).toBe(rightId)
    const parts = after.project.mediaClips.filter((c) => c.mediaId === id)
    expect(parts).toHaveLength(2)
    const left = parts.find((c) => c.id === clip.id)!
    const right = parts.find((c) => c.id === rightId)!
    expect(left.timelineEndSec).toBe(right.timelineStartSec)
    expect(left.sourceOutSec).toBe(right.sourceInSec)
    expect(left.timelineEndSec - left.timelineStartSec + (right.timelineEndSec - right.timelineStartSec)).toBeCloseTo(6, 6)
    // 空隙处无可拆段
    expect(useProjectStore.getState().splitTargetAt(100)).toBeNull()
    // 太贴近段首（不足最短）不可拆
    expect(useProjectStore.getState().splitTargetAt(clip.timelineStartSec + MIN_MEDIA_CLIP_SEC / 2)).toBeNull()
  })

  it('removeMediaClip：只删段，素材池不动', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 0 })!
    useProjectStore.getState().removeMediaClip(clip.id)
    expect(useProjectStore.getState().project.mediaClips).toHaveLength(0)
    expect(useProjectStore.getState().project.media).toHaveLength(1)
  })
})

describe('时间轴与帧率联动', () => {
  it('timelineDurationSec：双轨取最大覆盖；空工程回默认', () => {
    freshProject()
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem({ meta: baseMeta({ durationSec: 30 }) }))
    store.insertMediaClip({ mediaId: id, timelineStartSec: 0 })
    store.addClip(0)
    const project = useProjectStore.getState().project
    expect(project.clips.length + project.mediaClips.length).toBe(2)
    expect(timelineDurationSec(project)).toBeGreaterThanOrEqual(30)
  })

  it('setFps：媒体轨四个坐标随新帧率重新吸附，时长恒等式保持', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem({ meta: baseMeta({ durationSec: 10.017 } ) }))
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 1.017, durationSec: 4, sourceInSec: 0.5 })!
    useProjectStore.getState().setFps(FPS_29_97)
    const after = useProjectStore.getState().project.mediaClips.find((c) => c.id === clip.id)!
    expect(after.timelineStartSec).toBe(snapTimeToFrame(clip.timelineStartSec, FPS_29_97))
    expect(after.timelineEndSec - after.timelineStartSec).toBeCloseTo(after.sourceOutSec - after.sourceInSec, 6)
    // 再切回 30fps：已经吸附过的坐标保持不动（幂等）
    useProjectStore.getState().setFps(FPS_30)
    const back = useProjectStore.getState().project.mediaClips.find((c) => c.id === clip.id)!
    expect(back.timelineStartSec).toBe(snapTimeToFrame(after.timelineStartSec, FPS_30))
  })
})

/**
 * 切预设 / 清除自定义的 store 口径（用户明确要求）：
 * 点预设 = 即时应用该预设 + 把全部自定义参数还原到它的默认配置，文字与入出点不动。
 * 面板层的二次确认不改变这个口径，只决定要不要发出这次 patch。
 */
describe('切预设与清除自定义（预览必须回到该预设默认形态）', () => {
  const seedEdited = (): string => {
    freshProject()
    const store = useProjectStore.getState()
    const id = store.addClip(0)!
    store.updateClip(id, { presetId: 'breakingRed' })
    store.updateClip(id, {
      styleOverrides: { tokens: { primary: '#101010' }, barOpacity: 0.7, fontScale: { title: 1.4 }, compact: true }
    })
    store.updateClip(id, { fontId: 'builtin-notosanssc-900' })
    return id
  }
  const clipOf = (id: string) => useProjectStore.getState().project.clips.find((clip) => clip.id === id)!

  it('切预设即时应用，并把配色/透明度/字号缩放/紧凑/字体全部回到新预设默认', () => {
    const id = seedEdited()
    const before = clipOf(id)
    // 先确认自定义真的写进去了，否则后面的断言会空转
    expect(before.styleOverrides.tokens?.primary).toBe('#101010')
    expect(before.fontId).toBe('builtin-notosanssc-900')

    const revisionBefore = useProjectStore.getState().revision
    useProjectStore.getState().updateClip(id, { presetId: 'calmEditorial' })

    const after = clipOf(id)
    expect(after.presetId).toBe('calmEditorial')
    expect(after.styleOverrides).toEqual({})
    expect(after.fontId).toBe(DEFAULT_FONT_ID)
    expect(after.animation.inDuration).toBe(getPreset('calmEditorial').animation.inDuration)
    expect(after.animation.outDuration).toBe(getPreset('calmEditorial').animation.outDuration)
    // revision 必须动：预览重建与自动保存都靠它
    expect(useProjectStore.getState().revision).toBe(revisionBefore + 1)
  })

  it('文字内容与入出点不属于样式：切预设一律不动', () => {
    const id = seedEdited()
    useProjectStore.getState().updateClip(id, { content: { title: '必须留下', subtitle: '也要留下' } })
    const before = clipOf(id)

    useProjectStore.getState().updateClip(id, { presetId: 'globalSimple' })

    const after = clipOf(id)
    expect(after.content).toEqual({ title: '必须留下', subtitle: '也要留下' })
    expect({ start: after.startTime, end: after.endTime }).toEqual({ start: before.startTime, end: before.endTime })
  })

  it('重复点当前预设同样清空自定义（store 单一口径，确认弹窗由面板负责）', () => {
    const id = seedEdited()
    expect(clipOf(id).presetId).toBe('breakingRed')

    useProjectStore.getState().updateClip(id, { presetId: 'breakingRed' })

    expect(clipOf(id).styleOverrides).toEqual({})
    expect(clipOf(id).fontId).toBe(DEFAULT_FONT_ID)
  })

  it('同一次调用里显式传的覆盖仍然生效（不让 patch 默默丢字段）', () => {
    freshProject()
    const id = useProjectStore.getState().addClip(0)!
    useProjectStore.getState().updateClip(id, {
      presetId: 'breakingRed',
      styleOverrides: { tokens: { primary: '#101010' }, barOpacity: 0.8, fontScale: { title: 1.3 } }
    })
    const after = clipOf(id)
    expect(after.presetId).toBe('breakingRed')
    expect(after.styleOverrides.tokens?.primary).toBe('#101010')
    expect(after.styleOverrides.barOpacity).toBe(0.8)
    expect(after.styleOverrides.fontScale?.title).toBe(1.3)
  })

  it('resetClipStyle 只清当前片段，其他片段的自定义不受牵连', () => {
    freshProject()
    const store = useProjectStore.getState()
    const first = store.addClip(0)!
    const second = store.addClip(5)!
    useProjectStore.getState().updateClip(first, { styleOverrides: { tokens: { primary: '#101010' } } })
    useProjectStore.getState().updateClip(second, { styleOverrides: { tokens: { accent: '#202020' } } })

    useProjectStore.getState().resetClipStyle(first)

    expect(clipOf(first).styleOverrides).toEqual({})
    expect(clipOf(second).styleOverrides.tokens?.accent).toBe('#202020')
  })

  it('覆盖是整组替换：空令牌集等于撤销这一层，不留 {tokens:{}} 噪声', () => {
    const id = seedEdited()
    useProjectStore.getState().updateClip(id, { styleOverrides: { tokens: {} } })
    const after = clipOf(id)
    expect('tokens' in after.styleOverrides).toBe(false)
    // 其他层（透明度/字号/紧凑）仍然保留：只撤销令牌这一层
    expect(after.styleOverrides.barOpacity).toBe(0.7)
    expect(after.styleOverrides.fontScale?.title).toBe(1.4)
    expect(after.styleOverrides.compact).toBe(true)
  })

  it('回到「没有偏离」的值就删键：不透明 1、紧凑 false、字号 100% 都不留在工程里', () => {
    const id = seedEdited()
    useProjectStore.getState().updateClip(id, {
      styleOverrides: { barOpacity: 1, compact: false, fontScale: { title: 1 } }
    })
    const after = clipOf(id)
    expect('barOpacity' in after.styleOverrides).toBe(false)
    expect('compact' in after.styleOverrides).toBe(false)
    expect('fontScale' in after.styleOverrides).toBe(false)
    // 令牌层没动，仍然在
    expect(after.styleOverrides.tokens?.primary).toBe('#101010')
  })
})

/**
 * v6：媒体段的画面编辑与检查器分流。
 * 检查器靠「最后点选的是哪类」分流，而不是靠哪个 id 非空——否则选完媒体段再点字幕条会卡住。
 */
describe('媒体段画面编辑与检查器分流', () => {
  function seedMediaClip(): string {
    freshProject()
    const store = useProjectStore.getState()
    const mediaId = store.addMedia(seedItem())
    return store.insertMediaClip({ mediaId, timelineStartSec: 0 })!.id
  }
  const mediaClipOf = (id: string) => useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!

  it('选中媒体段把检查器切到 media，再点字幕条切回 subtitle', () => {
    const mediaClipId = seedMediaClip()
    const subtitleId = useProjectStore.getState().addClip(0)!
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')

    useProjectStore.getState().selectMediaClip(mediaClipId)
    expect(useProjectStore.getState().selectionKind).toBe('media')

    useProjectStore.getState().selectClip(subtitleId)
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
    // 两个选中态各自保留，不互相清空
    expect(useProjectStore.getState().selectedMediaClipId).toBe(mediaClipId)
  })

  it('updateMediaClipVideo 是增量合并；回到默认值就整键删除', () => {
    const id = seedMediaClip()
    useProjectStore.getState().updateMediaClipVideo(id, { scalePercent: 150 })
    expect(mediaClipOf(id).video?.scalePercent).toBe(150)
    expect(mediaClipOf(id).video?.flipH).toBe(false)

    useProjectStore.getState().updateMediaClipVideo(id, { flipH: true })
    expect(mediaClipOf(id).video?.scalePercent).toBe(150)
    expect(mediaClipOf(id).video?.flipH).toBe(true)

    // 逐项拉回默认 + 关掉镜像 → 整键消失（不留一堆零值）
    useProjectStore.getState().updateMediaClipVideo(id, { scalePercent: 100, flipH: false })
    expect(mediaClipOf(id).video).toBeUndefined()
  })

  it('越界值在写入时就夹好，脏值不会落到工程里', () => {
    const id = seedMediaClip()
    useProjectStore.getState().updateMediaClipVideo(id, { scalePercent: 9999, rotationDeg: -90, brightness: 500 })
    const video = mediaClipOf(id).video!
    expect(video.scalePercent).toBe(400)
    expect(video.rotationDeg).toBe(0)
    expect(video.brightness).toBe(100)
  })

  it('resetMediaClipVideo 只清当前段，其他段不受牵连', () => {
    const first = seedMediaClip()
    const store = useProjectStore.getState()
    const second = store.insertMediaClip({ mediaId: store.project.media[0]!.id, timelineStartSec: 20 })!.id
    useProjectStore.getState().updateMediaClipVideo(first, { scalePercent: 130 })
    useProjectStore.getState().updateMediaClipVideo(second, { contrast: 40 })

    useProjectStore.getState().resetMediaClipVideo(first)

    expect(mediaClipOf(first).video).toBeUndefined()
    expect(mediaClipOf(second).video?.contrast).toBe(40)
  })

  it('v8：updateMediaClipStab 增量合并；回到全默认时整键删除', () => {
    const id = seedMediaClip()
    useProjectStore.getState().updateMediaClipStab(id, { enabled: true })
    expect(mediaClipOf(id).stab).toEqual({ enabled: true, level: 'standard', tripod: false })

    // 增量：改档位不丢开关
    useProjectStore.getState().updateMediaClipStab(id, { level: 'high' })
    expect(mediaClipOf(id).stab).toEqual({ enabled: true, level: 'high', tripod: false })

    // 关掉开关但留着非默认档位 → 键仍落盘（与 video 的逐项默认纪律一致）
    useProjectStore.getState().updateMediaClipStab(id, { enabled: false })
    expect(mediaClipOf(id).stab).toEqual({ enabled: false, level: 'high', tripod: false })

    // 拉回标准档 → 全默认，整键消失
    useProjectStore.getState().updateMediaClipStab(id, { level: 'standard' })
    expect(mediaClipOf(id).stab).toBeUndefined()
  })

  it('v8：resetMediaClipVideo 连防抖一起清，不牵连其他段', () => {
    const first = seedMediaClip()
    const store = useProjectStore.getState()
    const second = store.insertMediaClip({ mediaId: store.project.media[0]!.id, timelineStartSec: 20 })!.id
    useProjectStore.getState().updateMediaClipVideo(first, { scalePercent: 130 })
    useProjectStore.getState().updateMediaClipStab(first, { enabled: true, level: 'low' })
    useProjectStore.getState().updateMediaClipStab(second, { enabled: true })

    useProjectStore.getState().resetMediaClipVideo(first)

    expect(mediaClipOf(first).video).toBeUndefined()
    expect(mediaClipOf(first).stab).toBeUndefined()
    expect(mediaClipOf(second).stab).toEqual({ enabled: true, level: 'standard', tripod: false })
  })

  it('删掉正在编辑的最后一条媒体段 → 检查器退回字幕编辑器', () => {
    const id = seedMediaClip()
    useProjectStore.getState().selectMediaClip(id)
    expect(useProjectStore.getState().selectionKind).toBe('media')

    useProjectStore.getState().removeMediaClip(id)

    expect(useProjectStore.getState().selectedMediaClipId).toBeNull()
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
  })
})

/**
 * v9：片段音频与变速的 store 口径。
 *
 * 除「增量合并 + 回默认删键」，最关键的是**变速时源窗口不动、时间轴伸缩**，
 * 以及「恢复默认」必须连音频与变速一起清掉（否则预览与导出会分叉）。
 */
describe('v9 片段音频与变速动作', () => {
  function seedMedia(): string {
    freshProject()
    const store = useProjectStore.getState()
    return store.addMedia(seedItem())
  }
  const mediaClipOf = (id: string) => useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!
  const audioClipOf = (id: string) => useProjectStore.getState().project.audioClips!.find((clip) => clip.id === id)!

  /** 夹具：素材长 10s，默认整段入轨 → 时间轴 0→10、源 0→10 */
  function seedClipAt0(): string {
    const mediaId = seedMedia()
    return useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0 })!.id
  }
  function seedAudioAt0(): string {
    const mediaId = seedMedia()
    return useProjectStore.getState().insertAudioClip({ mediaId, timelineStartSec: 0 })!.id
  }

  it('updateMediaClipAudio 增量合并；回到全默认整键删除', () => {
    const id = seedClipAt0()
    useProjectStore.getState().updateMediaClipAudio(id, { volumePercent: 140 })
    expect(mediaClipOf(id).audio).toEqual({ volumePercent: 140, fadeInSec: 0, fadeOutSec: 0 })
    useProjectStore.getState().updateMediaClipAudio(id, { fadeInSec: 1.5 })
    expect(mediaClipOf(id).audio).toEqual({ volumePercent: 140, fadeInSec: 1.5, fadeOutSec: 0 })
    useProjectStore.getState().updateMediaClipAudio(id, { volumePercent: 100, fadeInSec: 0 })
    expect('audio' in mediaClipOf(id)).toBe(false)
  })

  it('越界值写入时就夹好（面板上拖到头也不会落脏数据）', () => {
    const id = seedClipAt0()
    useProjectStore.getState().updateMediaClipAudio(id, { volumePercent: 900, fadeOutSec: -2 })
    expect(mediaClipOf(id).audio).toEqual({ volumePercent: 200, fadeInSec: 0, fadeOutSec: 0 })
  })

  it('updateMediaClipSpeed：源窗口不动，时间轴出点按倍速伸缩', () => {
    const id = seedClipAt0()
    useProjectStore.getState().updateMediaClipSpeed(id, { speed: 2 })
    const fast = mediaClipOf(id)
    expect(fast.timelineStartSec).toBe(0)
    expect(fast.timelineEndSec).toBeCloseTo(5, 6)
    expect(fast.sourceInSec).toBe(0)
    expect(fast.sourceOutSec).toBe(10)
    expect(fast.speed).toEqual({ speed: 2, maintainPitch: true })

    useProjectStore.getState().updateMediaClipSpeed(id, { speed: 4 })
    expect(mediaClipOf(id).timelineEndSec).toBeCloseTo(2.5, 6)

    // 回到 1x：时间轴回到源窗口长度，整键消失
    useProjectStore.getState().updateMediaClipSpeed(id, { speed: 1 })
    expect(mediaClipOf(id).timelineEndSec).toBeCloseTo(10, 6)
    expect('speed' in mediaClipOf(id)).toBe(false)
  })

  it('只改音高开关不改时长，但 speed 键仍落盘', () => {
    const id = seedClipAt0()
    useProjectStore.getState().updateMediaClipSpeed(id, { maintainPitch: false })
    expect(mediaClipOf(id).timelineEndSec).toBeCloseTo(10, 6)
    expect(mediaClipOf(id).speed).toEqual({ speed: 1, maintainPitch: false })
  })

  it('变速不推挤其他段，也不改它们的参数', () => {
    const first = seedClipAt0()
    const mediaId = useProjectStore.getState().project.media[0]!.id
    // 落点被占：第二段顺延到第一段后面的空档（10s 起），不叠在 0s
    const second = useProjectStore.getState().insertMediaClip({ mediaId, timelineStartSec: 0 })!.id
    expect(mediaClipOf(second).timelineStartSec).toBeCloseTo(10, 6)
    useProjectStore.getState().updateMediaClipSpeed(first, { speed: 2 })
    expect(mediaClipOf(second).timelineStartSec).toBeCloseTo(10, 6)
    expect(mediaClipOf(second).timelineEndSec).toBeCloseTo(20, 6)
    expect(mediaClipOf(second).speed).toBeUndefined()
  })

  it('变速后再拖边：恒等式仍成立（源位移 = 时间轴位移 × 倍速）', () => {
    const id = seedClipAt0()
    useProjectStore.getState().updateMediaClipSpeed(id, { speed: 2 })
    useProjectStore.getState().trimMediaClip(id, { timelineStartSec: 1 })
    const trimmed = mediaClipOf(id)
    expect(trimmed.sourceInSec).toBeCloseTo(2, 6)
    expect(trimmed.sourceOutSec - trimmed.sourceInSec).toBeCloseTo(
      (trimmed.timelineEndSec - trimmed.timelineStartSec) * 2,
      6
    )
  })

  it('resetMediaClipVideo 连音频与变速一起清，时间轴回到源窗口长度', () => {
    const id = seedClipAt0()
    useProjectStore.getState().updateMediaClipVideo(id, { scalePercent: 130 })
    useProjectStore.getState().updateMediaClipAudio(id, { volumePercent: 60 })
    useProjectStore.getState().updateMediaClipSpeed(id, { speed: 2 })

    useProjectStore.getState().resetMediaClipVideo(id)

    const cleared = mediaClipOf(id)
    expect(cleared.video).toBeUndefined()
    expect(cleared.audio).toBeUndefined()
    expect(cleared.speed).toBeUndefined()
    expect(cleared.timelineEndSec).toBeCloseTo(10, 6)
  })

  it('选中音频段把检查器切到 audio；删掉后退回 subtitle', () => {
    const id = seedAudioAt0()
    useProjectStore.getState().selectAudioClip(id)
    expect(useProjectStore.getState().selectionKind).toBe('audio')

    useProjectStore.getState().removeAudioClip(id)
    expect(useProjectStore.getState().selectedAudioClipId).toBeNull()
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
  })

  it('音频段同样一套：音量落盘/删键、倍速伸缩、恢复默认', () => {
    const id = seedAudioAt0()
    useProjectStore.getState().updateAudioClipAudio(id, { volumePercent: 150, fadeInSec: 2 })
    expect(audioClipOf(id).audio).toEqual({ volumePercent: 150, fadeInSec: 2, fadeOutSec: 0 })

    useProjectStore.getState().updateAudioClipSpeed(id, { speed: 2 })
    expect(audioClipOf(id).timelineEndSec).toBeCloseTo(5, 6)
    expect(audioClipOf(id).sourceOutSec).toBe(10)

    useProjectStore.getState().resetAudioClipFx(id)
    const cleared = audioClipOf(id)
    expect('audio' in cleared).toBe(false)
    expect('speed' in cleared).toBe(false)
    expect(cleared.timelineEndSec).toBeCloseTo(10, 6)
  })
})

describe('拆分 / 删除作用于「当前该操作的那一段」（P3）', () => {
  /** 直接搭轨：避开插入时的重叠右移规则，把多轨场景摆准（trackIndex 0 = 最底层） */
  function seedTracks(clips: Array<{ id: string; start: number; end: number; track?: number }>): void {
    const project = createDefaultProject('拆分目标')
    project.fps = FPS_30
    project.media = [{ id: 'media-1', ...seedItem() }]
    const maxTrack = clips.reduce((max, clip) => Math.max(max, clip.track ?? 0), 0)
    project.mediaTracks = Array.from({ length: maxTrack + 1 }, (_, index) => makeMediaTrack(index))
    project.mediaClips = clips.map((clip) => ({
      id: clip.id,
      mediaId: 'media-1',
      trackId: `${MEDIA_TRACK_ID_PREFIX}${clip.track ?? 0}`,
      timelineStartSec: clip.start,
      timelineEndSec: clip.end,
      sourceInSec: clip.start,
      sourceOutSec: clip.end
    }))
    useProjectStore.setState({
      project,
      selectedClipId: null,
      selectedMediaClipId: null,
      selectedAudioClipId: null,
      selectionKind: 'subtitle',
      fonts: []
    })
  }

  function seedSubtitle(title: string, start: number, end: number): string {
    const project = createDefaultProject('拆字幕')
    project.fps = FPS_30
    const clip = createClip({ startTime: start, fps: FPS_30 })
    clip.content = { title, subtitle: '省应急管理厅' }
    clip.endTime = end
    project.clips = [clip]
    useProjectStore.setState({
      project,
      selectedClipId: null,
      selectedMediaClipId: null,
      selectedAudioClipId: null,
      selectionKind: 'subtitle',
      fonts: []
    })
    return clip.id
  }

  const mediaClips = () => useProjectStore.getState().project.mediaClips
  const audioClips = () => useProjectStore.getState().project.audioClips ?? []

  it('选中字幕条时拆字幕条：两半文字一致，右半入选中', () => {
    const id = seedSubtitle('汛期防御启动', 0, 6)
    useProjectStore.getState().selectClip(id)

    const rightId = useProjectStore.getState().splitTargetAt(2)

    expect(rightId).not.toBeNull()
    const after = useProjectStore.getState().project.clips
    expect(after).toHaveLength(2)
    const left = after.find((clip) => clip.id === id)!
    const right = after.find((clip) => clip.id === rightId)!
    expect(left.endTime).toBe(2)
    expect(right.startTime).toBe(2)
    expect(right.content.title).toBe('汛期防御启动')
    expect(useProjectStore.getState().selectedClipId).toBe(rightId)
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
  })

  it('选中音频段时拆音频段，源窗口按切点投影', () => {
    const mediaId = useProjectStore.getState().addMedia({ ...seedItem(), path: 'C:/media/vo.mp3', name: 'vo.mp3', meta: baseMeta({ width: 0, height: 0, durationSec: 10 }) })
    const clip = useProjectStore.getState().insertAudioClip({ mediaId, timelineStartSec: 0, durationSec: 6 })!
    useProjectStore.getState().selectAudioClip(clip.id)

    const rightId = useProjectStore.getState().splitTargetAt(2)

    expect(rightId).not.toBeNull()
    expect(audioClips()).toHaveLength(2)
    expect(audioClips().find((item) => item.id === rightId)?.sourceInSec).toBe(2)
    expect(useProjectStore.getState().selectedAudioClipId).toBe(rightId)
    expect(useProjectStore.getState().selectionKind).toBe('audio')
  })

  it('未选中时拆播放头处的媒体段，多轨取最下面那一轨', () => {
    seedTracks([
      { id: 'base', start: 0, end: 10, track: 0 },
      { id: 'top', start: 0, end: 10, track: 3 }
    ])

    const rightId = useProjectStore.getState().splitTargetAt(4)

    expect(rightId).not.toBeNull()
    // 被拆的是最下面那一轨（索引 0）；上层轨道保持整段不动
    expect(mediaClips().find((clip) => clip.id === 'top')?.timelineEndSec).toBe(10)
    expect(mediaClips().find((clip) => clip.id === 'base')).toMatchObject({ timelineStartSec: 0, timelineEndSec: 4 })
    expect(mediaClips().find((clip) => clip.id === rightId)).toMatchObject({
      trackId: 'track-media-0',
      timelineStartSec: 4,
      timelineEndSec: 10
    })
  })

  it('切点不在选中段里：返回 null 且工程一个字节也不动', () => {
    const id = seedSubtitle('地铁新线开通', 10, 16)
    useProjectStore.getState().selectClip(id)
    const before = JSON.stringify(useProjectStore.getState().project)

    expect(useProjectStore.getState().splitTargetAt(2)).toBeNull()

    expect(JSON.stringify(useProjectStore.getState().project)).toBe(before)
  })

  it('removeTargetAt：选中谁就删谁，未选中删播放头处的媒体段', () => {
    const id = seedSubtitle('长三角一体化新规', 0, 6)
    useProjectStore.getState().selectClip(id)
    expect(useProjectStore.getState().removeTargetAt(3)).toBe(true)
    expect(useProjectStore.getState().project.clips).toHaveLength(0)

    seedTracks([
      { id: 'base', start: 0, end: 10, track: 0 },
      { id: 'top', start: 0, end: 10, track: 2 }
    ])
    expect(useProjectStore.getState().removeTargetAt(3)).toBe(true)
    expect(mediaClips().map((clip) => clip.id)).toEqual(['top'])
  })

  it('播放头处什么都没有：removeTargetAt 返回 false，工程不变', () => {
    seedTracks([{ id: 'base', start: 8, end: 10 }])
    const before = JSON.stringify(useProjectStore.getState().project)

    expect(useProjectStore.getState().removeTargetAt(2)).toBe(false)

    expect(JSON.stringify(useProjectStore.getState().project)).toBe(before)
  })

  it('拆出来的半段不够长时返回 null（与媒体段同一套最短时长口径）', () => {
    const id = seedSubtitle('汛期防御启动', 0, 6)
    useProjectStore.getState().selectClip(id)

    expect(useProjectStore.getState().splitTargetAt(MIN_CLIP_DURATION_SEC / 2)).toBeNull()
    expect(useProjectStore.getState().project.clips).toHaveLength(1)
  })

  it('removeSelected（Delete 键的路径）：只删选中的段，没选中就不动工程', () => {
    const id = seedSubtitle('汛期防御启动', 0, 6)

    expect(useProjectStore.getState().removeSelected()).toBe(false)
    expect(useProjectStore.getState().project.clips).toHaveLength(1)

    useProjectStore.getState().selectClip(id)
    expect(useProjectStore.getState().removeSelected()).toBe(true)
    expect(useProjectStore.getState().project.clips).toHaveLength(0)

    // 播放头处有媒体段也不会被顺手删掉
    seedTracks([{ id: 'base', start: 0, end: 10 }])
    expect(useProjectStore.getState().removeSelected()).toBe(false)
    expect(mediaClips()).toHaveLength(1)
  })
})

describe('v3 轨道管理', () => {
  const addMediaItem = (): string =>
    useProjectStore.getState().addMedia(seedItem({ meta: baseMeta({ durationSec: 30 }) }))

  it('addMediaTrack 置顶新增并选中；rename / move 生效', () => {
    const first = useProjectStore.getState().project.mediaTracks[0]!.id
    const second = useProjectStore.getState().addMediaTrack()!

    expect(second).not.toBeNull()
    expect(useProjectStore.getState().project.mediaTracks.map((track) => track.id)).toEqual([first, second])
    expect(useProjectStore.getState().selectedTrackId).toBe(second)

    useProjectStore.getState().renameTrack(second, '特写')
    expect(useProjectStore.getState().project.mediaTracks[1]!.name).toBe('特写')

    useProjectStore.getState().moveMediaTrack(second, 0)
    expect(useProjectStore.getState().project.mediaTracks.map((track) => track.id)).toEqual([second, first])
  })

  it('removeMediaTrack 连同片段一起删除，且最后一条轨不可删', () => {
    const mediaId = addMediaItem()
    const second = useProjectStore.getState().addMediaTrack()!
    const clip = useProjectStore
      .getState()
      .insertMediaClip({ mediaId, timelineStartSec: 0, trackId: second })!

    useProjectStore.getState().removeMediaTrack(second)
    expect(useProjectStore.getState().project.mediaTracks).toHaveLength(1)
    expect(useProjectStore.getState().project.mediaClips.some((item) => item.id === clip.id)).toBe(false)
    expect(useProjectStore.getState().selectedMediaClipId).toBeNull()

    const last = useProjectStore.getState().project.mediaTracks[0]!.id
    useProjectStore.getState().removeMediaTrack(last)
    expect(useProjectStore.getState().project.mediaTracks).toHaveLength(1)
  })

  it('跨轨移动：目标轨无冲突时改 trackId；有冲突时拒绝', () => {
    const mediaId = addMediaItem()
    const base = useProjectStore.getState().project.mediaTracks[0]!.id
    const second = useProjectStore.getState().addMediaTrack()!
    const b = useProjectStore
      .getState()
      .insertMediaClip({ mediaId, timelineStartSec: 10, durationSec: 2, trackId: second })!
    const c = useProjectStore
      .getState()
      .insertMediaClip({ mediaId, timelineStartSec: 10, durationSec: 2, trackId: base })!
    const d = useProjectStore
      .getState()
      .insertMediaClip({ mediaId, timelineStartSec: 20, durationSec: 2, trackId: base })!

    // 底层 [20,22] → 上层：与 B[10,12] 不重叠，允许
    useProjectStore.getState().moveMediaClip(d.id, 20, second)
    expect(useProjectStore.getState().project.mediaClips.find((item) => item.id === d.id)!.trackId).toBe(second)

    // 底层 [10,12] → 上层：与 B 重叠，拒绝（位置与轨道都不动）
    useProjectStore.getState().moveMediaClip(c.id, 10, second)
    const movedC = useProjectStore.getState().project.mediaClips.find((item) => item.id === c.id)!
    expect(movedC.trackId).toBe(base)
    expect(movedC.timelineStartSec).toBe(10)

    // setMediaClipTrack 同样按目标轨冲突拒绝
    useProjectStore.getState().setMediaClipTrack(c.id, second)
    expect(useProjectStore.getState().project.mediaClips.find((item) => item.id === c.id)!.trackId).toBe(base)
    expect(useProjectStore.getState().project.mediaClips.find((item) => item.id === b.id)!.trackId).toBe(second)
  })

  it('锁定轨道拒绝平移 / 裁剪 / 删除；静音与隐藏只改轨道开关', () => {
    const mediaId = addMediaItem()
    const clip = useProjectStore
      .getState()
      .insertMediaClip({ mediaId, timelineStartSec: 0, durationSec: 2 })!
    const trackId = clip.trackId

    useProjectStore.getState().setTrackLocked(trackId, true)
    useProjectStore.getState().moveMediaClip(clip.id, 6)
    useProjectStore.getState().trimMediaClip(clip.id, { timelineEndSec: 1 })
    useProjectStore.getState().removeMediaClip(clip.id)
    const locked = useProjectStore.getState().project.mediaClips.find((item) => item.id === clip.id)!
    expect(locked.timelineStartSec).toBe(0)
    expect(locked.timelineEndSec).toBe(2)

    useProjectStore.getState().setTrackLocked(trackId, false)
    useProjectStore.getState().setTrackMuted(trackId, true)
    useProjectStore.getState().setTrackHidden(trackId, true)
    const track = useProjectStore.getState().project.mediaTracks.find((item) => item.id === trackId)!
    expect(track.muted).toBe(true)
    expect(track.hidden).toBe(true)
  })

  it('字幕轨只能改名 / 隐藏 / 锁定', () => {
    const id = useProjectStore.getState().project.subtitleTrack.id
    useProjectStore.getState().renameTrack(id, '解说字幕')
    useProjectStore.getState().setTrackHidden(id, true)
    useProjectStore.getState().setTrackLocked(id, true)
    expect(useProjectStore.getState().project.subtitleTrack).toMatchObject({
      name: '解说字幕',
      hidden: true,
      locked: true
    })
  })

  it('音频轨新增 / 删除会连带删除其片段，最后一条轨不可删', () => {
    const audioId = useProjectStore.getState().addMedia(
      seedItem({
        path: 'C:/media/vo.mp3',
        name: 'vo.mp3',
        meta: baseMeta({ width: 0, height: 0, durationSec: 10 })
      })
    )
    const second = useProjectStore.getState().addAudioTrack()!
    const clip = useProjectStore
      .getState()
      .insertAudioClip({ mediaId: audioId, timelineStartSec: 0, durationSec: 2, trackId: second })!

    useProjectStore.getState().removeAudioTrack(second)
    expect(useProjectStore.getState().project.audioTracks).toHaveLength(1)
    expect(useProjectStore.getState().project.audioClips ?? []).toHaveLength(0)
    expect(useProjectStore.getState().selectedAudioClipId).toBeNull()

    const last = useProjectStore.getState().project.audioTracks[0]!.id
    useProjectStore.getState().removeAudioTrack(last)
    expect(useProjectStore.getState().project.audioTracks).toHaveLength(1)
    expect(clip.trackId).toBe(second)
  })
})
