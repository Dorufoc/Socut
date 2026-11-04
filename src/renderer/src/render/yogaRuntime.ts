import { loadYoga } from 'yoga-layout/load'

/**
 * Yoga 运行时（规格 §4.3）。
 * yoga-layout 为 ESM-only，浏览器无顶层 await 时用 `yoga-layout/load` 手工加载；
 * wasm 已内联在包内（dist/binaries/yoga-wasm-base64-esm.js），因此不需要额外资源路径。
 */

export type YogaModule = Awaited<ReturnType<typeof loadYoga>>

let loading: Promise<YogaModule> | null = null

export function getYoga(): Promise<YogaModule> {
  if (!loading) {
    loading = loadYoga().catch((error: unknown) => {
      // 失败后允许重试（否则整个会话锁死在 rejected promise 上）
      loading = null
      throw error
    })
  }
  return loading
}

export function isYogaReady(): boolean {
  return loading !== null
}
