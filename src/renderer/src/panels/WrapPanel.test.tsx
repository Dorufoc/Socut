import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FPS_30 } from '@shared/constants'
import { TEXT } from '@shared/i18n'
import { createClip, createDefaultProject } from '@shared/projectSchema'
import type { Project } from '@shared/types'
import { WrapPanel } from './WrapPanel'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 左侧「包装」Tab（P6）：字幕 / 片尾 / 水印三块从上到下一次铺开。
 *
 * 合并的只有入口位置，三块各自的契约一个字都不改：
 * 字幕区仍是那份列表（新建 / 删除 / 点一条跳中点都归它），水印区仍是那份面板，
 * 片尾区只做占位——没有假入口，因为功能还没实现，给了就是骗人。
 */

function seed(clipCount: number): Project {
  const project = createDefaultProject('包装')
  project.fps = FPS_30
  project.clips = Array.from({ length: clipCount }, (_, index) => {
    const clip = createClip({ startTime: index * 4, fps: FPS_30 })
    clip.content = { title: `第 ${index + 1} 段标题`, subtitle: '' }
    return clip
  })
  useProjectStore.setState({ project, selectedClipId: project.clips[0]?.id ?? null, fonts: [] })
  return project
}

afterEach(() => {
  cleanup()
  act(() => {
    useProjectStore.setState({ project: createDefaultProject('空'), selectedClipId: null, fonts: [] })
    useUiStore.setState({ seekHandler: null, playing: false, displayTimeSec: 0, notice: null })
  })
})

describe('WrapPanel：分段顺序与归属', () => {
  it('从上到下依次是字幕、文本元素、片尾、水印（M7 增加文本元素段）', () => {
    seed(0)
    const { container } = render(<WrapPanel />)

    const titles = Array.from(container.querySelectorAll('.wrap-section')).map(
      (section) => section.querySelector('.group__title')?.textContent
    )
    expect(titles).toEqual([TEXT.captions.title, TEXT.wrap.textElements, TEXT.wrap.ending, TEXT.wrap.watermark])
  })

  it('字幕区就是原来那份字幕列表：新建与删除入口都在里面', () => {
    seed(2)
    const { container } = render(<WrapPanel />)

    expect(container.querySelector('.caption-add')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: TEXT.captions.removeNamed('第 1 段标题') })).toHaveLength(1)
  })

  it('在包装区点新建：当场加一条，并选中之', () => {
    seed(0)
    act(() => useUiStore.setState({ seekHandler: vi.fn() }))
    const { container } = render(<WrapPanel />)

    fireEvent.click(container.querySelector('.caption-add--hero')!)

    expect(useProjectStore.getState().project.clips).toHaveLength(1)
    expect(useProjectStore.getState().selectedClipId).toBe(useProjectStore.getState().project.clips[0]!.id)
  })

  it('片尾区只有占位说明，不给任何假入口（功能尚未实现）', () => {
    seed(0)
    const { container } = render(<WrapPanel />)
    const ending = container.querySelector('.wrap-section--ending') as HTMLElement

    expect(ending.textContent).toContain(TEXT.wrap.endingTodo)
    expect(ending.querySelector('button')).toBeNull()
  })

  it('水印区就是原来的水印面板：导入入口在里面', () => {
    seed(0)
    const { container } = render(<WrapPanel />)

    expect(screen.getByRole('button', { name: /水印图片/ })).toBeTruthy()
    expect(container.querySelector('.wrap-section--watermark .group')).toBeTruthy()
  })
})
