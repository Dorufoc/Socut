import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { frameIntervalSec, frameTimeSec } from '@shared/fps'
import type { RenderJobSpec } from '@shared/types'
import { NativeStage } from '../render/stage'
import { choosePreviewFrame } from '../render/previewFrame'

/**
 * 预览循环（规格 §4.3 / §11 纪律 6）。
 * 播放头由 performance.now() 累加时间后折算为帧号，不由 rAF 计数驱动，
 * 因此掉帧不会让时间轴漂移；绘制仍发生在 rAF。
 */

export interface PreviewArgs {
  canvasRef: RefObject<HTMLCanvasElement | null>
  spec: RenderJobSpec | null
  playing: boolean
  showSafeArea: boolean
  /** 有参考视频垫底时不再画棋盘格：让 Canvas 透明，视频从下层透出来 */
  transparent?: boolean
  /**
   * P4：预览轴的悬停帧（相对工程起点的秒）。非空时**只换画哪一帧**，
   * 不回写 `onDisplayTime`，所以时间轴蓝线、时间码、逐帧跳转的基准全部留在原地。
   */
  overrideSec?: number | null
  /** UI 时间文本节流回调（不进高频 store） */
  onDisplayTime?: (sec: number) => void
}

export interface PreviewHandle {
  currentFrame: () => number
  seekFrame: (frame: number) => void
  seekTime: (sec: number) => void
  totalFrames: number
}

const DISPLAY_TICK_MS = 100

export function usePreviewLoop(args: PreviewArgs): PreviewHandle {
  const stageRef = useRef<NativeStage | null>(null)
  const specRef = useRef<RenderJobSpec | null>(args.spec)
  const playingRef = useRef(args.playing)
  const safeRef = useRef(args.showSafeArea)
  // rAF 循环只建立一次：透明垫底态必须进 ref，否则取到的是首次渲染的旧值
  const transparentRef = useRef(args.transparent === true)
  const overrideRef = useRef<number | null>(args.overrideSec ?? null)
  const elapsedSecRef = useRef(0)
  const dirtyRef = useRef(true)
  const lastTsRef = useRef(0)
  const lastDisplayRef = useRef(0)
  const onDisplayRef = useRef(args.onDisplayTime)

  specRef.current = args.spec
  playingRef.current = args.playing
  safeRef.current = args.showSafeArea
  transparentRef.current = args.transparent === true
  overrideRef.current = args.overrideSec ?? null
  onDisplayRef.current = args.onDisplayTime

  // 规格 / 内容 / 安全区 / 参考视频垫底 / 悬停帧变化：重画一帧
  useEffect(() => {
    dirtyRef.current = true
  }, [args.spec, args.showSafeArea, args.transparent, args.overrideSec])

  const totalFrames = args.spec ? Math.max(0, args.spec.endFrame - args.spec.startFrame) : 0

  useEffect(() => {
    let raf = 0
    const tick = (ts: number): void => {
      const spec = specRef.current
      const canvas = args.canvasRef.current
      if (spec && canvas) {
        const framesTotal = Math.max(1, spec.endFrame - spec.startFrame)
        const durationSec = framesTotal * frameIntervalSec(spec.fps)

        if (lastTsRef.current === 0) lastTsRef.current = ts
        const dt = Math.min(0.25, (ts - lastTsRef.current) / 1000)
        lastTsRef.current = ts

        if (playingRef.current) {
          elapsedSecRef.current += dt
          if (elapsedSecRef.current >= durationSec) elapsedSecRef.current = 0
          dirtyRef.current = true
        }

        if (dirtyRef.current) {
          let stage = stageRef.current
          if (!stage || stage.width !== spec.width || stage.height !== spec.height) {
            stage = new NativeStage(spec.width, spec.height)
            stageRef.current = stage
          }
          const choice = choosePreviewFrame({
            elapsedSec: elapsedSecRef.current,
            overrideSec: overrideRef.current,
            fps: spec.fps,
            startFrame: spec.startFrame,
            endFrame: spec.endFrame
          })
          stage.render(spec, choice.frame, { safeArea: safeRef.current })
          stage.blitTo(canvas, { transparent: transparentRef.current })
          dirtyRef.current = false
          // 悬停接管期间不回写：蓝线与时间码必须留在播放头上
          if (choice.reportDisplay && ts - lastDisplayRef.current > DISPLAY_TICK_MS) {
            lastDisplayRef.current = ts
            onDisplayRef.current?.(frameTimeSec(choice.frame, spec.fps))
          }
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
   */
  useEffect(() => {
    const canvas = args.canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      dirtyRef.current = true
    })
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
    dirtyRef.current = true
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
