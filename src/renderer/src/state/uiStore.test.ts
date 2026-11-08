import { afterEach, describe, expect, it } from 'vitest'
import { useUiStore } from './uiStore'

/** 界面模式：程序启动总是基础模式（只显示高频入口），高级模式按需切换。 */

afterEach(() => {
  useUiStore.setState({ uiMode: 'basic', playheadSec: 0 })
})

describe('uiStore · 界面模式', () => {
  it('启动默认进入基础模式', () => {
    expect(useUiStore.getState().uiMode).toBe('basic')
  })

  it('可切换到高级模式，也能切回基础模式', () => {
    useUiStore.getState().setUiMode('advanced')
    expect(useUiStore.getState().uiMode).toBe('advanced')
    useUiStore.getState().setUiMode('basic')
    expect(useUiStore.getState().uiMode).toBe('basic')
  })
})

describe('uiStore · 预览轴的悬停帧（P4）', () => {
  afterEach(() => {
    useUiStore.setState({ hoverPreviewSec: null })
  })

  it('默认没有悬停帧（黄线不接管预览）', () => {
    expect(useUiStore.getState().hoverPreviewSec).toBeNull()
  })

  it('写入悬停帧后能读回，再写同一个值不产生新 state（不拖着重渲染整条轨道）', () => {
    useUiStore.getState().setHoverPreview(4.5)
    expect(useUiStore.getState().hoverPreviewSec).toBe(4.5)

    const before = useUiStore.getState()
    useUiStore.getState().setHoverPreview(4.5)
    expect(useUiStore.getState()).toBe(before)
  })

  it('传 null = 鼠标移出时间轴，回到蓝线的位置与状态', () => {
    useUiStore.getState().setHoverPreview(4.5)
    useUiStore.getState().setHoverPreview(null)

    expect(useUiStore.getState().hoverPreviewSec).toBeNull()
  })
})

describe('uiStore · 帧级播放头（Task 5）', () => {
  it('写入后能读回', () => {
    expect(useUiStore.getState().playheadSec).toBe(0)
    useUiStore.getState().setPlayheadSec(3.25)
    expect(useUiStore.getState().playheadSec).toBe(3.25)
  })

  it('写同一个值不产生新 state（预览循环每帧都会调）', () => {
    useUiStore.getState().setPlayheadSec(2)
    const before = useUiStore.getState()
    useUiStore.getState().setPlayheadSec(2)
    expect(useUiStore.getState()).toBe(before)

    // 计数器口径再钉一次：同值写入不应惊动订阅者
    let calls = 0
    const unsubscribe = useUiStore.subscribe(() => (calls += 1))
    useUiStore.getState().setPlayheadSec(2)
    unsubscribe()
    expect(calls).toBe(0)
  })
})
