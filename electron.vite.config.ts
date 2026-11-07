import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@renderer': resolve(__dirname, 'src/renderer/src')
}

/**
 * 开发模式去掉 index.html 里的严格 CSP（React Refresh 需要内联 preamble）；
 * 生产包保留 CSP meta，与文件协议加载无法通过响应头注入 CSP 的现实一致。
 */
function relaxCspInDev(): Plugin {
  return {
    name: 'focusnews-relax-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html: string): string {
      return html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/, '')
    }
  }
}

/**
 * 生产包去掉 CSP 中只为 Vite HMR 存在的 `ws: http://localhost:5173`。
 * 交付物是离线单机应用（规格 §8：零外部依赖），connect-src 应收紧到 'self'；
 * 留着 5173 等于在安装包里永久开放一个本地端口连接权限。
 */
function tightenCspInProd(): Plugin {
  return {
    name: 'focusnews-tighten-csp-in-prod',
    apply: 'build',
    transformIndexHtml(html: string): string {
      // 按 token 过滤而不是整段替换：源码里 connect-src 还带着 wasm 需要的 `data:`
      return html.replace(/connect-src([^;"]*)/, (_match: string, sources: string) => {
        const kept = sources
          .trim()
          .split(/\s+/)
          .filter((source) => source !== 'ws:' && source !== 'http://localhost:5173')
        return `connect-src ${kept.join(' ')}`
      })
    }
  }
}

/**
 * 主进程 sourcemap 只在开发构建保留（行号对排查子进程/帧通道问题真有用）。
 * 之前无条件 `inline`：地图直接内联进 out/main/index.js，而 `files` 白名单会把 out/ 全部打进
 * app.asar——等于把闭源应用（license: UNLICENSED）的可读源码随安装包分发出去，还白白撑大体积。
 * 生产构建（--win x64 / --dir）走 command==='build'，不生成地图。
 */
export default defineConfig(({ command }) => {
  const devMaps = command === 'serve'
  return {
    main: {
      // 主进程只 import electron 与 node 内置模块；运行时依赖一律外置，不打包进 bundle。
      plugins: [externalizeDepsPlugin()],
      resolve: { alias },
      build: {
        sourcemap: devMaps ? 'inline' : false
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: { alias }
    },
    renderer: {
      resolve: { alias },
      plugins: [react(), relaxCspInDev(), tightenCspInProd()],
      // yoga-layout 是 ESM-only 且带 wasm 内联二进制，预打包会破坏其加载入口，交由 Vite 直接处理。
      optimizeDeps: { exclude: ['yoga-layout'] },
      build: {
        target: 'chrome120',
        assetsInlineLimit: 0
      }
    }
  }
})
