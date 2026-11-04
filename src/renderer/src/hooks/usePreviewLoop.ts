import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { frameIntervalSec, frameTimeSec, timeToFrameFloor } from '@shared/fps'
import type { RenderJobSpec } from '@shared/types'
import { NativeStage } from '../render/stage'

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
  const elapsedSecRef = useRef(0)
  const dirtyRef = useRef(true)
  const lastTsRef = useRef(0)
  const lastDisplayRef = useRef(0)
  const onDisplayRef = useRef(args.onDisplayTime)

  specRef.current = args.spec
  playingRef.current = args.playing
  safeRef.current = args.showSafeArea
  transparentRef.current = args.transparent === true
  onDisplayRef.current = args.onDisplayTime

  // 规格 / 内容 / 安全区 / 参考视频垫底变化：重画一帧
  useEffect(() => {
    dirtyRef.current = true
  }, [args.spec, args.showSafeArea, args.transparent])

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
          const frame = Math.min(
            framesTotal - 1,
            Math.max(0, timeToFrameFloor(elapsedSecRef.current, spec.fps))
          )
          stage.render(spec, spec.startFrame + Math.max(0, frame), { safeArea: safeRef.current })
          stage.blitTo(canvas, { transparent: transparentRef.current })
          dirtyRef.current = false
          if (ts - lastDisplayRef.current > DISPLAY_TICK_MS) {
            lastDisplayRef.current = ts
            onDisplayRef.current?.(frameTimeSec(spec.startFrame + Math.max(0, frame), spec.fps))
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [args.canvasRef])

  const currentFrame = useCallback((): number => {
    const spec = specRef.current
    if (!spec) return 0
    const framesTotal = Math.max(1, spec.endFrame - spec.startFrame)
    const local = Math.min(
      framesTotal - 1,
      Math.max(0, timeToFrameFloor(elapsedSecRef.current, spec.fps))
    )
    return spec.startFrame + Math.max(0, local)
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
