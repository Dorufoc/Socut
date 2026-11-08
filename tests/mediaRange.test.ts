import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isPreviewNotModified,
  mimeTypeOf,
  normalizePreviewPath,
  parseByteRange,
  previewFileVersion,
  previewResponseHeaders,
  previewUrlFor
} from '../src/main/mediaRange'

/**
 * 参考视频预览协议的纯逻辑：
 * - Range 解析决定 <video> 能否拖动进度条（单段范围必须严格、越界必须回退）；
 * - 扩展名白名单决定哪些文件允许登记给 custom scheme。
 */

describe('parseByteRange（HTTP Range）', () => {
  it('bytes=0- 取整段（<video> 的首个请求）', () => {
    expect(parseByteRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
  })

  it('bytes=a-b 取闭区间，右端越界时收敛到文件末尾', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
    expect(parseByteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 })
  })

  it('bytes=-n 取最后 n 字节', () => {
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseByteRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 })
  })

  it('不可满足或非法范围返回 null（调用方回退整段 200）', () => {
    expect(parseByteRange(null, 100)).toBeNull()
    expect(parseByteRange('bytes=', 100)).toBeNull()
    expect(parseByteRange('bytes=100-', 100)).toBeNull()
    expect(parseByteRange('bytes=20-10', 100)).toBeNull()
    expect(parseByteRange('items=0-10', 100)).toBeNull()
    expect(parseByteRange('bytes=0-', 0)).toBeNull()
  })
})

describe('视频扩展名白名单', () => {
  it('常见容器扩展名映射到正确的 Content-Type', () => {
    expect(mimeTypeOf('D:/a.MP4')).toBe('video/mp4')
    expect(mimeTypeOf('D:/a.mov')).toBe('video/quicktime')
    expect(mimeTypeOf('D:/a.webm')).toBe('video/webm')
    expect(mimeTypeOf('D:/a.txt')).toBeUndefined()
  })

  it('只接受白名单内的视频文件，其他一律拒绝', () => {
    expect(normalizePreviewPath('D:/clips/ref.mp4')).toMatch(/ref\.mp4$/)
    expect(normalizePreviewPath('D:/clips/ref.MOV')).toMatch(/ref\.MOV$/)
    expect(normalizePreviewPath('D:/clips/secret.txt')).toBeNull()
    expect(normalizePreviewPath('')).toBeNull()
  })
})

describe('图片白名单（水印预览与视频同一条协议）', () => {
  it('常见图片扩展名给出 image/* 的 Content-Type', () => {
    expect(mimeTypeOf('D:/brand/logo.PNG')).toBe('image/png')
    expect(mimeTypeOf('D:/brand/logo.jpg')).toBe('image/jpeg')
    expect(mimeTypeOf('D:/brand/logo.jpeg')).toBe('image/jpeg')
    expect(mimeTypeOf('D:/brand/logo.webp')).toBe('image/webp')
    expect(mimeTypeOf('D:/brand/logo.tiff')).toBe('image/tiff')
  })

  it('图片也走「登记过才可读」的同一个入口；svg 不在内（FFmpeg 未必能读）', () => {
    expect(normalizePreviewPath('D:/brand/logo.png')).toMatch(/logo\.png$/)
    expect(normalizePreviewPath('D:/brand/mark.svg')).toBeNull()
    expect(normalizePreviewPath('D:/Windows/win.ini')).toBeNull()
  })

  it('图片与视频的映射不互相覆盖（两套扩展名合并后仍保留视频条目）', () => {
    expect(mimeTypeOf('D:/a.mp4')).toBe('video/mp4')
    expect(mimeTypeOf('D:/a.png')).toBe('image/png')
    expect(mimeTypeOf('D:/a.md')).toBeUndefined()
  })
})

describe('previewFileVersion（URL 里的文件版本）', () => {
  it('同 size + mtime 稳定，mtime 取整到秒（和 Last-Modified 对齐）', () => {
    const stat = { size: 1024, mtimeMs: Date.UTC(2026, 10, 8, 3, 4, 5, 789) }
    expect(previewFileVersion(stat)).toBe(`${stat.size}-${Math.floor(stat.mtimeMs)}`)
    expect(previewFileVersion(stat)).toBe(previewFileVersion({ ...stat }))
  })

  it('size 或 mtime 变化都会产生新版本（换文件就不会命中旧缓冲）', () => {
    const base = { size: 1024, mtimeMs: 1_700_000_000_000 }
    expect(previewFileVersion({ ...base, size: 2048 })).not.toBe(previewFileVersion(base))
    expect(previewFileVersion({ ...base, mtimeMs: base.mtimeMs + 1000 })).not.toBe(previewFileVersion(base))
  })
})

describe('previewUrlFor（版本化协议地址）', () => {
  it('同时带 path 与 v，路径按绝对路径规范化并整体 encode', () => {
    const file = 'D:/clips/我的 参考 01.mp4'
    const url = previewUrlFor(file, '1024-1700000000')
    expect(url).toBe(
      `socut-media://preview/?path=${encodeURIComponent(path.resolve(file))}&v=${encodeURIComponent('1024-1700000000')}`
    )
    // 空格与中文必须被编码，否则 custom scheme 的 query 会被截断
    expect(url).toContain('%20')
    expect(url).toContain('%E5%8F%82')
    expect(url).not.toContain(' ')
  })
})

describe('previewResponseHeaders（可缓存读取）', () => {
  it('ETag / Last-Modified / Cache-Control 齐全，且不再阻止缓存', () => {
    const mtimeMs = Date.UTC(2026, 10, 8, 3, 4, 5, 789)
    const headers = previewResponseHeaders({ size: 1024, mtimeMs, version: '1024-1794097445' })
    expect(headers['Accept-Ranges']).toBe('bytes')
    expect(headers.ETag).toBe('"1024-1794097445"')
    expect(headers['Last-Modified']).toBe(new Date(mtimeMs).toUTCString())
    expect(headers['Cache-Control']).toContain('private')
    expect(headers['Cache-Control']).toContain('max-age=31536000')
    expect(headers['Cache-Control']).toContain('immutable')
    expect(headers['Cache-Control']).not.toContain('no-store')
    expect(headers['Content-Type']).toBeUndefined()
  })
})

describe('isPreviewNotModified（304 判定）', () => {
  const mtimeMs = Date.UTC(2026, 10, 8, 3, 4, 5)
  const target = { version: '1024-1794097445', mtimeMs }

  it('If-None-Match 精确命中版本（带双引号）→ 304', () => {
    expect(
      isPreviewNotModified({ ...target, ifNoneMatch: '"1024-1794097445"', ifModifiedSince: null })
    ).toBe(true)
    // 多值列表与 * 也按命中处理
    expect(isPreviewNotModified({ ...target, ifNoneMatch: '"other", *', ifModifiedSince: null })).toBe(true)
  })

  it('If-Modified-Since 命中（按秒、允许相等）→ 304', () => {
    expect(
      isPreviewNotModified({
        ...target,
        ifNoneMatch: null,
        ifModifiedSince: new Date(mtimeMs).toUTCString()
      })
    ).toBe(true)
  })

  it('ETag 与日期都不匹配 → 200（重新读文件）', () => {
    expect(
      isPreviewNotModified({
        ...target,
        ifNoneMatch: '"other"',
        ifModifiedSince: new Date(mtimeMs - 5000).toUTCString()
      })
    ).toBe(false)
    expect(isPreviewNotModified({ ...target, ifNoneMatch: null, ifModifiedSince: null })).toBe(false)
  })

  it('无效日期不抛错，一律当不匹配', () => {
    expect(() =>
      isPreviewNotModified({ ...target, ifNoneMatch: null, ifModifiedSince: 'not-a-date' })
    ).not.toThrow()
    expect(isPreviewNotModified({ ...target, ifNoneMatch: null, ifModifiedSince: 'not-a-date' })).toBe(false)
  })
})
