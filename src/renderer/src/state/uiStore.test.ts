import { afterEach, describe, expect, it } from 'vitest'
import { useUiStore } from './uiStore'

/** 界面模式：程序启动总是基础模式（只显示高频入口），高级模式按需切换。 */

afterEach(() => {
  useUiStore.setState({ uiMode: 'basic' })
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
