/**
 * 预览音频增益图（v9）：WebAudio 的 `MediaElementAudioSource → Gain → Analyser → destination`。
 *
 * 为什么要走 WebAudio 而不是只写 `element.volume`：
 * 1. `HTMLMediaElement.volume` 的上限就是 1.0，而面板的音量范围是 0%~**200%**；
 *    增益节点没有这个天花板，预览里能真听到 +6dB（与导出 `volume=2` 同一语义）；
 * 2. 频谱条要「实时」：分析节点顺手给出当前输出电平，卡片按它起伏。
 *
 * 失败必须无声退化（这是预览，不是导出；拿不到图也不能把画面/时间轴弄坏）：
 * - 环境没有 AudioContext（jsdom / 老内核）→ 返回 null，调用方退回 `element.volume`；
 * - 上下文起不来（自动播放策略、无音频设备）→ 延迟复检后自我拆除，同样退回 `element.volume`。
 */

/** 一路元素的增益与分析节点。 */
export interface PreviewAudioNode {
  /** 设线性增益（0..2 与面板百分比同一口径） */
  setLevel(level: number): void
  /** 当前输出峰值电平（0..1），给频谱条做实时调制 */
  peakLevel(): number
  /** 拆掉图，让元素回到浏览器自己的音频输出 */
  dispose(): void
}

type AudioContextCtor = new () => AudioContext

let sharedContext: AudioContext | null = null
const attached = new WeakMap<HTMLMediaElement, PreviewAudioNode>()

/** 复检间隔：上下文起不来就拆除（一次挂载只查一轮，不做轮询）。 */
const CONTEXT_READY_MS = 400

function resolveConstructor(): AudioContextCtor | null {
  const direct = typeof AudioContext !== 'undefined' ? AudioContext : undefined
  const legacy = (globalThis as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext
  return (direct ?? legacy) ?? null
}

function createContext(): AudioContext | null {
  const Ctor = resolveConstructor()
  if (!Ctor) return null
  try {
    return new Ctor()
  } catch {
    return null
  }
}

/** 把元素的音频接进增益图；不可用时返回 null（调用方自行退回 element.volume）。 */
export function attachPreviewAudio(element: HTMLMediaElement): PreviewAudioNode | null {
  const existing = attached.get(element)
  if (existing) return existing
  if (!sharedContext) sharedContext = createContext()
  const context = sharedContext
  if (!context) return null
  try {
    const source = context.createMediaElementSource(element)
    const gain = context.createGain()
    const analyser = context.createAnalyser()
    // fftSize 512 ≈ 每帧 11ms（48k）：电平起伏够跟手，又不必逐样本扫描
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.55
    gain.gain.value = 1
    source.connect(gain)
    gain.connect(analyser)
    analyser.connect(context.destination)
    const buffer = new Uint8Array(analyser.fftSize)

    const node: PreviewAudioNode = {
      setLevel(level: number): void {
        // 0.015s 的时间常数就是「不爆音的斜边」：滑杆拖到端点也不会听到咔哒
        gain.gain.setTargetAtTime(Math.max(0, level), context.currentTime, 0.015)
      },
      peakLevel(): number {
        analyser.getByteTimeDomainData(buffer)
        let peak = 0
        for (let i = 0; i < buffer.length; i += 1) {
          const deviation = Math.abs(buffer[i]! - 128)
          if (deviation > peak) peak = deviation
        }
        return peak / 128
      },
      dispose(): void {
        try {
          source.disconnect()
          gain.disconnect()
          analyser.disconnect()
        } catch {
          // 已经断开过：没什么可补救的，交给 element.volume
        }
        attached.delete(element)
      }
    }
    attached.set(element, node)

    if (context.state !== 'running') {
      void context.resume().catch(() => undefined)
      // 用户手势之外（例如脚本直接置 playing）可能起不来：复检不过就拆除，
      // 否则接了图却没声音，比听不到 200% 增益严重得多
      const timer = globalThis.setTimeout(() => {
        if (context.state !== 'running') node.dispose()
      }, CONTEXT_READY_MS)
      const onCancel = (): void => {
        globalThis.clearTimeout(timer)
        element.removeEventListener('error', onCancel)
      }
      element.addEventListener('error', onCancel)
    }
    return node
  } catch {
    return null
  }
}

/** 已经接好图的这一路（拿它的实时电平时用）。 */
export function previewAudioNodeOf(element: HTMLMediaElement): PreviewAudioNode | null {
  return attached.get(element) ?? null
}

/**
 * 设这一路的输出电平。
 *
 * 策略：**需要 100% 以上增益，或这一路已经接了图**才走 WebAudio，
 * 其余情况直接写 `element.volume`（等于旧行为，不引入任何新依赖）。
 * 一旦接过图就必须继续用图（元素自身的输出已经被改道，退回 volume 会没声音）。
 */
export function setElementLevel(element: HTMLMediaElement, level: number): void {
  const safe = Number.isFinite(level) ? Math.max(0, level) : 1
  const node = attached.get(element)
  if (node) {
    node.setLevel(safe)
    element.volume = 1
    return
  }
  if (safe > 1.0001) {
    const created = attachPreviewAudio(element)
    if (created) {
      element.muted = false
      created.setLevel(safe)
      element.volume = 1
      return
    }
  }
  element.volume = Math.min(1, safe)
}

/** 该元素当前的实时电平读者（没接图 = null，频谱条退回静态幅度）。 */
export function elementLevelReader(element: HTMLMediaElement): (() => number) | null {
  const node = attached.get(element)
  return node ? () => node.peakLevel() : null
}

/** 测试用：拆掉某一路的图（正常会话不需要，WeakMap 会随元素回收）。 */
export function detachPreviewAudio(element: HTMLMediaElement): void {
  attached.get(element)?.dispose()
}

/**
 * 变速时是否保持音高（面板的「变速保持音高」开关，对应导出侧 `atempo` / `asetrate`）。
 *
 * `preservesPitch` 还是事实标准（Firefox 没有、旧 WebKit 叫 webkitPreservesPitch），
 * 所以两个名字都试一下；都不存在也不报错——预览只是听个参考。
 */
export function setPreservesPitch(element: HTMLMediaElement, keep: boolean): void {
  const media = element as HTMLMediaElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean }
  if ('preservesPitch' in media) media.preservesPitch = keep
  if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = keep
}
