import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createDefaultProject } from '@shared/projectSchema'
import type { JobResult, VideoMeta } from '@shared/types'
import { proxyJobId } from '@shared/mediaProxy'
import { MediaLibraryPanel } from './MediaLibraryPanel'
import { useProjectStore } from '../state/projectStore'
import { useProxyStore } from '../state/proxyStore'
import { useUiStore } from '../state/uiStore'
import { askConfirm } from '../dialog/ask'
import {
  MEDIA_TILE_SIZE_DEFAULT,
  MEDIA_TILE_SIZE_KEY,
  MEDIA_TILE_SIZE_STEP
} from './mediaTileSize'

vi.mock('../dialog/ask', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialog/ask')>()
  return { ...actual, askConfirm: vi.fn() }
})

const askConfirmMock = vi.mocked(askConfirm)

/**
 * 素材库紧凑网格（v11）：
 * - 卡片只保留缩略图/文件名/分辨率，操作收进悬停浮层；
 * - Ctrl + 滚轮改 `--media-tile-size`，并写回本机偏好；
 * - 普通滚轮不缩放（否则侧栏无法滚动）。
 */

const META: VideoMeta = {
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
  bitRateKbps: null
}

function resetProject(): void {
  useProjectStore.setState({ project: createDefaultProject('素材库测试'), fonts: [], revision: 0 })
}

function seedMedia(): void {
  resetProject()
  useProjectStore.getState().addMedia({
    path: META.path,
    name: 'a.mp4',
    meta: META,
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  })
}

/** 两枚素材：a.mp4（全小写）与 B.MP4（便于验证大小写不敏感）。 */
function seedTwo(): { aId: string; bId: string } {
  resetProject()
  const aId = useProjectStore.getState().addMedia({
    path: META.path,
    name: 'a.mp4',
    meta: META,
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  })
  const bId = useProjectStore.getState().addMedia({
    path: 'C:/media/B.MP4',
    name: 'B.MP4',
    meta: META,
    non169Ack: true,
    hdrAck: true,
    vfrPolicy: 'none',
    compactMode: 'auto',
    thumbnailUrl: '',
    importedAt: '2026-01-01T00:00:00.000Z'
  })
  return { aId, bId }
}

function mediaOf(id: string): NonNullable<ReturnType<typeof useProjectStore.getState>['project']['media'][number]> {
  return useProjectStore.getState().project.media.find((item) => item.id === id)!
}

function tileOf(name: string): HTMLElement {
  // 归类编辑区也会显示同一个素材名，这里只认卡片里的那一个
  const tile = screen
    .getAllByText(name)
    .map((element) => element.closest('.media-tile'))
    .find((element) => element !== null)
  if (!tile) throw new Error(`找不到素材卡片：${name}`)
  return tile as HTMLElement
}

function tileSizeVar(grid: HTMLElement): string {
  return grid.style.getPropertyValue('--media-tile-size')
}

beforeEach(() => {
  localStorage.clear()
  seedMedia()
  askConfirmMock.mockReset()
  askConfirmMock.mockResolvedValue(true)
  useProxyStore.setState({ entries: {}, errors: {}, busy: {} })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetProject()
  useProxyStore.setState({ entries: {}, errors: {}, busy: {} })
  delete (window as { focusnews?: unknown }).focusnews
  useUiStore.setState({ missingMediaIds: [], refVideoMissing: false })
  localStorage.clear()
})

describe('素材库紧凑网格', () => {
  it('每个素材渲染成一张小卡片：缩略图、文件名、分辨率、时长', () => {
    const { container } = render(<MediaLibraryPanel />)

    const tile = container.querySelector('.media-tile')
    expect(tile).not.toBeNull()
    expect(container.querySelector('.media-tile__thumb')).not.toBeNull()
    expect(screen.getByText('a.mp4')).toBeTruthy()
    expect(screen.getByText('1920×1080')).toBeTruthy()
    expect(screen.getByText('10.00s')).toBeTruthy()
  })

  it('操作入口收进缩略图浮层（放到播放头 / 重命名 / 移出）', () => {
    const onPlace = vi.fn()
    render(<MediaLibraryPanel onPlaceAtPlayhead={onPlace} />)

    fireEvent.click(screen.getByLabelText('放到播放头：a.mp4'))
    expect(onPlace).toHaveBeenCalledTimes(1)

    expect(screen.getByLabelText('重命名：a.mp4')).toBeTruthy()
    expect(screen.getByLabelText('移出素材库：a.mp4')).toBeTruthy()
  })

  it('Ctrl + 滚轮缩小卡片并写回本机偏好；普通滚轮不缩放', () => {
    const { container } = render(<MediaLibraryPanel />)
    const grid = container.querySelector('.media-grid') as HTMLElement
    const panel = container.querySelector('section.group') as HTMLElement

    expect(tileSizeVar(grid)).toBe(`${MEDIA_TILE_SIZE_DEFAULT}px`)

    fireEvent.wheel(panel, { deltaY: 100, bubbles: true, cancelable: true })
    expect(tileSizeVar(grid)).toBe(`${MEDIA_TILE_SIZE_DEFAULT}px`)

    fireEvent.wheel(panel, { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true })
    const shrunk = MEDIA_TILE_SIZE_DEFAULT - MEDIA_TILE_SIZE_STEP
    expect(tileSizeVar(grid)).toBe(`${shrunk}px`)
    expect(localStorage.getItem(MEDIA_TILE_SIZE_KEY)).toBe(String(shrunk))

    fireEvent.wheel(panel, { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
    expect(tileSizeVar(grid)).toBe(`${MEDIA_TILE_SIZE_DEFAULT}px`)
  })
})

/** v10（Task 9）：分组筛选、搜索、选中素材后的归类与标签。 */
describe('素材分组、标签与搜索', () => {
  it('新建分组 → 选中素材 → 归入分组：计数与筛选联动', () => {
    seedTwo()
    const { container } = render(<MediaLibraryPanel />)

    fireEvent.change(screen.getByLabelText('新分组名称'), { target: { value: ' 培训 ' } })
    fireEvent.click(screen.getByText('新建分组'))
    // 新分组立即成为筛选条件：组内还没有素材
    expect(screen.getByText('培训 (0)')).toBeTruthy()
    expect(screen.getByText('没有匹配的素材')).toBeTruthy()

    fireEvent.click(screen.getByText('全部 (2)'))
    fireEvent.click(screen.getByText('a.mp4'))
    expect(tileOf('a.mp4').className).toContain('media-tile--selected')

    const binId = useProjectStore.getState().project.mediaBins![0]!.id
    fireEvent.change(screen.getByLabelText('所属分组'), { target: { value: binId } })
    const aId = useProjectStore.getState().project.media.find((item) => item.path === META.path)!.id
    expect(mediaOf(aId).binId).toBe(binId)
    expect(screen.getByText('培训 (1)')).toBeTruthy()

    fireEvent.click(screen.getByText('培训 (1)'))
    expect(container.querySelectorAll('.media-tile')).toHaveLength(1)
    expect(tileOf('a.mp4')).toBeTruthy()
    expect(screen.queryByText('B.MP4')).toBeNull()
  })

  it('搜索名称/标签大小写不敏感，并与分组筛选叠加', () => {
    const { aId, bId } = seedTwo()
    const binId = useProjectStore.getState().addMediaBin('培训')!
    useProjectStore.getState().assignMediaBin(aId, binId)
    useProjectStore.getState().setMediaTags(bId, ['Policy', '新闻'])
    render(<MediaLibraryPanel />)
    const search = screen.getByLabelText('搜索素材')

    fireEvent.change(search, { target: { value: 'b.mp4' } })
    expect(screen.getByText('B.MP4')).toBeTruthy()
    expect(screen.queryByText('a.mp4')).toBeNull()

    fireEvent.change(search, { target: { value: 'POLICY' } })
    expect(screen.getByText('B.MP4')).toBeTruthy()
    expect(screen.queryByText('a.mp4')).toBeNull()

    fireEvent.change(search, { target: { value: 'A.MP4' } })
    expect(screen.getByText('a.mp4')).toBeTruthy()
    expect(screen.queryByText('B.MP4')).toBeNull()

    // 分组 + 搜索叠加：培训组里没有 B，即使它带 policy 标签
    fireEvent.click(screen.getByText('培训 (1)'))
    fireEvent.change(search, { target: { value: 'policy' } })
    expect(screen.getByText('没有匹配的素材')).toBeTruthy()
    expect(screen.queryByText('B.MP4')).toBeNull()

    fireEvent.change(search, { target: { value: 'a.mp4' } })
    expect(screen.getByText('a.mp4')).toBeTruthy()
  })

  it('删除分组要二次确认：取消保留，确认后素材回到未分组', async () => {
    const { aId } = seedTwo()
    const binId = useProjectStore.getState().addMediaBin('培训')!
    useProjectStore.getState().assignMediaBin(aId, binId)
    render(<MediaLibraryPanel />)
    fireEvent.click(screen.getByText('培训 (1)'))

    askConfirmMock.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByText('删除分组'))
    await waitFor(() => expect(askConfirmMock).toHaveBeenCalledTimes(1))
    expect(useProjectStore.getState().project.mediaBins).toHaveLength(1)
    expect(mediaOf(aId).binId).toBe(binId)

    askConfirmMock.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByText('删除分组'))
    await waitFor(() => expect(useProjectStore.getState().project.mediaBins).toBeUndefined())
    expect('binId' in mediaOf(aId)).toBe(false)
    // 删除后筛选退回「全部」
    expect(screen.getByText('全部 (2)')).toBeTruthy()
    expect(tileOf('a.mp4')).toBeTruthy()
  })

  it('标签：中文/英文逗号都可解析、去重；清空标签删键', () => {
    const { aId } = seedTwo()
    render(<MediaLibraryPanel />)
    fireEvent.click(screen.getByText('a.mp4'))

    const input = screen.getByLabelText('标签（逗号分隔）')
    fireEvent.change(input, { target: { value: '新闻，重点, 新闻' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mediaOf(aId).tags).toEqual(['新闻', '重点'])
    // 卡片与编辑区都会显示当前标签
    expect(screen.getAllByText('新闻').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('清空标签'))
    expect('tags' in mediaOf(aId)).toBe(false)
  })

  it('筛选结果为空但素材池非空时显示「没有匹配的素材」', () => {
    seedTwo()
    const { container } = render(<MediaLibraryPanel />)
    fireEvent.change(screen.getByLabelText('搜索素材'), { target: { value: 'zzz-不存在' } })

    expect(screen.getByText('没有匹配的素材')).toBeTruthy()
    expect(container.querySelectorAll('.media-tile')).toHaveLength(0)
  })
})

/** v10（Task 10）：预览代理入口、状态徽标、MXF 提示与移出池的回收。 */
describe('预览代理（v10）', () => {
  function seedMxf(): string {
    resetProject()
    return useProjectStore.getState().addMedia({
      path: 'C:/media/a.mxf',
      name: 'a.mxf',
      meta: { ...META, path: 'C:/media/a.mxf', width: 1920, height: 1080 },
      non169Ack: true,
      hdrAck: true,
      vfrPolicy: 'none',
      compactMode: 'auto',
      thumbnailUrl: '',
      importedAt: '2026-01-01T00:00:00.000Z'
    })
  }

  function installProxyApi(proxy: ReturnType<typeof vi.fn>): {
    proxyStatus: ReturnType<typeof vi.fn>
    removeProxy: ReturnType<typeof vi.fn>
  } {
    const proxyStatus = vi.fn(async () => ({ fresh: true, path: 'D:/proxies/fresh.mp4', signature: 'sig' }))
    const removeProxy = vi.fn(async () => undefined)
    Object.defineProperty(window, 'focusnews', {
      configurable: true,
      value: {
        media: {
          proxy,
          proxyStatus,
          removeProxy,
          thumbUrl: vi.fn(async () => null),
          removeThumb: vi.fn(async () => undefined)
        }
      }
    })
    return { proxyStatus, removeProxy }
  }

  function jobResult(jobId: string, outputs: string[]): JobResult {
    return {
      jobId,
      ok: true,
      outputs,
      progress: {
        jobId,
        phase: 'done',
        framesDone: 1,
        framesTotal: 1,
        outTimeUs: 0,
        percent: 1,
        bytesWritten: 0,
        elapsedMs: 0,
        notices: []
      }
    }
  }

  it('MXF 卡片有「不可预览」提示；queued 显示生成中，完成后显示代理就绪', async () => {
    const mediaId = seedMxf()
    const proxy = vi.fn(async (request: { mediaId: string }) => ({
      status: 'queued' as const,
      jobId: proxyJobId(request.mediaId),
      path: null,
      signature: 'sig-queued'
    }))
    installProxyApi(proxy)
    render(<MediaLibraryPanel />)

    expect(screen.getByText('MXF 不可预览 · 生成代理')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByLabelText('生成预览代理：a.mxf'))
    })
    await waitFor(() => expect(screen.getByText('生成中')).toBeTruthy())
    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId, path: 'C:/media/a.mxf', hasAudio: true, durationSec: 10 })
    )

    act(() => {
      useProxyStore.getState().handleJobResult(jobResult(proxyJobId(mediaId), ['D:/proxies/a-abc.mp4']))
    })
    await waitFor(() => expect(screen.getByText('代理就绪')).toBeTruthy())
  })

  it('命中缓存：直接显示代理就绪；失败显示代理失败', async () => {
    seedMxf()
    const cached = vi.fn(async () => ({
      status: 'cached' as const,
      jobId: 'proxy-m',
      path: 'D:/proxies/a-cached.mp4',
      signature: 'sig-cached'
    }))
    installProxyApi(cached)
    render(<MediaLibraryPanel />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('生成预览代理：a.mxf'))
    })
    await waitFor(() => expect(screen.getByText('代理就绪')).toBeTruthy())

    act(() => {
      useProxyStore.setState({ entries: {}, errors: {}, busy: {} })
    })
    const failing = vi.fn(async () => {
      throw new Error('源文件不存在或不可读')
    })
    installProxyApi(failing)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('生成预览代理：a.mxf'))
    })
    await waitFor(() => expect(screen.getByText('代理失败')).toBeTruthy())
  })

  it('移出素材时回收代理缓存，并清掉账本', async () => {
    const mediaId = seedMxf()
    const proxy = vi.fn(async () => ({
      status: 'cached' as const,
      jobId: proxyJobId(mediaId),
      path: 'D:/proxies/a-cached.mp4',
      signature: 'sig'
    }))
    const { removeProxy } = installProxyApi(proxy)
    render(<MediaLibraryPanel />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText('生成预览代理：a.mxf'))
    })
    await waitFor(() => expect(useProxyStore.getState().entries[mediaId]).toBeDefined())

    act(() => {
      fireEvent.click(screen.getByLabelText('移出素材库：a.mxf'))
    })
    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith(mediaId))
    expect(useProxyStore.getState().entries[mediaId]).toBeUndefined()
  })
})
