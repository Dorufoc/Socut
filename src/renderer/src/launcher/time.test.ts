import { describe, expect, it } from 'vitest'
import { formatDateTime, formatFull, formatRelative } from './time'

/** 时间格式化（启动页卡片用）：全部按本地时区断言，构造 Date 时也用本地时间。 */

const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): string =>
  new Date(year, month - 1, day, hour, minute, second).toISOString()

describe('formatDateTime', () => {
  it('输出本地 YYYY-MM-DD HH:mm', () => {
    expect(formatDateTime(local(2026, 5, 3, 9, 5, 7))).toBe('2026-05-03 09:05')
  })

  it('非法输入回落到占位符', () => {
    expect(formatDateTime('')).toBe('—')
    expect(formatDateTime('not-a-date')).toBe('—')
  })
})

describe('formatFull', () => {
  it('输出本地 YYYY-MM-DD HH:mm:ss', () => {
    expect(formatFull(local(2026, 5, 3, 9, 5, 7))).toBe('2026-05-03 09:05:07')
  })

  it('非法输入回落到占位符', () => {
    expect(formatFull('2026-13-40')).toBe('—')
  })
})

describe('formatRelative', () => {
  const now = new Date(2026, 4, 3, 12, 0, 0).getTime()

  it('一分钟内显示「刚刚」，未来时间也按刚刚处理', () => {
    expect(formatRelative(local(2026, 5, 3, 11, 59, 30), now)).toBe('刚刚')
    expect(formatRelative(local(2026, 5, 3, 13, 0, 0), now)).toBe('刚刚')
  })

  it('一小时内按分钟，一天内按小时', () => {
    expect(formatRelative(local(2026, 5, 3, 11, 55, 0), now)).toBe('5 分钟前')
    expect(formatRelative(local(2026, 5, 3, 9, 0, 0), now)).toBe('3 小时前')
  })

  it('昨天显示「昨天 HH:mm」，更早回落日期', () => {
    expect(formatRelative(local(2026, 5, 2, 9, 0, 0), now)).toBe('昨天 09:00')
    expect(formatRelative(local(2026, 4, 30, 12, 0, 0), now)).toBe('2026-04-30')
  })

  it('非法输入回落到占位符', () => {
    expect(formatRelative('bad-date', now)).toBe('—')
  })
})
