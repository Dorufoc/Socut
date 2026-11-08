import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { frameIntervalSec, frameTimeSec } from '@shared/fps'
import type { RenderJobSpec } from '@shared/types'
import { NativeStage } from '../render/stage'
import { choosePreviewFrame, decidePreviewRender, type PreviewRenderState } from '../render/previewFrame'
import {
  formatPreviewPerfSummary,
  noteFrame,
  previewPerf,
  previewPerfSnapshot
} from '../render/previewPerf'

/**
 * 预览循环（规格 §4.3 / §11 纪律 6）。
 * 播放头由 performance.now() 累加时间后折算为帧号，不由 rAF 计数驱动，
 * 因此掉帧不会让时间轴漂移；绘制仍发生在 rAF。
 *
 * Task 2：rAF 每帧只做「是否要重画」的判定。帧号没变、尺寸/DPR/透明底都没变时整帧跳过，
 * 不再让 30fps 的工程在 60Hz 屏上做 60 次 1080P 全量软件光栅化。
 */

export interface PreviewArgs {
  canvasRef: RefObject<HTMLCanvasElement | null>
  spec: RenderJobSpec | null
  playing: boolean
  showSafeArea: boolean
  /** 有参考视频垫底时不再画棋盘格：让 Canvas 透明，视频从下层透出来 */
  transparent?: boolean
  /**
   * 高优先级透明开关：媒体层在 rAF 里同步写这个 ref，绘制循环同一帧就能读到，
   * 不必等 React re-render。切段时「视频已显示、Canvas 还画着棋盘格」的那一帧就是这样消掉的。
   */
  transparentRef?: RefObject<boolean>
  /**
   * P4：预览轴的悬停帧（相对工程起点的秒）。非空时**只换画哪一帧**，
   * 不回写 `onDisplayTime`，所以时间轴蓝线、时间码、逐帧跳转的基准全部留在原地。
   * 传 getter 而不是静态值：rAF 每帧现读，悬停换帧不必等 React 渲染。
   */
  getOverrideSec?: () => number | null
  /** UI 时间文本节流回调（不进高频 store） */
  onDisplayTime?: (sec: number) => void
  /**
   * 帧级播放头回调：只有真正在跟时钟（`reportDisplay === true`）且帧号变化时调用，
   * 给 `<Playhead>` 用。悬停接管期间不调用（蓝线必须留在播放头上）。
   */
  onPlayhead?: (sec: number) => void
  /**
   * 每帧回调（绝对时间轴秒 + 是否正在播放）：媒体预览层用它同步 `<video>`。
   * 在 Canvas 绘制之前调用，媒体层写透明 ref 后同一帧的 blit 就会用上新值。
   */
  onTick?: (timelineSec: number, playing: boolean) => void
  /**
   * 回绕通知：播放头跨过末尾、同时把 `elapsedSec` 折回 0 的那一帧调用一次，
   * 且在 `onTick` **之前**。媒体层用它把各 `<video>` 复位到入点，
   * 随后同一帧的 tick 就在 t=0 上重新选段，不会出现「回绕后画面还停在末尾」。
   */
  onLoop?: () => void
}

export interface PreviewHandle {
  currentFrame: () => number
  seekFrame: (frame: number) => void
  seekTime: (sec: number) => void
  totalFrames: number
}

const DISPLAY_TICK_MS = 100
/** dev 性能汇总窗口：5s 一次，避免刷屏淹没真正的告警 */
const PERF_LOG_INTERVAL_MS = 5000

export function usePreviewLoop(args: PreviewArgs): PreviewHandle {
  const stageRef = useRef<NativeStage | null>(null)
  const specRef = useRef<RenderJobSpec | null>(args.spec)
  const playingRef = useRef(args.playing)
  const safeRef = useRef(args.showSafeArea)
  // rAF 循环只建立一次：透明垫底态必须进 ref，否则取到的是首次渲染的旧值
  const transparentRef = useRef(args.transparent === true)
  /** 悬停帧 getter：rAF 每帧现读，不走 React 渲染 */
  const getOverrideRef = useRef(args.getOverrideSec)
  /** 上一帧的 override：变化时置 force（悬停换帧必须重画） */
  const lastOverrideRef = useRef<number | null>(null)
  const elapsedSecRef = useRef(0)
  const lastTsRef = useRef(0)
  const lastDisplayRef = useRef(0)
  const onDisplayRef = useRef(args.onDisplayTime)
  const onTickRef = useRef(args.onTick)
  const onLoopRef = useRef(args.onLoop)
  const onPlayheadRef = useRef(args.onPlayhead)
  /** 上次回调给 `<Playhead>` 的帧号：同帧不重复写 store */
  const lastPlayheadFrameRef = useRef<number | null>(null)
  /** 强制整帧出图：规格/安全区/悬停帧变化、画布挂载、ResizeObserver、seek 时置位 */
  const forceRef = useRef(true)
  /** 显示画布的 CSS 盒子：只在 ResizeObserver 回调里读，rAF 里不再做布局读取 */
  const cssSizeRef = useRef({ width: 0, height: 0 })
  /** 上一次真正参与判定的状态：用来跳过内容与上屏条件都没变的帧 */
  const lastStateRef = useRef<PreviewRenderState | null>(null)
  /** 画布换挂载时强制补画（旧位图在新元素上不存在） */
  const lastCanvasRef = useRef<HTMLCanvasElement | null>(null)

  specRef.current = args.spec
  playingRef.current = args.playing
  safeRef.current = args.showSafeArea
  transparentRef.current = args.transparent === true
  getOverrideRef.current = args.getOverrideSec
  onDisplayRef.current = args.onDisplayTime
  onTickRef.current = args.onTick
  onLoopRef.current = args.onLoop
  onPlayheadRef.current = args.onPlayhead

  // 规格 / 安全区变化：必须重画字幕层。
  // 透明底刻意不在这里置 force：它只影响「上屏时画不画棋盘格」，
  // 由 decidePreviewRender 判成 blit-only；同一帧的 blit 已经读到最新透明 ref。
  // 悬停帧变化同样要重画，但它由 rAF 每帧比对 getter 的返回值后置 force（不必等渲染）。
  useEffect(() => {
    forceRef.current = true
  }, [args.spec, args.showSafeArea])

  const totalFrames = args.spec ? Math.max(0, args.spec.endFrame - args.spec.startFrame) : 0

  useEffect(() => {
    let raf = 0
    let lastPerfLogTs = 0
    const tick = (ts: number): void => {
      const spec = specRef.current
      if (!spec) {
        lastStateRef.current = null
        raf = requestAnimationFrame(tick)
        return
      }

      const framesTotal = Math.max(1, spec.endFrame - spec.startFrame)
      const durationSec = framesTotal * frameIntervalSec(spec.fps)

      if (lastTsRef.current === 0) lastTsRef.current = ts
      const dt = Math.min(0.25, (ts - lastTsRef.current) / 1000)
      lastTsRef.current = ts

      if (playingRef.current) {
        elapsedSecRef.current += dt
        if (elapsedSecRef.current >= durationSec) {
          // 连续回绕：先减去一圈再取模，保留帧相位。
          // 原来直接置 0 会让回绕那一帧丢掉 0..dt 的零头，30fps 下每圈都能看出一次跳帧。
          elapsedSecRef.current -= durationSec
          if (elapsedSecRef.current >= durationSec) elapsedSecRef.current %= durationSec
          previewPerf.loopWraps += 1
          // 先让媒体层复位到入点，再走同一帧的 tick：t=0 上重新选段，不等 React 渲染。
          onLoopRef.current?.()
        }
      }

      // 悬停帧每帧现读：变化即强制重画（悬停换帧不能等到下一次 React 渲染才生效）
      const override = getOverrideRef.current?.() ?? null
      if (override !== lastOverrideRef.current) {
        lastOverrideRef.current = override
        forceRef.current = true
      }

      const choice = choosePreviewFrame({
        elapsedSec: elapsedSecRef.current,
        overrideSec: override,
        fps: spec.fps,
        startFrame: spec.startFrame,
        endFrame: spec.endFrame
      })

      // 媒体层先同步（它会写 transparentRef）；随后同一帧的 blit 就能用上新透明值，
      // 不会出现「视频已经翻上来、Canvas 还盖着棋盘格」的那一帧。
      onTickRef.current?.(frameTimeSec(choice.frame, spec.fps), playingRef.current)

      // 帧级播放头：只跟时钟时回调，且帧号变化才写（悬停接管期间蓝线必须留在原地）
      if (choice.reportDisplay && choice.frame !== lastPlayheadFrameRef.current) {
        lastPlayheadFrameRef.current = choice.frame
        onPlayheadRef.current?.(frameTimeSec(choice.frame, spec.fps))
      }

      const transparent = args.transparentRef?.current ?? transparentRef.current

      const canvas = args.canvasRef.current
      if (canvas) {
        let stage = stageRef.current
        if (!stage || stage.width !== spec.width || stage.height !== spec.height) {
          // 预览不回读：构造 GPU 画布，避免每帧 GPU→CPU 回读；
          // smoothing 用 low 降低重采样成本（导出/回归仍走默认 high）。
          stage = new NativeStage(spec.width, spec.height, { readback: false, smoothing: 'low' })
          stageRef.current = stage
          forceRef.current = true
        }
        if (lastCanvasRef.current !== canvas) {
          lastCanvasRef.current = canvas
          forceRef.current = true
        }

        // CSS 尺寸未知时补读一次（挂载早期布局可能还没落定），之后只由 ResizeObserver 更新
        if (cssSizeRef.current.width <= 0 || cssSizeRef.current.height <= 0) {
          cssSizeRef.current = {
            width: Math.max(1, Math.floor(canvas.clientWidth || canvas.width || 1)),
            height: Math.max(1, Math.floor(canvas.clientHeight || canvas.height || 1))
          }
        }

        const state: PreviewRenderState = {
          frame: choice.frame,
          spec,
          cssWidth: cssSizeRef.current.width,
          cssHeight: cssSizeRef.current.height,
          // 与 blitTo 的钳制口径一致，避免把 2.5→2.5001 这类噪声当成上屏变化
          dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
          safeArea: safeRef.current,
          transparent
        }
        const decision = decidePreviewRender(state, lastStateRef.current, forceRef.current)
        forceRef.current = false
        lastStateRef.current = state

        let renderMs = 0
        let blitMs = 0
        if (decision.render) {
          const started = performance.now()
          stage.render(spec, choice.frame, { safeArea: state.safeArea })
          renderMs = performance.now() - started
          previewPerf.renders += 1
        }
        if (decision.blit) {
          const started = performance.now()
          stage.blitTo(canvas, {
            transparent,
            cssWidth: state.cssWidth,
            cssHeight: state.cssHeight
          })
          blitMs = performance.now() - started
          previewPerf.blits += 1
        }
        if (decision.render || decision.blit) {
          noteFrame({ renderMs, blitMs, frameIntervalSec: frameIntervalSec(spec.fps) })
          // 悬停接管期间不回写：蓝线与时间码必须留在播放头上
          if (choice.reportDisplay && ts - lastDisplayRef.current > DISPLAY_TICK_MS) {
            lastDisplayRef.current = ts
            onDisplayRef.current?.(frameTimeSec(choice.frame, spec.fps))
          }
        } else {
          // 暂停且同一帧：不重画也不重新上屏（长帧判断的数据只看真正画过的帧）
          previewPerf.skips += 1
        }
      }

      // dev 性能汇总只在循环内按窗口触发：模块顶层定时器会污染 vitest
      if (import.meta.env.DEV) {
        if (lastPerfLogTs === 0) lastPerfLogTs = ts
        if (ts - lastPerfLogTs >= PERF_LOG_INTERVAL_MS) {
          lastPerfLogTs = ts
          console.debug('[preview-perf]', formatPreviewPerfSummary(previewPerfSnapshot()))
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [args.canvasRef])

  /**
   * 显示层盒子一变就补画一帧。`blitTo` 只在绘制时按 clientWidth×DPR 重设后备缓冲，
   * 暂停态下不重画的话，浏览器会把旧尺寸的位图**非等比拉伸**到新盒子上——
   * 拖分隔线 / 缩窗口时画面被压扁、字幕条跟着变形就是这个原因。
   * （ResizeObserver 只看 CSS 盒子，blitTo 改 width/height 属性不会触发它，不构成回环。）
   *
   * Task 2：这里把 CSS 尺寸读一次存进 ref，rAF 里就不必每帧读 clientWidth/clientHeight。
   */
  useEffect(() => {
    const canvas = args.canvasRef.current
    if (!canvas) return
    const measure = (): void => {
      cssSizeRef.current = {
        width: Math.max(1, Math.floor(canvas.clientWidth || canvas.width || 1)),
        height: Math.max(1, Math.floor(canvas.clientHeight || canvas.height || 1))
      }
      forceRef.current = true
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [args.canvasRef])

  const currentFrame = useCallback((): number => {
    const spec = specRef.current
    if (!spec) return 0
    // 逐帧跳转的基准始终是播放头自己（overrideSec 传 null），不受悬停影响
    return choosePreviewFrame({
      elapsedSec: elapsedSecRef.current,
      overrideSec: null,
      fps: spec.fps,
      startFrame: spec.startFrame,
      endFrame: spec.endFrame
    }).frame
  }, [])

  const seekTime = useCallback((sec: number): void => {
    const spec = specRef.current
    if (!spec) return
    const framesTotal = Math.max(1, spec.endFrame - spec.startFrame)
    const durationSec = framesTotal * frameIntervalSec(spec.fps)
    elapsedSecRef.current = Math.max(0, Math.min(durationSec - frameIntervalSec(spec.fps), sec))
    // 只有 seek 到「当前正在显示的那一帧」之外才需要补画；帧号变化本身也会触发重绘，
    // 这里置 force 是为了同一帧的其它显示条件（例如悬停接管）不把这次跳转吃掉。
    const target = choosePreviewFrame({
      elapsedSec: elapsedSecRef.current,
      overrideSec: getOverrideRef.current?.() ?? null,
      fps: spec.fps,
      startFrame: spec.startFrame,
      endFrame: spec.endFrame
    }).frame
    if (lastStateRef.current === null || lastStateRef.current.frame !== target) forceRef.current = true
  }, [])

  const seekFrame = useCallback(
    (frame: number): void => {
      const spec = specRef.current
      if (!spec) return
      seekTime(frameTimeSec(frame, spec.fps))
    },
    [seekTime]
  )

  return { currentFrame, seekFrame, seekTime, totalFrames }
}
