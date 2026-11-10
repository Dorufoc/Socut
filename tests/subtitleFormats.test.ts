import { describe, expect, it } from 'vitest'
import {
  cuesFromClips,
  formatAss,
  formatAssTimecode,
  formatSrt,
  formatSrtTimecode,
  parseAss,
  parseAssTimecode,
  parseSrt,
  parseSrtTimecode,
  parseSubtitleFile
} from '@shared/subtitleFormats'

/** M11：SRT/ASS 解析与生成（纯净函数层）。 */

const SRT = `1
00:00:01,000 --> 00:00:03,500
今日头条

2
00:00:04,000 --> 00:00:06,000
<i>第二段</i>
副标题行
`

describe('SRT', () => {
  it('解析：两条 cue、时间码与多行文本', () => {
    const report = parseSrt(SRT)
    expect(report.dropped).toBe(0)
    expect(report.cues).toHaveLength(2)
    expect(report.cues[0]).toEqual({ startSec: 1, endSec: 3.5, text: '今日头条' })
    expect(report.cues[1]!.text).toBe('第二段\n副标题行')
  })

  it('宽容：BOM / CRLF / 点号毫秒 / 缺序号', () => {
    const raw = '\uFEFF00:00:00.500 --> 00:00:01.250\r\n标题\r\n\r\n00:00:02,000 --> 00:00:03,000\r\n第二条'
    const report = parseSrt(raw)
    expect(report.cues).toHaveLength(2)
    expect(report.cues[0]).toEqual({ startSec: 0.5, endSec: 1.25, text: '标题' })
  })

  it('丢弃：时间倒挂 / 空文本 / 无时间码块', () => {
    const broken = `1
00:00:05,000 --> 00:00:01,000
倒挂

2
00:00:06,000 --> 00:00:07,000

3
没有时间码的行
`
    const report = parseSrt(broken)
    expect(report.cues).toHaveLength(0)
    expect(report.dropped).toBe(3)
  })

  it('生成：序号、逗号毫秒、末行换行；空/倒挂 cue 被跳过', () => {
    const text = formatSrt([
      { startSec: 0, endSec: 1.234, text: '第一条' },
      { startSec: 2, endSec: 2, text: '零时长' },
      { startSec: 3, endSec: 4, text: '   ' }
    ])
    expect(text).toContain('1\n00:00:00,000 --> 00:00:01,234\n第一条')
    expect(text.endsWith('\n')).toBe(true)
    expect(text).not.toContain('零时长')
  })

  it('时间码换算互逆', () => {
    expect(parseSrtTimecode(formatSrtTimecode(3723.456))).toBeCloseTo(3723.456, 3)
    expect(formatSrtTimecode(0)).toBe('00:00:00,000')
    expect(formatSrtTimecode(3661.5)).toBe('01:01:01,500')
    expect(parseSrtTimecode('01:02')).toBeNull()
  })
})

const ASS = `[Script Info]
Title: 测试
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an2}今日头条
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,第一行\\N第二行
`

describe('ASS', () => {
  it('解析：只取 [Events] 的 Dialogue，去掉覆盖标签、还原换行', () => {
    const report = parseAss(ASS)
    expect(report.cues).toHaveLength(2)
    expect(report.cues[0]).toEqual({ startSec: 1, endSec: 3.5, text: '今日头条' })
    expect(report.cues[1]!.text).toBe('第一行\n第二行')
  })

  it('生成：最小可导入结构 + Dialogue 转义', () => {
    const text = formatAss([{ startSec: 1, endSec: 2.5, text: '今日\n头条' }], { title: '新闻' })
    expect(text).toContain('[Script Info]')
    expect(text).toContain('Style: Default')
    expect(text).toContain('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,今日\\N头条')
    expect(text).toContain('Title: 新闻')
  })

  it('生成 → 解析 往返一致（时间与文本）', () => {
    const cues = [
      { startSec: 0.5, endSec: 2, text: '第一条' },
      { startSec: 3, endSec: 5.25, text: '第二条\n换行' }
    ]
    const report = parseAss(formatAss(cues))
    expect(report.cues).toHaveLength(2)
    expect(report.cues[0]!.startSec).toBeCloseTo(0.5, 2)
    expect(report.cues[1]!.endSec).toBeCloseTo(5.25, 2)
    expect(report.cues[1]!.text).toBe('第二条\n换行')
  })

  it('自动识别：含 [Events] 走 ASS，否则 SRT', () => {
    expect(parseSubtitleFile(ASS).cues).toHaveLength(2)
    expect(parseSubtitleFile(SRT).cues).toHaveLength(2)
    expect(parseSubtitleFile('坏内容').cues).toHaveLength(0)
  })

  it('时间码：ASS 两位厘秒', () => {
    expect(formatAssTimecode(1.5)).toBe('0:00:01.50')
    expect(parseAssTimecode('0:01:02.30')).toBeCloseTo(62.3, 2)
    expect(parseAssTimecode('1:2')).toBeNull()
  })
})

describe('cuesFromClips', () => {
  it('标题+副标题换行拼接；空标题跳过；按时间排序', () => {
    const cues = cuesFromClips([
      { startTime: 5, endTime: 7, content: { title: '后一条', subtitle: '' } },
      { startTime: 0, endTime: 2, content: { title: '前一条', subtitle: '职务' } },
      { startTime: 9, endTime: 10, content: { title: '  ', subtitle: '' } }
    ])
    expect(cues).toHaveLength(2)
    expect(cues[0]).toEqual({ startSec: 0, endSec: 2, text: '前一条\n职务' })
    expect(cues[1]!.text).toBe('后一条')
  })
})
