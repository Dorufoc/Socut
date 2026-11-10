import { describe, expect, it } from 'vitest'
import type { MediaClip } from '@shared/types'
import { captionAutoWindowOf, planCaptionAutoCues } from './captionAuto'

/**
 * M11：自动字幕「源时间 → 时间轴」映射（纯函数）。
 * 锁住：入点偏移、变速（源窗口不变、时间轴随倍速伸缩）、片段窗口裁剪与空文本丢弃。
 */

function clip(overrides: Partial<MediaClip> = {}): Pick<MediaClip, 'timelineStartSec' | 'timelineEndSec' | 'sourceInSec' | 'speed'> {
  return { timelineStartSec: 10, timelineEndSec: 20, sourceInSec: 2, ...overrides }
}

describe('captionAutoWindowOf', () => {
  it('带变速时取 speed；缺省不落盘 → undefined（映射时按 1 处理）', () => {
    expect(captionAutoWindowOf(clip({ speed: { speed: 2, maintainPitch: true } }))).toEqual({
      timelineStartSec: 10,
      timelineEndSec: 20,
      sourceInSec: 2,
      speed: 2
    })
    expect(captionAutoWindowOf(clip())).toEqual({ timelineStartSec: 10, timelineEndSec: 20, sourceInSec: 2 })
  })
})

describe('planCaptionAutoCues', () => {
  it('1x 无入点：时间原样落位（整份媒体从片段起点开始）', () => {
    const cues = planCaptionAutoCues(
      [
        { startSec: 0.2, endSec: 2.4, text: '今日头条' },
        { startSec: 2.6, endSec: 4.8, text: '省发展改革委发布' }
      ],
      { timelineStartSec: 0, timelineEndSec: 8, sourceInSec: 0 }
    )
    expect(cues).toEqual([
      { startSec: 0.2, endSec: 2.4, text: '今日头条' },
      { startSec: 2.6, endSec: 4.8, text: '省发展改革委发布' }
    ])
  })

  it('剪切片段：按 sourceInSec 平移（源 4s 起 → 时间轴 10s 起）', () => {
    const cues = planCaptionAutoCues(
      [
        { startSec: 4, endSec: 6, text: 'A' },
        { startSec: 8, endSec: 9.5, text: 'B' }
      ],
      { timelineStartSec: 10, timelineEndSec: 20, sourceInSec: 4 }
    )
    expect(cues).toEqual([
      { startSec: 10, endSec: 12, text: 'A' },
      { startSec: 14, endSec: 15.5, text: 'B' }
    ])
  })

  it('变速 2x：时间轴长度随倍速缩短（(cue - sourceIn) / speed）', () => {
    const cues = planCaptionAutoCues(
      [{ startSec: 2, endSec: 6, text: '两倍速' }],
      { timelineStartSec: 10, timelineEndSec: 12, sourceInSec: 2, speed: 2 }
    )
    expect(cues).toEqual([{ startSec: 10, endSec: 12, text: '两倍速' }])
  })

  it('变速 0.5x：时间轴长度翻倍', () => {
    const cues = planCaptionAutoCues(
      [{ startSec: 2, endSec: 6, text: '慢放' }],
      { timelineStartSec: 10, timelineEndSec: 18, sourceInSec: 2, speed: 0.5 }
    )
    expect(cues).toEqual([{ startSec: 10, endSec: 18, text: '慢放' }])
  })

  it('窗口裁剪：只保留与片段重叠的部分，完全在窗口外的 cue 丢弃', () => {
    const cues = planCaptionAutoCues(
      [
        { startSec: 0, endSec: 1, text: '窗口前：丢' },
        { startSec: 1, endSec: 3, text: '压入点：裁左' },
        { startSec: 3.5, endSec: 4.5, text: '窗口内：原样' },
        { startSec: 11, endSec: 13, text: '压出点：裁右' },
        { startSec: 20, endSec: 22, text: '窗口后：丢' }
      ],
      { timelineStartSec: 10, timelineEndSec: 20, sourceInSec: 2 }
    )
    expect(cues).toEqual([
      { startSec: 10, endSec: 11, text: '压入点：裁左' },
      { startSec: 11.5, endSec: 12.5, text: '窗口内：原样' },
      { startSec: 19, endSec: 20, text: '压出点：裁右' }
    ])
  })

  it('一个长素材的全文不会被整段堆进时间轴：超长 cue 裁到片段窗口内', () => {
    const cues = planCaptionAutoCues(
      [{ startSec: 0, endSec: 30, text: '整份媒体' }],
      { timelineStartSec: 10, timelineEndSec: 20, sourceInSec: 2 }
    )
    expect(cues).toEqual([{ startSec: 10, endSec: 20, text: '整份媒体' }])
  })

  it('空文本/纯空白丢弃，文本内多余空白压成单空格', () => {
    const cues = planCaptionAutoCues(
      [
        { startSec: 2, endSec: 3, text: '   ' },
        { startSec: 3, endSec: 4, text: ' 你好   世界 ' }
      ],
      { timelineStartSec: 0, timelineEndSec: 10, sourceInSec: 0 }
    )
    expect(cues).toEqual([{ startSec: 3, endSec: 4, text: '你好 世界' }])
  })

  it('零时长或倒挂的 cue（裁剪后无正时长）丢弃', () => {
    const cues = planCaptionAutoCues(
      [
        { startSec: 5, endSec: 5, text: '零时长' },
        { startSec: 6, endSec: 5, text: '倒挂' }
      ],
      { timelineStartSec: 0, timelineEndSec: 10, sourceInSec: 0 }
    )
    expect(cues).toEqual([])
  })

  it('非法倍速（0/负数/NaN）按 1x 处理，不把时间算崩', () => {
    const expected = [{ startSec: 0, endSec: 2, text: 'x' }]
    for (const speed of [0, -2, Number.NaN]) {
      expect(
        planCaptionAutoCues(
          [{ startSec: 0, endSec: 2, text: 'x' }],
          { timelineStartSec: 0, timelineEndSec: 20, sourceInSec: 0, speed }
        )
      ).toEqual(expected)
    }
  })

  it('输出按开始时间升序（输入乱序也稳定）', () => {
    const cues = planCaptionAutoCues(
      [
        { startSec: 6, endSec: 7, text: '后' },
        { startSec: 3, endSec: 4, text: '前' }
      ],
      { timelineStartSec: 0, timelineEndSec: 20, sourceInSec: 0 }
    )
    expect(cues.map((cue) => cue.text)).toEqual(['前', '后'])
  })
})
