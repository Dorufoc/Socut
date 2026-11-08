/**
 * 4K / MXF 预览代理的公共口径（v10，主/渲染/测试共用）。
 *
 * 纪律与防抖代理同一套：
 * 1. **代理只服务预览**：导出永远读原片路径，工程 JSON 不落盘代理路径；
 * 2. **签名含源指纹**：源路径 + size/mtime + 目标规格，源文件被替换即失效；
 * 3. **文件名按 mediaId 前缀**：素材移出池时可整批回收，令牌保证同素材不同版本互不覆盖。
 */

import { MEDIA_PROXY } from './constants'

/** 算法/规格修订号：代理规格变化时递增，使旧缓存自动失效。 */
const PROXY_ALGO_REV = 1

export interface ProxySignatureInput {
  sourcePath: string
  /** 源文件字节数（主进程 stat 得到；渲染侧通常只重算路径后交给主进程校验） */
  sourceBytes?: number
  /** 源文件 mtime（毫秒） */
  sourceMtimeMs?: number
}

/** 预览代理新鲜度签名：源路径 + size/mtime + 代理规格任一变化即失效。 */
export function proxySignature(input: ProxySignatureInput): string {
  const spec = [
    `short=${MEDIA_PROXY.maxShortSide}`,
    `long=${MEDIA_PROXY.maxLongSide}`,
    `fps=${MEDIA_PROXY.fps}`,
    `crf=${MEDIA_PROXY.crf}`,
    `a=${MEDIA_PROXY.audioBitrateKbps}`
  ].join(',')
  return [
    `r${PROXY_ALGO_REV}`,
    input.sourcePath,
    String(Math.round(input.sourceBytes ?? 0)),
    String(Math.round(input.sourceMtimeMs ?? 0)),
    spec
  ].join('|')
}

/**
 * 缓存文件令牌：签名 + 源指纹的 FNV-1a 哈希（8 位十六进制）。
 * 不依赖 Node crypto：同一纯函数在主/渲染两侧都可调用，测试不需 Electron。
 */
export function proxyToken(signature: string, sourceBytes: number, sourceMtimeMs: number): string {
  const text = `${signature}|${Math.round(sourceBytes)}|${Math.round(sourceMtimeMs)}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** mediaId 的安全化前缀（目录穿越与非法字符一律替换为下划线）。 */
export function safeProxyMediaId(mediaId: string): string {
  return mediaId.replace(/[^\w-]/g, '_').slice(0, 64) || 'media'
}

/** 代理文件名：<安全 mediaId>-<令牌>.mp4；按前缀可整批回收。 */
export function proxyFileName(mediaId: string, token: string): string {
  const safeToken = token.replace(/[^\w-]/g, '').slice(0, 16) || 'plain'
  return `${safeProxyMediaId(mediaId)}-${safeToken}.mp4`
}

/** 代理作业 id（确定性）：同素材重复点击复用运行中的作业，进度面板只有一张卡。 */
export function proxyJobId(mediaId: string): string {
  return `proxy-${safeProxyMediaId(mediaId)}`
}

/** 代理文件前缀（素材移出池时按它回收该素材的全部代理版本）。 */
export function proxyFilePrefix(mediaId: string): string {
  return `${safeProxyMediaId(mediaId)}-`
}

/** 文件名是否属于该素材的代理产物。 */
export function isProxyFileOf(mediaId: string, fileName: string): boolean {
  return fileName.startsWith(proxyFilePrefix(mediaId)) && fileName.endsWith('.mp4')
}
