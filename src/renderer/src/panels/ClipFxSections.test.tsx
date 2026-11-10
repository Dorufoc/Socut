import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TEXT } from '@shared/i18n'
import { ClipAudioSection } from './ClipFxSections'
import type { ClipAudio } from '@shared/types'

/** M8：音频分区的两个新控件（人声增强 / 变声）——视频段与音频段共用这一组。 */

describe('ClipAudioSection · M8 净化控件', () => {
  it('默认「关闭」；选标准增强写回 voiceEnhance', () => {
    const onChange = vi.fn<(patch: Partial<ClipAudio>) => void>()
    render(<ClipAudioSection audio={undefined} durationSec={4} onChange={onChange} />)

    const enhance = screen.getByLabelText(TEXT.clipAudio.voiceEnhance) as HTMLSelectElement
    expect(enhance.value).toBe('off')

    fireEvent.change(enhance, { target: { value: 'standard' } })
    expect(onChange).toHaveBeenCalledWith({ voiceEnhance: 'standard' })
    cleanup()
  })

  it('选变声写回 voiceChange；选回关闭写 undefined（整键可被删）', () => {
    const onChange = vi.fn<(patch: Partial<ClipAudio>) => void>()
    render(
      <ClipAudioSection
        audio={{ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, voiceChange: 'phone' }}
        durationSec={4}
        onChange={onChange}
      />
    )
    const change = screen.getByLabelText(TEXT.clipAudio.voiceChange) as HTMLSelectElement
    expect(change.value).toBe('phone')

    fireEvent.change(change, { target: { value: 'off' } })
    expect(onChange).toHaveBeenCalledWith({ voiceChange: undefined })
    cleanup()
  })

  it('已有档位从工程值回显（增强 + 变声同时存在时各自独立）', () => {
    render(
      <ClipAudioSection
        audio={{ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, voiceEnhance: 'strong', voiceChange: 'chipmunk' }}
        durationSec={4}
        onChange={() => undefined}
      />
    )
    expect((screen.getByLabelText(TEXT.clipAudio.voiceEnhance) as HTMLSelectElement).value).toBe('strong')
    expect((screen.getByLabelText(TEXT.clipAudio.voiceChange) as HTMLSelectElement).value).toBe('chipmunk')
    cleanup()
  })

  it('M8 AI 降噪：下拉里有 ai 档；选中写回 denoise: "ai"，工程值能回显', () => {
    const onChange = vi.fn<(patch: Partial<ClipAudio>) => void>()
    render(<ClipAudioSection audio={undefined} durationSec={4} onChange={onChange} />)
    const denoise = screen.getByLabelText(TEXT.clipAudio.denoise) as HTMLSelectElement
    const values = Array.from(denoise.options).map((option) => option.value)
    expect(values).toEqual(['off', 'light', 'standard', 'strong', 'ai'])
    expect(denoise.options[4]!.textContent).toBe(TEXT.clipAudio.denoiseAi)
    fireEvent.change(denoise, { target: { value: 'ai' } })
    expect(onChange).toHaveBeenCalledWith({ denoise: 'ai' })
    cleanup()

    render(
      <ClipAudioSection
        audio={{ volumePercent: 100, fadeInSec: 0, fadeOutSec: 0, denoise: 'ai' }}
        durationSec={4}
        onChange={() => undefined}
      />
    )
    expect((screen.getByLabelText(TEXT.clipAudio.denoise) as HTMLSelectElement).value).toBe('ai')
    cleanup()
  })
})
