import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act, type RenderResult } from '@testing-library/react'
import { createDefaultProject } from '@shared/projectSchema'
import type { WatermarkSettings } from '@shared/types'
import { WatermarkPanel } from './WatermarkPanel'
import { useProjectStore } from '../state/projectStore'
import { useUiStore } from '../state/uiStore'

/**
 * 水印面板（左侧「水印」Tab）。
 * 测的是「导入 → 工程状态 → 换算读数」这条真实链路：面板只改 store，
 * 导出参数由 store 派生（shared/ffmpegArgs），所以这里的状态正确就等于合成正确。
 *
 * 面板只用到两条主进程能力，因此桩只给这两条：video.previewUrl（缩略图）+ watermark.pick。
 */

const PICKED = { path: 'D:/brand/logo.png', name: 'logo.png', sourceWidth: 800, sourceHeight: 450 }

/**
 * 把异步桩（pick / previewUrl 的 promise）引发的 setState 收进 act：
 * 这批用例全是「点一下 → 等主进程回来 → 断言 DOM」，不收干净会刷一屏 React 告警。
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function stubApi(pickResult: typeof PICKED | null, preview: string | null = 'focusnews-media://preview/?path=logo'): { pick: ReturnType<typeof vi.fn> } {
  const pick = vi.fn(async () => {
    if (pickResult) return pickResult
    return null
  })
  const api = {
    video: { previewUrl: vi.fn(async () => preview) },
    watermark: { pick }
  }
  ;(window as unknown as { focusnews: unknown }).focusnews = api
  return { pick }
}

function seedWatermark(overrides: Partial<WatermarkSettings> = {}): void {
  const project = createDefaultProject('水印测试')
  project.watermark = {
    enabled: true,
    path: 'D:/brand/logo.png',
    name: 'logo.png',
    sourceWidth: 800,
    sourceHeight: 450,
    importedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
  useProjectStore.setState({ project, fonts: [], revision: 0 })
}

function emptyProject(): void {
  useProjectStore.setState({ project: createDefaultProject('水印测试'), fonts: [], revision: 0 })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  emptyProject()
  useUiStore.getState().setNotice(null)
  delete (window as unknown as { focusnews?: unknown }).focusnews
})

describe('导入水印', () => {
  it('空态给出导入入口，成功后写入工程并提示', async () => {
    emptyProject()
    stubApi(PICKED)
    const { container } = render(<WatermarkPanel />)
    expect(container.textContent).toContain('还没有水印')

    fireEvent.click(screen.getByRole('button', { name: /导入水印图片/ }))
    await screen.findByText('logo.png')

    const settings = useProjectStore.getState().project.watermark
    expect(settings).toMatchObject({ enabled: true, path: PICKED.path, sourceWidth: 800, sourceHeight: 450 })
    expect(useUiStore.getState().notice).toContain('水印已导入')
    // 导入后按钮换成「更换」，用户不会再点出一个「再导一遍」的歧义入口
    expect(screen.queryByRole('button', { name: /导入水印图片/ })).toBeNull()
    expect(screen.getByRole('button', { name: /更换水印图片/ })).toBeTruthy()
  })

  it('用户取消选择时不改工程、也不提示', async () => {
    emptyProject()
    stubApi(null)
    render(<WatermarkPanel />)
    fireEvent.click(screen.getByRole('button', { name: /导入水印图片/ }))
    await flush()
    expect(useProjectStore.getState().project.watermark).toBeUndefined()
    expect(useUiStore.getState().notice).toBeNull()
  })

  it('探测失败（主进程报错）时只提示，不留下半个水印', async () => {
    emptyProject()
    ;(window as unknown as { focusnews: unknown }).focusnews = {
      video: { previewUrl: vi.fn(async () => null) },
      watermark: { pick: vi.fn(async () => { throw new Error('无法读取图片尺寸：broken.png') }) }
    }
    render(<WatermarkPanel />)
    fireEvent.click(screen.getByRole('button', { name: /导入水印图片/ }))
    await flush()
    expect(useUiStore.getState().notice).toContain('无法读取图片尺寸')
    expect(useProjectStore.getState().project.watermark).toBeUndefined()
  })
})

describe('换算读数', () => {
  it('1080P 基准显示 256×144 @ (30,30)，本工程按高度比同步换算', async () => {
    seedWatermark()
    stubApi(null)
    const { container } = render(<WatermarkPanel />)
    await screen.findByText('logo.png')
    const text = container.textContent ?? ''
    // 800×450 × 32% = 256×144，边距 30px（基准与工程同为 1080P）
    expect(text).toContain('256×144 @ (30,30)')
    expect(text).toContain('原图 800×450')
    expect(text).toContain('30px@1080p')
  })

  it('工程改成 720p 时读数缩到 2/3（171×96 @ (20,20)）', async () => {
    seedWatermark()
    useProjectStore.getState().setResolution(1280, 720)
    stubApi(null)
    const { container } = render(<WatermarkPanel />)
    await screen.findByText('logo.png')
    const text = container.textContent ?? ''
    expect(text).toContain('256×144 @ (30,30)') // 基准行不动
    expect(text).toContain('171×96 @ (20,20)') // 本工程行跟着分辨率走
  })

  it('图片不可读时不画缩略图，并给出可操作的提示', async () => {
    seedWatermark()
    stubApi(null, null)
    const { container } = render(<WatermarkPanel />)
    await flush()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('图片不可读')
  })

  it('已导入时缩略图使用预览地址', async () => {
    seedWatermark()
    stubApi(null, 'focusnews-media://preview/?path=logo')
    render(<WatermarkPanel />)
    const img = await screen.findByRole('presentation')
    expect(img.getAttribute('src')).toBe('focusnews-media://preview/?path=logo')
  })
})

describe('开关与移除', () => {
  it('关掉开关只改 enabled，路径与尺寸保持可随时再启用', async () => {
    seedWatermark()
    stubApi(null)
    render(<WatermarkPanel />)
    const toggle = await screen.findByRole('checkbox')
    fireEvent.click(toggle)
    expect(useProjectStore.getState().project.watermark?.enabled).toBe(false)
    expect(useProjectStore.getState().project.watermark?.path).toBe(PICKED.path)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(useProjectStore.getState().project.watermark?.enabled).toBe(true)
  })

  it('移除后整个字段消失（工程回到未导入形态，argv 也就退回旧路径）', async () => {
    seedWatermark()
    stubApi(null)
    let view: RenderResult = render(<WatermarkPanel />)
    fireEvent.click(await view.findByRole('button', { name: '移除' }))
    expect(useProjectStore.getState().project.watermark).toBeUndefined()
    expect(useUiStore.getState().notice).toContain('已移除水印')
    view.unmount()
    view = render(<WatermarkPanel />)
    expect(view.container.textContent).toContain('还没有水印')
  })
})
