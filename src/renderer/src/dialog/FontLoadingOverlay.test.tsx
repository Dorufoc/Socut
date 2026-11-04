import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import type { CompatFlags } from '@shared/types'
import { FontLoadingOverlay } from './FontLoadingOverlay'
import { gateBlocked, useUiStore } from '../state/uiStore'

/**
 * 大字体加载遮罩（计划 M2-5）与门禁判定（规格 §6）。
 * 两条都是「不满足就静默放行」的高风险点，所以按行为直接断言。
 */

afterEach(() => {
  cleanup()
  act(() => {
    useUiStore.setState({ fontLoadingCount: 0, dialogQueue: [], refVideoMissing: false })
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

describe('gateBlocked（未确认不得导入/导出）', () => {
  const noFlags: CompatFlags = {
    non169: false,
    hdr: false,
    vfr: false,
    noAudio: false,
    portrait: false,
    ultraWide: false,
    audioTranscodeNeeded: false
  }

  it('全部达标时放行', () => {
    expect(gateBlocked(noFlags, { non169: false, hdr: false, vfrResolved: false })).toEqual({
      blocked: false,
      reason: null
    })
  })

  it('非 16:9 / HDR / VFR 各自阻塞，并给出可读原因', () => {
    const ackNone = { non169: false, hdr: false, vfrResolved: false }
    expect(gateBlocked({ ...noFlags, non169: true }, ackNone)).toEqual({
      blocked: true,
      reason: '非 16:9 尚未确认'
    })
    expect(gateBlocked({ ...noFlags, hdr: true }, ackNone)).toEqual({ blocked: true, reason: 'HDR 降级尚未确认' })
    expect(gateBlocked({ ...noFlags, vfr: true }, ackNone)).toEqual({ blocked: true, reason: 'VFR 处理方式未选择' })
    // 逐项确认后才放行（确认一个不代表全部放行）
    expect(gateBlocked({ ...noFlags, non169: true, hdr: true }, { ...ackNone, non169: true }).blocked).toBe(true)
    expect(gateBlocked({ ...noFlags, non169: true, hdr: true }, { non169: true, hdr: true, vfrResolved: false }).blocked).toBe(
      false
    )
  })
})
