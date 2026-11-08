import { afterEach, describe, expect, it } from 'vitest'
import { EXPORT_CANVAS_SIZES } from '@shared/constants'
import { createDefaultProject } from '@shared/projectSchema'
import { previewTargetCanvas } from './usePreviewSpec'
import { useUiStore } from '../state/uiStore'

/** 目标画布预览（v10）：portrait/square 用 1080 档固定尺寸并强制紧凑分支；null 不覆盖。 */

afterEach(() => {
  useUiStore.setState({ previewCanvasKind: null, previewFit: 'contain' })
})

describe('previewTargetCanvas', () => {
  const project = createDefaultProject('预览画布')

  it('null = 工程画布，不传覆盖参数', () => {
    expect(previewTargetCanvas(project, null, 'contain')).toBeNull()
  })

  it('竖屏 1080×1920，走 compact 分支', () => {
    expect(previewTargetCanvas(project, 'portrait', 'cover')).toEqual({
      ...EXPORT_CANVAS_SIZES.portrait['1080'],
      mode: 'compact'
    })
  })

  it('方形 1080×1080，同样走 compact 分支', () => {
    expect(previewTargetCanvas(project, 'square', 'cover')).toEqual({
      ...EXPORT_CANVAS_SIZES.square['1080'],
      mode: 'compact'
    })
  })

  it('横屏覆盖仍跟随工程分辨率与分支', () => {
    expect(previewTargetCanvas(project, 'landscape', 'contain')).toEqual({
      ...project.resolution,
      mode: 'standard'
    })
  })
})

describe('uiStore 预览画布覆盖', () => {
  it('设置后可读回；工程画布清除覆盖', () => {
    useUiStore.getState().setPreviewCanvas('portrait')
    useUiStore.getState().setPreviewFit('cover')
    expect(useUiStore.getState().previewCanvasKind).toBe('portrait')
    expect(useUiStore.getState().previewFit).toBe('cover')

    useUiStore.getState().setPreviewCanvas(null)
    expect(useUiStore.getState().previewCanvasKind).toBeNull()
  })
})
