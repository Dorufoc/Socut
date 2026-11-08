import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DEFAULT_AUDIO_TRACK_ID, DEFAULT_MEDIA_TRACK_ID, FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { AudioClip, MediaItem, VideoMeta } from '@shared/types'
import { ClipInspector } from './ClipInspector'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 音频片段编辑器（v9）：选中音频轨上的段时右栏换成音频视图。
 *
 * 锁四件事：
 * 1. 分流走 `selectionKind === 'audio'`，与字幕/视频编辑器互不卡住；
 * 2. **画面参数一条都不渲染**（缩放/旋转/色彩/防抖对声音没有意义），不是渲染出来再禁用；
 * 3. 与视频编辑器共用同一组分区：音量/渐入/渐出/倍速 + 保持音高，数值以标签直接可读；
 * 4. 倍速写回后本段时间轴出点伸缩，「恢复默认」连音频与变速一起清。
 */

function meta(over: Partial<VideoMeta> = {}): VideoMeta {
  return {
    path: 'C:/audio/bed.mp3',
    containerName: 'mp3',
    width: 0,
    height: 0,
    sar: null,
    displayRatio: 0,
    rFrameRate: { num: 0, den: 1 },
    avgFrameRate: { num: 0, den: 1 },
    pixFmt: 'none',
    colorPrimaries: null,
    colorSpace: null,
    colorTransfer: null,
    colorRange: null,
    videoCodec: 'none',
    audioCodec: 'mp3',
    audioChannels: 2,
    durationSec: 30,
    nbFrames: null,
    bitRateKbps: null,
    ...over
  }
}

function seed(): { audioClipId: string; mediaClipId: string; subtitleClipId: string } {
  const project = createDefaultProject('音频编辑')
  project.fps = FPS_30
  const item: MediaItem = {
    id: 'media-a1',
    path: 'C:/audio/bed.mp3',
    name: 'bed.mp3',
    meta: meta(),
    kind: 'audio',
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
  const videoItem: MediaItem = {
    ...item,
    id: 'media-v1',
    path: 'C:/media/a.mp4',
    name: 'a.mp4',
    kind: 'video',
    meta: meta({ path: 'C:/media/a.mp4', width: 1920, height: 1080, displayRatio: 16 / 9, pixFmt: 'yuv420p', videoCodec: 'h264' })
  }
  const audioClip: AudioClip = {
    id: 'aclip-1',
    mediaId: item.id,
    trackId: DEFAULT_AUDIO_TRACK_ID,
    timelineStartSec: 0,
    timelineEndSec: 4,
    sourceInSec: 0,
    sourceOutSec: 4
  }
  const mediaClip = {
    id: 'mclip-1',
    mediaId: videoItem.id,
    trackId: DEFAULT_MEDIA_TRACK_ID,
    timelineStartSec: 0,
    timelineEndSec: 8,
    sourceInSec: 0,
    sourceOutSec: 8
  }
  const subtitle = createClip({ startTime: 1, fps: FPS_30 })
  subtitle.content = { title: '字幕标题', subtitle: '字幕副标题' }
  project.media = [item, videoItem]
  project.audioClips = [audioClip]
  project.mediaClips = [mediaClip]
  project.clips = [subtitle]
  useProjectStore.setState({
    project,
    selectedClipId: subtitle.id,
    selectedMediaClipId: null,
    selectedAudioClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 1
  })
  return { audioClipId: audioClip.id, mediaClipId: mediaClip.id, subtitleClipId: subtitle.id }
}

const audioOf = (id: string) => useProjectStore.getState().project.audioClips!.find((clip) => clip.id === id)!

/** 控件右边的数值标签（需求：不要靠 tooltip 读数） */
const readout = (label: string) => screen.getByLabelText(label).nextElementSibling?.textContent

afterEach(() => {
  cleanup()
  act(() => {
    useProjectStore.setState({
      project: createDefaultProject('空'),
      selectedClipId: null,
      selectedMediaClipId: null,
      selectedAudioClipId: null,
      selectionKind: 'subtitle',
      fonts: []
    })
  })
})

describe('ClipInspector 分流：音频段', () => {
  it('选中音频段显示音频编辑器（标题 + 素材名 + 序号），画面参数一条都不渲染', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    expect(screen.getByText(TEXT.audioEditor.title)).toBeTruthy()
    expect(screen.getByText(/bed\.mp3 · 1 \/ 1/)).toBeTruthy()
    expect(screen.getByText(TEXT.clipAudio.title)).toBeTruthy()
    expect(screen.getByText(TEXT.clipSpeed.title)).toBeTruthy()
    // 画面相关：整个分区都不该出现
    expect(screen.queryByText(TEXT.videoEditor.title)).toBeNull()
    expect(screen.queryByText(TEXT.videoEditor.geometry)).toBeNull()
    expect(screen.queryByText(TEXT.videoEditor.grade)).toBeNull()
    expect(screen.queryByText(TEXT.stab.title)).toBeNull()
    expect(screen.queryByLabelText(TEXT.videoEditor.scale)).toBeNull()
    // 字幕检查器也不出现
    expect(screen.queryByText(TEXT.inspector.selectedClip)).toBeNull()
  })

  it('三个编辑器互不卡住：音频 → 字幕 → 媒体 → 音频', () => {
    const { audioClipId, mediaClipId, subtitleClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)
    expect(screen.getByText(TEXT.audioEditor.title)).toBeTruthy()

    act(() => useProjectStore.getState().selectClip(subtitleClipId))
    expect(screen.getByText(TEXT.inspector.selectedClip)).toBeTruthy()
    expect(screen.queryByText(TEXT.audioEditor.title)).toBeNull()

    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    expect(screen.getByText(TEXT.videoEditor.title)).toBeTruthy()

    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    expect(screen.getByText(TEXT.audioEditor.title)).toBeTruthy()
    // 回到音频视图时画面分区依然不在 DOM 里（不是 disabled）
    expect(screen.queryByText(TEXT.videoEditor.geometry)).toBeNull()
  })
})

describe('音频片段的音频与变速编辑', () => {
  it('默认读数 100% / 0s / 0s / 1x；没有任何编辑时「恢复默认」禁用', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    expect(readout(TEXT.clipAudio.volume)).toBe('100%')
    expect(readout(TEXT.clipAudio.fadeIn)).toBe('0s')
    expect(readout(TEXT.clipAudio.fadeOut)).toBe('0s')
    expect(readout(TEXT.clipSpeed.rate)).toBe('1x')
    expect((screen.getByRole('button', { name: TEXT.audioEditor.reset }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(TEXT.audioEditor.edited)).toBeNull()
  })

  it('音量滑杆写回本段；回到 100% 整键删除', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.volume), { target: { value: '160' } })
    expect(audioOf(audioClipId).audio).toEqual({ volumePercent: 160, fadeInSec: 0, fadeOutSec: 0 })
    expect(readout(TEXT.clipAudio.volume)).toBe('160%')

    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.volume), { target: { value: '100' } })
    expect('audio' in audioOf(audioClipId)).toBe(false)
  })

  it('渐变上限按本段时间轴长度收（4s 段最多 2s）', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    expect(screen.getByLabelText(TEXT.clipAudio.fadeIn).getAttribute('max')).toBe('2')
    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.fadeOut), { target: { value: '2' } })
    expect(audioOf(audioClipId).audio).toEqual({ volumePercent: 100, fadeInSec: 0, fadeOutSec: 2 })
  })

  it('倍速 2x：源窗口不变，本段在时间轴上缩短一半', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.clipSpeed.rate), { target: { value: '2' } })
    const fast = audioOf(audioClipId)
    expect(fast.speed).toEqual({ speed: 2, maintainPitch: true })
    expect(fast.sourceOutSec).toBe(4)
    expect(fast.timelineEndSec).toBeCloseTo(2, 6)
    expect(readout(TEXT.clipSpeed.rate)).toBe('2x')
  })

  it('保持音高开关：默认按下；点一下改成连动音高', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    const on = screen.getByRole('button', { name: TEXT.clipSpeed.on })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(on)
    expect(audioOf(audioClipId).speed).toEqual({ speed: 1, maintainPitch: false })
    expect(screen.getByRole('button', { name: TEXT.clipSpeed.off }).getAttribute('aria-pressed')).toBe('false')
  })

  it('改过的值算「已编辑」，恢复默认连音频与变速一起清、时间轴长度还原', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.fadeIn), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(TEXT.clipSpeed.rate), { target: { value: '2' } })
    expect(screen.getByText(TEXT.audioEditor.edited)).toBeTruthy()
    expect(audioOf(audioClipId).timelineEndSec).toBeCloseTo(2, 6)

    fireEvent.click(screen.getByRole('button', { name: TEXT.audioEditor.reset }))
    const cleared = audioOf(audioClipId)
    expect('audio' in cleared).toBe(false)
    expect('speed' in cleared).toBe(false)
    expect(cleared.timelineEndSec).toBeCloseTo(4, 6)
  })

  it('素材移出后不显示空素材名（编辑仍然可用，只是提示源已丢失）', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().removeMedia('media-a1', { removeClips: false }))
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    expect(screen.getByText(new RegExp(TEXT.audioEditor.missingMedia))).toBeTruthy()
  })
})

/** v10：降噪 / 角色 / ducking（全部导出生效，但控件与恢复默认同一口径） */
describe('音频质量：降噪、BGM 角色与 ducking（v10）', () => {
  it('降噪默认「关闭」；选标准写回 audio.denoise；回到关闭整键删除', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    const denoise = screen.getByLabelText(TEXT.clipAudio.denoise) as HTMLSelectElement
    expect(denoise.value).toBe('off')
    fireEvent.change(denoise, { target: { value: 'standard' } })
    expect(audioOf(audioClipId).audio).toEqual({
      volumePercent: 100,
      fadeInSec: 0,
      fadeOutSec: 0,
      denoise: 'standard'
    })
    fireEvent.change(denoise, { target: { value: 'off' } })
    expect('audio' in audioOf(audioClipId)).toBe(false)
  })

  it('角色：默认人声；切 BGM 落盘，切回人声删除；BGM 时出现 ducking 下拉', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    expect(screen.getByRole('button', { name: TEXT.audioRole.voice }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText(TEXT.audioRole.ducking)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: TEXT.audioRole.bgm }))
    expect(audioOf(audioClipId).role).toBe('bgm')
    expect(screen.getByRole('button', { name: TEXT.audioRole.bgm }).getAttribute('aria-pressed')).toBe('true')

    const ducking = screen.getByLabelText(TEXT.audioRole.ducking) as HTMLSelectElement
    expect(ducking.value).toBe('off')
    fireEvent.change(ducking, { target: { value: 'standard' } })
    expect(audioOf(audioClipId).ducking).toBe('standard')
    fireEvent.change(ducking, { target: { value: 'off' } })
    expect('ducking' in audioOf(audioClipId)).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: TEXT.audioRole.voice }))
    expect('role' in audioOf(audioClipId)).toBe(false)
    expect(screen.queryByLabelText(TEXT.audioRole.ducking)).toBeNull()
  })

  it('角色或 ducking 也算「已编辑」；恢复默认把它们一起清掉', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.audioRole.bgm }))
    fireEvent.change(screen.getByLabelText(TEXT.audioRole.ducking), { target: { value: 'strong' } })
    expect(screen.getByText(TEXT.audioEditor.edited)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: TEXT.audioEditor.reset }))
    const cleared = audioOf(audioClipId)
    expect('role' in cleared).toBe(false)
    expect('ducking' in cleared).toBe(false)
    expect(screen.queryByText(TEXT.audioEditor.edited)).toBeNull()
  })
})

/** P5：点音频段只选中不跳转，于是音频编辑器也要有明确的「过去」入口 */
describe('音频编辑器 · 定位到这一段（P5）', () => {
  it('播放头在本段之外时出现，点一下跳到该段中点', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    const seek = vi.fn()
    act(() => useUiStore.setState({ displayTimeSec: 20, seekHandler: seek }))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.inspector.locate }))

    // 本段 0→4s
    expect(seek).toHaveBeenCalledWith(2)
  })

  it('播放头已在本段区间内：不出现', () => {
    const { audioClipId } = seed()
    act(() => useProjectStore.getState().selectAudioClip(audioClipId))
    act(() => useUiStore.setState({ displayTimeSec: 1, seekHandler: vi.fn() }))
    render(<ClipInspector />)

    expect(screen.queryByRole('button', { name: TEXT.inspector.locate })).toBeNull()
  })
})
