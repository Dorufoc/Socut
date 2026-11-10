/**
 * 二进制 → base64（不依赖 `toDataURL`：渲染进程被 check-env 禁止，且 DataURL 会多一层内存拷贝）。
 *
 * 用途：`preview.frame` 把渲染帧 PNG 交给 Agent / CLI / JSON-RPC 客户端。
 * 纯函数，浏览器与 Node 都能跑（Node 24 全局有 btoa/atob）。
 */

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += CHUNK) {
    const slice = bytes.subarray(index, Math.min(bytes.length, index + CHUNK))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
