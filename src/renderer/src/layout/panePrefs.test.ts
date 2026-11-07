import { describe, expect, it } from 'vitest'
import { PANE_PREFS_VERSION, serializePaneRatios, type PaneRatios } from '@shared/paneLayout'
import { PANE_PREFS_KEY, readPaneRatios, writePaneRatios, type PanePrefsStorage } from './panePrefs'

/**
 * 布局偏好的本机持久化：读回的要合法、写坏的要能回落默认、异常存储不许冒泡到渲染。
 * （这里全部注入内存实现，不依赖运行环境有没有 localStorage。）
 */

const RATIOS: PaneRatios = { left: 0.25, right: 0.24, timeline: 0.33 }

function memoryStorage(initial: Record<string, string> = {}): PanePrefsStorage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    }
  }
}

function throwingStorage(): PanePrefsStorage {
  return {
    getItem: () => {
      throw new Error('SecurityError: storage disabled')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => {
      throw new Error('QuotaExceededError')
    }
  }
}

describe('panePrefs 读写', () => {
  it('无存档时 null（交给默认布局），写入后原样读回', () => {
    const storage = memoryStorage()
    expect(readPaneRatios(storage)).toBeNull()

    writePaneRatios(RATIOS, storage)
    expect(storage.getItem(PANE_PREFS_KEY)).toContain(`"version":${PANE_PREFS_VERSION}`)
    expect(readPaneRatios(storage)).toEqual(RATIOS)
  })

  it('写入 null 等于删除键（恢复默认，不留自造值）', () => {
    const storage = memoryStorage({ [PANE_PREFS_KEY]: serializePaneRatios(RATIOS) })
    expect(readPaneRatios(storage)).toEqual(RATIOS)

    writePaneRatios(null, storage)
    expect(storage.getItem(PANE_PREFS_KEY)).toBeNull()
    expect(readPaneRatios(storage)).toBeNull()
  })

  it('脏数据与旧版本一律当没有存档：非 JSON、缺字段、越界、版本不符', () => {
    const cases: string[] = [
      'not json',
      'null',
      '"0.25"',
      '[]',
      '{}',
      '{"left":0.2}',
      '{"left":0.2,"right":0.3,"timeline":1.4}',
      // 旧版「容器未测量就拖拽」会写坏成全 0，正常拖拽有下限，不可能出现
      '{"version":1,"left":0,"right":0,"timeline":0}'
    ]
    for (const raw of cases) {
      expect(readPaneRatios(memoryStorage({ [PANE_PREFS_KEY]: raw }))).toBeNull()
    }
    expect(readPaneRatios(memoryStorage({ [PANE_PREFS_KEY]: JSON.stringify({ version: 99, ...RATIOS }) }))).toBeNull()
  })

  it('存储不可用（隐私模式 / 配额）不抛异常，只回落到默认', () => {
    const storage = throwingStorage()
    expect(() => readPaneRatios(storage)).not.toThrow()
    expect(readPaneRatios(storage)).toBeNull()
    expect(() => writePaneRatios(RATIOS, storage)).not.toThrow()
    expect(() => writePaneRatios(null, storage)).not.toThrow()
  })

  it('环境有 localStorage 时默认落在它上面，键名带版本口径', () => {
    globalThis.localStorage.clear()
    writePaneRatios(RATIOS)
    expect(globalThis.localStorage.getItem(PANE_PREFS_KEY)).toBeTruthy()
    expect(readPaneRatios()).toEqual(RATIOS)

    writePaneRatios(null)
    expect(globalThis.localStorage.getItem(PANE_PREFS_KEY)).toBeNull()
    expect(readPaneRatios()).toBeNull()
  })
})
