import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  DEFAULT_CLIP_DURATION_SEC,
  FPS_PRESETS,
  RESOLUTION_PRESETS,
  fpsToString
} from '@shared/constants'
import { createClip, createDefaultProject, LEFT_TABS } from '@shared/projectSchema'
import { frameTimeSec, stepLocalFrame } from '@shared/fps'
import { secondsToTimecode } from '@shared/timecode'
import { timelineContentEndSec } from '@shared/presetResolver'
import { mediaKindOf } from '@shared/audioClips'
import { projectHasProgress } from '@shared/recentProjects'
import { TEXT } from '@shared/i18n'
import type { AppInfo } from '@shared/api'
import { attachFrameSource } from './render/frameSource'
import { bindJobEvents } from './state/jobEvents'
import { useProjectStore } from './state/projectStore'
import { useUiStore } from './state/uiStore'
import { useExportStore } from './state/exportStore'
import { usePreviewSpec } from './hooks/usePreviewSpec'
import { useTransportKeys, isEditableTarget } from './hooks/useTransportKeys'
import { useEditKeys } from './hooks/useEditKeys'
import { attachProjectHistory, useHistoryStore } from './state/projectHistory'
import { useProjectAutosave } from './hooks/useProjectAutosave'
import { runAppSmoke } from './smoke/runAppSmoke'
import { renderReviewSheet } from './smoke/renderReviewSheet'
import { runPixelParityCheck } from './smoke/runPixelParityCheck'
import { runErrorDemo } from './smoke/runErrorDemo'
import { runVisualCheck } from './smoke/runVisualCheck'
import { ensureFontRegistered } from './hooks/useFontLoader'
import { PreviewStage, type StageSeekHandle } from './components/PreviewStage'
import { RecentProjectsPage } from './launcher/RecentProjectsPage'
import { SettingsPage } from './settings/SettingsPage'
import { captureCurrentCover } from './launcher/cover'
import { useRecentProjectsStore } from './state/recentProjectsStore'
import { InfoBar } from './components/ui/InfoBar'
import { Splitter } from './components/ui/Splitter'
import { usePaneLayout } from './layout/usePaneLayout'
import { ClipInspector } from './panels/ClipInspector'
import { ExportPanel } from './panels/ExportPanel'
import { LastResultPanel, ProgressPanel } from './panels/ProgressPanel'
import { Timeline } from './timeline/Timeline'
import { useMediaIntegrity } from './hooks/useMediaIntegrity'
import { FontLoadingOverlay } from './dialog/FontLoadingOverlay'
import { CompatModal } from './dialog/CompatModal'
import { MediaLibraryPanel } from './panels/MediaLibraryPanel'
import { WrapPanel } from './panels/WrapPanel'
import type { LeftTabValue, Project } from '@shared/types'

/** 自动存档里是否有值得恢复的编辑进度：字幕/媒体/音频任一轨有内容，或水印已启用 */
export function hasRestoreProgress(project: Project): boolean {
  return projectHasProgress(project)
}

/**
 * 主界面（WinUI 3 / Fluent）：标题栏 + 命令栏 + 左侧 Tab 壳（素材库/包装/导出/进度） + 中央预览 + 右侧字幕条检查器 + 双轨时间轴。
 * 默认基础模式，只暴露高频入口；配色、字体、动画、编码与工程分辨率等低频项收进高级模式。
 * v2：左侧不再堆叠三块面板，同一时刻只展开当前 Tab；选中项写回 project.ui.leftTab 持久化。
 * v3：四条区域之间的三条分隔线可拖拽（usePaneLayout + Splitter），比例存本机 localStorage，冷启动恢复。
 * v4：左侧新增「字幕」Tab（按时间顺序的标题列表，点击 = 选中 + 跳到入点）；时间轴字幕轨改为窄示意条。
 * v10（P6）：字幕与水印合并成「包装」，片尾只做占位，左侧只剩四个 Tab；Tab 清单取自
 * shared 的 LEFT_TABS，旧工程里的 'captions' / 'watermark' 在 normalizeProject 里已迁到 'wrap'。
 */

/** 左侧 Tab 的显示名（顺序取 LEFT_TABS，不另写一份清单） */
const RAIL_LABELS: Record<LeftTabValue, string> = {
  media: '素材库',
  wrap: TEXT.wrap.tab,
  export: '导出',
  progress: '进度'
}

export function App(): ReactElement {
  const project = useProjectStore((state) => state.project)
  const setProject = useProjectStore((state) => state.loadProject)
  const setResolution = useProjectStore((state) => state.setResolution)
  const setFps = useProjectStore((state) => state.setFps)

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
  const leftTab = useUiStore((state) => state.leftTab)
  const setLeftTab = useUiStore((state) => state.setLeftTab)
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)

  const busy = useExportStore((state) => state.busy)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  // 伸缩布局：三条分隔线各自治理一个区域（左栏宽 / 右栏宽 / 时间轴高）
  const layout = usePaneLayout()

  const { spec, error } = usePreviewSpec()
  useProjectAutosave()
  // 规格 §8（v2 枚级）：素材池里的文件被移动/删除时提示重新定位（而不是等到导出才报错）
  useMediaIntegrity()

  /**
   * 预览句柄（时间轴定位 + 键盘逐帧跳转共用）：PreviewStage 每次渲染补登一次，
   * 所以 totalFrames / currentFrame 取到的都是当前规格下的读数。
   */
  const stageRef = useRef<StageSeekHandle | null>(null)
  const setDisplayTime = useUiStore((state) => state.setDisplayTime)
  const seekTo = useCallback(
    (sec: number): void => {
      // 播放头不是「无限长」的：最多到最后一个媒体/字幕/音频段的末尾（空工程 = 0s）。
      // 轨道本身可以更宽（方便往后拖新段），但定位永远停在有内容的地方。
      const contentEnd = timelineContentEndSec(useProjectStore.getState().project)
      const clamped = Math.min(Math.max(0, sec), contentEnd)
      stageRef.current?.seekTime(clamped)
      // 拖拽刮擦时同步 UI 时间文本：预览循环是节流的，不等它才能让时间码/播放头即刻跟随
      setDisplayTime(clamped)
    },
    [setDisplayTime]
  )

  /**
   * 素材库「放到播放头」：媒体进媒体轨、音频进音频轨，落点被占时由 store 顺延到空档。
   * 播放头已经夹在内容末尾内，所以这里不需要再夹（但空工程时就是 0s，正好落在开头）。
   */
  const placeMediaAtPlayhead = useCallback((mediaId: string): void => {
    const store = useProjectStore.getState()
    const item = store.project.media.find((m) => m.id === mediaId)
    if (!item) return
    const atSec = Math.min(useUiStore.getState().displayTimeSec, timelineContentEndSec(store.project))
    if (mediaKindOf(item) === 'audio') {
      store.insertAudioClip({ mediaId, timelineStartSec: atSec, durationSec: item.meta.durationSec })
      return
    }
    store.insertMediaClip({ mediaId, timelineStartSec: atSec, durationSec: item.meta.durationSec, sourceInSec: 0 })
  }, [])

  const registerHandle = useCallback((handle: StageSeekHandle): void => {
    stageRef.current = handle
  }, [])

  /**
   * 项目级撤销/重做记账（P1）：挂上工程 store 的订阅，本次启动轮次内最多 100 步。
   * 启动恢复自动存档发生在订阅之后，它走 loadProject（换工程）路径，
   * 记账侧看到 projectEpoch 变了会清空历史，所以恢复不会留下一条“可撤销”的步骤。
   */
  useEffect(() => attachProjectHistory(), [])

  useEditKeys({
    undo: () => useHistoryStore.getState().undo(),
    redo: () => useHistoryStore.getState().redo()
  })

  /**
   * 把播放头跳转能力交给 uiStore：样式面板（配色/字体/动画/预设）改完参数后
   * 用它把播放头落到「能看清当前样式」的帧上，避免预览看着没反应（片段入点在别处时）。
   */
  useEffect(() => {
    useUiStore.getState().setSeekHandler(seekTo)
    return () => useUiStore.getState().setSeekHandler(null)
  }, [seekTo])

  /**
   * 逐帧跳转（← / →，长按连跳）：帧号取预览时钟的真实当前帧——
   * UI 时间文本是 100ms 节流值，拿它折算会差好几帧。落点夹在总帧数内（到头停住、不回绕），
   * 并且先接管播放时钟：播放中不暂停的话，跳完这一帧立刻被时钟带走，等于没跳。
   */
  const stepFrame = useCallback(
    (deltaFrames: number): void => {
      const stage = stageRef.current
      if (!stage || !spec) return
      const ui = useUiStore.getState()
      if (ui.playing) ui.setPlaying(false)
      // currentFrame() 是绝对帧号，减去工程起点才是预览循环用的相对帧
      const local = stepLocalFrame(stage.currentFrame() - spec.startFrame, deltaFrames, stage.totalFrames)
      seekTo(frameTimeSec(local, spec.fps))
    },
    [seekTo, spec]
  )

  // 空格播放/暂停 + 方向键逐帧（长按连跳）：焦点在输入框或门禁弹窗排队中自动让位
  useTransportKeys({
    togglePlay: () => {
      const ui = useUiStore.getState()
      ui.setPlaying(!ui.playing)
    },
    stepFrame
  })

  /**
   * 快捷键（阶段 6，P3 改成走统一目标解析）：
   * - Ctrl/Cmd+B：拆「当前该操作的那一段」（选中优先，未选中拆播放头处的媒体段）；
   * - Delete：删「当前选中的那一段」（三类段都算）。Delete 不做「未选中退到播放头」的兼容，
   *   一个键盘就能删掉用户没打算动的段太危疑；工具栏的删除才走完整默认解析。
   * 输入控件里不拦：文本框内的 Ctrl+B（如浏览器式加粗）不得被抢走。
   * 空格与方向键在 `useTransportKeys` 里，共用同一条 `isEditableTarget` 判据。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const inField = isEditableTarget(event.target)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !inField) {
        event.preventDefault()
        const ui = useUiStore.getState()
        if (ui.playing) ui.setPlaying(false)
        // P4：黄线（预览轴）在的时候，拆分以它指向的那一帧为准，蓝线位置不变
        const atSec = ui.hoverPreviewSec ?? ui.displayTimeSec
        if (!useProjectStore.getState().splitTargetAt(atSec)) ui.setNotice(TEXT.timeline.noSplitTarget)
        return
      }
      if (event.key === 'Delete' && !inField) {
        // 只删选中的那一段（不退到播放头默认解析）：没选中时 Delete 保持安静
        if (!useProjectStore.getState().removeSelected()) return
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * leftTab 持久化（阶段 9）：uiStore 是真值，工程里的快照只在分叉时补写；
   * 自动保存因此能记住上次离开左侧栏的位置（冷启动仍默认素材库，见 uiStore 初始态）。
   */
  useEffect(() => {
    // 启动页不该为了一个编辑器面板偏好去推 revision（否则冷启动会写一份空草稿）
    if (view !== 'editor') return
    if (project.ui?.leftTab === leftTab) return
    useProjectStore.setState((state) => ({
      project: { ...state.project, ui: { ...(state.project.ui ?? {}), leftTab } },
      revision: state.revision + 1
    }))
  }, [leftTab, project.ui?.leftTab, view])

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
        /**
         * 开发取证分支（冒烟 / 视觉检查 / 评审表 / 像素回归 / 错误与缺失取证）
         * 都必须直接落在编辑器：它们不经过用户点击，启动页会挡住取证目标。
         */
        const specialBoot = Boolean(
          info.visualCheck ||
            info.smoke ||
            info.reviewSheet ||
            info.pixelCheck ||
            info.errorDemo ||
            info.refMissingDemo
        )
        if (specialBoot) useUiStore.getState().setView('editor')
        if (info.presetIssues.length > 0) {
          setBootError(`预设校验问题 ${info.presetIssues.length} 条：${info.presetIssues[0] ?? ''}`)
        }
        // 直接写字体库而不走 setFonts：后者会推 revision，冷启动会因此自动保存一份空工程
        useProjectStore.setState({ fonts: await window.focusnews.fonts.list() })
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
            // 取证目标是「完整性检查弹出重新定位模态 + 导出面板禁用」，直接落在导出 Tab
            useUiStore.getState().setLeftTab('export')
          }
          return
        }
        // 正常启动：落在启动页，不读自动存档。
        // 草稿只在用户从最近列表主动打开时恢复（避免启动页被旧工程顶掉）。
        useUiStore.getState().setView('launcher')
        void useRecentProjectsStore.getState().refresh()
      } catch (bootFailure) {
        setBootError(String(bootFailure))
      }
    }
    void boot()
  }, [setProject])

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

  // ---------------------------------------------------------------- 启动页动作

  const handleOpenRecent = useCallback(
    async (id: string): Promise<void> => {
      try {
        const opened = await window.focusnews.project.openRecent(id)
        if (!opened) {
          setNotice('工程文件已丢失或无法读取')
          void useRecentProjectsStore.getState().refresh()
          return
        }
        setProject(opened.project, opened.path, opened.entryId)
        setView('editor')
        void useRecentProjectsStore.getState().refresh()
      } catch (failure) {
        setNotice(`打开工程失败：${String(failure)}`)
      }
    },
    [setNotice, setProject, setView]
  )

  const handleCreate = useCallback(async (): Promise<void> => {
    try {
      const created = await window.focusnews.project.createNew()
      setProject(created.project, created.entry.filePath ?? undefined, created.entry.id)
      setView('editor')
      void useRecentProjectsStore.getState().refresh()
      setNotice(`已新建工程：${created.project.name}`)
    } catch (failure) {
      setNotice(`新建工程失败：${String(failure)}`)
    }
  }, [setNotice, setProject, setView])

  const handleBrowse = useCallback(async (): Promise<void> => {
    try {
      const opened = await window.focusnews.project.open()
      if (!opened) return
      setProject(opened.project, opened.path, opened.entryId)
      setView('editor')
      void useRecentProjectsStore.getState().refresh()
    } catch (failure) {
      setNotice(`打开工程失败：${String(failure)}`)
    }
  }, [setNotice, setProject, setView])

  /**
   * 回到启动页：先暂停播放、趁 `.stage__frame` 还挂载时补拍封面，再切视图。
   * 不清空工程——用户从启动页再点回来时应看到刚才的编辑现场。
   */
  const handleBackToLauncher = useCallback(async (): Promise<void> => {
    setPlaying(false)
    await captureCurrentCover(useProjectStore.getState().currentEntryId)
    setView('launcher')
    await useRecentProjectsStore.getState().refresh()
  }, [setPlaying, setView])

  /** 另存为：主进程返回新路径/entryId，当前工程从此按新身份自动保存与拍封面。 */
  const handleSaveAs = useCallback(async (): Promise<void> => {
    try {
      const saved = await window.focusnews.project.saveAs(useProjectStore.getState().project)
      if (!saved) return
      useProjectStore.getState().adoptSavedEntry(saved.path, saved.entryId)
      setNotice(`${TEXT.project.saveAs}：${saved.path}`)
      await captureCurrentCover(saved.entryId)
      void useRecentProjectsStore.getState().refresh()
    } catch (failure) {
      setNotice(`另存为失败：${String(failure)}`)
    }
  }, [setNotice])

  /** 标题栏「打开」：打开成功同样接住 entryId，后续自动保存记到同一条最近记录。 */
  const handleOpenProject = useCallback(async (): Promise<void> => {
    try {
      const opened = await window.focusnews.project.open()
      if (!opened) return
      setProject(opened.project, opened.path, opened.entryId)
      void useRecentProjectsStore.getState().refresh()
    } catch (failure) {
      setNotice(`打开工程失败：${String(failure)}`)
    }
  }, [setNotice, setProject])

  return (
    <>
      {view === 'settings' ? (
        <SettingsPage onBack={() => setView('launcher')} appVersion={appInfo?.version ?? ''} />
      ) : view === 'launcher' ? (
        <RecentProjectsPage
          appVersion={appInfo?.version ?? ''}
          onOpen={handleOpenRecent}
          onCreate={handleCreate}
          onBrowse={handleBrowse}
          onOpenSettings={() => setView('settings')}
        />
      ) : (
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
              title="只显示常用入口"
              onClick={() => setUiMode('basic')}
            >
              基础
            </button>
            <button
              type="button"
              className={`segmented__item${uiMode === 'advanced' ? ' segmented__item--active' : ''}`}
              aria-pressed={uiMode === 'advanced'}
              title="配色、字体、动画与编码选项"
              onClick={() => setUiMode('advanced')}
            >
              高级
            </button>
          </div>
          <span className="titlebar__divider" aria-hidden="true" />
          <button
            type="button"
            className="btn btn--sm btn--subtle"
            title="返回最近项目（先暂停播放并保存封面）"
            onClick={() => void handleBackToLauncher()}
          >
            最近项目
          </button>
          <button type="button" className="btn btn--sm btn--subtle" onClick={() => void handleOpenProject()}>
            {TEXT.project.open}
          </button>
          <button type="button" className="btn btn--sm btn--subtle" onClick={() => void handleSaveAs()}>
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

      <div className="shell" ref={layout.shellRef} style={layout.shellStyle}>
        <div className="body">
          {/* 左侧：Tab 壳（素材库 / 包装 / 导出 / 进度）——与「当前字幕条」无关的全局操作 */}
          <aside className="rail">
            <div className="rail__tabs" role="tablist" aria-label="左侧面板">
              {LEFT_TABS.map((tab) => {
                const badge =
                  tab === 'media'
                    ? project.media.length > 0
                      ? project.media.length
                      : null
                    : tab === 'wrap'
                      ? project.clips.length > 0
                        ? project.clips.length
                        : null
                      : tab === 'export' && busy
                        ? '●'
                        : null
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={leftTab === tab}
                    className={`rail__tab${leftTab === tab ? ' rail__tab--active' : ''}`}
                    onClick={() => setLeftTab(tab)}
                  >
                    {RAIL_LABELS[tab]}
                    {badge !== null ? (
                      <span className={`rail__tab-badge${tab === 'export' ? ' rail__tab-badge--busy' : ''}`}>{badge}</span>
                    ) : null}
                    {tab === 'wrap' && project.watermark?.enabled ? <span className="rail__tab-badge">●</span> : null}
                  </button>
                )
              })}
            </div>
            <div className="rail__panels">
              {leftTab === 'media' ? <MediaLibraryPanel onPlaceAtPlayhead={placeMediaAtPlayhead} /> : null}
              {leftTab === 'wrap' ? <WrapPanel /> : null}
              {leftTab === 'export' ? (
                <ExportPanel spec={spec} fontLoading={fontLoading} ffmpegAvailable={appInfo?.ffmpegAvailable ?? false} />
              ) : null}
              {leftTab === 'progress' ? (
                <>
                  <ProgressPanel />
                  <LastResultPanel />
                </>
              ) : null}
            </div>
          </aside>

          <Splitter {...layout.splitterProps('left')} />

          <main className="stage">
            <PreviewStage spec={spec} onHandle={registerHandle} />
            <div className="transport">
              <div className="transport__group">
                <button
                  type="button"
                  className="iconbtn"
                  aria-label="回到起点"
                  title="回到起点"
                  onClick={() => seekTo(0)}
                >
                  ⏮
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  aria-label="上一帧"
                  title="上一帧（←，按住连跳）"
                  onClick={() => stepFrame(-1)}
                >
                  |◀
                </button>
                <button
                  type="button"
                  className="iconbtn iconbtn--accent"
                  aria-label={playing ? TEXT.preview.pause : TEXT.preview.play}
                  title={`${playing ? TEXT.preview.pause : TEXT.preview.play}（空格）`}
                  onClick={() => setPlaying(!playing)}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  aria-label="下一帧"
                  title="下一帧（→，按住连跳）"
                  onClick={() => stepFrame(1)}
                >
                  ▶|
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

          <Splitter {...layout.splitterProps('right')} />

          {/* 右侧：当前字幕条的检查器（时间轴点选 / 预览点字幕条都会落到这里） */}
          <aside className="inspector-dock">
            <ClipInspector />
          </aside>
        </div>

        {/* 上边缘：同一条线同时改预览区高与时间轴高（两区共享总高，此消彼长） */}
        <Splitter {...layout.splitterProps('timeline')} />

        <footer className="timeline-dock">
          <Timeline seekTo={seekTo} />
        </footer>
      </div>

      <div className="statusbar">
        <span className="mono">FocusNews {appInfo?.version ?? ''}</span>
        <span className="muted mono">{appInfo ? appInfo.ffmpegSource : 'FFmpeg 检测中…'}</span>
        <span className="muted mono">
          {project.resolution.width}×{project.resolution.height} · {fpsToString(project.fps)}
        </span>
        <span className="statusbar__spacer" />
        {layout.ready ? (
          <span
            className="muted mono"
            title={`${TEXT.layout.labels.left} ${layout.sizes.left} · ${TEXT.layout.labels.center} ${layout.sizes.center} · ${TEXT.layout.labels.right} ${layout.sizes.right} · ${TEXT.layout.labels.stage} ${layout.sizes.stage} · ${TEXT.layout.labels.timeline} ${layout.sizes.timeline}`}
          >
            {layout.sizes.left} / {layout.sizes.right} / {layout.sizes.timeline}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn--sm btn--subtle"
          title={TEXT.layout.resetHint}
          onClick={layout.resetLayout}
        >
          {TEXT.layout.reset}
        </button>
        <span className="chip chip--accent">{uiMode === 'advanced' ? '高级模式' : '基础模式'}</span>
        {busy ? <span className="chip chip--warn">导出中…</span> : null}
        {appInfo && !appInfo.ffmpegAvailable ? <span className="chip chip--danger">FFmpeg 缺失</span> : null}
      </div>

      {/* 规格 §4.5：大字体加载遮罩（之前组件存在但从未被挂载，用户看不到任何加载指示） */}
      <FontLoadingOverlay />
        </div>
      )}
      {/* 启动页与编辑器共用同一个模态队列：askConfirm 在两边都能弹 */}
      <CompatModal />
    </>
  )
}
