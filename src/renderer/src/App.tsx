import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  DEFAULT_CLIP_DURATION_SEC,
  FPS_PRESETS,
  RESOLUTION_PRESETS,
  fpsToRatio,
  fpsToString
} from '@shared/constants'
import { createClip, createDefaultProject, normalizeProject } from '@shared/projectSchema'
import { secondsToTimecode } from '@shared/timecode'
import { TEXT } from '@shared/i18n'
import type { AppInfo } from '@shared/api'
import { attachFrameSource } from './render/frameSource'
import { bindJobEvents } from './state/jobEvents'
import { useProjectStore } from './state/projectStore'
import { useUiStore } from './state/uiStore'
import { useExportStore } from './state/exportStore'
import { usePreviewSpec } from './hooks/usePreviewSpec'
import { useProjectAutosave } from './hooks/useProjectAutosave'
import { runAppSmoke } from './smoke/runAppSmoke'
import { renderReviewSheet } from './smoke/renderReviewSheet'
import { runPixelParityCheck } from './smoke/runPixelParityCheck'
import { runErrorDemo } from './smoke/runErrorDemo'
import { runVisualCheck } from './smoke/runVisualCheck'
import { ensureFontRegistered } from './hooks/useFontLoader'
import { askConfirm } from './dialog/ask'
import { PreviewStage } from './components/PreviewStage'
import { InfoBar } from './components/ui/InfoBar'
import { ClipInspector } from './panels/ClipInspector'
import { RefVideoPanel } from './panels/RefVideoPanel'
import { ExportPanel } from './panels/ExportPanel'
import { LastResultPanel, ProgressPanel } from './panels/ProgressPanel'
import { Timeline } from './timeline/Timeline'
import { useRefVideoIntegrity } from './hooks/useRefVideoIntegrity'
import { FontLoadingOverlay } from './dialog/FontLoadingOverlay'
import { CompatModal } from './dialog/CompatModal'

/**
 * 主界面（WinUI 3 / Fluent）：标题栏 + 命令栏 + 左侧素材/导出 + 中央预览 + 右侧字幕条检查器 + 时间轴。
 * 默认基础模式，只暴露高频入口；配色、字体、动画、编码与工程分辨率等低频项收进高级模式。
 */

export function App(): ReactElement {
  const project = useProjectStore((state) => state.project)
  const setProject = useProjectStore((state) => state.loadProject)
  const setResolution = useProjectStore((state) => state.setResolution)
  const setFps = useProjectStore((state) => state.setFps)
  const setFonts = useProjectStore((state) => state.setFonts)

  const playing = useUiStore((state) => state.playing)
  const setPlaying = useUiStore((state) => state.setPlaying)
  const toggleSafeArea = useUiStore((state) => state.toggleSafeArea)
  const showSafeArea = useUiStore((state) => state.showSafeArea)
  const displayTime = useUiStore((state) => state.displayTimeSec)
  const uiMode = useUiStore((state) => state.uiMode)
  const setUiMode = useUiStore((state) => state.setUiMode)
  const fontLoading = useUiStore((state) => state.fontLoadingCount) > 0
  const notice = useUiStore((state) => state.notice)
  const setNotice = useUiStore((state) => state.setNotice)

  const busy = useExportStore((state) => state.busy)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  const { spec, error } = usePreviewSpec()
  useProjectAutosave()
  // 规格 §8：参考视频被移动/删除时提示重新定位（而不是等到导出才报错）
  useRefVideoIntegrity()

  const seekRef = useRef<((sec: number) => void) | null>(null)
  const seekTo = useCallback((sec: number): void => {
    seekRef.current?.(sec)
  }, [])

  const registerHandle = useCallback((handle: { seekTime: (sec: number) => void; seekFrame: (f: number) => void }) => {
    seekRef.current = handle.seekTime
  }, [])

  // 帧通道与任务事件：一次订阅
  useEffect(() => {
    const offSource = attachFrameSource()
    const offEvents = bindJobEvents()
    return () => {
      offSource()
      offEvents()
    }
  }, [])

  // 启动：应用信息 → 字体库 → 自动存档恢复询问
  useEffect(() => {
    const boot = async (): Promise<void> => {
      try {
        const info = await window.focusnews.app.info()
        setAppInfo(info)
        if (info.presetIssues.length > 0) {
          setBootError(`预设校验问题 ${info.presetIssues.length} 条：${info.presetIssues[0] ?? ''}`)
        }
        setFonts(await window.focusnews.fonts.list())
        if (info.visualCheck) {
          // 视觉检查：先用生产渲染路径出图 + 指标，再由主进程按报告 passed 退出
          const fontIndex = await window.focusnews.fonts.list()
          for (const record of fontIndex) {
            try {
              await ensureFontRegistered(record)
            } catch {
              // 单只字体缺失不阻断出图（缺失字体会在报告里体现为度量偏小）
            }
          }
          const report = await runVisualCheck({ reportPath: info.visualCheck, fontIndex })
          await window.focusnews.app.writeLog(
            'info',
            `视觉检查：${report.cases.length} 例 / ${report.structures} 种结构 · ${report.passed ? '全部通过' : `${report.failures} 项未通过`}`
          )
          console.log(report.passed ? '✓ 视觉检查通过' : '✗ 视觉检查未通过', report.failures)
          return
        }
        if (info.smoke) {
          // 开发专用的端到端冒烟（FOCUSNEWS_SMOKE=1）：跑完由主进程校验并退出
          void runAppSmoke(info.smoke).catch(async (error: unknown) => {
            // 必须落盘：否则冒烟卡住时看不到任何原因
            await window.focusnews.app.writeLog('error', `冒烟异常：${String(error)}`)
            console.error('冒烟异常', error)
          })
          return
        }
        if (info.reviewSheet) {
          // 开发专用：逐帧动画评审表（M4-7）。字体必须先注册完，否则 Canvas 回落默认字形会让评审失真。
          const fontIndex = await window.focusnews.fonts.list()
          for (const record of fontIndex) {
            try {
              await ensureFontRegistered(record)
            } catch {
              // 单只字体缺失不阻断评审表
            }
          }
          let backdropBytes: ArrayBuffer | null = null
          if (info.reviewBackdrop) {
            const bytes = await window.focusnews.app.readFileDev(info.reviewBackdrop)
            backdropBytes = bytes ? (new Uint8Array(bytes).buffer as ArrayBuffer) : null
          }
          const summary = await renderReviewSheet({
            outputPath: info.reviewSheet,
            fontIndex,
            backdropBytes
          })
          await window.focusnews.app.writeLog(
            'info',
            `逐帧动画评审表：${summary.presets} 预设 × ${summary.columns} 关键帧 · ${summary.sheetWidth}×${summary.sheetHeight} · ${summary.bytesWritten}B`
          )
          console.log('✓ 逐帧动画评审表已生成', summary)
          return
        }
        if (info.pixelCheck) {
          // 开发专用：M1-7 的逐像素比对（主进程把报告里的 passed 翻译成退出码）
          const report = await runPixelParityCheck({ outputPath: info.pixelCheck })
          await window.focusnews.app.writeLog(
            report.passed ? 'info' : 'error',
            `像素一致性回归：${report.frames.length} 帧 · ${report.passed ? '全部一致' : report.failures.join('; ')}`
          )
          console.log(report.passed ? '✓ 像素一致性回归通过' : '✗ 像素一致性回归失败', report.failures)
          return
        }
        if (info.errorDemo) {
          // 错误呈现取证（M4-2）：发起一次必然失败的导出，然后断言失败面板的数据源里
          // 确实带上了完整命令行（规格 §9）。不走自动存档恢复弹窗，以免盖住面板。
          const fontIndex = await window.focusnews.fonts.list()
          const demo = await runErrorDemo(fontIndex)
          const demoFailures: string[] = []
          if (demo.ok) demoFailures.push('导出本应失败，实际却成功了')
          if (demo.argvSegments === 0) demoFailures.push('错误里没有 argv，失败面板无法展示完整命令行')
          if (!demo.argvHasBinary) demoFailures.push('argv 首段不是 ffmpeg 二进制路径')
          if (demo.stderrTailBytes === 0) demoFailures.push('错误里没有 stderr 尾部')
          if (!demo.panelSeesSameResult) demoFailures.push('失败面板的 store 与结果不一致')
          const payload = new TextEncoder().encode(
            `${JSON.stringify({ generatedAt: new Date().toISOString(), ...demo, passed: demoFailures.length === 0, failures: demoFailures }, null, 2)}\n`
          )
          await window.focusnews.app.writeFileDev(info.errorDemo, payload)
          console.log(demoFailures.length === 0 ? '✓ 错误呈现取证通过' : '✗ 错误呈现取证失败', demoFailures)
          return
        }
        if (info.refMissingDemo) {
          // 取证（规格 §8）：借用真实夹具的元数据，但把路径指向不存在的文件，
          // 让 useRefVideoIntegrity 弹出「重新定位」模态，再由 FOCUSNEWS_SHOT 截图。
          const probe = await window.focusnews.video.probe(info.refMissingDemo)
          if (probe) {
            const demoProject = createDefaultProject('ref-missing-demo')
            const missingPath = `${info.refMissingDemo}.missing.mp4`
            const clip = createClip({ startTime: 0, fps: demoProject.fps })
            clip.content = { title: '参考视频已不可用', subtitle: '叠加导出应被禁用而不是等到 FFmpeg 报错' }
            demoProject.clips = [clip]
            demoProject.refVideo = {
              path: missingPath,
              meta: { ...probe.meta, path: missingPath },
              non169Ack: true,
              hdrAck: true,
              vfrPolicy: 'none',
              compactMode: 'auto',
              importedAt: new Date().toISOString()
            }
            setProject(demoProject)
          }
          return
        }
        const saved = await window.focusnews.project.autosaveRead()
        if (saved && saved.clips.length > 0) {
          const ok = await askConfirm(TEXT.project.newProject, TEXT.project.restoreAutosave, '恢复')
          if (ok) setProject(normalizeProject(saved) ?? saved)
        }
      } catch (bootFailure) {
        setBootError(String(bootFailure))
      }
    }
    void boot()
  }, [setFonts, setProject])

  const resolutionKey = useMemo(() => {
    const match = RESOLUTION_PRESETS.find(
      (preset) =>
        preset.resolution.width === project.resolution.width && preset.resolution.height === project.resolution.height
    )
    return match?.key ?? 'custom'
  }, [project.resolution])

  const fpsKey = useMemo(() => {
    const match = FPS_PRESETS.find((preset) => preset.fps.num === project.fps.num && preset.fps.den === project.fps.den)
    return match?.key ?? 'custom'
  }, [project.fps])

  const lastClipEnd = project.clips.reduce((acc, clip) => Math.max(acc, clip.endTime), 0)
  const banner = error ?? bootError ?? notice

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar__identity">
          <span className="brandmark" aria-hidden="true">
            FN
          </span>
          <span className="titlebar__titles">
            <span className="titlebar__app">FocusNews</span>
            <span className="titlebar__project" title={project.name}>
              {project.name || '未命名工程'}
            </span>
          </span>
        </div>

        <div className="titlebar__center">
          {uiMode === 'advanced' ? (
            <>
              <label className="inline-field">
                <span className="muted">分辨率</span>
                <select
                  className="select select--compact"
                  value={resolutionKey}
                  onChange={(event) => {
                    const preset = RESOLUTION_PRESETS.find((item) => item.key === event.target.value)
                    if (preset) setResolution(preset.resolution.width, preset.resolution.height)
                  }}
                >
                  {RESOLUTION_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.note}
                    </option>
                  ))}
                  <option value="custom">自定义</option>
                </select>
              </label>
              <label className="inline-field">
                <span className="muted">帧率</span>
                <select
                  className="select select--compact"
                  value={fpsKey}
                  onChange={(event) => {
                    const preset = FPS_PRESETS.find((item) => item.key === event.target.value)
                    if (preset) setFps(preset.fps)
                  }}
                >
                  {FPS_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="custom">自定义</option>
                </select>
              </label>
            </>
          ) : (
            <span className="chip mono titlebar__project-chip">
              {project.resolution.width}×{project.resolution.height} · {fpsToString(project.fps)}
            </span>
          )}
        </div>

        <div className="titlebar__actions">
          <div className="segmented" role="group" aria-label="界面模式">
            <button
              type="button"
              className={`segmented__item${uiMode === 'basic' ? ' segmented__item--active' : ''}`}
              aria-pressed={uiMode === 'basic'}
              title="基础模式：只显示常用入口"
              onClick={() => setUiMode('basic')}
            >
              基础
            </button>
            <button
              type="button"
              className={`segmented__item${uiMode === 'advanced' ? ' segmented__item--active' : ''}`}
              aria-pressed={uiMode === 'advanced'}
              title="高级模式：配色、字体、动画与编码选项"
              onClick={() => setUiMode('advanced')}
            >
              高级
            </button>
          </div>
          <span className="titlebar__divider" aria-hidden="true" />
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            onClick={async () => {
              const loaded = await window.focusnews.project.open()
              if (loaded) setProject(loaded.project, loaded.path)
            }}
          >
            {TEXT.project.open}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            onClick={async () => {
              const saved = await window.focusnews.project.saveAs(project)
              if (saved) setNotice(`${TEXT.project.saveAs}：${saved.path}`)
            }}
          >
            {TEXT.project.saveAs}
          </button>
        </div>
      </header>

      {banner ? (
        <div className="banner-stack">
          {error ? <InfoBar tone="error" message={`预览：${error}`} /> : null}
          {bootError ? (
            <InfoBar
              tone="error"
              message={bootError}
              onDismiss={() => setBootError(null)}
              dismissLabel="忽略"
            />
          ) : null}
          {notice ? (
            <InfoBar
              tone="info"
              message={notice}
              onDismiss={() => setNotice(null)}
              dismissLabel="忽略"
            />
          ) : null}
        </div>
      ) : null}

      <div className="body">
        {/* 左侧：素材与导出（与「当前字幕条」无关的全局操作） */}
        <aside className="rail">
          <RefVideoPanel />
          <ExportPanel spec={spec} fontLoading={fontLoading} ffmpegAvailable={appInfo?.ffmpegAvailable ?? false} />
          <ProgressPanel />
          <LastResultPanel />
        </aside>

        <main className="stage">
          <PreviewStage spec={spec} onHandle={registerHandle} />
          <div className="transport">
            <div className="transport__group">
              <button
                type="button"
                className="iconbtn iconbtn--accent"
                aria-label={playing ? TEXT.preview.pause : TEXT.preview.play}
                title={playing ? TEXT.preview.pause : TEXT.preview.play}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <button type="button" className="iconbtn" aria-label="回到起点" title="回到起点" onClick={() => seekTo(0)}>
                ⏮
              </button>
              <button
                type="button"
                className="iconbtn"
                aria-label="跳到末尾"
                title="跳到末尾"
                onClick={() => seekTo(Math.max(0, lastClipEnd - DEFAULT_CLIP_DURATION_SEC / 2))}
              >
                ⏭
              </button>
            </div>
            <span className="timecode mono">{secondsToTimecode(displayTime, project.fps)}</span>
            <span className="transport__spacer" />
            <label className="switch">
              <input type="checkbox" checked={showSafeArea} onChange={toggleSafeArea} />
              <span>{TEXT.preview.safeArea}</span>
            </label>
          </div>
        </main>

        {/* 右侧：当前字幕条的检查器（时间轴点选 / 预览点字幕条都会落到这里） */}
        <aside className="inspector-dock">
          <ClipInspector />
        </aside>
      </div>

      <footer className="timeline-dock">
        <Timeline seekTo={seekTo} />
      </footer>

      <div className="statusbar">
        <span className="mono">FocusNews {appInfo?.version ?? ''}</span>
        <span className="muted mono">{appInfo ? appInfo.ffmpegSource : 'FFmpeg 检测中…'}</span>
        <span className="muted mono">
          {project.resolution.width}×{project.resolution.height} · {fpsToString(project.fps)} ·{' '}
          {fpsToRatio(project.fps).toFixed(3)}
        </span>
        <span className="statusbar__spacer" />
        <span className="chip chip--accent">{uiMode === 'advanced' ? '高级模式' : '基础模式'}</span>
        {busy ? <span className="chip chip--warn">导出中…</span> : null}
        {appInfo && !appInfo.ffmpegAvailable ? <span className="chip chip--danger">FFmpeg 缺失</span> : null}
      </div>

      <CompatModal />
      {/* 规格 §4.5：大字体加载遮罩（之前组件存在但从未被挂载，用户看不到任何加载指示） */}
      <FontLoadingOverlay />
    </div>
  )
}
