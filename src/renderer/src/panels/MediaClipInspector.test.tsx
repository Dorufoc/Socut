import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import type { MediaClip, MediaClipVideo, MediaItem, Project, VideoMeta } from '@shared/types'
import { ClipInspector } from './ClipInspector'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

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
