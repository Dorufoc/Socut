import { describe, expect, it } from 'vitest'
import {
  clampMediaTileSize,
  MEDIA_TILE_SIZE_DEFAULT,
  MEDIA_TILE_SIZE_KEY,
  MEDIA_TILE_SIZE_MAX,
  MEDIA_TILE_SIZE_MIN,
  MEDIA_TILE_SIZE_STEP,
  nextMediaTileSize,
  readMediaTileSize,
  writeMediaTileSize,
  type TileSizeStorage
} from './mediaTileSize'

/**
 * 素材卡片尺寸偏好：越界/脏值要夹回合法区间，存储异常不许冒泡到渲染。
 * （全部注入内存实现，不依赖运行环境有没有 localStorage。）
 */

function memoryStorage(initial: Record<string, string> = {}): TileSizeStorage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    }
  }
}

function throwingStorage(): TileSizeStorage {
  return {
    getItem: () => {
      throw new Error('SecurityError: storage disabled')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    }
  }
}

describe('mediaTileSize 读写', () => {
  it('无存档时回默认尺寸', () => {
    expect(readMediaTileSize(memoryStorage())).toBe(MEDIA_TILE_SIZE_DEFAULT)
    expect(readMediaTileSize(null)).toBe(MEDIA_TILE_SIZE_DEFAULT)
  })

  it('夹到合法区间：过小、过大、非有限值', () => {
    expect(clampMediaTileSize(1)).toBe(MEDIA_TILE_SIZE_MIN)
    expect(clampMediaTileSize(9999)).toBe(MEDIA_TILE_SIZE_MAX)
    expect(clampMediaTileSize(Number.NaN)).toBe(MEDIA_TILE_SIZE_DEFAULT)
    expect(clampMediaTileSize(Number.POSITIVE_INFINITY)).toBe(MEDIA_TILE_SIZE_DEFAULT)
    expect(clampMediaTileSize(120.6)).toBe(121)
  })

  it('写入后原样读回（并夹取非法值）', () => {
    const storage = memoryStorage()
    writeMediaTileSize(144, storage)
    expect(storage.getItem(MEDIA_TILE_SIZE_KEY)).toBe('144')
    expect(readMediaTileSize(storage)).toBe(144)

    writeMediaTileSize(5, storage)
    expect(readMediaTileSize(storage)).toBe(MEDIA_TILE_SIZE_MIN)
  })

  it('滚轮向下滚缩小、向上滚放大，并夹在区间内', () => {
    expect(nextMediaTileSize(120, 100)).toBe(120 - MEDIA_TILE_SIZE_STEP)
    expect(nextMediaTileSize(120, -100)).toBe(120 + MEDIA_TILE_SIZE_STEP)
    expect(nextMediaTileSize(120, 0)).toBe(120)
    expect(nextMediaTileSize(MEDIA_TILE_SIZE_MIN, 100)).toBe(MEDIA_TILE_SIZE_MIN)
    expect(nextMediaTileSize(MEDIA_TILE_SIZE_MAX, -100)).toBe(MEDIA_TILE_SIZE_MAX)
  })

  it('脏数据当没有存档：非数字、空串', () => {
    expect(readMediaTileSize(memoryStorage({ [MEDIA_TILE_SIZE_KEY]: 'not a number' }))).toBe(MEDIA_TILE_SIZE_DEFAULT)
    expect(readMediaTileSize(memoryStorage({ [MEDIA_TILE_SIZE_KEY]: '' }))).toBe(MEDIA_TILE_SIZE_DEFAULT)
  })

  it('存储不可用（隐私模式 / 配额）不抛异常', () => {
    const storage = throwingStorage()
    expect(() => readMediaTileSize(storage)).not.toThrow()
    expect(readMediaTileSize(storage)).toBe(MEDIA_TILE_SIZE_DEFAULT)
    expect(() => writeMediaTileSize(140, storage)).not.toThrow()
  })
})
