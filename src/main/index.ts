import fs from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { APP_NAME, WINDOW_TITLE } from '../shared/constants'
import { APP_VERSION } from './appVersion'
import { ExportEngine } from './export/engine'
import { registerIpc } from './ipc'
import { createMainWindow } from './windows'
import { flushPendingAutosave } from './projectStore'
import { terminateAll } from './procRegistry'
import { sweepStaleWorkspaces } from './tempWorkspace'
import { resolveFfmpegBinaries, tempRoot } from './paths'
import { initSmoke, smokeConfig } from './smoke'
import { installMediaProtocol, registerMediaScheme } from './media'
import { installThumbProtocol, registerThumbScheme } from './thumbProtocol'
import { installStripProtocol, registerStripScheme } from './stripProtocol'
import { installCoverProtocol, registerCoverScheme } from './coverProtocol'
import { applyGpuPreferenceAtStartup } from './gpu'
import { log } from './log'
import { CliControlServer } from './cliServer'

/**
 * 主进程入口（规格 §4.2）：
 * - 文件读写与工程保存
 * - FFmpeg 子进程生命周期（spawn / 取消 / 超时强杀）
 * - 导出任务队列与临时目录清理
 * - 退出前统一回收（规格 §11）
 */

const engine = new ExportEngine()
/** CLI 自动拉起时带 `--cli-server`：窗口保持隐藏，只作为控制面/渲染后端。 */
const cliOnly = process.argv.includes('--cli-server')
let cliServer: CliControlServer | null = null

async function ensureCliServer(): Promise<CliControlServer | null> {
  if (cliServer) return cliServer
  const server = new CliControlServer(engine)
  try {
    await server.start()
    cliServer = server
    return server
  } catch (error) {
    await log('error', `CLI 控制服务启动失败：${String(error)}`)
    return null
  }
}

// 自定义媒体协议必须在 app ready 之前声明（参考视频预览 + 素材库缩略图 + 时间帧预览条 + 启动页封面）
registerMediaScheme()
registerThumbScheme()
registerStripScheme()
registerCoverScheme()

/**
 * 自动化取证专用（仅开发）：把 userData 换到隔离目录。
 * 单实例锁的锁文件就住在 userData 里——用户正开着 Socut 时，冒烟/取证实例
 * 抢不到锁会**秒退且退出码仍为 0**，取证脚本于是把上一轮的旧报告当成本轮结果（假绿）。
 * 隔离 profile 后门禁与人工使用互不干扰；打包版一律忽略，不影响交付。
 */
function applyDevUserDataOverride(): void {
  if (app.isPackaged) return
  const target = process.env.SOCUT_USER_DATA
  if (!target) return
  try {
    app.setPath('userData', target)
  } catch (error) {
    console.error(`✗ 隔离 userData 设置失败（${target}）：${String(error)}`)
  }
}
applyDevUserDataOverride()

// 显卡偏好开关必须在 GPU 进程初始化前追加（app ready 之前），因此放在模块作用域。
// 依赖上一步的 userData 覆盖，否则读到的会是默认 profile 里的设置。
const appliedGpuPreference = applyGpuPreferenceAtStartup()

// 单实例：多开会让临时目录与子进程失控
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // 已有实例可能由普通启动创建、尚未开控制服务；CLI 自动拉起时补开一次。
    if (argv.includes('--cli-server')) {
      void ensureCliServer()
      return
    }
    const focused = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible())
    if (focused) {
      if (focused.isMinimized()) focused.restore()
      focused.focus()
      return
    }
    // 之前是 `--cli-server` 隐藏实例：用户手动再启动时把窗口显示出来。
    const hidden = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
    if (hidden) {
      hidden.show()
      hidden.focus()
    }
  })
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.name = APP_NAME
  app.setAppUserModelId('com.socut.app')

  installMediaProtocol()
  installThumbProtocol()
  installStripProtocol()
  installCoverProtocol()

  // 冒烟模式（开发）：先读环境，再在渲染侧主动上报时校验并退出
  initSmoke()
  if (smokeConfig()) {
    setTimeout(() => {
      console.log('✗ 应用内冒烟超时未上报（180s）')
      void log('error', '冒烟超时未上报')
      app.exit(1)
    }, 180_000).unref?.()
  }
  // 逐帧评审表模式：渲染侧写完即退，卡住也要有终局（否则 CI 只能靠外部超时）
  if (!app.isPackaged && process.env.SOCUT_REVIEW_SHEET) {
    setTimeout(() => {
      console.log('✗ 逐帧动画评审表超时未产出（150s）')
      void log('error', '逐帧动画评审表超时未产出')
      app.exit(1)
    }, 150_000).unref?.()
  }
  // 像素一致性回归（M1-7）同样必须有终局
  if (!app.isPackaged && process.env.SOCUT_PIXELCHECK) {
    setTimeout(() => {
      console.log('✗ 像素一致性回归超时未产出报告（120s）')
      void log('error', '像素一致性回归超时未产出报告')
      app.exit(1)
    }, 120_000).unref?.()
  }
  // 错误呈现取证（M4-2）也一样
  if (!app.isPackaged && process.env.SOCUT_SHOT_ERROR) {
    setTimeout(() => {
      console.log('✗ 错误呈现取证超时未产出报告（120s）')
      void log('error', '错误呈现取证超时未产出报告')
      app.exit(1)
    }, 120_000).unref?.()
  }

  // 启动清理：崩溃遗留的临时目录
  const swept = await sweepStaleWorkspaces()

  const cli = await ensureCliServer()
  registerIpc(engine, cli)
  const window = createMainWindow({ hidden: cliOnly })
  window.setTitle(WINDOW_TITLE)
  window.webContents.on('did-start-loading', () => cli?.notifyRendererGone())
  window.on('closed', () => cli?.notifyRendererGone())

  const binaries = await resolveFfmpegBinaries()
  await log(
    'info',
    `启动 Socut ${APP_VERSION}｜Electron ${process.versions.electron}｜Chromium ${process.versions.chrome}｜` +
      `FFmpeg ${binaries.source} (${binaries.ffmpeg})｜渲染显卡偏好 ${appliedGpuPreference}｜清理残留临时目录 ${swept} 个`
  )
  if (binaries.hint) await log('warn', binaries.hint)
  if (!binaries.available) await log('error', `FFmpeg 不可用：${binaries.ffmpeg}`)

  await maybeCaptureUiShot(window)
}

/**
 * 开发专用的 UI 取证截图（SOCUT_SHOT=<png 路径>）。
 * 无人值守环境里屏幕为黑（非交互式会话），所以只能走 Chromium 自己的
 * capturePage 拿真实绘制结果；打包版本一律忽略。
 */
async function maybeCaptureUiShot(window: BrowserWindow): Promise<void> {
  const target = process.env.SOCUT_SHOT
  if (!target || app.isPackaged) return
  // 等字体注册 + 首帧预览绘制完成（与 useFontLoader/预览循环的实际耗时对齐）
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SOCUT_SHOT_DELAY_MS ?? 8000)))
  try {
    const image = await window.webContents.capturePage()
    await fs.writeFile(target, image.toPNG())
    await log('info', `UI 取证截图已写入 ${target}（${image.getSize().width}x${image.getSize().height}）`)
    console.log(`✓ UI 取证截图：${target}`)
  } catch (error) {
    await log('error', `UI 截图失败：${String(error)}`)
    console.log(`✗ UI 截图失败：${String(error)}`)
  } finally {
    app.exit(0)
  }
}

// ---------------------------------------------------------------------------
// 退出纪律（规格 §11：应用退出前统一清理子进程与临时文件）
// ---------------------------------------------------------------------------

let cleaning = false

async function cleanup(reason: string): Promise<void> {
  if (cleaning) return
  cleaning = true
  try {
    // 先等自动存档落盘：渲染侧 beforeunload 补发的最后一笔可能还在 IPC/写入队列里，
    // 直接 app.exit 会把它打断（规格 §4.6：关闭程序不丢编辑进度）
    await cliServer?.stop()
    cliServer = null
    await flushPendingAutosave()
    await engine.shutdown()
    const killed = await terminateAll()
    await fs.rm(tempRoot(), { recursive: true, force: true }).catch(() => undefined)
    await log('info', `${reason}：已回收 ${killed} 个子进程并清空临时目录`)
  } catch (error) {
    await log('error', `${reason} 清理异常：${String(error)}`)
  }
}

app.on('window-all-closed', () => {
  // Windows 桌面工具：关窗即退（短期不规划 macOS）
  app.quit()
})

app.on('before-quit', (event) => {
  if (cleaning) return
  event.preventDefault()
  void cleanup('before-quit').then(() => app.exit(0))
})

process.on('exit', () => {
  // 最后一道防线：同步阶段无法 await，真正的回收在 before-quit 完成
  void log('info', '进程退出')
})

process.on('uncaughtException', (error) => {
  void log('error', `未捕获异常：${error.stack ?? error.message}`)
})

process.on('unhandledRejection', (reason) => {
  void log('error', `未处理的 Promise 拒绝：${String(reason)}`)
})
