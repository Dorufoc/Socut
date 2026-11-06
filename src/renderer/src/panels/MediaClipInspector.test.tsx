import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import type { JobResult, MediaClip, MediaClipVideo, MediaItem, Project, StabPreviewRequest, StabPreviewResult, VideoMeta } from '@shared/types'
import { ClipInspector } from './ClipInspector'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import { useExportStore } from '../state/exportStore'
import { useStabPreviewStore } from '../state/stabPreviewStore'

/**
 * 视频片段编辑器（v6）：右栏按「最后点中的是哪类」分流。
 *
 * 锁四件事：
 * 1. 选中媒体段 → 视频编辑器（几何/翻转/调色三段）；选中字幕条 → 原字幕检查器（不受影响）；
 * 2. 每个滑杆/开关只写回**当前媒体段**的 `video`，默认值整键删除；
 * 3. 曲线是 R/G/B 三通道三点位（阴影/中间调/高光），默认直线；
 * 4. 「恢复默认」一键清空本条的全部画面参数，且无编辑时禁用。
 */

function meta(): VideoMeta {
  return {
    path: 'C:/media/a.mp4',
    containerName: 'mp4',
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
    durationSec: 30,
    nbFrames: null,
    bitRateKbps: null
  }
}

function seed(): { project: Project; mediaClipId: string; subtitleClipId: string } {
  const project = createDefaultProject('视频编辑')
  project.fps = FPS_30
  const item: MediaItem = {
    id: 'media-1',
    path: 'C:/media/a.mp4',
    name: 'a.mp4',
    meta: meta(),
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  }
  const mediaClip: MediaClip = {
    id: 'mclip-1',
    mediaId: item.id,
    timelineStartSec: 0,
    timelineEndSec: 8,
    sourceInSec: 0,
    sourceOutSec: 8
  }
  const subtitle = createClip({ startTime: 1, fps: FPS_30 })
  subtitle.content = { title: '字幕标题', subtitle: '字幕副标题' }
  project.media = [item]
  project.mediaClips = [mediaClip]
  // 故意乱序写入：面板要自己按时间轴顺序算序号
  project.clips = [subtitle]
  useProjectStore.setState({
    project,
    selectedClipId: subtitle.id,
    selectedMediaClipId: null,
    selectionKind: 'subtitle',
    fonts: [],
    revision: 1
  })
  return { project, mediaClipId: mediaClip.id, subtitleClipId: subtitle.id }
}

/** 取某段的画面参数；断言里会单独检查「整键消失」，所以这里按非空返回，避免逐行断言炸在 TS 上。 */
const videoOf = (id: string) =>
  useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!.video as MediaClipVideo

afterEach(() => {
  cleanup()
  act(() => {
    useProjectStore.setState({
      project: createDefaultProject('空'),
      selectedClipId: null,
      selectedMediaClipId: null,
      selectionKind: 'subtitle',
      fonts: []
    })
    useUiStore.setState({ uiMode: 'basic', notice: null, seekHandler: null, stageInteract: true })
    // v8.1：代理账本与任务队列不留到下一个用例
    useStabPreviewStore.setState({ applied: {}, errors: {} })
    useExportStore.setState({ jobs: {}, order: [], busy: false, lastResult: null, lastInput: null })
  })
})

describe('ClipInspector 分流：媒体段 ↔ 字幕条', () => {
  it('选中媒体段后显示视频编辑器（三段分区 + 素材名 + 序号）', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    expect(screen.getByText(TEXT.videoEditor.title)).toBeTruthy()
    expect(screen.getByText(TEXT.videoEditor.geometry)).toBeTruthy()
    expect(screen.getByText(TEXT.videoEditor.flip)).toBeTruthy()
    expect(screen.getByText(TEXT.videoEditor.grade)).toBeTruthy()
    expect(screen.getByText(/a\.mp4 · 1 \/ 1/)).toBeTruthy()
    // 字幕检查器不再出现
    expect(screen.queryByText(TEXT.inspector.selectedClip)).toBeNull()
  })

  it('再点字幕条就切回字幕检查器（两个选中态互不干扰）', () => {
    const { mediaClipId, subtitleClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)
    expect(screen.getByText(TEXT.videoEditor.title)).toBeTruthy()

    act(() => useProjectStore.getState().selectClip(subtitleClipId))

    expect(screen.getByText(TEXT.inspector.selectedClip)).toBeTruthy()
    expect(screen.queryByText(TEXT.videoEditor.title)).toBeNull()
  })
})

describe('几何变换与翻转', () => {
  it('缩放滑杆写回百分比，默认值不落库', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.scale), { target: { value: '150' } })
    expect(videoOf(mediaClipId).scalePercent).toBe(150)

    // 拉回 100% = 回到默认，整键删除
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.scale), { target: { value: '100' } })
    expect(videoOf(mediaClipId)).toBeUndefined()
  })

  it('水平/垂直位移与旋转各写各的字段', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.offsetX), { target: { value: '-20' } })
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.offsetY), { target: { value: '15' } })
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.rotation), { target: { value: '90' } })

    const video = videoOf(mediaClipId)
    expect(video.offsetXPercent).toBe(-20)
    expect(video.offsetYPercent).toBe(15)
    expect(video.rotationDeg).toBe(90)
  })

  it('两个镜像开关是独立状态，再点一下即关闭', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    const flipH = screen.getByRole('button', { name: TEXT.videoEditor.flipH })
    const flipV = screen.getByRole('button', { name: TEXT.videoEditor.flipV })
    expect(flipH.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(flipH)
    expect(videoOf(mediaClipId).flipH).toBe(true)
    expect(flipH.getAttribute('aria-pressed')).toBe('true')
    expect(videoOf(mediaClipId).flipV).toBe(false)

    fireEvent.click(flipV)
    fireEvent.click(flipH)
    expect(videoOf(mediaClipId).flipV).toBe(true)
    expect(videoOf(mediaClipId).flipH).toBe(false)
  })
})

describe('色彩与光影', () => {
  it('六个调色滑杆各自独立写回', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.brightness), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.exposure), { target: { value: '-8' } })
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.contrast), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.saturation), { target: { value: '-15' } })
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.warmth), { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.vibrance), { target: { value: '25' } })

    const video = videoOf(mediaClipId)
    expect(video.brightness).toBe(12)
    expect(video.exposure).toBe(-8)
    expect(video.contrast).toBe(20)
    expect(video.saturation).toBe(-15)
    expect(video.warmth).toBe(30)
    expect(video.vibrance).toBe(25)
  })

  it('曲线：默认四条直线；空白处点一下加点、拖动改形、复位回直线', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    const { container } = render(<ClipInspector />)

    const svg = container.querySelector('.curve-editor') as SVGSVGElement
    expect(svg).toBeTruthy()
    // jsdom 没有布局：把尺寸伪造成 200×200，也就能把 client 坐标当数据坐标用
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    // 默认直线：还没有 video 键
    expect(useProjectStore.getState().project.mediaClips[0]!.video).toBeUndefined()

    // 在正中间按下 = 新增控制点并直接进入拖拽
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 100, clientY: 40 })
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 100, clientY: 40 })

    const master = videoOf(mediaClipId).curves.master
    expect(master).toHaveLength(3)
    expect(master[1]!.x).toBeCloseTo(0.5, 2)
    expect(master[1]!.y).toBeCloseTo(0.8, 2)
    // 另外三条通道不受影响
    expect(videoOf(mediaClipId).curves.r).toEqual(defaultMediaVideo().curves.r)

    // 当前曲线读数写在面板上
    expect(container.textContent).toContain('0.50,0.80')

    // 复位 → 回到直线，其余参数也是默认 → 整键消失
    fireEvent.click(screen.getByRole('button', { name: TEXT.videoEditor.resetCurve }))
    expect(useProjectStore.getState().project.mediaClips[0]!.video).toBeUndefined()
  })

  it('曲线：四条曲线可切换（亮度 / R / G / B）', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    const { container } = render(<ClipInspector />)

    const svg = container.querySelector('.curve-editor') as SVGSVGElement
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    const group = screen.getByRole('group', { name: TEXT.videoEditor.curves })
    const buttons = Array.from(group.querySelectorAll('button')).map((item) => item.textContent)
    expect(buttons).toEqual([TEXT.videoEditor.curveMaster, 'R', 'G', 'B'])

    // 切到 B 通道再打点，只写 blue
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    fireEvent.pointerDown(svg, { pointerId: 2, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 100, clientY: 150 })
    fireEvent.pointerUp(svg, { pointerId: 2, clientX: 100, clientY: 150 })

    expect(videoOf(mediaClipId).curves.b[1]!.y).toBeCloseTo(0.25, 2)
    expect(videoOf(mediaClipId).curves.master).toEqual(defaultMediaVideo().curves.master)
  })

  it('「交互」开关默认开，点一下关掉并同步到 uiStore（遮住字幕点选时的逃生口）', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    const toggle = screen.getByRole('button', { name: TEXT.videoEditor.interact })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(toggle)
    expect(useUiStore.getState().stageInteract).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('一键恢复默认', () => {
  it('无编辑时按钮禁用；有编辑时一键清空本条全部画面参数', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    const reset = screen.getByRole('button', { name: TEXT.videoEditor.reset })
    expect((reset as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.scale), { target: { value: '180' } })
    fireEvent.click(screen.getByRole('button', { name: TEXT.videoEditor.flipH }))
    fireEvent.change(screen.getByLabelText(TEXT.videoEditor.brightness), { target: { value: '40' } })
    expect(videoOf(mediaClipId)).toBeDefined()

    fireEvent.click(reset)
    expect(videoOf(mediaClipId)).toBeUndefined()
    expect((reset as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('防抖稳定（v8）', () => {
  /** 取当前防抖参数；关闭后应为 undefined（整键删除） */
  const stabOf = (id: string) => useProjectStore.getState().project.mediaClips.find((clip) => clip.id === id)!.stab

  it('开关写回 stab；再点一下回到全默认 → 整键消失', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    const toggle = screen.getByRole('button', { name: TEXT.stab.off })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(stabOf(mediaClipId)).toEqual({ enabled: true, level: 'standard', tripod: false })

    // 开启后按钮文案切到「防抖」；再点关闭，全默认整键删除
    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.on }))
    expect(stabOf(mediaClipId)).toBeUndefined()
  })

  it('档位按钮只写 level；默认高亮标准档', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    // 关闭时不渲染档位区
    expect(screen.queryByText(TEXT.stab.levelLabel)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.off }))
    const low = screen.getByRole('button', { name: TEXT.stab.levelLow })
    const standard = screen.getByRole('button', { name: TEXT.stab.levelStandard })
    expect(standard.getAttribute('aria-pressed')).toBe('true')
    expect(low.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(low)
    expect(stabOf(mediaClipId)).toEqual({ enabled: true, level: 'low', tripod: false })
  })

  it('虚拟三脚架开关独立写 tripod', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.off }))
    const tripod = screen.getByRole('button', { name: TEXT.stab.tripod })
    fireEvent.click(tripod)
    expect(stabOf(mediaClipId)).toEqual({ enabled: true, level: 'standard', tripod: true })

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.tripod }))
    expect(stabOf(mediaClipId)).toEqual({ enabled: true, level: 'standard', tripod: false })
  })

  it('防抖开启也算「已编辑」：徽章出现且恢复默认连 stab 一起清', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    const reset = screen.getByRole('button', { name: TEXT.videoEditor.reset })
    expect((reset as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.off }))
    expect(screen.getByText(TEXT.videoEditor.edited)).toBeTruthy()
    expect((reset as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(reset)
    expect(stabOf(mediaClipId)).toBeUndefined()
  })
})

/**
 * v9：视频片段编辑器里的「音频」与「变速」两个分区。
 *
 * 锁四件事：滑杆确实写回本段、数值以标签形式直接可读、回到默认值整键不落盘、
 * 以及**变速会同时伸缩时间轴出点**（面板不能只改参数不改长度）。
 */
describe('音频与变速分区（v9）', () => {
  const clipOf = (id: string) => useProjectStore.getState().project.mediaClips.find((c) => c.id === id)!

  it('两个分区都在，默认值读作 100% / 0s / 0s / 1x', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    expect(screen.getByText(TEXT.clipAudio.title)).toBeTruthy()
    expect(screen.getByText(TEXT.clipSpeed.title)).toBeTruthy()
    // 数值就写在控件右边的标签里，不靠 tooltip（需求里的「音量: 120%」同一口径）
    const readout = (label: string) => screen.getByLabelText(label).nextElementSibling?.textContent
    expect(readout(TEXT.clipAudio.volume)).toBe('100%')
    expect(readout(TEXT.clipAudio.fadeIn)).toBe('0s')
    expect(readout(TEXT.clipAudio.fadeOut)).toBe('0s')
    expect(readout(TEXT.clipSpeed.rate)).toBe('1x')
  })

  it('音量滑杆写回百分比，读数即时跟随，回到 100% 整键删除', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.volume), { target: { value: '120' } })
    expect(clipOf(mediaClipId).audio).toEqual({ volumePercent: 120, fadeInSec: 0, fadeOutSec: 0 })
    expect(screen.getByLabelText(TEXT.clipAudio.volume).nextElementSibling?.textContent).toBe('120%')

    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.volume), { target: { value: '100' } })
    expect('audio' in clipOf(mediaClipId)).toBe(false)
  })

  it('渐变滑杆的上限按本段长度收（8s 段最多 4s，导出侧也夹到半段）', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    expect(screen.getByLabelText(TEXT.clipAudio.fadeIn).getAttribute('max')).toBe('4')
    expect(screen.getByLabelText(TEXT.clipAudio.fadeOut).getAttribute('max')).toBe('4')

    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.fadeIn), { target: { value: '1.5' } })
    expect(clipOf(mediaClipId).audio).toEqual({ volumePercent: 100, fadeInSec: 1.5, fadeOutSec: 0 })
  })

  it('倍速滑杆：写回 speed 同时伸缩时间轴出点（源窗口不变）', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.clipSpeed.rate), { target: { value: '2' } })
    const clip = clipOf(mediaClipId)
    expect(clip.speed).toEqual({ speed: 2, maintainPitch: true })
    expect(clip.sourceOutSec).toBe(8)
    expect(clip.timelineEndSec).toBeCloseTo(4, 6)

    // 回到 1x：长度还原，整键消失
    fireEvent.change(screen.getByLabelText(TEXT.clipSpeed.rate), { target: { value: '1' } })
    expect('speed' in clipOf(mediaClipId)).toBe(false)
    expect(clipOf(mediaClipId).timelineEndSec).toBeCloseTo(8, 6)
  })

  it('保持音高开关：只改音高开关不会改时长', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    const toggle = screen.getByRole('button', { name: TEXT.clipSpeed.on })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(toggle)
    expect(clipOf(mediaClipId).speed).toEqual({ speed: 1, maintainPitch: false })
    expect(clipOf(mediaClipId).timelineEndSec).toBeCloseTo(8, 6)
    expect(screen.getByRole('button', { name: TEXT.clipSpeed.off }).getAttribute('aria-pressed')).toBe('false')
  })

  it('音频参数也算「已编辑」，恢复默认连 audio 与 speed 一起清', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    const reset = screen.getByRole('button', { name: TEXT.videoEditor.reset })
    fireEvent.change(screen.getByLabelText(TEXT.clipAudio.volume), { target: { value: '60' } })
    expect(screen.getByText(TEXT.videoEditor.edited)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(TEXT.clipSpeed.rate), { target: { value: '2' } })
    fireEvent.click(reset)

    const cleared = clipOf(mediaClipId)
    expect('audio' in cleared).toBe(false)
    expect('speed' in cleared).toBe(false)
    expect(cleared.timelineEndSec).toBeCloseTo(8, 6)
  })

  it('开着主轨对齐时改倍速会重新摆紧时间轴（不会留新间隙）', () => {
    const { mediaClipId } = seed()
    act(() => useUiStore.setState({ timelineTools: { ...useUiStore.getState().timelineTools, snapTogether: true } }))
    const second = useProjectStore.getState().insertMediaClip({
      mediaId: 'media-1',
      timelineStartSec: 8
    })!
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.change(screen.getByLabelText(TEXT.clipSpeed.rate), { target: { value: '2' } })
    const moved = useProjectStore.getState().project.mediaClips.find((c) => c.id === second.id)!
    expect(moved.timelineStartSec).toBeCloseTo(4, 6)

    act(() => useUiStore.setState({ timelineTools: { ...useUiStore.getState().timelineTools, snapTogether: false } }))
  })
})

/**
 * v8.1：防抖预览代理按钮的状态机。
 * 锁四件事：未开启不渲染；queued 期间按钮禁用 + 可取消；
 * 记账后切「已就绪」、改档变「重新应用」；关防抖连磁盘缓存一起回收。
 */
describe('防抖预览代理按钮（v8.1）', () => {
  function stubPreviewApi(result: StabPreviewResult) {
    const impl = async (_request: StabPreviewRequest): Promise<StabPreviewResult> => result
    const stabPreview = vi.fn(impl)
    const removeImpl = async (_clipId: string): Promise<void> => undefined
    const stabPreviewRemove = vi.fn(removeImpl)
    const cancel = vi.fn(async () => undefined)
    ;(window as unknown as { focusnews: unknown }).focusnews = {
      video: { stabPreview, stabPreviewRemove },
      export: { cancel }
    }
    return { stabPreview, stabPreviewRemove, cancel }
  }

  const doneResult = (): JobResult => ({
    jobId: 'stab-mclip-1',
    ok: true,
    outputs: ['C:/userData/stab-preview/stab-mclip-1-abcd.mp4'],
    progress: {
      jobId: 'stab-mclip-1',
      phase: 'done',
      framesDone: 2,
      framesTotal: 2,
      outTimeUs: 8e6,
      percent: 1,
      bytesWritten: 0,
      elapsedMs: 10,
      notices: []
    }
  })

  it('未开启防抖时不渲染应用按钮', () => {
    stubPreviewApi({ status: 'queued', jobId: 'stab-mclip-1', path: null, signature: 'sig' })
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)
    expect(screen.queryByText(TEXT.stab.previewApply)).toBeNull()
  })

  it('点应用→queued 不记账；jobResult 成功后按钮变「已就绪」', async () => {
    const api = stubPreviewApi({ status: 'queued', jobId: 'stab-mclip-1', path: null, signature: 'sig' })
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.off }))
    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.previewApply }))
    await waitFor(() => expect(api.stabPreview).toHaveBeenCalledTimes(1))
    expect(api.stabPreview.mock.calls[0]![0]).toMatchObject({ clipId: mediaClipId, sourceInSec: 0, sourceOutSec: 8 })
    expect(useStabPreviewStore.getState().applied[mediaClipId]).toBeUndefined()

    act(() => useStabPreviewStore.getState().handleJobResult(doneResult()))
    expect(screen.getByText(TEXT.stab.previewApplied)).toBeTruthy()
  })

  it('作业进行中：按钮禁用且有取消入口（走 export.cancel 同一 jobId）', async () => {
    const api = stubPreviewApi({ status: 'queued', jobId: 'stab-mclip-1', path: null, signature: 'sig' })
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.off }))
    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.previewApply }))
    await waitFor(() => expect(api.stabPreview).toHaveBeenCalled())
    act(() =>
      useExportStore.getState().upsertProgress({
        jobId: 'stab-mclip-1',
        phase: 'rendering',
        framesDone: 1.5,
        framesTotal: 2,
        outTimeUs: 6e6,
        percent: 0.75,
        bytesWritten: 0,
        elapsedMs: 100,
        notices: []
      })
    )
    expect((screen.getByRole('button', { name: TEXT.stab.previewApply }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '✕' }))
    expect(api.cancel).toHaveBeenCalledWith('stab-mclip-1')
  })

  it('就绪后改档位 → 「重新应用防抖预览」（签名失配自动回落原片）', async () => {
    stubPreviewApi({ status: 'queued', jobId: 'stab-mclip-1', path: null, signature: 'sig' })
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.off }))
    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.previewApply }))
    await waitFor(() => expect(useStabPreviewStore.getState().applied[mediaClipId]).toBeUndefined())
    act(() => useStabPreviewStore.getState().handleJobResult(doneResult()))
    expect(screen.getByText(TEXT.stab.previewApplied)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.levelHigh }))
    expect(screen.getByRole('button', { name: TEXT.stab.previewReapply })).toBeTruthy()
    expect(screen.getByText(TEXT.stab.previewStale)).toBeTruthy()
    expect(useStabPreviewStore.getState().applied[mediaClipId]).toBeDefined()
  })

  it('关闭防抖：账本清空且回收磁盘缓存（stabPreviewRemove）', async () => {
    const api = stubPreviewApi({ status: 'queued', jobId: 'stab-mclip-1', path: null, signature: 'sig' })
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.off }))
    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.previewApply }))
    await waitFor(() => expect(api.stabPreview).toHaveBeenCalled())
    act(() => useStabPreviewStore.getState().handleJobResult(doneResult()))

    fireEvent.click(screen.getByRole('button', { name: TEXT.stab.on }))
    expect(useStabPreviewStore.getState().applied[mediaClipId]).toBeUndefined()
    await waitFor(() => expect(api.stabPreviewRemove).toHaveBeenCalledWith(mediaClipId))
  })
})

/**
 * P5：时间轴上点媒体段现在只选中、不再顺手把播放头带过来，
 * 所以画面编辑器必须给一个明确的「把画面带到这一段」入口，
 * 否则用户改的缩放/防抖在预览里根本看不见。
 */
describe('视频编辑器 · 定位到这一段（P5）', () => {
  it('播放头在本段之外时出现，点一下跳到该段中点', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    const seek = vi.fn()
    act(() => useUiStore.setState({ displayTimeSec: 20, seekHandler: seek }))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.inspector.locate }))

    // 本段 0→8s
    expect(seek).toHaveBeenCalledWith(4)
  })

  it('播放头已在本段区间内：不出现', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    act(() => useUiStore.setState({ displayTimeSec: 3, seekHandler: vi.fn() }))
    render(<ClipInspector />)

    expect(screen.queryByRole('button', { name: TEXT.inspector.locate })).toBeNull()
  })

  it('播放中点定位：先接管时钟再跳，否则跳过去立刻被带走', () => {
    const { mediaClipId } = seed()
    act(() => useProjectStore.getState().selectMediaClip(mediaClipId))
    const seek = vi.fn()
    act(() => useUiStore.setState({ displayTimeSec: 20, playing: true, seekHandler: seek }))
    render(<ClipInspector />)

    fireEvent.click(screen.getByRole('button', { name: TEXT.inspector.locate }))

    expect(useUiStore.getState().playing).toBe(false)
    expect(seek).toHaveBeenCalledWith(4)
  })
})
