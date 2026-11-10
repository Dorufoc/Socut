import { describe, expect, it } from 'vitest'
import { FPS_30 } from '@shared/constants'
import {
  MAX_BATCH_ROWS,
  parseCaptionCsv,
  parseCaptionJson,
  parseCaptionLines,
  parseCaptionRows,
  planCaptionClips
} from '@shared/captionBatch'

/** M11：批量名单解析与排布（CSV/JSON/纯文本 → 首尾相接的字幕条计划）。 */

describe('parseCaptionCsv', () => {
  it('带表头：标题/副标题/时长三列，跳首行', () => {
    const report = parseCaptionCsv('标题,副标题,时长\n张伟,省发展改革委主任,4\n李娜,记者,3.5')
    expect(report.dropped).toBe(0)
    expect(report.rows).toEqual([
      { title: '张伟', subtitle: '省发展改革委主任', durationSec: 4 },
      { title: '李娜', subtitle: '记者', durationSec: 3.5 }
    ])
  })

  it('无表头 + 引号包裹 + 空副标题/非法时长', () => {
    const report = parseCaptionCsv('"张伟, 主任",,abc\n李娜,记者,')
    expect(report.rows[0]).toEqual({ title: '张伟, 主任', subtitle: '' })
    expect(report.rows[1]).toEqual({ title: '李娜', subtitle: '记者' })
  })

  it('空行忽略；空标题记 dropped', () => {
    const report = parseCaptionCsv(',副\n有效标题')
    expect(report.rows).toEqual([{ title: '有效标题', subtitle: '' }])
    expect(report.dropped).toBe(1)
  })

  it('超长标题截断到 200 字', () => {
    const report = parseCaptionCsv(`${'长'.repeat(300)}`)
    expect(report.rows[0]!.title).toHaveLength(200)
  })

  it('条数上限 500', () => {
    const raw = Array.from({ length: MAX_BATCH_ROWS + 20 }, (_, index) => `标题${index}`).join('\n')
    expect(parseCaptionCsv(raw).rows).toHaveLength(MAX_BATCH_ROWS)
  })
})

describe('parseCaptionJson / parseCaptionLines / auto', () => {
  it('JSON 字符串数组 / 对象数组 / {rows}', () => {
    expect(parseCaptionJson('["张伟","李娜"]').rows).toEqual([
      { title: '张伟', subtitle: '' },
      { title: '李娜', subtitle: '' }
    ])
    expect(parseCaptionJson('[{"name":"张伟","subtitle":"主任","durationSec":4}]').rows).toEqual([
      { title: '张伟', subtitle: '主任', durationSec: 4 }
    ])
    expect(parseCaptionJson('{"rows":[{"title":"张伟"}]}').rows).toEqual([{ title: '张伟', subtitle: '' }])
    expect(parseCaptionJson('不是 JSON').rows).toEqual([])
  })

  it('纯文本一行一条；空行忽略', () => {
    const report = parseCaptionLines('张伟\n\n李娜\n')
    expect(report.rows.map((row) => row.title)).toEqual(['张伟', '李娜'])
  })

  it('auto：JSON/CSV/纯文本自动识别', () => {
    expect(parseCaptionRows('["a","b"]').rows).toHaveLength(2)
    expect(parseCaptionRows('标题,副标题\na,b').rows).toHaveLength(1)
    expect(parseCaptionRows('单独一行').rows).toHaveLength(1)
  })
})

describe('planCaptionClips', () => {
  const rows = [
    { title: 'A', subtitle: '' },
    { title: 'B', subtitle: '职务', durationSec: 2 },
    { title: 'C', subtitle: '' }
  ]

  it('首尾相接：缺省 5s，行内 duration 优先；帧对齐', () => {
    const plan = planCaptionClips(rows, { fps: FPS_30, startSec: 0 })
    expect(plan.map((item) => [item.startTime, item.endTime])).toEqual([
      [0, 5],
      [5, 7],
      [7, 12]
    ])
    expect(plan[1]!.subtitle).toBe('职务')
  })

  it('起点与空隙都吸附帧边界', () => {
    const plan = planCaptionClips(rows, { fps: FPS_30, startSec: 0.017, gapSec: 0.0167, defaultDurationSec: 1 })
    expect(plan[0]!.startTime).toBeCloseTo(1 / 30, 6)
    expect(plan[1]!.startTime).toBeCloseTo(plan[1]!.endTime - 2, 6)
    // 第二条结束 + gap 吸附后 = 第三条起点
    expect(plan[2]!.startTime).toBeCloseTo(Math.round((plan[1]!.endTime + 0.0167) * 30) / 30, 6)
  })

  it('过短 duration 夹到工程最短字幕时长 0.2s', () => {
    const plan = planCaptionClips([{ title: '短', subtitle: '', durationSec: 0.01 }], { fps: FPS_30, defaultDurationSec: 5 })
    expect(plan[0]!.endTime - plan[0]!.startTime).toBeGreaterThanOrEqual(0.2 - 1e-9)
  })

  it('空行列表返回空计划', () => {
    expect(planCaptionClips([], { fps: FPS_30 })).toEqual([])
  })
})
