import { describe, expect, it } from 'vitest'
import { DEFAULT_AUDIO_TRACK_ID } from '../src/shared/constants'
import { createDefaultProject } from '../src/shared/projectSchema'
import {
  AUTOSAVE_ENTRY_ID,
  coverUrlFor,
  filterRecentProjects,
  formatDefaultProjectName,
  nextProjectName,
  normalizeRecentHistory,
  projectHasProgress,
  projectStats,
  recentEntryIdForPath,
  sortRecentProjects,
  type RecentProjectEntry
} from '../src/shared/recentProjects'
import type { Project } from '../src/shared/types'

function entry(over: Partial<RecentProjectEntry> & Pick<RecentProjectEntry, 'id' | 'name'>): RecentProjectEntry {
  return {
    source: 'file',
    filePath: `C:/projects/${over.id}.focusnews.json`,
    createdAt: '2026-01-01T08:00:00.000Z',
    modifiedAt: '2026-01-01T09:00:00.000Z',
    lastOpenedAt: '2026-01-01T10:00:00.000Z',
    resolution: { width: 1920, height: 1080 },
    fps: { num: 25, den: 1 },
    clipCount: 0,
    mediaCount: 0,
    audioClipCount: 0,
    hasCover: false,
    nameCustomized: false,
    ...over
  }
}

describe('日期默认工程名', () => {
  it('用本地日期补零成 YYYY-MM-DD', () => {
    expect(formatDefaultProjectName(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(formatDefaultProjectName(new Date(2026, 10, 17, 0, 0))).toBe('2026-11-17')
  })
})

describe('同名工程括号序号', () => {
  it('基名空闲时直接使用基名', () => {
    expect(nextProjectName('2026-11-07', [])).toBe('2026-11-07')
    expect(nextProjectName('2026-11-07', ['别的工程'])).toBe('2026-11-07')
  })

  it('同名时依次追加（一）（二）（三）', () => {
    expect(nextProjectName('2026-11-07', ['2026-11-07'])).toBe('2026-11-07（一）')
    expect(nextProjectName('2026-11-07', ['2026-11-07', '2026-11-07（一）'])).toBe('2026-11-07（二）')
    expect(
      nextProjectName('2026-11-07', ['2026-11-07', '2026-11-07（一）', '2026-11-07（二）'])
    ).toBe('2026-11-07（三）')
  })

  it('只补第一个空位，不重排已有序号', () => {
    // （一）被手动删除后仍不复用旧序号以外的名字：基名已占，第一个空位就是（一）
    expect(nextProjectName('2026-11-07', ['2026-11-07', '2026-11-07（二）'])).toBe('2026-11-07（一）')
  })

  it('基名被改名后仍可继续用基名（不因历史序号而跳号）', () => {
    expect(nextProjectName('2026-11-07', ['2026-11-07（一）'])).toBe('2026-11-07')
  })

  it('超过十也能写成中文序号', () => {
    const taken = ['工程']
    for (const suffix of ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']) {
      taken.push(`工程（${suffix}）`)
    }
    expect(nextProjectName('工程', taken)).toBe('工程（十一）')
  })

  it('清洗名字前后空白与控制字符', () => {
    expect(nextProjectName('  2026-11-07  ', [])).toBe('2026-11-07')
    expect(nextProjectName('a\u0000b', [])).toBe('a b')
  })
})

describe('排序与过滤', () => {
  const older = entry({ id: 'p00000000000000a1', name: 'B 工程', lastOpenedAt: '2026-11-01T09:00:00.000Z' })
  const newer = entry({ id: 'p00000000000000a2', name: 'A 工程', lastOpenedAt: '2026-11-06T09:00:00.000Z' })
  const middle = entry({ id: 'p00000000000000a3', name: 'C 工程', lastOpenedAt: '2026-11-03T09:00:00.000Z' })

  it('默认按最近使用倒序', () => {
    expect(sortRecentProjects([older, newer, middle], 'recent').map((item) => item.name)).toEqual([
      'A 工程',
      'C 工程',
      'B 工程'
    ])
  })

  it('按名称排序：中文按拼音、数字按大小、英文忽略大小写', () => {
    const chinese = [
      entry({ id: 'p00000000000000b1', name: '上海' }),
      entry({ id: 'p00000000000000b2', name: '北京' }),
      entry({ id: 'p00000000000000b3', name: '广州' })
    ]
    expect(sortRecentProjects(chinese, 'name').map((item) => item.name)).toEqual(['北京', '广州', '上海'])

    const numbered = [
      entry({ id: 'p00000000000000b4', name: '工程10' }),
      entry({ id: 'p00000000000000b5', name: '工程2' })
    ]
    expect(sortRecentProjects(numbered, 'name').map((item) => item.name)).toEqual(['工程2', '工程10'])

    const latin = [
      entry({ id: 'p00000000000000b6', name: 'banana' }),
      entry({ id: 'p00000000000000b7', name: 'Apple' })
    ]
    expect(sortRecentProjects(latin, 'name').map((item) => item.name)).toEqual(['Apple', 'banana'])
  })

  it('搜索按名字子串过滤且不改顺序', () => {
    const sorted = sortRecentProjects([older, newer, middle], 'recent')
    expect(filterRecentProjects(sorted, '  ').map((item) => item.name)).toEqual(['A 工程', 'C 工程', 'B 工程'])
    expect(filterRecentProjects(sorted, 'b').map((item) => item.name)).toEqual(['B 工程'])
    expect(filterRecentProjects(sorted, '工程').length).toBe(3)
  })
})

describe('进度判据与统计', () => {
  it('空工程不算进度，任意一轨有内容或启用水印才算', () => {
    expect(projectHasProgress(createDefaultProject('空'))).toBe(false)

    const withClip = createDefaultProject('字幕')
    withClip.clips.push({
      id: 'clip-1',
      startTime: 0,
      endTime: 2,
      presetId: 'breakingRed',
      styleOverrides: {},
      content: { title: '标题', subtitle: '' },
      animation: {
        inDuration: 1,
        outDuration: 1,
        easing: 'outCubic',
        textRevealFrames: 3,
        displacement: { x: '-30px@1080p', y: '0' }
      },
      fontId: 'builtin-default'
    })
    expect(projectHasProgress(withClip)).toBe(true)

    const withWatermark: Project = {
      ...createDefaultProject('水印'),
      watermark: {
        enabled: true,
        path: 'C:/w.png',
        name: 'w.png',
        sourceWidth: 100,
        sourceHeight: 40,
        importedAt: '2026-01-01T00:00:00.000Z'
      }
    }
    expect(projectHasProgress(withWatermark)).toBe(true)

    const disabledWatermark: Project = {
      ...withWatermark,
      watermark: { ...withWatermark.watermark!, enabled: false }
    }
    expect(projectHasProgress(disabledWatermark)).toBe(false)
  })

  it('统计分辨率/帧率/三类段数量', () => {
    const project = createDefaultProject('统计')
    project.audioClips = [
      { id: 'a1', mediaId: 'm1', trackId: DEFAULT_AUDIO_TRACK_ID, timelineStartSec: 0, timelineEndSec: 1, sourceInSec: 0, sourceOutSec: 1 }
    ]
    expect(projectStats(project)).toEqual({
      resolution: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      clipCount: 0,
      mediaCount: 0,
      audioClipCount: 1
    })
  })
})

describe('路径 id 与索引归一化', () => {
  it('同路径不同斜杠/大小写得到同一个 id', () => {
    const a = recentEntryIdForPath('C:\\Projects\\A.focusnews.json')
    const b = recentEntryIdForPath('c:/projects/a.focusnews.json')
    expect(a).toBe(b)
    expect(a).toMatch(/^p[0-9a-f]{16}$/)
    expect(recentEntryIdForPath('C:/projects/b.focusnews.json')).not.toBe(a)
  })

  it('坏 JSON / 坏条目被丢弃，重复 id 只留第一条', () => {
    const normalized = normalizeRecentHistory({
      version: 1,
      entries: [
        {
          id: 'p00000000000000c1',
          name: '好工程',
          source: 'file',
          filePath: 'C:/p/a.focusnews.json',
          createdAt: '2026-01-01T00:00:00.000Z',
          modifiedAt: '2026-01-02T00:00:00.000Z',
          lastOpenedAt: '2026-01-03T00:00:00.000Z',
          resolution: { width: 1920, height: 1080 },
          fps: { num: 25, den: 1 }
        },
        { id: 'bad-id', name: '坏 id' },
        { id: 'p00000000000000c2', name: '缺路径', source: 'file' },
        {
          id: 'p00000000000000c1',
          name: '重复',
          source: 'file',
          filePath: 'C:/p/a.focusnews.json'
        },
        {
          id: AUTOSAVE_ENTRY_ID,
          name: '上次编辑',
          source: 'autosave',
          lastOpenedAt: '2026-01-04T00:00:00.000Z'
        }
      ]
    })
    expect(normalized.version).toBe(1)
    expect(normalized.entries.map((item) => item.name)).toEqual(['上次编辑', '好工程'])
  })

  it('数组形态的旧索引也能读', () => {
    const normalized = normalizeRecentHistory([
      {
        id: AUTOSAVE_ENTRY_ID,
        name: '',
        source: 'autosave'
      }
    ])
    expect(normalized.entries.length).toBe(1)
    expect(normalized.entries[0]?.name).toBe('上次编辑')
  })

  it('封面地址只在有封面时生成，并带修改时间版本号', () => {
    expect(coverUrlFor({ id: 'p00000000000000c1', hasCover: false, modifiedAt: '2026-01-01T00:00:00.000Z' })).toBeNull()
    const url = coverUrlFor({
      id: 'p00000000000000c1',
      hasCover: true,
      modifiedAt: '2026-01-03T04:05:06.000Z'
    })
    expect(url).toBe(`focusnews-cover://p00000000000000c1?v=${Date.parse('2026-01-03T04:05:06.000Z')}`)
  })
})
