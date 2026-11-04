import path from 'node:path'
import { BrowserWindow, app, shell } from 'electron'
import { WINDOW_TITLE } from '../shared/constants'
import { resourcesRoot } from './paths'
import { log } from './log'

/** 主窗口：contextIsolation + sandbox + 无 Node 泄露（规格 §4.2 进程模型）。 */

/**
 * 窗口/任务栏图标（计划工程结构里的 resources/icons）。
 * 不能只依赖 exe 内嵌图标：未签名交付里 `signAndEditExecutable` 一旦关掉，
 * exe 资源不会被改写，运行时就会回到 Electron 默认图标。
 */
export function appIconPath(): string {
  return path.join(resourcesRoot(), 'icons', 'icon.png')
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: WINDOW_TITLE,
    icon: appIconPath(),
    backgroundColor: '#12161c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关闭拼写/自动填充等无关能力，减少 Chromium 侧不确定行为
      spellcheck: false,
      devTools: !process.env.FOCUSNEWS_PROD
    }
  })

  window.once('ready-to-show', () => window.show())

  // 外链一律走系统浏览器，避免在主窗口内导航
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 开发环境把渲染进程控制台输出落盘（M0 验证靠它定位 Yoga / 字体 / 渲染异常）
  if (!app.isPackaged) {
    window.webContents.on('console-message', (event) => {
      const { level, message, lineNumber } = event
      if (level === 'warning' || level === 'error') {
        void log(level === 'error' ? 'error' : 'warn', `渲染进程 [${level}] ${message} @${lineNumber}`)
      } else {
        console.log(`[renderer:${level}] ${message}`)
      }
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}
