import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { defaultMediaVideo } from '@shared/mediaClipVideo'
import type { MediaClipVideo } from '@shared/types'
import { ClipEffectsSection } from './ClipFxSections'

/** M7-E：特效包分区（勾选/取消 + 参数滑杆写回 video.effects）。 */

describe('ClipEffectsSection', () => {
  it('六个内置包都有开关；默认全部未勾选', () => {
    render(<ClipEffectsSection video={undefined} onChange={() => undefined} />)
    for (const label of ['暗角', '胶片颗粒', '故障', '色差偏移', '暖色漏光', '黑白']) {
      const checkbox = screen.getByLabelText(label) as HTMLInputElement
      expect(checkbox.checked).toBe(false)
    }
    cleanup()
  })

  it('勾选暗角：整份写回 effects（只存 id + 空参数）', () => {
    const onChange = vi.fn<(patch: Partial<MediaClipVideo>) => void>()
    render(<ClipEffectsSection video={undefined} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('暗角'))
    expect(onChange).toHaveBeenCalledWith({ effects: [{ id: 'vignette', params: {} }] })
    cleanup()
  })

  it('已启用时显示参数滑杆，拖动写入 params', () => {
    const onChange = vi.fn<(patch: Partial<MediaClipVideo>) => void>()
    const video: MediaClipVideo = { ...defaultMediaVideo(), effects: [{ id: 'vignette', params: {} }] }
    render(<ClipEffectsSection video={video} onChange={onChange} />)

    const slider = screen.getByRole('slider', { name: '暗角 · 强度' })
    fireEvent.change(slider, { target: { value: '90' } })
    expect(onChange).toHaveBeenCalledWith({ effects: [{ id: 'vignette', params: { intensity: 90 } }] })
    cleanup()
  })

  it('取消勾选：从列表移除；移除最后一个时 effects 写 undefined（整键删除）', () => {
    const onChange = vi.fn<(patch: Partial<MediaClipVideo>) => void>()
    const video: MediaClipVideo = { ...defaultMediaVideo(), effects: [{ id: 'vignette', params: {} }] }
    render(<ClipEffectsSection video={video} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('暗角'))
    expect(onChange).toHaveBeenCalledWith({ effects: undefined })
    cleanup()
  })
})
