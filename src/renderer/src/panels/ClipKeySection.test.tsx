import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { KEY_DEFAULTS, type MediaClipKey } from '@shared/keying'
import { TEXT } from '@shared/i18n'
import { ClipKeySection } from './ClipFxSections'

/** M8：抠像分区 UI（模式切换 / 绿幕参数 / 白底参数 / 关闭）。 */

describe('ClipKeySection', () => {
  it('默认关闭；选色度键写入 chroma 参数（保留其余默认）', () => {
    const onChange = vi.fn<(key: MediaClipKey | undefined) => void>()
    render(<ClipKeySection keyValue={undefined} onChange={onChange} />)
    const mode = screen.getByLabelText(TEXT.clipKey.mode) as HTMLSelectElement
    expect(mode.value).toBe('off')

    fireEvent.change(mode, { target: { value: 'chroma' } })
    expect(onChange).toHaveBeenCalledWith({ ...KEY_DEFAULTS, mode: 'chroma' })
    cleanup()
  })

  it('色度键模式显示键色/相似度/混合/去溢色，改键色写回', () => {
    const onChange = vi.fn<(key: MediaClipKey | undefined) => void>()
    render(<ClipKeySection keyValue={{ ...KEY_DEFAULTS, mode: 'chroma' }} onChange={onChange} />)
    const color = screen.getByLabelText(TEXT.clipKey.color) as HTMLInputElement
    expect(color.value).toBe(KEY_DEFAULTS.color)
    fireEvent.change(color, { target: { value: '#0000ff' } })
    expect(onChange).toHaveBeenCalledWith({ ...KEY_DEFAULTS, mode: 'chroma', color: '#0000ff' })

    const similarity = screen.getByRole('slider', { name: TEXT.clipKey.similarity })
    fireEvent.change(similarity, { target: { value: '0.4' } })
    expect(onChange).toHaveBeenCalledWith({ ...KEY_DEFAULTS, mode: 'chroma', similarity: 0.4 })
    cleanup()
  })

  it('亮度键模式只显示阈值/容差/柔和', () => {
    render(<ClipKeySection keyValue={{ ...KEY_DEFAULTS, mode: 'luma' }} onChange={() => undefined} />)
    expect(screen.getByRole('slider', { name: TEXT.clipKey.threshold })).toBeTruthy()
    expect(screen.getByRole('slider', { name: TEXT.clipKey.tolerance })).toBeTruthy()
    expect(screen.getByRole('slider', { name: TEXT.clipKey.softness })).toBeTruthy()
    expect(screen.queryByLabelText(TEXT.clipKey.color)).toBeNull()
    cleanup()
  })

  it('选回关闭 → onChange(undefined)（整键删除）', () => {
    const onChange = vi.fn<(key: MediaClipKey | undefined) => void>()
    render(<ClipKeySection keyValue={{ ...KEY_DEFAULTS, mode: 'chroma' }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(TEXT.clipKey.mode), { target: { value: 'off' } })
    expect(onChange).toHaveBeenCalledWith(undefined)
    cleanup()
  })
})
