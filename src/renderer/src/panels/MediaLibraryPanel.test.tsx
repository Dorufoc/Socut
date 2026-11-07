import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createDefaultProject } from '@shared/projectSchema'
import type { VideoMeta } from '@shared/types'
import { MediaLibraryPanel } from './MediaLibraryPanel'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'
import {
  MEDIA_TILE_SIZE_DEFAULT,
  MEDIA_TILE_SIZE_KEY,
  MEDIA_TILE_SIZE_STEP
} from './mediaTileSize'

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

function tileSizeVar(grid: HTMLElement): string {
  return grid.style.getPropertyValue('--media-tile-size')
}

beforeEach(() => {
  localStorage.clear()
  seedMedia()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetProject()
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
