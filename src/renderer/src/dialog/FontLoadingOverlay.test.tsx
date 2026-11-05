import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import type { MediaItem, VideoMeta } from '@shared/types'
import { FontLoadingOverlay } from './FontLoadingOverlay'
import { gateBlocked, useUiStore } from '../state/uiStore'

/**
 * 大字体加载遮罩（计划 M2-5）与门禁判定（规格 §6，v2 枚级）。
 * 两条都是「不满足就静默放行」的高风险点，所以按行为直接断言。
 */

afterEach(() => {
  cleanup()
  act(() => {
    useUiStore.setState({ fontLoadingCount: 0, dialogQueue: [], refVideoMissing: false, missingMediaIds: [] })
  })
})

describe('FontLoadingOverlay', () => {
  it('未加载时不占位，开始加载后显示指示，加载结束自动消失', () => {
    const { container } = render(<FontLoadingOverlay />)
    expect(container.textContent).toBe('')

    act(() => useUiStore.getState().beginFontLoad())
    expect(screen.getByText(TEXT.fonts.loading)).toBeTruthy()

    act(() => useUiStore.getState().endFontLoad())
    expect(container.textContent).toBe('')
  })

  it('并发加载按计数归零才消失（不会提前收起遮罩）', () => {
    const { container } = render(<FontLoadingOverlay />)
    act(() => {
      useUiStore.getState().beginFontLoad()
      useUiStore.getState().beginFontLoad()
    })
    act(() => useUiStore.getState().endFontLoad())
    expect(screen.getByText(TEXT.fonts.loading)).toBeTruthy()
    act(() => useUiStore.getState().endFontLoad())
    expect(container.textContent).toBe('')
  })
})

describe('gateBlocked（v2 枚级：未确认不得导入/导出）', () => {
  /** 达标 16:9 SDR CFR 带 aac 的基准 meta，用例只改自己的那一项 */
  const baseMeta = (over: Partial<VideoMeta> = {}): VideoMeta => ({
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
  })

  const item = (options: { id?: string; name?: string; non169Ack?: boolean; hdrAck?: boolean; vfrPolicy?: MediaItem['vfrPolicy']; meta?: Partial<VideoMeta> } = {}): MediaItem => ({
    id: options.id ?? 'media-1',
    path: 'C:/media/a.mp4',
    name: options.name ?? 'a.mp4',
    meta: baseMeta(options.meta ?? {}),
    non169Ack: options.non169Ack ?? false,
    hdrAck: options.hdrAck ?? false,
    vfrPolicy: options.vfrPolicy ?? 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  })

  it('空池/全部达标时放行', () => {
    expect(gateBlocked([])).toEqual({ blocked: false, reason: null })
    expect(gateBlocked([item()])).toEqual({ blocked: false, reason: null })
  })

  it('非 16:9 / HDR / VFR 各自阻塞，原因带展示名', () => {
    expect(gateBlocked([item({ meta: { displayRatio: 1080 / 1920 } })])).toEqual({
      blocked: true,
      reason: '《a.mp4》非 16:9 尚未确认'
    })
    expect(gateBlocked([item({ meta: { colorTransfer: 'smpte2084' } })])).toEqual({
      blocked: true,
      reason: '《a.mp4》HDR 降级尚未确认'
    })
    const vfr = item({ meta: { rFrameRate: { num: 30, den: 1 }, avgFrameRate: { num: 24, den: 1 } } })
    expect(gateBlocked([vfr])).toEqual({ blocked: true, reason: '《a.mp4》VFR 处理方式未选择' })
    // 枚级确认：确认了的那枚放行，另一枚仍阻塞
    const acked = item({ id: 'media-1', non169Ack: true, name: 'ok.mp4' })
    const gated = item({ id: 'media-2', name: 'bad.mp4', meta: { displayRatio: 1080 / 1920 } })
    expect(gateBlocked([acked]).blocked).toBe(false)
    expect(gateBlocked([acked, gated])).toEqual({ blocked: true, reason: '《bad.mp4》非 16:9 尚未确认' })
    // VFR 选了「保留 raw」也算处理完毕（导出时另有二次确认）
    expect(gateBlocked([item({ vfrPolicy: 'raw', meta: { rFrameRate: { num: 30, den: 1 }, avgFrameRate: { num: 24, den: 1 } } })]).blocked).toBe(false)
  })
})
