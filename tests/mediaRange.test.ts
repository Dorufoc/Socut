import { describe, expect, it } from 'vitest'
import { mimeTypeOf, normalizePreviewPath, parseByteRange } from '../src/main/mediaRange'

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
