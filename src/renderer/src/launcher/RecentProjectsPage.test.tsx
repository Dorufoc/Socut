import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { RecentProjectCard } from '@shared/recentProjects'
import { RecentProjectsPage } from './RecentProjectsPage'
import { ProjectCard } from './ProjectCard'
import { useRecentProjectsStore } from '../state/recentProjectsStore'

/**
 * 启动页交互：默认最近使用排序、名称排序、搜索过滤、空态与重命名。
 * 主进程 API 用桩替换（recentList / renameRecent），不碰真实 IPC。
 */

function card(overrides: Partial<RecentProjectCard> & { id: string; name: string }): RecentProjectCard {
  const base: Omit<RecentProjectCard, 'id' | 'name' | 'filePath'> = {
    source: 'file',
    createdAt: '2026-05-01T01:00:00.000Z',
    modifiedAt: '2026-05-02T01:00:00.000Z',
    lastOpenedAt: '2026-05-03T01:00:00.000Z',
    resolution: { width: 1920, height: 1080 },
    fps: { num: 25, den: 1 },
    clipCount: 0,
    mediaCount: 0,
    audioClipCount: 0,
    hasCover: false,
    nameCustomized: false,
    missing: false,
    coverUrl: null
  }
  return {
    ...base,
    filePath: `C:/projects/${overrides.id}.fnproj`,
    ...overrides
  }
}

function installApi(
  cards: RecentProjectCard[],
  rename?: (id: string, name: string) => Promise<RecentProjectCard | null>
): { recentList: ReturnType<typeof vi.fn>; renameRecent: ReturnType<typeof vi.fn> } {
  const recentList = vi.fn(async () => cards)
  const renameRecent = vi.fn(rename ?? (async () => null))
  ;(window as unknown as { socut: unknown }).socut = {
    project: { recentList, renameRecent }
  }
  return { recentList, renameRecent }
}

function renderPage(): void {
  render(
    <RecentProjectsPage
      appVersion="0.1.0"
      onOpen={() => undefined}
      onCreate={() => undefined}
      onBrowse={() => undefined}
    />
  )
}

function cardNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.project-card__name')).map((node) => node.textContent ?? '')
}

beforeEach(() => {
  useRecentProjectsStore.setState({
    entries: [],
    loading: false,
    error: null,
    sortMode: 'recent',
    query: ''
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete (window as unknown as { socut?: unknown }).socut
})

describe('RecentProjectsPage', () => {
  it('默认按最近使用倒序渲染卡片', async () => {
    installApi([
      card({ id: 'p0000000000000001', name: '上海', lastOpenedAt: '2026-05-03T05:00:00.000Z' }),
      card({ id: 'p0000000000000002', name: '北京', lastOpenedAt: '2026-05-03T03:00:00.000Z' }),
      card({ id: 'p0000000000000003', name: '广州', lastOpenedAt: '2026-05-03T01:00:00.000Z' })
    ])
    const { container } = render(
      <RecentProjectsPage appVersion="0.1.0" onOpen={() => undefined} onCreate={() => undefined} onBrowse={() => undefined} />
    )

    await screen.findByText('上海')
    expect(cardNames(container)).toEqual(['上海', '北京', '广州'])
  })

  it('切到「名称 A→Z」后按拼音排序', async () => {
    installApi([
      card({ id: 'p0000000000000001', name: '上海', lastOpenedAt: '2026-05-03T05:00:00.000Z' }),
      card({ id: 'p0000000000000002', name: '北京', lastOpenedAt: '2026-05-03T03:00:00.000Z' }),
      card({ id: 'p0000000000000003', name: '广州', lastOpenedAt: '2026-05-03T01:00:00.000Z' })
    ])
    const { container } = render(
      <RecentProjectsPage appVersion="0.1.0" onOpen={() => undefined} onCreate={() => undefined} onBrowse={() => undefined} />
    )

    await screen.findByText('上海')
    fireEvent.click(screen.getByRole('button', { name: '名称 A→Z' }))

    expect(cardNames(container)).toEqual(['北京', '广州', '上海'])
  })

  it('搜索框按名称过滤，结果计数同步', async () => {
    installApi([
      card({ id: 'p0000000000000001', name: '上海', lastOpenedAt: '2026-05-03T05:00:00.000Z' }),
      card({ id: 'p0000000000000002', name: '北京', lastOpenedAt: '2026-05-03T03:00:00.000Z' }),
      card({ id: 'p0000000000000003', name: '广州', lastOpenedAt: '2026-05-03T01:00:00.000Z' })
    ])
    const { container } = render(
      <RecentProjectsPage appVersion="0.1.0" onOpen={() => undefined} onCreate={() => undefined} onBrowse={() => undefined} />
    )

    await screen.findByText('上海')
    fireEvent.change(screen.getByLabelText('搜索工程名称'), { target: { value: '北京' } })

    await waitFor(() => expect(cardNames(container)).toEqual(['北京']))
    expect(screen.getByText('共 1 个')).toBeTruthy()
  })

  it('没有工程时展示空态', async () => {
    installApi([])
    renderPage()

    expect(await screen.findByText('还没有工程')).toBeTruthy()
  })

  it('内联重命名调用 renameRecent 并更新卡片名称', async () => {
    const target = card({ id: 'p0000000000000001', name: '旧名字' })
    const { renameRecent } = installApi([target], async (id, name) => card({ id, name }))
    renderPage()

    await screen.findByText('旧名字')
    const cardEl = screen.getByRole('button', { name: '打开工程 旧名字' })
    fireEvent.click(within(cardEl).getByRole('button', { name: '重命名' }))

    const input = screen.getByRole('textbox', { name: '重命名工程 旧名字' })
    fireEvent.change(input, { target: { value: '新名字' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(renameRecent).toHaveBeenCalledWith('p0000000000000001', '新名字'))
    expect(await screen.findByText('新名字')).toBeTruthy()
  })

  it('双击名称进入重命名，不会顺带打开工程', async () => {
    const target = card({ id: 'p0000000000000001', name: '旧名字' })
    const onOpen = vi.fn()
    const onRename = vi.fn(async () => true)

    render(
      <ProjectCard entry={target} onOpen={onOpen} onRename={onRename} onRemove={() => undefined} />
    )

    const name = screen.getByText('旧名字')
    fireEvent.click(name)
    fireEvent.doubleClick(name)

    expect(screen.getByRole('textbox', { name: '重命名工程 旧名字' })).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 260))
    expect(onOpen).not.toHaveBeenCalled()
  })
})
