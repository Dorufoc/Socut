import { describe, expect, it } from 'vitest'
import { IMPORTABLE_VIDEO_EXTENSIONS } from '@shared/constants'
import { mimeTypeOf, normalizePreviewPath } from '../src/main/mediaRange'

/**
 * MXF（广播交付容器）的导入与预览白名单。
 *
 * 分工要说清楚：
 * - **导入 / 探测 / 导出**：ffprobe 与 ffmpeg 原生支持 MXF（本机实证：ffmpeg `-f mxf` 生成的
 *   mpeg2video 1280x720/25fps 夹具可被 ffprobe 正确读出），所以这条链路只需要把扩展名纳入白名单；
 * - **预览**：Chromium 没有 MXF 解封装器，`<video>` 会 onError → 预览区显示「不可预览」并保留
 *   字幕叠加预览；要真正看到 MXF 画面需要先转一份代理 MP4（后续单独实现）。
 *
 * 这里锁的是「白名单不会被人悄悄改回去」：少了 mxf，导入对话框会直接拒文件、预览协议也会 403。
 */

describe('MXF 支持面', () => {
  it('mxf 在可导入扩展名里（视频导入对话框据此放行）', () => {
    expect([...IMPORTABLE_VIDEO_EXTENSIONS]).toContain('mxf')
  })

  it('预览协议认得 mxf：给 video/mxf，而不是退回 octet-stream', () => {
    expect(mimeTypeOf('D:/media/a.MXF')).toBe('video/mxf')
    expect(mimeTypeOf('D:/media/a.mxf')).toBe('video/mxf')
  })

  it('normalizePreviewPath 放行 mxf（大小写无关），未知容器仍然拒绝', () => {
    expect(normalizePreviewPath('D:/media/a.mxf')).not.toBeNull()
    expect(normalizePreviewPath('D:/media/a.Mxf')).not.toBeNull()
    expect(normalizePreviewPath('D:/media/a.zip')).toBeNull()
    expect(normalizePreviewPath('')).toBeNull()
  })
})
