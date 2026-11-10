import { describe, expect, it } from 'vitest'
import { DEFAULT_SEQUENCE_ID, DEFAULT_SEQUENCE_NAME, FPS_30, MAX_SEQUENCES, PROJECT_VERSION } from '@shared/constants'
import { createClip, createDefaultProject, normalizeProject } from '@shared/projectSchema'
import {
  activeSequence,
  activeSequenceId,
  activeSequenceName,
  addSequence,
  allSequences,
  duplicateSequence,
  findSequence,
  inactiveSequences,
  normalizeSequenceName,
  removeSequence,
  renameSequence,
  sequenceSummaries,
  switchSequence
} from '@shared/sequence'
import { makeMediaTrack } from '@shared/tracks'
import type { Project } from '@shared/types'

/** v4 多序列：纯函数口径 + schema 归一/迁移。 */

function seededProject(): Project {
  const project = createDefaultProject('多序列测试')
  project.fps = FPS_30
  project.clips = [createClip({ startTime: 0, fps: FPS_30, title: '主序列字幕' })]
  return project
}

describe('sequence 纯函数：默认与摘要', () => {
  it('默认工程只有一条活动序列，id/名字取默认值（且不写进工程 JSON）', () => {
    const project = seededProject()
    expect(activeSequenceId(project)).toBe(DEFAULT_SEQUENCE_ID)
    expect(activeSequenceName(project)).toBe(DEFAULT_SEQUENCE_NAME)
    expect(allSequences(project)).toHaveLength(1)
    expect(activeSequence(project).clips).toBe(project.clips)
    expect(project.activeSequenceId).toBeUndefined()
    expect(project.sequences).toBeUndefined()
  })

  it('摘要：活动标记、片段数与时长', () => {
    const project = seededProject()
    const [summary] = sequenceSummaries(project)
    expect(summary).toMatchObject({ id: DEFAULT_SEQUENCE_ID, active: true, clipCount: 1 })
    expect(summary!.durationSec).toBeGreaterThan(0)
  })

  it('序列名归一：trim + 限长，空名回退', () => {
    expect(normalizeSequenceName('  第二段  ', 'x')).toBe('第二段')
    expect(normalizeSequenceName('', '缺省')).toBe('缺省')
    expect(normalizeSequenceName(42, '缺省')).toBe('缺省')
    expect(normalizeSequenceName('a'.repeat(60), 'x')).toHaveLength(40)
  })
})

describe('sequence 纯函数：新建 / 切换 / 重命名 / 删除 / 复制', () => {
  it('新建序列不切换活动序列；切换后内容互相隔离，切回来内容完好', () => {
    const project = seededProject()
    const added = addSequence(project, '第二段')!
    expect(added.project.activeSequenceId).toBeUndefined()
    expect(inactiveSequences(added.project)).toHaveLength(1)
    expect(inactiveSequences(added.project)[0]!.name).toBe('第二段')

    const switched = switchSequence(added.project, added.id)!
    expect(switched.activeSequenceId).toBe(added.id)
    expect(switched.activeSequenceName).toBe('第二段')
    // 新序列是空的；原主序列被收进非活动快照（内容原样保留）
    expect(switched.clips).toHaveLength(0)
    expect(inactiveSequences(switched)).toHaveLength(1)
    expect(inactiveSequences(switched)[0]!.id).toBe(DEFAULT_SEQUENCE_ID)
    expect(inactiveSequences(switched)[0]!.clips).toHaveLength(1)

    const back = switchSequence(switched, DEFAULT_SEQUENCE_ID)!
    expect(back.clips).toHaveLength(1)
    expect(back.activeSequenceId).toBeUndefined()
    expect(back.activeSequenceName).toBeUndefined()
    expect(inactiveSequences(back)).toHaveLength(1)
    expect(inactiveSequences(back)[0]!.id).toBe(added.id)
  })

  it('切换到不存在的序列 / 当前序列：前者 null，后者原对象', () => {
    const project = seededProject()
    expect(switchSequence(project, 'seq-missing')).toBeNull()
    expect(switchSequence(project, DEFAULT_SEQUENCE_ID)).toBe(project)
  })

  it('重命名：活动序列写 activeSequenceName，非活动序列改快照；空名忽略', () => {
    const added = addSequence(seededProject(), '旧名')!
    const renamedActive = renameSequence(added.project, DEFAULT_SEQUENCE_ID, '主剪辑')
    expect(activeSequenceName(renamedActive)).toBe('主剪辑')
    expect(findSequence(renamedActive, DEFAULT_SEQUENCE_ID)!.name).toBe('主剪辑')

    const renamedInactive = renameSequence(added.project, added.id, '新名')
    expect(findSequence(renamedInactive, added.id)!.name).toBe('新名')

    expect(renameSequence(added.project, added.id, '   ')).toBe(added.project)
  })

  it('删除非活动序列；删除活动序列会先切到第一条；只剩一条时拒绝', () => {
    const added = addSequence(seededProject(), 'B')!
    const removedInactive = removeSequence(added.project, added.id)!
    expect(inactiveSequences(removedInactive)).toHaveLength(0)

    const switched = switchSequence(added.project, added.id)!
    const removedActive = removeSequence(switched, added.id)!
    expect(activeSequenceId(removedActive)).toBe(DEFAULT_SEQUENCE_ID)
    expect(removedActive.clips).toHaveLength(1)

    expect(removeSequence(seededProject(), DEFAULT_SEQUENCE_ID)).toBeNull()
    expect(removeSequence(seededProject(), 'seq-missing')).toBeNull()
  })

  it('复制序列：内容一致、id 不同、数组不共享引用；副本留在非活动序列里', () => {
    const project = seededProject()
    const duplicated = duplicateSequence(project, undefined, '副本 A')!
    expect(duplicated.id).not.toBe(DEFAULT_SEQUENCE_ID)
    const snapshot = findSequence(duplicated.project, duplicated.id)!
    expect(snapshot.name).toBe('副本 A')
    expect(snapshot.clips).toHaveLength(1)
    expect(activeSequenceId(duplicated.project)).toBe(DEFAULT_SEQUENCE_ID)
    // 数组是浅拷贝，改副本不影响活动序列
    snapshot.clips.push(createClip({ startTime: 5, fps: FPS_30 }))
    expect(duplicated.project.clips).toHaveLength(1)
  })

  it('序列数量软上限：最多 MAX_SEQUENCES 条（活动 + 非活动）', () => {
    let project = seededProject()
    for (let index = 0; index < MAX_SEQUENCES - 1; index += 1) {
      const added = addSequence(project, `序列 ${index}`)
      expect(added).not.toBeNull()
      project = added!.project
    }
    expect(allSequences(project)).toHaveLength(MAX_SEQUENCES)
    expect(addSequence(project)).toBeNull()
  })
})

describe('schema v4：归一与迁移', () => {
  /** 构造一份"v3 时代的工程 JSON"：有平铺字段，没有任何序列键。 */
  function v3Raw(): Record<string, unknown> {
    const project = seededProject()
    const raw = JSON.parse(JSON.stringify(project)) as Record<string, unknown>
    raw['version'] = 3
    delete raw['sequences']
    delete raw['activeSequenceId']
    delete raw['activeSequenceName']
    return raw
  }

  it('v3 工程迁移到 v4：版本号升级，且不凭空写入序列键（单序列 JSON 形状不变）', () => {
    const parsed = normalizeProject(v3Raw())!
    expect(parsed.version).toBe(PROJECT_VERSION)
    expect(parsed.activeSequenceId).toBeUndefined()
    expect(parsed.activeSequenceName).toBeUndefined()
    expect(parsed.sequences).toBeUndefined()
    expect(parsed.clips).toHaveLength(1)
  })

  it('v4 往返：activeSequenceId/Name 与序列快照原样归一', () => {
    const added = addSequence(seededProject(), '第二段')!
    const switched = switchSequence(added.project, added.id)!
    const raw = JSON.parse(JSON.stringify(switched)) as Record<string, unknown>
    const parsed = normalizeProject(raw)!
    expect(parsed.activeSequenceId).toBe(added.id)
    expect(parsed.activeSequenceName).toBe('第二段')
    expect(parsed.sequences).toHaveLength(1)
    expect(parsed.sequences![0]!.id).toBe(DEFAULT_SEQUENCE_ID)
    expect(parsed.sequences![0]!.clips).toHaveLength(1)
  })

  it('脏数据：与活动 id 重复 / 缺 id / 非对象 的序列快照被丢弃', () => {
    const project = seededProject()
    const raw: Record<string, unknown> = {
      ...JSON.parse(JSON.stringify(project)),
      version: PROJECT_VERSION,
      activeSequenceId: 'seq-x',
      activeSequenceName: '第二段',
      sequences: [
        { id: 'seq-ok', name: '好序列', clips: [], mediaClips: [], mediaTracks: [makeMediaTrack(0)], audioTracks: [], subtitleTrack: { id: 'track-subtitle', name: '字幕', muted: false, hidden: false, locked: false, kind: 'subtitle' } },
        { name: '缺 id' },
        'not-a-snapshot',
        { id: 'seq-x', name: '与活动重复的 id' }
      ]
    }
    const parsed = normalizeProject(raw)!
    expect(parsed.sequences).toHaveLength(1)
    expect(parsed.sequences![0]!.id).toBe('seq-ok')
  })

  it('序列数量在归一阶段夹到 MAX_SEQUENCES', () => {
    const project = seededProject()
    const snapshot = {
      id: 'seq',
      name: 'x',
      clips: [],
      mediaClips: [],
      mediaTracks: [makeMediaTrack(0)],
      audioTracks: [],
      subtitleTrack: { id: 'track-subtitle', name: '字幕', muted: false, hidden: false, locked: false, kind: 'subtitle' }
    }
    const raw = {
      ...JSON.parse(JSON.stringify(project)),
      version: PROJECT_VERSION,
      sequences: Array.from({ length: MAX_SEQUENCES + 5 }, (_, index) => ({ ...snapshot, id: `seq-${index}` }))
    }
    const parsed = normalizeProject(raw)!
    expect(parsed.sequences).toHaveLength(MAX_SEQUENCES - 1)
  })
})
