import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FONT_ID, FPS_29_97, FPS_30, MIN_MEDIA_CLIP_SEC } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import { getPreset } from '@shared/presets'
import { snapTimeToFrame } from '@shared/fps'
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

  it('moveMediaClip：仅重叠才把后续片段整体右移，各自时长与源坐标不变', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const a = store.insertMediaClip({ mediaId: id, timelineStartSec: 0, durationSec: 4 })!
    const b = store.insertMediaClip({ mediaId: id, timelineStartSec: 5, durationSec: 3 })!
    // 把 a 拖到 4s：与 b（5–8）重叠 4–? a 变为 4–8，b 应被右移到 8–11
    useProjectStore.getState().moveMediaClip(a.id, 4)
    const after = useProjectStore.getState().project.mediaClips
    const movedA = after.find((c) => c.id === a.id)!
    const movedB = after.find((c) => c.id === b.id)!
    expect(movedA.timelineStartSec).toBe(4)
    expect(movedB.timelineStartSec).toBe(8)
    expect(movedB.timelineEndSec - movedB.timelineStartSec).toBeCloseTo(3, 6)
    expect(movedB.sourceInSec).toBe(b.sourceInSec)
    expect(movedB.sourceOutSec).toBe(b.sourceOutSec)
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

  it('splitAtFrame：拆出的两段首尾相接、右段入选中；切点无效返回 null', () => {
    const store = useProjectStore.getState()
    const id = store.addMedia(seedItem())
    const clip = store.insertMediaClip({ mediaId: id, timelineStartSec: 0, durationSec: 6, sourceInSec: 2 })!
    const rightId = useProjectStore.getState().splitAtFrame(2)
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
    expect(useProjectStore.getState().splitAtFrame(100)).toBeNull()
    // 太贴近段首（不足最短）不可拆
    expect(useProjectStore.getState().splitAtFrame(clip.timelineStartSec + MIN_MEDIA_CLIP_SEC / 2)).toBeNull()
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

  it('删掉正在编辑的最后一条媒体段 → 检查器退回字幕编辑器', () => {
    const id = seedMediaClip()
    useProjectStore.getState().selectMediaClip(id)
    expect(useProjectStore.getState().selectionKind).toBe('media')

    useProjectStore.getState().removeMediaClip(id)

    expect(useProjectStore.getState().selectedMediaClipId).toBeNull()
    expect(useProjectStore.getState().selectionKind).toBe('subtitle')
  })
})
