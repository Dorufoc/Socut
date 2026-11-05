import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 预览音频增益图（v9）的退化纪律。
 *
 * 预览不是导出：拿不到 WebAudio 也只能「听不到 200% 增益」，
 * 不许抛异常、不许把 `element.volume` 留成脏值、更不许影响画面链。
 *
 * 被测模块有两个跨调用状态（共享 AudioContext + 元素→节点的 WeakMap），
 * 所以每个用例都重加载一次，避免「前一个用例建的上下文」被后一个复用。
 */

type GraphModule = typeof import('./previewAudioGraph')

interface FakeNodes {
  gain: { value: number; calls: Array<{ target: number; constant: number }> }
}

function makeFakeContext(state: AudioContextState): { context: AudioContext; nodes: FakeNodes } {
  const gain: FakeNodes['gain'] = {
    value: 1,
    calls: [] as Array<{ target: number; constant: number }>
  }
  // 真实 API 是 `gainNode.gain`（AudioParam），夹具必须把这一层也搭出来
  const gainNode = {
    gain: {
      get value(): number {
        return gain.value
      },
      set value(value: number) {
        gain.value = value
      },
      setTargetAtTime(target: number, _when: number, constant: number): void {
        gain.value = target
        gain.calls.push({ target, constant })
      }
    },
    connect(): void {},
    disconnect(): void {}
  }
  const analyser = {
    fftSize: 512,
    smoothingTimeConstant: 0,
    /** 方波半幅：偏离 128 最多 64 → peakLevel() = 0.5 */
    getByteTimeDomainData(buffer: Uint8Array): void {
      for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 2 === 0 ? 192 : 128
    },
    connect(): void {},
    disconnect(): void {}
  }
  const source = { connect(): void {}, disconnect(): void {} }
  const context = {
    state,
    currentTime: 0,
    destination: {},
    resume: () => Promise.resolve(),
    createMediaElementSource: () => source,
    createGain: () => gainNode,
    createAnalyser: () => analyser
  }
  return { context: context as unknown as AudioContext, nodes: { gain } }
}

async function loadGraph(): Promise<GraphModule> {
  vi.resetModules()
  return import('./previewAudioGraph')
}

function mediaElement(): HTMLMediaElement {
  const host = document.createElement('div')
  document.body.append(host)
  const video = document.createElement('video')
  host.append(video)
  return video
}

/**
 * 把假上下文挂成全局 `AudioContext`。
 * 必须用 `function`（可被 `new`）：`vi.fn` 包箭头函数在本机 Vitest 下不可构造，
 * 会被被测模块的 try/catch 当成「环境不支持」静默吞掉。
 */
function stubAudioContext(context: AudioContext): void {
  vi.stubGlobal(
    'AudioContext',
    function fakeAudioContext(): AudioContext {
      return context
    }
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('没有 WebAudio 时的退化', () => {
  it('attach 直接给 null，不抛', async () => {
    const graph = await loadGraph()
    vi.stubGlobal('AudioContext', undefined)
    expect(graph.attachPreviewAudio(mediaElement())).toBeNull()
  })

  it('≤100% 写 element.volume；>100% 封顶在 1（图拿不到也不能越界或抛）', async () => {
    const graph = await loadGraph()
    vi.stubGlobal('AudioContext', undefined)
    const element = mediaElement()
    graph.setElementLevel(element, 0.4)
    expect(element.volume).toBe(0.4)
    graph.setElementLevel(element, 2)
    expect(element.volume).toBe(1)
    graph.setElementLevel(element, Number.NaN)
    expect(element.volume).toBe(1)
    expect(graph.elementLevelReader(element)).toBeNull()
  })
})

describe('接上增益图', () => {
  it('>100% 必须走 Gain 节点（可超过 1.0），element.volume 固定为 1', async () => {
    const { context, nodes } = makeFakeContext('running')
    stubAudioContext(context)
    const graph = await loadGraph()
    const element = mediaElement()

    const node = graph.attachPreviewAudio(element)
    expect(node).not.toBeNull()
    node?.setLevel(2)
    expect(nodes.gain.value).toBe(2)
    expect(nodes.gain.calls[0]?.constant).toBeCloseTo(0.015, 6)

    graph.setElementLevel(element, 1.8)
    expect(element.volume).toBe(1)
    expect(nodes.gain.value).toBe(1.8)
    expect(graph.previewAudioNodeOf(element)).toBe(node)
  })

  it('实时电平读数是分析节点的峰值（0..1），拆图后退回 volume 表达', async () => {
    const { context } = makeFakeContext('running')
    stubAudioContext(context)
    const graph = await loadGraph()
    const element = mediaElement()
    graph.attachPreviewAudio(element)

    const read = graph.elementLevelReader(element)
    expect(read).not.toBeNull()
    expect(read?.()).toBeCloseTo(0.5, 6)

    graph.detachPreviewAudio(element)
    expect(graph.previewAudioNodeOf(element)).toBeNull()
    expect(graph.elementLevelReader(element)).toBeNull()
    // 拆完图之后必须还能用 volume 表达增益（不会留着 1.0 把 50% 吞掉）
    graph.setElementLevel(element, 0.5)
    expect(element.volume).toBe(0.5)
  })

  it('上下文起不来（非 running）：不抛，且音量不超过 1', async () => {
    const { context } = makeFakeContext('suspended')
    context.resume = () => Promise.reject(new Error('NotAllowedError'))
    stubAudioContext(context)
    const graph = await loadGraph()
    const element = mediaElement()

    expect(() => graph.setElementLevel(element, 1.5)).not.toThrow()
    expect(element.volume).toBeLessThanOrEqual(1)
  })
})

describe('变速保持音高的预览侧写回', () => {
  it('两个前缀名都试；都不存在时静默跳过', async () => {
    const graph = await loadGraph()
    const element = mediaElement() as HTMLMediaElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean }
    graph.setPreservesPitch(element, false)
    if ('preservesPitch' in element) expect(element.preservesPitch).toBe(false)
    if ('webkitPreservesPitch' in element) expect(element.webkitPreservesPitch).toBe(false)

    const bare = {} as HTMLMediaElement
    expect(() => graph.setPreservesPitch(bare, true)).not.toThrow()
  })
})
